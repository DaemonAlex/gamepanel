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

export function consoleUrl(id: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/servers/${encodeURIComponent(id)}/console`;
}
