import type { Dashboard, Me, NewServer, PowerAction, ServerView } from "@gamepanel/shared";

// Talking to the panel API. Every change carries the x-gamepanel header the API requires.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
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
  if (!res.ok) throw new ApiError((data as { error?: string } | undefined)?.error ?? `request failed (${res.status})`, res.status);
  return data as T;
}

export const api = {
  me: () => call<Me>("GET", "/api/me"),
  login: (email: string, password: string) => call<Me>("POST", "/api/auth/login", { email, password }),
  changePassword: (current: string, next: string) => call<{ ok: true }>("POST", "/api/auth/password", { current, next }),
  logout: () => call<{ ok: true }>("POST", "/api/auth/logout", {}),
  dashboard: () => call<Dashboard>("GET", "/api/dashboard"),
  server: (id: string) => call<ServerView>("GET", `/api/servers/${encodeURIComponent(id)}`),
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
