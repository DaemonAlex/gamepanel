import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { ConflictError, type Servers } from "./servers.js";

const token = "t".repeat(40);
const auth = { authorization: `Bearer ${token}` };
const spec = { id: "homeworld", type: "PAPER", version: "1.21.1", memoryMb: 4096, cpus: 2, port: 25565, eulaAccepted: true };

// A stand-in for the Docker side, so these tests check only the HTTP rules.
const fake = {
  status: vi.fn(async (id: string) => ({ id, state: "stopped" })),
  apply: vi.fn(async (s: { id: string }) => {
    if (s.id === "busy") throw new ConflictError("stop the server before changing it");
    return { id: s.id, state: "created" };
  }),
  power: vi.fn(async (id: string) => ({ id, state: "running" })),
  removeContainer: vi.fn(async () => {}),
  sendCommand: vi.fn(async () => {}),
};

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp(token, fake as unknown as Servers);
});
afterAll(() => app.close());

describe("agent API", () => {
  it("refuses a request without the token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a wrong token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health", headers: { authorization: "Bearer nope" } });
    expect(res.statusCode).toBe(401);
  });

  it("answers health with the token", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health", headers: auth });
    expect(res.json()).toEqual({ ok: true });
  });

  it("refuses a bad server id before touching Docker", async () => {
    fake.status.mockClear();
    const res = await app.inject({ method: "GET", url: "/v1/servers/..%2Fetc", headers: auth });
    expect(res.statusCode).toBe(400);
    expect(fake.status).not.toHaveBeenCalled();
  });

  it("creates a server from a valid spec", async () => {
    const res = await app.inject({ method: "PUT", url: "/v1/servers/homeworld", headers: auth, payload: spec });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "homeworld", state: "created" });
  });

  it("refuses a spec without the EULA accepted", async () => {
    const res = await app.inject({ method: "PUT", url: "/v1/servers/homeworld", headers: auth, payload: { ...spec, eulaAccepted: false } });
    expect(res.statusCode).toBe(400);
  });

  it("refuses when the path and body ids differ", async () => {
    const res = await app.inject({ method: "PUT", url: "/v1/servers/other", headers: auth, payload: spec });
    expect(res.statusCode).toBe(400);
  });

  it("answers 409 when the server must be stopped first", async () => {
    const res = await app.inject({ method: "PUT", url: "/v1/servers/busy", headers: auth, payload: { ...spec, id: "busy" } });
    expect(res.statusCode).toBe(409);
  });

  it("passes a power action through", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/servers/homeworld/power", headers: auth, payload: { action: "start" } });
    expect(res.statusCode).toBe(200);
    expect(fake.power).toHaveBeenCalledWith("homeworld", "start");
  });

  it("refuses an unknown power action", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/servers/homeworld/power", headers: auth, payload: { action: "explode" } });
    expect(res.statusCode).toBe(400);
  });

  it("sends one command over HTTP", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/servers/homeworld/command", headers: auth, payload: { cmd: "say hi" } });
    expect(res.statusCode).toBe(204);
    expect(fake.sendCommand).toHaveBeenCalledWith("homeworld", "say hi");
  });

  it("refuses a command with a newline over HTTP too", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/servers/homeworld/command", headers: auth, payload: { cmd: "say a\nop x" } });
    expect(res.statusCode).toBe(400);
  });
});
