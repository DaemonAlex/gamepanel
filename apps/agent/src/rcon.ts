import { connect, type Socket } from "node:net";

// A small RCON client (Source RCON protocol, which Minecraft uses).
// RCON is only reached on the game network from the node; it is never published.
//
// Minecraft logs every new RCON connection ("Thread RCON Client ... started /
// shutting down"), so the pool below keeps one connection per server open and
// reuses it, instead of connecting for every poll.

const AUTH = 3;
const COMMAND = 2;

function packet(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf; // last two bytes stay 0: body terminator and empty string
}

export class RconConnection {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private waiting = new Map<number, { resolve: (body: string) => void; reject: (err: Error) => void }>();
  private nextId = 10;
  closed = false;

  constructor(
    readonly host: string,
    readonly port: number,
    private readonly password: string,
    private readonly timeoutMs = 4000,
  ) {}

  private failAll(err: Error) {
    this.closed = true;
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
    this.socket?.destroy();
  }

  async open(): Promise<void> {
    const socket = connect({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setKeepAlive(true, 30_000);
    socket.on("error", (err) => this.failAll(err));
    socket.on("close", () => this.failAll(new Error("rcon connection closed")));
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const len = this.buffer.readInt32LE(0);
        if (len < 10 || len > 1 << 20) return this.failAll(new Error("bad rcon packet"));
        if (this.buffer.length < 4 + len) break;
        const id = this.buffer.readInt32LE(4);
        const body = this.buffer.toString("utf8", 12, 4 + len - 2);
        this.buffer = this.buffer.subarray(4 + len);
        // A failed login answers with id -1.
        if (id === -1) return this.failAll(new Error("rcon login failed"));
        this.waiting.get(id)?.resolve(body);
        this.waiting.delete(id);
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    await this.send(AUTH, this.password);
  }

  private send(type: number, body: string): Promise<string> {
    if (this.closed || !this.socket) return Promise.reject(new Error("rcon connection closed"));
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        this.failAll(new Error("rcon timed out"));
        reject(new Error("rcon timed out"));
      }, this.timeoutMs);
      this.waiting.set(id, {
        resolve: (b) => (clearTimeout(timer), resolve(b)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.socket!.write(packet(id, type, body));
    });
  }

  command(cmd: string): Promise<string> {
    return this.send(COMMAND, cmd);
  }

  close() {
    this.closed = true;
    this.socket?.destroy();
  }
}

// One open connection per server. Commands for a server run one after another.
// A dropped connection (server restarted, new address) is replaced once.
export class RconPool {
  private conns = new Map<string, RconConnection>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly timeoutMs = 4000) {}

  run(key: string, host: string, port: number, password: string, commands: string[]): Promise<string[]> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.runNow(key, host, port, password, commands));
    this.queues.set(key, next);
    return next;
  }

  private async conn(key: string, host: string, port: number, password: string): Promise<RconConnection> {
    const have = this.conns.get(key);
    if (have && !have.closed && have.host === host && have.port === port) return have;
    have?.close();
    const c = new RconConnection(host, port, password, this.timeoutMs);
    this.conns.set(key, c);
    try {
      await c.open();
    } catch (err) {
      c.close();
      this.conns.delete(key);
      throw err;
    }
    return c;
  }

  private async runNow(key: string, host: string, port: number, password: string, commands: string[]): Promise<string[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        const c = await this.conn(key, host, port, password);
        const out: string[] = [];
        for (const cmd of commands) out.push(await c.command(cmd));
        return out;
      } catch (err) {
        this.conns.get(key)?.close();
        this.conns.delete(key);
        if (attempt >= 1) throw err;
      }
    }
  }

  // Forget a server's connection (e.g. it was stopped or removed).
  drop(key: string) {
    this.conns.get(key)?.close();
    this.conns.delete(key);
  }
}

// One-off helper kept for callers that do not need a pooled connection.
export async function rcon(host: string, port: number, password: string, commands: string[], timeoutMs = 4000): Promise<string[]> {
  const c = new RconConnection(host, port, password, timeoutMs);
  try {
    await c.open();
    const out: string[] = [];
    for (const cmd of commands) out.push(await c.command(cmd));
    return out;
  } finally {
    c.close();
  }
}

// Minecraft colour codes (§x) and terminal colours, removed.
export function plain(text: string): string {
  return text.replace(/§[0-9a-fk-orx]/gi, "").replace(/\x1b\[[0-9;]*m/g, "").trim();
}

// Paper: "TPS from last 1m, 5m, 15m: 20.0, 19.98, *20.0"
export function parseTps(text: string): [number, number, number] | null {
  const m = plain(text).match(/TPS from last 1m, 5m, 15m:\s*\*?([\d.]+),\s*\*?([\d.]+),\s*\*?([\d.]+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Paper: "... from last 5s, 10s, 1m: ◴ 0.1/0.0/0.3, ..." -> average tick time over the last 5 s, in ms.
export function parseMspt(text: string): number | null {
  const m = plain(text).match(/from last 5s, 10s, 1m:\s*\S*\s*([\d.]+)\/([\d.]+)\/([\d.]+)/);
  return m ? Number(m[1]) : null;
}

// Vanilla "list uuids": "There are 2 of a max of 20 players online: Steve (uuid), Alex (uuid)"
export function parseList(text: string): { online: number; max: number; players: { name: string; uuid: string | null }[] } | null {
  const t = plain(text);
  const head = t.match(/There are (\d+) (?:of a max of|out of maximum) (\d+) players online/);
  if (!head) return null;
  const rest = t.split(/players online:?/)[1] ?? "";
  const players = rest
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^(\S+)\s*\(([0-9a-f-]{36})\)$/i);
      return m ? { name: m[1]!, uuid: m[2]! } : { name: p, uuid: null };
    });
  return { online: Number(head[1]), max: Number(head[2]), players };
}
