import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it, vi } from "vitest";
import type { AgentClient } from "../agent/client.js";
import { seal } from "../auth/crypto.js";
import { schema, type Db } from "../db/index.js";
import { Nodes } from "./nodes.js";
import { isDue, localParts, runSchedule, tickSchedules } from "./schedules.js";

const daily = { kind: "daily" as const, minutes: 60, time: "04:00", days: [0, 1, 2, 3, 4, 5, 6], tz: "America/New_York", enabled: true, lastRunAt: null };

describe("isDue", () => {
  // 2026-10-17 08:00 UTC is 04:00 in New York (EDT), a Saturday.
  const at4am = new Date("2026-10-17T08:00:20Z");

  it("reads local time in the server's time zone", () => {
    expect(localParts(at4am, "America/New_York")).toEqual({ day: 6, hhmm: "04:00" });
    expect(localParts(at4am, "UTC")).toEqual({ day: 6, hhmm: "08:00" });
  });

  it("runs daily at the set time on chosen days", () => {
    expect(isDue(daily, at4am)).toBe(true);
    expect(isDue({ ...daily, days: [1, 2, 3, 4, 5] }, at4am)).toBe(false);
    expect(isDue(daily, new Date("2026-10-17T08:01:00Z"))).toBe(false);
  });

  it("does not run twice in the same minute", () => {
    expect(isDue({ ...daily, lastRunAt: new Date("2026-10-17T08:00:00Z") }, at4am)).toBe(false);
  });

  it("runs on an interval", () => {
    const every = { ...daily, kind: "interval" as const, minutes: 30 };
    expect(isDue(every, at4am)).toBe(true);
    expect(isDue({ ...every, lastRunAt: new Date(at4am.getTime() - 29 * 60_000) }, at4am)).toBe(false);
    expect(isDue({ ...every, lastRunAt: new Date(at4am.getTime() - 30 * 60_000) }, at4am)).toBe(true);
  });

  it("never runs when off", () => {
    expect(isDue({ ...daily, enabled: false }, at4am)).toBe(false);
  });
});

function fakeClient(state: "running" | "stopped") {
  return {
    status: vi.fn(async (id: string) => ({ id, state })),
    command: vi.fn(async () => {}),
    power: vi.fn(async () => ({ id: "pw", state: "running" })),
    startBackup: vi.fn(async () => ({ id: "job-12345678" })),
  };
}
const row = (action: string, payload = "") =>
  ({ id: "s1", serverId: "pw", action, payload, kind: "interval", minutes: 60, time: "04:00", days: [0], tz: "UTC", enabled: true, lastRunAt: null, lastResult: null, createdAt: new Date() }) as never;

describe("runSchedule", () => {
  it("warns players, waits, then restarts", async () => {
    const c = fakeClient("running");
    const wait = vi.fn(async () => {});
    expect(await runSchedule(row("restart"), c as unknown as AgentClient, 7, wait)).toBe("restarted");
    expect(c.command).toHaveBeenCalledWith("pw", "say Scheduled restart in 1 minute");
    expect(wait).toHaveBeenCalledWith(60_000);
    expect(c.power).toHaveBeenCalledWith("pw", "restart");
  });

  it("skips actions that need a running server", async () => {
    const c = fakeClient("stopped");
    for (const a of ["restart", "save", "command", "message"]) {
      expect(await runSchedule(row(a, "x"), c as unknown as AgentClient, 7)).toMatch(/skipped/);
    }
    expect(c.command).not.toHaveBeenCalled();
  });

  it("backs up even when stopped, with the keep count", async () => {
    const c = fakeClient("stopped");
    expect(await runSchedule(row("backup"), c as unknown as AgentClient, 5)).toMatch(/backup started/);
    expect(c.startBackup).toHaveBeenCalledWith("pw", "schedule", 5);
  });

  it("sends messages and commands", async () => {
    const c = fakeClient("running");
    await runSchedule(row("message", "Vote for the next build!"), c as unknown as AgentClient, 7);
    await runSchedule(row("command", "/time set day"), c as unknown as AgentClient, 7);
    expect(c.command.mock.calls.map((x) => x[1])).toEqual(["say Vote for the next build!", "time set day"]);
  });
});

describe("tickSchedules", () => {
  it("runs a due schedule once and records the result", async () => {
    const pg = new PGlite();
    const db = drizzle(pg, { schema }) as unknown as Db;
    await migrate(drizzle(pg), { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
    await db.insert(schema.users).values({ id: "u", email: "u@example.com", passwordHash: "x", role: "admin" });
    await db.insert(schema.nodes).values({ id: "n1", name: "N", agentUrl: "https://x", agentTokenEnc: seal("s".repeat(40), "t"), agentCaPem: "p", publicIp: "1.2.3.4", portMin: 1, portMax: 2 });
    await db.insert(schema.servers).values({ id: "pw", name: "PW", nodeId: "n1", ownerId: "u", type: "PAPER", version: "1.21.4", memoryMb: 1024, cpus: 1, port: 1, eulaAcceptedBy: "u", eulaAcceptedAt: new Date(), backupKeep: 3 });
    await db.insert(schema.schedules).values({ id: "s1", serverId: "pw", action: "backup", kind: "interval", minutes: 60, days: [0], tz: "UTC" });
    const c = fakeClient("running");
    const nodes = new Nodes(db, "s".repeat(40), () => c as unknown as AgentClient);

    await tickSchedules(db, nodes);
    await tickSchedules(db, nodes);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.startBackup).toHaveBeenCalledTimes(1);
    expect(c.startBackup).toHaveBeenCalledWith("pw", "schedule", 3);
    const [s] = await db.select().from(schema.schedules);
    expect(s!.lastResult).toMatch(/backup started/);
    expect(s!.lastRunAt).not.toBeNull();
  });
});
