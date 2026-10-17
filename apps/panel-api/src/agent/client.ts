import type { Readable } from "node:stream";
import { Agent, request } from "undici";
import WebSocket from "ws";
import type { NodeInfo, PowerAction, ServerSpec, ServerStats, ServerStatus } from "@gamepanel/shared";

// Talking to one node's agent. TLS trusts only that node's own certificate,
// and every call carries the node's token.

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
  stats = (id: string) => this.call<ServerStats>("GET", `/v1/servers/${id}/stats`);
  apply = (spec: ServerSpec) => this.call<ServerStatus>("PUT", `/v1/servers/${spec.id}`, spec);
  power = (id: string, action: PowerAction) => this.call<ServerStatus>("POST", `/v1/servers/${id}/power`, { action });
  command = (id: string, cmd: string) => this.call<void>("POST", `/v1/servers/${id}/command`, { cmd });
  remove = (id: string) => this.call<void>("DELETE", `/v1/servers/${id}`);

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
