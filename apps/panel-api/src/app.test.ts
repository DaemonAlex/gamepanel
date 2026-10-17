import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addressFor, buildApp, slugify } from "./app.js";
import type { AgentClient } from "./agent/client.js";
import { hashPassword, seal } from "./auth/crypto.js";
import { schema, type Db } from "./db/index.js";
import { containerBytesFor, memoryFits, nextFreePort } from "./services/allocation.js";
import { Nodes } from "./services/nodes.js";

const SECRET = "s".repeat(40);
const GiB = 2 ** 30;

function fakeAgent(memoryBytes = 16 * GiB) {
  const created: string[] = [];
  return {
    created,
    fail: false,
    node: vi.fn(async () => ({ memoryBytes, cpus: 4, disk: { totalBytes: 100 * GiB, freeBytes: 90 * GiB }, servers: { total: created.length, running: 0, allocatedMemoryBytes: 0 } })),
    list: vi.fn(async () => created.map((id) => ({ id, state: "running" }))),
    stats: vi.fn(async () => ({ cpuPercent: 1, memoryBytes: GiB, memoryLimitBytes: 2 * GiB, players: { online: 0, max: 20, names: [] }, version: "Paper" })),
    async apply(spec: { id: string }) {
      if (this.fail) throw new Error("agent down");
      created.push(spec.id);
      return { id: spec.id, state: "created" };
    },
    power: vi.fn(async (id: string) => ({ id, state: "running" })),
    command: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

let app: FastifyInstance;
let db: Db;
let agent: ReturnType<typeof fakeAgent>;
const H = { "x-gamepanel": "1" };

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  expect(res.statusCode).toBe(200);
  const c = res.cookies.find((x) => x.name === "gp_session")!;
  expect(c.httpOnly).toBe(true);
  expect(c.sameSite).toBe("Strict");
  return `gp_session=${c.value}`;
}

async function setup(memoryBytes?: number) {
  const pg = new PGlite();
  db = drizzle(pg, { schema }) as unknown as Db;
  await migrate(drizzle(pg), { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  agent = fakeAgent(memoryBytes);
  const nodes = new Nodes(db, SECRET, () => agent as unknown as AgentClient);
  app = await buildApp({ cfg: { cookieSecure: true, webDist: null, serverDomain: "mc.example.com" }, db, nodes });
  await db.insert(schema.users).values([
    { id: "admin", email: "admin@example.com", passwordHash: await hashPassword("admin-pass"), role: "admin" },
    { id: "bob", email: "bob@example.com", passwordHash: await hashPassword("bob-pass"), role: "owner" },
  ]);
  await db.insert(schema.nodes).values({
    id: "node1", name: "Node 1", agentUrl: "https://10.0.0.1:8443", agentTokenEnc: seal(SECRET, "tok"), agentCaPem: "pem",
    publicIp: "203.0.113.5", portMin: 25566, portMax: 25568,
  });
  await db.insert(schema.servers).values({
    id: "pw", name: "Perpetual Wonders", nodeId: "node1", ownerId: "admin", type: "PAPER", version: "1.21.4",
    memoryMb: 6144, cpus: 4, port: 25565, hostname: "pw.mc.example.com", eulaAcceptedBy: "admin", eulaAcceptedAt: new Date(),
  });
  agent.created.push("pw");
}

const newServer = { name: "Survival Two", type: "PAPER", version: "1.21.4", memoryMb: 2048, cpus: 2, eulaAccepted: true };

describe("panel API", () => {
  beforeEach(() => setup());

  it("refuses the dashboard without a login", async () => {
    expect((await app.inject({ url: "/api/dashboard" })).statusCode).toBe(401);
  });

  it("refuses a wrong password and logs the attempt", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@example.com", password: "nope" } });
    expect(res.statusCode).toBe(401);
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "login.failed"));
    expect(rows).toHaveLength(1);
  });

  it("limits login attempts per address", async () => {
    const codes = [];
    for (let i = 0; i < 7; i++) {
      codes.push((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "x@example.com", password: "x" } })).statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it("shows an admin every server, with its address and node totals", async () => {
    const cookie = await login("admin@example.com", "admin-pass");
    const res = await app.inject({ url: "/api/dashboard", headers: { cookie } });
    const body = res.json();
    expect(body.servers.map((s: { id: string }) => s.id)).toEqual(["pw"]);
    expect(body.servers[0].address).toBe("pw.mc.example.com");
    expect(body.servers[0].stats.players.max).toBe(20);
    expect(body.nodes[0].info.cpus).toBe(4);
  });

  it("hides other people's servers from an owner", async () => {
    const cookie = await login("bob@example.com", "bob-pass");
    const res = await app.inject({ url: "/api/dashboard", headers: { cookie } });
    expect(res.json().servers).toEqual([]);
    expect(res.json().nodes).toBeNull();
    expect((await app.inject({ url: "/api/servers/pw", headers: { cookie } })).statusCode).toBe(404);
    const power = await app.inject({ method: "POST", url: "/api/servers/pw/power", headers: { cookie, ...H }, payload: { action: "stop" } });
    expect(power.statusCode).toBe(404);
    expect(agent.power).not.toHaveBeenCalled();
  });

  it("refuses a state change without the panel's request header", async () => {
    const cookie = await login("admin@example.com", "admin-pass");
    const res = await app.inject({ method: "POST", url: "/api/servers/pw/power", headers: { cookie }, payload: { action: "stop" } });
    expect(res.statusCode).toBe(403);
  });

  it("creates a server on the next free port and starts it", async () => {
    const cookie = await login("admin@example.com", "admin-pass");
    const res = await app.inject({ method: "POST", url: "/api/servers", headers: { cookie, ...H }, payload: newServer });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: "survival-two", port: 25566, address: "203.0.113.5:25566" });
    expect(agent.power).toHaveBeenCalledWith("survival-two", "start");
    const second = await app.inject({ method: "POST", url: "/api/servers", headers: { cookie, ...H }, payload: { ...newServer, name: "Creative" } });
    expect(second.json().port).toBe(25567);
  });

  it("refuses a server without the EULA ticked", async () => {
    const cookie = await login("admin@example.com", "admin-pass");
    const res = await app.inject({ method: "POST", url: "/api/servers", headers: { cookie, ...H }, payload: { ...newServer, eulaAccepted: false } });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a duplicate name", async () => {
    const cookie = await login("admin@example.com", "admin-pass");
    const res = await app.inject({ method: "POST", url: "/api/servers", headers: { cookie, ...H }, payload: { ...newServer, name: "PW" } });
    expect(res.statusCode).toBe(409);
  });

  it("only lets admins create servers for now", async () => {
    const cookie = await login("bob@example.com", "bob-pass");
    const res = await app.inject({ method: "POST", url: "/api/servers", headers: { cookie, ...H }, payload: newServer });
    expect(res.statusCode).toBe(403);
  });

  it("removes the row again when the node fails to create the server", async () => {
    const cookie = await login("admin@example.com", "admin-pass");
    agent.fail = true;
    const res = await app.inject({ method: "POST", url: "/api/servers", headers: { cookie, ...H }, payload: newServer });
    expect(res.statusCode).toBe(500);
    expect(await db.select().from(schema.servers).where(eq(schema.servers.id, "survival-two"))).toEqual([]);
  });

  it("refuses a server that does not fit in the node's RAM", async () => {
    await setup(4 * GiB);
    const cookie = await login("admin@example.com", "admin-pass");
    const res = await app.inject({ method: "POST", url: "/api/servers", headers: { cookie, ...H }, payload: newServer });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/RAM/);
  });

  it("broadcasts to running servers", async () => {
    const cookie = await login("admin@example.com", "admin-pass");
    const res = await app.inject({ method: "POST", url: "/api/servers/broadcast", headers: { cookie, ...H }, payload: { message: "restart in 5" } });
    expect(res.json().results).toEqual([{ id: "pw", ok: true }]);
    expect(agent.command).toHaveBeenCalledWith("pw", "say restart in 5");
  });

  it("changes the password and logs out other sessions", async () => {
    const other = await login("admin@example.com", "admin-pass");
    const cookie = await login("admin@example.com", "admin-pass");
    const wrong = await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie, ...H }, payload: { current: "nope", next: "a-long-new-password" } });
    expect(wrong.statusCode).toBe(403);
    const short = await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie, ...H }, payload: { current: "admin-pass", next: "short" } });
    expect(short.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/api/auth/password", headers: { cookie, ...H }, payload: { current: "admin-pass", next: "a-long-new-password" } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/me", headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/me", headers: { cookie: other } })).statusCode).toBe(401);
    await login("admin@example.com", "a-long-new-password");
  });

  it("logs out", async () => {
    const cookie = await login("admin@example.com", "admin-pass");
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, ...H } });
    expect((await app.inject({ url: "/api/me", headers: { cookie } })).statusCode).toBe(401);
  });
});

describe("helpers", () => {
  it("makes DNS-safe ids", () => {
    expect(slugify("Perpetual Wonders")).toBe("perpetual-wonders");
    expect(slugify("  PW_ !! ")).toBe("pw");
    expect(slugify("!!!")).toBe("");
  });

  it("shows the address players type", () => {
    expect(addressFor({ hostname: "pw.mc.x.com", port: 25565 }, "1.2.3.4")).toBe("pw.mc.x.com");
    expect(addressFor({ hostname: null, port: 25570 }, "1.2.3.4")).toBe("1.2.3.4:25570");
  });

  it("picks the lowest free port", () => {
    expect(nextFreePort({ min: 25566, max: 25568 }, [25566, 25568])).toBe(25567);
    expect(nextFreePort({ min: 25566, max: 25567 }, [25566, 25567])).toBeNull();
  });

  it("keeps the node's reserve free", () => {
    expect(memoryFits(16 * GiB, 8 * GiB, 2048, containerBytesFor(4096))).toBe(true);
    expect(memoryFits(16 * GiB, 8 * GiB, 2048, containerBytesFor(8192))).toBe(false);
  });
});
