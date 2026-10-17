import type { Readable } from "node:stream";
import { Agent, request } from "undici";
import WebSocket from "ws";
import type { NodeInfo, PowerAction, ServerInfo, ServerSample, ServerSpec, ServerStats, ServerStatus } from "@gamepanel/shared";

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

  private async call<T>(method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await request(this.target.url + path, {
      method,
      dispatcher: this.dispatcher,
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
  list = () => this.call<ServerStatus[]>("GET", "/v1/servers");
  status = (id: string) => this.call<ServerStatus>("GET", `/v1/servers/${id}`);
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
