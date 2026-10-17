import { and, desc, gt, inArray, lt, sql } from "drizzle-orm";
import type { MetricPoint, MetricRange, NodeMetricPoint, ServerStatus, Warning } from "@gamepanel/shared";
import { schema, type Db } from "../db/index.js";
import type { Nodes } from "./nodes.js";

// History for graphs and warnings: the panel samples every running server and
// every node every 30 seconds and keeps 8 days.

export const SAMPLE_MS = 30_000;
const KEEP_DAYS = 8;

// Range shown -> how far back and how wide each averaged point is.
const RANGES: Record<MetricRange, { back: string; step: string }> = {
  "1h": { back: "1 hour", step: "1 minute" },
  "24h": { back: "24 hours", step: "15 minutes" },
  "7d": { back: "7 days", step: "1 hour" },
};

export async function sampleOnce(db: Db, nodes: Nodes): Promise<void> {
  const servers = await db.select({ id: schema.servers.id, nodeId: schema.servers.nodeId }).from(schema.servers);
  for (const node of await nodes.all()) {
    const client = nodes.client(node);
    try {
      const info = await client.node();
      await db.insert(schema.nodeSamples).values({
        nodeId: node.id,
        memTotalBytes: info.memoryBytes,
        memAllocatedBytes: info.servers.allocatedMemoryBytes,
        diskTotalBytes: info.disk.totalBytes,
        diskFreeBytes: info.disk.freeBytes,
        running: info.servers.running,
      });
      const statuses = await client.list();
      const running = new Set(statuses.filter((s) => s.state === "running").map((s) => s.id));
      for (const s of servers.filter((x) => x.nodeId === node.id && running.has(x.id))) {
        try {
          const v = await client.sample(s.id);
          await db.insert(schema.serverSamples).values({
            serverId: s.id,
            cpu: v.cpuPercent,
            memBytes: v.memoryBytes,
            memLimitBytes: v.memoryLimitBytes,
            players: v.players,
            tps: v.tps,
            mspt: v.msptAvg,
            diskBytes: v.diskBytes,
            restarts: v.restartCount,
          });
        } catch {
          // One server failing to answer must not stop the rest.
        }
      }
    } catch {
      // Node unreachable: the gap in the graph shows it.
    }
  }
}

export async function prune(db: Db): Promise<void> {
  const cutoff = sql`now() - ${`${KEEP_DAYS} days`}::interval`;
  await db.delete(schema.serverSamples).where(lt(schema.serverSamples.at, cutoff));
  await db.delete(schema.nodeSamples).where(lt(schema.nodeSamples.at, cutoff));
}

// Runs in the background; a slow round is never overlapped by the next one.
export function startSampler(db: Db, nodes: Nodes, log: (err: unknown) => void): () => void {
  let busy = false;
  let rounds = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await sampleOnce(db, nodes);
      if (++rounds % 120 === 1) await prune(db);
    } catch (err) {
      log(err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), SAMPLE_MS);
  void tick();
  return () => clearInterval(timer);
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function serverSeries(db: Db, serverId: string, range: MetricRange): Promise<MetricPoint[]> {
  const r = RANGES[range];
  const rows = await db.execute(sql`
    select date_bin(${r.step}::interval, at, timestamptz '2000-01-01') as t,
           avg(cpu) as cpu, avg(mem_bytes) as mem, max(mem_limit_bytes) as lim, max(players) as players,
           avg(tps) as tps, avg(mspt) as mspt, max(disk_bytes) as disk
    from server_samples
    where server_id = ${serverId} and at > now() - ${r.back}::interval
    group by 1 order by 1`);
  return (rows as unknown as { rows?: Record<string, unknown>[] }).rows?.map(toPoint) ?? (rows as unknown as Record<string, unknown>[]).map(toPoint);
}

function toPoint(r: Record<string, unknown>): MetricPoint {
  return {
    t: new Date(r.t as string).toISOString(),
    cpu: Math.round(Number(r.cpu) * 10) / 10,
    memBytes: Math.round(Number(r.mem)),
    memLimitBytes: Number(r.lim),
    players: num(r.players),
    tps: r.tps === null ? null : Math.round(Number(r.tps) * 100) / 100,
    mspt: r.mspt === null ? null : Math.round(Number(r.mspt) * 10) / 10,
    diskBytes: Number(r.disk),
  };
}

export async function nodeSeries(db: Db, nodeId: string, range: MetricRange): Promise<NodeMetricPoint[]> {
  const r = RANGES[range];
  const rows = await db.execute(sql`
    select date_bin(${r.step}::interval, at, timestamptz '2000-01-01') as t,
           avg(mem_allocated_bytes) as alloc, max(mem_total_bytes) as total,
           avg(disk_total_bytes - disk_free_bytes) as used, max(disk_total_bytes) as dtotal, max(running) as running
    from node_samples
    where node_id = ${nodeId} and at > now() - ${r.back}::interval
    group by 1 order by 1`);
  const list = (rows as unknown as { rows?: Record<string, unknown>[] }).rows ?? (rows as unknown as Record<string, unknown>[]);
  return list.map((x) => ({
    t: new Date(x.t as string).toISOString(),
    memAllocatedBytes: Math.round(Number(x.alloc)),
    memTotalBytes: Number(x.total),
    diskUsedBytes: Math.round(Number(x.used)),
    diskTotalBytes: Number(x.dtotal),
    running: Number(x.running),
  }));
}

// Last hour per server, one point a minute: CPU and players.
export async function sparks(db: Db, serverIds: string[]): Promise<Record<string, { cpu: number[]; players: number[] }>> {
  if (!serverIds.length) return {};
  const rows = await db
    .select({
      id: schema.serverSamples.serverId,
      t: sql<string>`date_bin('1 minute'::interval, ${schema.serverSamples.at}, timestamptz '2000-01-01')`,
      cpu: sql<number>`avg(${schema.serverSamples.cpu})`,
      players: sql<number>`max(${schema.serverSamples.players})`,
    })
    .from(schema.serverSamples)
    .where(and(inArray(schema.serverSamples.serverId, serverIds), gt(schema.serverSamples.at, sql`now() - interval '1 hour'`)))
    .groupBy(schema.serverSamples.serverId, sql`2`)
    .orderBy(sql`2`);
  const out: Record<string, { cpu: number[]; players: number[] }> = {};
  for (const r of rows) {
    const s = (out[r.id] ??= { cpu: [], players: [] });
    s.cpu.push(Math.round(Number(r.cpu) * 10) / 10);
    s.players.push(Number(r.players ?? 0));
  }
  return out;
}

// --- warnings ------------------------------------------------------------------

export interface WarningInput {
  servers: { id: string; name: string; status: ServerStatus | null }[];
  // Samples from the last 10 minutes, newest first, per server.
  recent: Record<string, { at: Date; tps: number | null; memBytes: number; memLimitBytes: number; restarts: number }[]>;
  // Servers someone stopped on purpose in the last 10 minutes.
  stoppedOnPurpose: Set<string>;
  nodes: { id: string; name: string; memTotalBytes: number; memAllocatedBytes: number; diskTotalBytes: number; diskFreeBytes: number }[];
}

// Pure, so every rule can be tested on its own.
export function computeWarnings(input: WarningInput): Warning[] {
  const out: Warning[] = [];
  const now = Date.now();
  for (const s of input.servers) {
    const recent = input.recent[s.id] ?? [];
    const state = s.status?.state;
    const running = state === "running" || state === "starting";
    const wasRunning = recent.some((r) => now - r.at.getTime() < 10 * 60_000);
    if (!running && wasRunning && !input.stoppedOnPurpose.has(s.id)) {
      out.push({ level: "bad", serverId: s.id, text: `${s.name} stopped without anyone stopping it` });
    }
    if (recent.length >= 2) {
      const restarts = recent[0]!.restarts - recent[recent.length - 1]!.restarts;
      if (restarts > 0) {
        out.push({ level: restarts >= 3 ? "bad" : "warn", serverId: s.id, text: `${s.name} crashed and restarted ${restarts} time${restarts > 1 ? "s" : ""} in 10 minutes` });
      }
    }
    const last5 = recent.filter((r) => now - r.at.getTime() < 5 * 60_000 && r.tps !== null);
    if (running && last5.length >= 3) {
      const avg = last5.reduce((n, r) => n + (r.tps ?? 0), 0) / last5.length;
      if (avg < 15) out.push({ level: avg < 10 ? "bad" : "warn", serverId: s.id, text: `${s.name} is lagging: ${avg.toFixed(1)} TPS over 5 minutes` });
    }
    const latest = recent[0];
    if (running && latest && latest.memLimitBytes > 0 && latest.memBytes / latest.memLimitBytes > 0.9) {
      out.push({ level: "warn", serverId: s.id, text: `${s.name} is using over 90% of its RAM` });
    }
  }
  for (const n of input.nodes) {
    if (n.diskTotalBytes > 0 && n.diskFreeBytes / n.diskTotalBytes < 0.1) {
      out.push({ level: "bad", nodeId: n.id, text: `${n.name} has less than 10% disk left` });
    }
    if (n.memTotalBytes > 0 && n.memAllocatedBytes / n.memTotalBytes > 0.9) {
      out.push({ level: "warn", nodeId: n.id, text: `${n.name} has promised over 90% of its RAM to servers` });
    }
  }
  return out;
}

// Gather what computeWarnings needs from the database.
export async function warningInput(db: Db, servers: WarningInput["servers"]): Promise<Omit<WarningInput, "servers">> {
  const ids = servers.map((s) => s.id);
  const since = sql`now() - interval '10 minutes'`;
  const rows = ids.length
    ? await db
        .select()
        .from(schema.serverSamples)
        .where(and(inArray(schema.serverSamples.serverId, ids), gt(schema.serverSamples.at, since)))
        .orderBy(desc(schema.serverSamples.at))
    : [];
  const recent: WarningInput["recent"] = {};
  for (const r of rows) (recent[r.serverId] ??= []).push({ at: r.at, tps: r.tps, memBytes: r.memBytes, memLimitBytes: r.memLimitBytes, restarts: r.restarts });

  const stops = ids.length
    ? await db
        .select({ serverId: schema.auditLog.serverId, action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(and(gt(schema.auditLog.at, since), inArray(schema.auditLog.action, ["server.stop", "server.kill", "server.restart", "server.stop-all", "server.kill-all", "server.restart-all"])))
    : [];
  const anyAll = stops.some((x) => x.action.endsWith("-all"));
  const stoppedOnPurpose = new Set(anyAll ? ids : stops.map((x) => x.serverId).filter((x): x is string => !!x));

  const latestNodes = await db.execute(sql`
    select distinct on (ns.node_id) ns.node_id, n.name, ns.mem_total_bytes, ns.mem_allocated_bytes, ns.disk_total_bytes, ns.disk_free_bytes
    from node_samples ns join nodes n on n.id = ns.node_id
    where ns.at > now() - interval '5 minutes'
    order by ns.node_id, ns.at desc`);
  const list = (latestNodes as unknown as { rows?: Record<string, unknown>[] }).rows ?? (latestNodes as unknown as Record<string, unknown>[]);
  const nodes = list.map((r) => ({
    id: String(r.node_id),
    name: String(r.name),
    memTotalBytes: Number(r.mem_total_bytes),
    memAllocatedBytes: Number(r.mem_allocated_bytes),
    diskTotalBytes: Number(r.disk_total_bytes),
    diskFreeBytes: Number(r.disk_free_bytes),
  }));
  return { recent, stoppedOnPurpose, nodes };
}

