import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { AgentClient } from "../agent/client.js";
import { seal } from "../auth/crypto.js";
import { schema, type Db } from "../db/index.js";
import { computeWarnings, sampleOnce, serverSeries, sparks, type WarningInput } from "./metrics.js";
import { Nodes } from "./nodes.js";

const GiB = 2 ** 30;
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);
const sample = (m: number, over: Partial<WarningInput["recent"][string][number]> = {}) => ({
  at: minsAgo(m),
  tps: 20,
  memBytes: GiB,
  memLimitBytes: 4 * GiB,
  restarts: 0,
  ...over,
});
const base = (over: Partial<WarningInput> = {}): WarningInput => ({
  servers: [{ id: "pw", name: "PW", status: { id: "pw", state: "running" } }],
  recent: { pw: [sample(0.5), sample(1), sample(1.5), sample(2)] },
  stoppedOnPurpose: new Set(),
  nodes: [],
  ...over,
});

describe("computeWarnings", () => {
  it("is quiet when all is well", () => {
    expect(computeWarnings(base())).toEqual([]);
  });

  it("flags a server that stopped by itself", () => {
    const w = computeWarnings(base({ servers: [{ id: "pw", name: "PW", status: { id: "pw", state: "stopped" } }] }));
    expect(w).toEqual([{ level: "bad", serverId: "pw", text: "PW stopped without anyone stopping it" }]);
  });

  it("stays quiet when someone stopped it on purpose", () => {
    const w = computeWarnings(base({ servers: [{ id: "pw", name: "PW", status: { id: "pw", state: "stopped" } }], stoppedOnPurpose: new Set(["pw"]) }));
    expect(w).toEqual([]);
  });

  it("flags a crash loop", () => {
    const w = computeWarnings(base({ recent: { pw: [sample(0.5, { restarts: 3 }), sample(5, { restarts: 0 })] } }));
    expect(w[0]).toMatchObject({ level: "bad", text: "PW crashed and restarted 3 times in 10 minutes" });
  });

  it("flags lag from the last 5 minutes only", () => {
    const lag = [sample(0.5, { tps: 9 }), sample(1, { tps: 9 }), sample(1.5, { tps: 9 }), sample(8, { tps: 20 })];
    expect(computeWarnings(base({ recent: { pw: lag } }))[0]).toMatchObject({ level: "bad", text: "PW is lagging: 9.0 TPS over 5 minutes" });
  });

  it("flags high RAM, full disk and an overbooked node", () => {
    const w = computeWarnings(
      base({
        recent: { pw: [sample(0.5, { memBytes: 3.8 * GiB })] },
        nodes: [{ id: "n1", name: "Node 1", memTotalBytes: 16 * GiB, memAllocatedBytes: 15 * GiB, diskTotalBytes: 100 * GiB, diskFreeBytes: 5 * GiB }],
      }),
    );
    expect(w.map((x) => x.text)).toEqual([
      "PW is using over 90% of its RAM",
      "Node 1 has less than 10% disk left",
      "Node 1 has promised over 90% of its RAM to servers",
    ]);
  });
});

describe("sampling and history", () => {
  it("samples running servers and averages them into points", async () => {
    const pg = new PGlite();
    const db = drizzle(pg, { schema }) as unknown as Db;
    await migrate(drizzle(pg), { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    await db.insert(schema.users).values({ id: "u", email: "u@example.com", passwordHash: "x", role: "admin" });
    await db.insert(schema.nodes).values({ id: "n1", name: "Node 1", agentUrl: "https://x", agentTokenEnc: seal("s".repeat(40), "t"), agentCaPem: "p", publicIp: "1.2.3.4", portMin: 1, portMax: 2 });
    for (const id of ["a", "b"]) {
      await db.insert(schema.servers).values({ id, name: id, nodeId: "n1", ownerId: "u", type: "PAPER", version: "1.21.4", memoryMb: 1024, cpus: 1, port: id === "a" ? 1 : 2, eulaAcceptedBy: "u", eulaAcceptedAt: new Date() });
    }
    const fake = {
      node: async () => ({ memoryBytes: 16 * GiB, cpus: 4, disk: { totalBytes: 100 * GiB, freeBytes: 90 * GiB }, servers: { total: 2, running: 1, allocatedMemoryBytes: 2 * GiB } }),
      list: async () => [{ id: "a", state: "running" }, { id: "b", state: "stopped" }],
      sample: async () => ({ cpuPercent: 12, memoryBytes: GiB, memoryLimitBytes: 2 * GiB, players: 3, tps: 19.5, msptAvg: 4, diskBytes: 5 * GiB, restartCount: 0 }),
    };
    const nodes = new Nodes(db, "s".repeat(40), () => fake as unknown as AgentClient);

    await sampleOnce(db, nodes);
    await sampleOnce(db, nodes);
    const rows = await db.select().from(schema.serverSamples);
    expect(rows.map((r) => r.serverId)).toEqual(["a", "a"]);
    expect((await db.select().from(schema.nodeSamples)).length).toBe(2);

    const series = await serverSeries(db, "a", "1h");
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ cpu: 12, players: 3, tps: 19.5, mspt: 4, memBytes: GiB, diskBytes: 5 * GiB });
    expect(await serverSeries(db, "b", "7d")).toEqual([]);

    expect(await sparks(db, ["a", "b"])).toEqual({ a: { cpu: [12], players: [3] } });

    // Old rows fall outside the range.
    await db.execute(sql`update server_samples set at = now() - interval '2 hours'`);
    expect(await serverSeries(db, "a", "1h")).toEqual([]);
    expect(await serverSeries(db, "a", "24h")).toHaveLength(1);
  });
});
