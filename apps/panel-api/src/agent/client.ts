import type { Readable } from "node:stream";
import { Agent, request } from "undici";
import WebSocket from "ws";
import type {
  BackupEntry,
  BackupJob,
  DatabaseInfo,
  DatabasesView,
  LogFile,
  LogRead,
  PluginItem,
  PluginUpdate,
  NodeInfo,
  PlayerAction,
  PlayersView,
  PowerAction,
  QueryResult,
  ServerInfo,
  ServerSample,
  ServerSpec,
  ServerStats,
  ServerStatus,
  TableInfo,
  TableRows,
} from "@gamepanel/shared";

const LONG_WAIT_MS = 10 * 60_000;

// Talking to one node's agent. TLS trusts only that node's own certificate,
// and every call carries the node's token.

export interface FileEntry {
  name: string;
  type: "file" | "dir" | "link";
  size: number;
  modified: string;
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface AgentTarget {
  url: string;
  token: string;
  caPem: string;
}

export class AgentClient {
  private readonly dispatcher: Agent;

  constructor(private readonly target: AgentTarget) {
    this.dispatcher = new Agent({ connect: { ca: target.caPem }, headersTimeout: 30_000, bodyTimeout: 0 });
  }

  // `waitMs` for calls that take a snapshot first, which can run for minutes on a big database.
  private async call<T>(method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: unknown, waitMs?: number): Promise<T> {
    const res = await request(this.target.url + path, {
      method,
      dispatcher: this.dispatcher,
      ...(waitMs ? { headersTimeout: waitMs } : {}),
      headers: { authorization: `Bearer ${this.target.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // Not JSON; keep the text.
      }
      throw new AgentError(msg || `agent answered ${res.statusCode}`, res.statusCode);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  node = () => this.call<NodeInfo>("GET", "/v1/node");

  // Databases. Changes snapshot first, so they get a long wait.
  private db = (id: string, name?: string) => `/v1/servers/${id}/databases${name ? `/${encodeURIComponent(name)}` : ""}`;
  databases = (id: string) => this.call<DatabasesView>("GET", this.db(id));
  createDatabase = (id: string, label: string) => this.call<DatabaseInfo & { password: string }>("POST", this.db(id), { label }, LONG_WAIT_MS);
  databasePassword = (id: string, name: string) => this.call<{ password: string }>("GET", `${this.db(id, name)}/password`);
  resetDatabasePassword = (id: string, name: string) => this.call<{ password: string }>("POST", `${this.db(id, name)}/password`, {});
  deleteDatabase = (id: string, name: string) => this.call<{ snapshot: string }>("DELETE", this.db(id, name), undefined, LONG_WAIT_MS);
  databaseTables = (id: string, name: string) => this.call<TableInfo[]>("GET", `${this.db(id, name)}/tables`);
  databaseRows = (id: string, name: string, table: string, page: number, pageSize: number) =>
    this.call<TableRows>("GET", `${this.db(id, name)}/rows?${this.qs({ table, page, pageSize })}`);
  databaseQuery = (id: string, name: string, sql: string, write: boolean) =>
    this.call<QueryResult>("POST", `${this.db(id, name)}/query`, { sql, write }, write ? LONG_WAIT_MS : undefined);
  databaseRowUpdate = (id: string, name: string, edit: { table: string; key: Record<string, string | null>; set?: Record<string, string | null> }) =>
    this.call<QueryResult>("POST", `${this.db(id, name)}/rows/update`, edit, LONG_WAIT_MS);
  databaseRowDelete = (id: string, name: string, edit: { table: string; key: Record<string, string | null> }) =>
    this.call<QueryResult>("POST", `${this.db(id, name)}/rows/delete`, edit, LONG_WAIT_MS);
  list = () => this.call<ServerStatus[]>("GET", "/v1/servers");
  status = (id: string) => this.call<ServerStatus>("GET", `/v1/servers/${id}`);
  setDisk = (id: string, gb: number) => this.call<{ usedBytes: number; limitBytes: number } | null>("PUT", `/v1/servers/${id}/disk`, { gb });
  plugins = (id: string, folder: string) => this.call<PluginItem[]>("GET", `/v1/servers/${id}/plugins?folder=${folder}`);
  setPluginEnabled = (id: string, folder: string, file: string, on: boolean) => this.call<{ file: string }>("POST", `/v1/servers/${id}/plugins/enabled?folder=${folder}`, { file, on });
  installPlugin = (id: string, folder: string, u: PluginUpdate) => this.call<{ file: string; bytes: number }>("POST", `/v1/servers/${id}/plugins/install?folder=${folder}`, u);
  logs = (id: string) => this.call<LogFile[]>("GET", `/v1/servers/${id}/logs`);
  readLog = (id: string, path: string, search: string) =>
    this.call<LogRead>("GET", `/v1/servers/${id}/logs/read?${this.qs({ path, ...(search ? { search } : {}) })}`);
  backups = (id: string) => this.call<{ backups: BackupEntry[]; jobs: BackupJob[] }>("GET", `/v1/servers/${id}/backups`);
  startBackup = (id: string, reason: "manual" | "schedule", keep: number) => this.call<BackupJob>("POST", `/v1/servers/${id}/backups`, { reason, keep });
  restoreBackup = (id: string, name: string) => this.call<BackupJob>("POST", `/v1/servers/${id}/backups/restore`, { name });
  pruneBackups = (id: string, keep: number) => this.call<{ removed: string[] }>("POST", `/v1/servers/${id}/backups/prune`, { keep });
  removeBackup = (id: string, name: string) => this.call<void>("DELETE", `/v1/servers/${id}/backups/${encodeURIComponent(name)}`);
  async downloadBackup(id: string, name: string) {
    const res = await request(`${this.target.url}/v1/servers/${id}/backups/${encodeURIComponent(name)}/download`, {
      method: "GET",
      dispatcher: this.dispatcher,
      headers: { authorization: `Bearer ${this.target.token}` },
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new AgentError((JSON.parse(text || "{}") as { error?: string }).error ?? text, res.statusCode);
    }
    return { headers: res.headers, body: res.body };
  }
  properties = (id: string) => this.call<{ values: Record<string, string> }>("GET", `/v1/servers/${id}/properties`);
  setProperties = (id: string, changes: Record<string, string>) =>
    this.call<{ backup: string; changed: string[] }>("PUT", `/v1/servers/${id}/properties`, { changes });
  players = (id: string) => this.call<PlayersView>("GET", `/v1/servers/${id}/players`);
  playerAction = (id: string, a: PlayerAction) => this.call<{ answer: string }>("POST", `/v1/servers/${id}/players/action`, a);
  setWhitelist = (id: string, on: boolean) => this.call<{ answer: string }>("POST", `/v1/servers/${id}/players/whitelist`, { on });
  sample = (id: string) => this.call<ServerSample>("GET", `/v1/servers/${id}/sample`);
  info = (id: string) => this.call<ServerInfo>("GET", `/v1/servers/${id}/info`);
  stats = (id: string) => this.call<ServerStats>("GET", `/v1/servers/${id}/stats`);
  apply = (spec: ServerSpec) => this.call<ServerStatus>("PUT", `/v1/servers/${spec.id}`, spec);
  power = (id: string, action: PowerAction) => this.call<ServerStatus>("POST", `/v1/servers/${id}/power`, { action });
  command = (id: string, cmd: string) => this.call<void>("POST", `/v1/servers/${id}/command`, { cmd });
  remove = (id: string) => this.call<void>("DELETE", `/v1/servers/${id}`);

  // --- files ---
  private qs(params: Record<string, string | number>): string {
    return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  }
  listFiles = (id: string, path: string) => this.call<FileEntry[]>("GET", `/v1/servers/${id}/files?${this.qs({ path })}`);
  readFile = (id: string, path: string) => this.call<{ text: string }>("GET", `/v1/servers/${id}/files/content?${this.qs({ path })}`);
  writeFile = (id: string, path: string, text: string) => this.call<void>("PUT", `/v1/servers/${id}/files/content?${this.qs({ path })}`, { text });
  mkdir = (id: string, path: string) => this.call<void>("POST", `/v1/servers/${id}/files/mkdir`, { path });
  rename = (id: string, from: string, to: string) => this.call<void>("POST", `/v1/servers/${id}/files/rename`, { from, to });
  removeFile = (id: string, path: string) => this.call<{ trashedTo: string }>("DELETE", `/v1/servers/${id}/files?${this.qs({ path })}`);

  // Streams pass straight through the panel; nothing is held in memory.
  async download(id: string, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Readable }> {
    const res = await request(`${this.target.url}/v1/servers/${id}/files/download?${this.qs({ path })}`, {
      method: "GET",
      dispatcher: this.dispatcher,
      headers: { authorization: `Bearer ${this.target.token}` },
    });
    if (res.statusCode >= 400) {
      const text = await res.body.text();
      throw new AgentError((JSON.parse(text || "{}") as { error?: string }).error ?? text, res.statusCode);
    }
    return { status: res.statusCode, headers: res.headers, body: res.body };
  }

  async uploadChunk(id: string, path: string, offset: number, done: boolean, body: Readable): Promise<{ size: number }> {
    const res = await request(`${this.target.url}/v1/servers/${id}/files/upload?${this.qs({ path, offset, done: done ? 1 : 0 })}`, {
      method: "POST",
      dispatcher: this.dispatcher,
      headers: { authorization: `Bearer ${this.target.token}`, "content-type": "application/octet-stream" },
      body,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) throw new AgentError((JSON.parse(text || "{}") as { error?: string }).error ?? text, res.statusCode);
    return JSON.parse(text) as { size: number };
  }

  async importArchive(id: string, format: "tar.gz" | "zip", body: Readable): Promise<unknown> {
    const res = await request(`${this.target.url}/v1/servers/${id}/import?format=${format}`, {
      method: "POST",
      dispatcher: this.dispatcher,
      headers: { authorization: `Bearer ${this.target.token}`, "content-type": "application/octet-stream" },
      body,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) throw new AgentError((JSON.parse(text || "{}") as { error?: string }).error ?? text, res.statusCode);
    return JSON.parse(text);
  }

  console(id: string): WebSocket {
    const url = this.target.url.replace(/^http/, "ws") + `/v1/servers/${id}/console`;
    return new WebSocket(url, { ca: this.target.caPem, headers: { authorization: `Bearer ${this.target.token}` } });
  }
}
