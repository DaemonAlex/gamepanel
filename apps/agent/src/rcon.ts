import { connect, type Socket } from "node:net";

// A small RCON client (Source RCON protocol, which Minecraft uses).
// RCON is only reached on the game network from the node; it is never published.

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

// Run commands on one connection and return each answer as text.
export async function rcon(host: string, port: number, password: string, commands: string[], timeoutMs = 4000): Promise<string[]> {
  const socket: Socket = connect({ host, port });
  socket.setTimeout(timeoutMs);
  let buffer = Buffer.alloc(0);
  const waiting = new Map<number, (body: string) => void>();
  let failed: Error | null = null;

  const fail = (err: Error) => {
    failed = err;
    for (const resolve of waiting.values()) resolve("");
    socket.destroy();
  };
  socket.on("timeout", () => fail(new Error("rcon timed out")));
  socket.on("error", fail);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readInt32LE(0);
      if (len < 10 || len > 1 << 20) return fail(new Error("bad rcon packet"));
      if (buffer.length < 4 + len) break;
      const id = buffer.readInt32LE(4);
      const body = buffer.toString("utf8", 12, 4 + len - 2);
      buffer = buffer.subarray(4 + len);
      waiting.get(id)?.(body);
      waiting.delete(id);
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const send = (id: number, type: number, body: string) =>
    new Promise<string>((resolve) => {
      waiting.set(id, resolve);
      socket.write(packet(id, type, body));
    });

  try {
    // A failed login answers with id -1, so our id never comes back: treat silence as failure.
    const authId = 1;
    const authed = await Promise.race([send(authId, AUTH, password).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs))]);
    if (!authed || failed) throw failed ?? new Error("rcon login failed");
    const out: string[] = [];
    let id = 10;
    for (const cmd of commands) {
      out.push(await send(id++, COMMAND, cmd));
      if (failed) throw failed;
    }
    return out;
  } finally {
    socket.destroy();
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
