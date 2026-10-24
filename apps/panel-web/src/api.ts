import type { AccessView, InviteView, Role, ServerPerm, UserView, CatalogHit, LogFile, LogRead, PluginsView, PluginReadiness, VersionJob, VersionsView, ServerType, BackupJob, BackupsView, ScheduleInput, ScheduleView, Dashboard, Me, MetricPoint, MetricRange, NewServer, NodeMetricPoint, PlayerAction, PlayersView, PowerAction, ServerInfo, ServerView } from "@gamepanel/shared";

// Talking to the panel API. Every change carries the x-gamepanel header the API requires.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { ...(method !== "GET" ? { "x-gamepanel": "1" } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) throw new ApiError((data as { error?: string } | undefined)?.error ?? `request failed (${res.status})`, res.status, (data ?? {}) as Record<string, unknown>);
  return data as T;
}

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  login: (email: string, password: string, code?: string) => call<Me>("POST", "/api/auth/login", { email, password, ...(code ? { code } : {}) }),
  totpSetup: () => call<{ secret: string; uri: string }>("POST", "/api/auth/totp/setup", {}),
  totpEnable: (code: string) => call<{ ok: true }>("POST", "/api/auth/totp/enable", { code }),
  totpDisable: (code: string) => call<{ ok: true }>("POST", "/api/auth/totp/disable", { code }),
  users: () => call<UserView[]>("GET", "/api/users"),
  invites: () => call<InviteView[]>("GET", "/api/invites"),
  invite: (email: string, role: Role) => call<{ path: string; expiresAt: string }>("POST", "/api/users/invite", { email, role }),
  resetLink: (uid: string) => call<{ path: string }>("POST", `/api/users/${encodeURIComponent(uid)}/reset`, {}),
  updateUser: (uid: string, body: { disabled?: boolean; role?: Role; quota?: { maxServers: number; maxMemoryMb: number; maxDiskGb: number } }) =>
    call<{ ok: true }>("PUT", `/api/users/${encodeURIComponent(uid)}`, body),
  inviteInfo: (token: string) => call<{ email: string; kind: string }>("GET", `/api/invite/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, password: string) => call<Me>("POST", "/api/invite/accept", { token, password }),
  access: (id: string) => call<AccessView[]>("GET", `/api/servers/${encodeURIComponent(id)}/access`),
  setAccess: (id: string, email: string, perms: ServerPerm[]) => call<{ ok: true }>("PUT", `/api/servers/${encodeURIComponent(id)}/access`, { email, perms }),
  removeAccess: (id: string, uid: string) => call<{ ok: true }>("DELETE", `/api/servers/${encodeURIComponent(id)}/access/${encodeURIComponent(uid)}`),
  setDisk: (id: string, gb: number) => call<unknown>("PUT", `/api/servers/${encodeURIComponent(id)}/disk`, { gb }),
  changePassword: (current: string, next: string) => call<{ ok: true }>("POST", "/api/auth/password", { current, next }),
  logout: () => call<{ ok: true }>("POST", "/api/auth/logout", {}),
  dashboard: () => call<Dashboard>("GET", "/api/dashboard"),
  server: (id: string) => call<ServerView>("GET", `/api/servers/${encodeURIComponent(id)}`),
  metrics: (id: string, range: MetricRange) => call<MetricPoint[]>("GET", `/api/servers/${encodeURIComponent(id)}/metrics?range=${range}`),
  nodeMetrics: (id: string, range: MetricRange) => call<NodeMetricPoint[]>("GET", `/api/nodes/${encodeURIComponent(id)}/metrics?range=${range}`),
  plugins: (id: string) => call<PluginsView>("GET", `/api/servers/${encodeURIComponent(id)}/plugins`),
  searchPlugins: (id: string, q: string) => call<CatalogHit[]>("GET", `/api/servers/${encodeURIComponent(id)}/plugins/search?q=${encodeURIComponent(q)}`),
  installPlugin: (id: string, source: string, pid: string) => call<{ file: string }>("POST", `/api/servers/${encodeURIComponent(id)}/plugins/install`, { source, id: pid }),
  updatePlugin: (id: string, file: string) => call<{ file: string }>("POST", `/api/servers/${encodeURIComponent(id)}/plugins/update`, { file }),
  setPluginEnabled: (id: string, file: string, on: boolean) => call<{ file: string }>("POST", `/api/servers/${encodeURIComponent(id)}/plugins/enabled`, { file, on }),
  deletePlugin: (id: string, file: string) => call<{ ok: true }>("DELETE", `/api/servers/${encodeURIComponent(id)}/plugins/${encodeURIComponent(file)}`),
  logs: (id: string) => call<LogFile[]>("GET", `/api/servers/${encodeURIComponent(id)}/logs`),
  readLog: (id: string, path: string, search: string) =>
    call<LogRead>("GET", `/api/servers/${encodeURIComponent(id)}/logs/read?path=${encodeURIComponent(path)}${search ? `&search=${encodeURIComponent(search)}` : ""}`),
  versions: (id: string) => call<VersionsView>("GET", `/api/servers/${encodeURIComponent(id)}/versions`),
  checkPlugins: (id: string, to: string) => call<PluginReadiness[]>("GET", `/api/servers/${encodeURIComponent(id)}/versions/check?to=${encodeURIComponent(to)}`),
  versionJob: (id: string) => call<VersionJob | null>("GET", `/api/servers/${encodeURIComponent(id)}/version-job`),
  changeVersion: (id: string, type: ServerType, version: string) => call<VersionJob>("POST", `/api/servers/${encodeURIComponent(id)}/version`, { type, version }),
  backups: (id: string) => call<BackupsView>("GET", `/api/servers/${encodeURIComponent(id)}/backups`),
  startBackup: (id: string) => call<BackupJob>("POST", `/api/servers/${encodeURIComponent(id)}/backups`, {}),
  restoreBackup: (id: string, name: string) => call<BackupJob>("POST", `/api/servers/${encodeURIComponent(id)}/backups/restore`, { name }),
  removeBackup: (id: string, name: string) => call<{ ok: true }>("DELETE", `/api/servers/${encodeURIComponent(id)}/backups/${encodeURIComponent(name)}`),
  setBackupKeep: (id: string, keep: number) => call<{ keep: number }>("PUT", `/api/servers/${encodeURIComponent(id)}/backups/keep`, { keep }),
  backupDownloadUrl: (id: string, name: string) => `/api/servers/${encodeURIComponent(id)}/backups/${encodeURIComponent(name)}/download`,
  schedules: (id: string) => call<ScheduleView[]>("GET", `/api/servers/${encodeURIComponent(id)}/schedules`),
  createSchedule: (id: string, s: ScheduleInput) => call<ScheduleView>("POST", `/api/servers/${encodeURIComponent(id)}/schedules`, s),
  updateSchedule: (id: string, sid: string, s: ScheduleInput) => call<ScheduleView>("PUT", `/api/servers/${encodeURIComponent(id)}/schedules/${encodeURIComponent(sid)}`, s),
  deleteSchedule: (id: string, sid: string) => call<{ ok: true }>("DELETE", `/api/servers/${encodeURIComponent(id)}/schedules/${encodeURIComponent(sid)}`),
  properties: (id: string) => call<{ values: Record<string, string> }>("GET", `/api/servers/${encodeURIComponent(id)}/properties`),
  setProperties: (id: string, changes: Record<string, string>) =>
    call<{ backup: string; changed: string[] }>("PUT", `/api/servers/${encodeURIComponent(id)}/properties`, { changes }),
  players: (id: string) => call<PlayersView>("GET", `/api/servers/${encodeURIComponent(id)}/players`),
  playerAction: (id: string, a: PlayerAction) => call<{ answer: string }>("POST", `/api/servers/${encodeURIComponent(id)}/players/action`, a),
  setWhitelist: (id: string, on: boolean) => call<{ answer: string }>("POST", `/api/servers/${encodeURIComponent(id)}/players/whitelist`, { on }),
  info: (id: string) => call<ServerInfo>("GET", `/api/servers/${encodeURIComponent(id)}/info`),
  create: (body: NewServer) => call<ServerView>("POST", "/api/servers", body),
  power: (id: string, action: PowerAction) => call<unknown>("POST", `/api/servers/${encodeURIComponent(id)}/power`, { action }),
  powerAll: (action: PowerAction) => call<{ results: { id: string; ok: boolean; error?: string }[] }>("POST", "/api/servers/power-all", { action }),
  broadcast: (message: string) => call<{ results: { id: string; ok: boolean }[] }>("POST", "/api/servers/broadcast", { message }),
};

export interface FileEntry {
  name: string;
  type: "file" | "dir" | "link";
  size: number;
  modified: string;
}

const enc = encodeURIComponent;
export const files = {
  list: (id: string, path: string) => call<FileEntry[]>("GET", `/api/servers/${enc(id)}/files?path=${enc(path)}`),
  read: (id: string, path: string) => call<{ text: string }>("GET", `/api/servers/${enc(id)}/files/content?path=${enc(path)}`),
  write: (id: string, path: string, text: string) => call<void>("PUT", `/api/servers/${enc(id)}/files/content?path=${enc(path)}`, { text }),
  mkdir: (id: string, path: string) => call<void>("POST", `/api/servers/${enc(id)}/files/mkdir`, { path }),
  rename: (id: string, from: string, to: string) => call<void>("POST", `/api/servers/${enc(id)}/files/rename`, { from, to }),
  remove: (id: string, path: string) => call<{ ok: true }>("DELETE", `/api/servers/${enc(id)}/files?path=${enc(path)}`),
  downloadUrl: (id: string, path: string) => `/api/servers/${enc(id)}/files/download?path=${enc(path)}`,

  // Upload in 50 MB pieces: Cloudflare refuses single requests over 100 MB.
  async upload(id: string, path: string, file: File, onProgress: (sent: number) => void): Promise<void> {
    const PIECE = 50 * 1024 * 1024;
    let offset = 0;
    do {
      const piece = file.slice(offset, offset + PIECE);
      const done = offset + piece.size >= file.size;
      const res = await fetch(`/api/servers/${enc(id)}/files/upload?path=${enc(path)}&offset=${offset}&done=${done ? 1 : 0}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-gamepanel": "1", "content-type": "application/octet-stream" },
        body: piece,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(data.error ?? `upload failed (${res.status})`, res.status);
      }
      offset += piece.size;
      onProgress(offset);
    } while (offset < file.size);
  },
};

export function consoleUrl(id: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/servers/${encodeURIComponent(id)}/console`;
}
