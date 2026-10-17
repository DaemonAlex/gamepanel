import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseList, parseMspt, parseTps, plain, rcon } from "./rcon.js";

// A tiny fake RCON server: password "pw", echoes commands.
let server: Server;
async function fake(): Promise<number> {
  server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0);
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.toString("utf8", 12, 4 + len - 2);
        buf = buf.subarray(4 + len);
        const reply = (rid: number, text: string) => {
          const p = Buffer.from(text);
          const out = Buffer.alloc(14 + p.length);
          out.writeInt32LE(10 + p.length, 0);
          out.writeInt32LE(rid, 4);
          out.writeInt32LE(type === 3 ? 2 : 0, 8);
          p.copy(out, 12);
          sock.write(out);
        };
        if (type === 3) reply(body === "pw" ? id : -1, "");
        else reply(id, `ran: ${body}`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

describe("rcon", () => {
  it("logs in and runs commands in order", async () => {
    const port = await fake();
    expect(await rcon("127.0.0.1", port, "pw", ["tps", "list"])).toEqual(["ran: tps", "ran: list"]);
  });

  it("fails on a wrong password", async () => {
    const port = await fake();
    await expect(rcon("127.0.0.1", port, "nope", ["tps"], 500)).rejects.toThrow(/login failed/);
  });
});

describe("parsers", () => {
  it("strips colours", () => {
    expect(plain("§6TPS: §a20.0\x1b[0m")).toBe("TPS: 20.0");
  });

  it("reads Paper TPS", () => {
    expect(parseTps("§6TPS from last 1m, 5m, 15m: §a20.0, §a19.98, §a*20.0")).toEqual([20, 19.98, 20]);
    expect(parseTps("Unknown command")).toBeNull();
  });

  it("reads Paper tick time", () => {
    const text = "\x1b[33mServer tick times (avg/min/max) from last 5s, 10s, 1m:\n◴ 0.1/0.0/0.3, 0.1/0.0/0.3, 0.1/0.0/0.7";
    expect(parseMspt(text)).toBe(0.1);
  });

  it("reads the player list with ids", () => {
    const t = "There are 2 of a max of 20 players online: Steve (069a79f4-44e9-4726-a5be-fca90e38aaf5), Alex (853c80ef-3c37-49fd-aa49-938b674adae6)";
    expect(parseList(t)).toEqual({
      online: 2,
      max: 20,
      players: [
        { name: "Steve", uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5" },
        { name: "Alex", uuid: "853c80ef-3c37-49fd-aa49-938b674adae6" },
      ],
    });
    expect(parseList("There are 0 of a max of 20 players online:")).toEqual({ online: 0, max: 20, players: [] });
  });
});
