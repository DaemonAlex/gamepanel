import { eq } from "drizzle-orm";
import type { ScheduleInput } from "@gamepanel/shared";
import type { AgentClient } from "../agent/client.js";
import { schema, type Db } from "../db/index.js";
import { audit } from "./audit.js";
import type { Nodes } from "./nodes.js";

// Scheduled backups, restarts, saves, commands and messages. The panel checks
// every 30 seconds which schedules are due and runs them on the server's node.

type Row = typeof schema.schedules.$inferSelect;
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Weekday and HH:MM of a moment, in a time zone.
export function localParts(at: Date, tz: string): { day: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: DAY.indexOf(get("weekday")), hhmm: `${get("hour")}:${get("minute")}` };
}

type Due = Pick<ScheduleInput, "kind" | "minutes" | "time" | "days" | "tz" | "enabled"> & { lastRunAt: Date | null };

export function isDue(s: Due, now: Date): boolean {
  if (!s.enabled) return false;
  if (s.kind === "interval") return !s.lastRunAt || now.getTime() - s.lastRunAt.getTime() >= s.minutes * 60_000;
  const p = localParts(now, s.tz);
  // Within the same minute only once: a run in the last two minutes counts.
  const ranRecently = s.lastRunAt && now.getTime() - s.lastRunAt.getTime() < 120_000;
  return p.hhmm === s.time && s.days.includes(p.day) && !ranRecently;
}

const RESTART_WARNING_MS = 60_000;

// Do one schedule now. Returns a short line for "last result".
export async function runSchedule(s: Row, client: AgentClient, keep: number, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<string> {
  const status = await client.status(s.serverId);
  const running = status.state === "running";
  switch (s.action) {
    case "backup": {
      const job = await client.startBackup(s.serverId, "schedule", keep);
      return `backup started (${job.id.slice(0, 8)})`;
    }
    case "restart":
      if (!running) return "skipped: server was stopped";
      await client.command(s.serverId, "say Scheduled restart in 1 minute");
      await wait(RESTART_WARNING_MS);
      await client.power(s.serverId, "restart");
      return "restarted";
    case "save":
      if (!running) return "skipped: server was stopped";
      await client.command(s.serverId, "save-all");
      return "saved";
    case "command":
      if (!running) return "skipped: server was stopped";
      await client.command(s.serverId, s.payload.replace(/^\//, ""));
      return "command sent";
    case "message":
      if (!running) return "skipped: server was stopped";
      await client.command(s.serverId, `say ${s.payload}`);
      return "message sent";
    default:
      return "unknown action";
  }
}

export async function tickSchedules(db: Db, nodes: Nodes, now = new Date()): Promise<void> {
  const rows = await db
    .select({ s: schema.schedules, nodeId: schema.servers.nodeId, keep: schema.servers.backupKeep })
    .from(schema.schedules)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.schedules.serverId))
    .where(eq(schema.schedules.enabled, true));
  for (const { s, nodeId, keep } of rows) {
    if (!isDue({ ...s, kind: s.kind as Due["kind"] }, now)) continue;
    // Mark first, so a slow run is never started twice.
    await db.update(schema.schedules).set({ lastRunAt: now, lastResult: "running" }).where(eq(schema.schedules.id, s.id));
    const node = await nodes.get(nodeId);
    if (!node) continue;
    // Each run goes on in the background (a restart waits a minute after its warning).
    void runSchedule(s, nodes.client(node), keep)
      .catch((err: Error) => `failed: ${err.message}`)
      .then(async (result) => {
        await db.update(schema.schedules).set({ lastResult: result }).where(eq(schema.schedules.id, s.id));
        await audit(db, { userId: null, action: `schedule.${s.action}`, serverId: s.serverId, detail: { schedule: s.id, result } });
      });
  }
}

export function startScheduler(db: Db, nodes: Nodes, log: (err: unknown) => void): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    tickSchedules(db, nodes)
      .catch(log)
      .finally(() => (busy = false));
  }, 30_000);
  return () => clearInterval(timer);
}
