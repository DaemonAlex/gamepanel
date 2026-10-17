import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { and, eq, gt, ne } from "drizzle-orm";
import { ZodError } from "zod";
import {
  broadcastSchema,
  changePasswordSchema,
  consoleInSchema,
  loginSchema,
  newServerSchema,
  powerBodySchema,
  type Dashboard,
  type Me,
  type NodeView,
  type ServerView,
} from "@gamepanel/shared";
import type { Readable } from "node:stream";
import { AgentError } from "./agent/client.js";
import { hashPassword, newSessionId, sessionHash, verifyPassword } from "./auth/crypto.js";
import type { PanelConfig } from "./config.js";
import { schema, type Db } from "./db/index.js";
import { containerBytesFor, memoryFits, nextFreePort } from "./services/allocation.js";
import { audit } from "./services/audit.js";
import type { NodeRow, Nodes } from "./services/nodes.js";

const COOKIE = "gp_session";
const SESSION_DAYS = 7;
type ServerRow = typeof schema.servers.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    me?: Me | undefined;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// A readable, DNS-safe id from a display name: "Perpetual Wonders" -> "perpetual-wonders".
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

export function addressFor(row: Pick<ServerRow, "hostname" | "port">, publicIp: string): string {
  if (row.hostname) return row.port === 25565 ? row.hostname : `${row.hostname}:${row.port}`;
  return row.port === 25565 ? publicIp : `${publicIp}:${row.port}`;
}

export interface AppDeps {
  cfg: Pick<PanelConfig, "cookieSecure" | "webDist" | "serverDomain">;
  db: Db;
  nodes: Nodes;
}

export async function buildApp({ cfg, db, nodes }: AppDeps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 64 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid request", issues: err.issues.map((i) => i.path.join(".")) });
    if (err instanceof AgentError) {
      // Pass the node's own answer through when it is about the request; hide node faults.
      const passthrough = err.status >= 400 && err.status < 500;
      return reply.code(passthrough ? err.status : 502).send({ error: passthrough ? err.message : `node: ${err.message}` });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    app.log.error(err);
    return reply.code(500).send({ error: "panel error" });
  });

  // --- sessions -------------------------------------------------------------

  async function loadMe(req: FastifyRequest): Promise<Me | undefined> {
    const sid = req.cookies[COOKIE];
    if (!sid) return undefined;
    const [row] = await db
      .select({ id: schema.users.id, email: schema.users.email, role: schema.users.role, disabled: schema.users.disabled })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(eq(schema.sessions.idHash, sessionHash(sid)), gt(schema.sessions.expiresAt, new Date())));
    if (!row || row.disabled) return undefined;
    return { id: row.id, email: row.email, role: row.role };
  }

  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    req.me = await loadMe(req);
    // State-changing calls must come from our own web app. Together with
    // SameSite=Strict cookies this stops cross-site requests.
    if (req.method !== "GET" && req.url !== "/api/auth/login" && req.headers["x-gamepanel"] !== "1") {
      throw new HttpError(403, "missing request header");
    }
  });

  function requireMe(req: FastifyRequest): Me {
    if (!req.me) throw new HttpError(401, "not logged in");
    return req.me;
  }
  function requireAdmin(req: FastifyRequest): Me {
    const me = requireMe(req);
    if (me.role !== "admin") throw new HttpError(403, "admins only");
    return me;
  }

  // Admins see every server; owners only their own.
  async function visibleServers(me: Me): Promise<ServerRow[]> {
    const q = db.select().from(schema.servers);
    return me.role === "admin" ? q : q.where(eq(schema.servers.ownerId, me.id));
  }

  async function serverFor(me: Me, id: string): Promise<{ row: ServerRow; node: NodeRow }> {
    const [row] = await db.select().from(schema.servers).where(eq(schema.servers.id, id));
    // Same answer for "missing" and "not yours", so ids cannot be probed.
    if (!row || (me.role !== "admin" && row.ownerId !== me.id)) throw new HttpError(404, "server not found");
    const node = await nodes.get(row.nodeId);
    if (!node) throw new HttpError(500, "server's node is missing");
    return { row, node };
  }

  // --- auth -----------------------------------------------------------------

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => req.ip } } },
    async (req, reply) => {
      const { email, password } = loginSchema.parse(req.body);
      const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase()));
      const ok = user && !user.disabled && (await verifyPassword(user.passwordHash, password));
      if (!ok) {
        await audit(db, { userId: user?.id ?? null, action: "login.failed", ip: req.ip, detail: { email } });
        throw new HttpError(401, "wrong email or password");
      }
      const sid = newSessionId();
      await db.insert(schema.sessions).values({
        idHash: sessionHash(sid),
        userId: user.id,
        expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
      });
      await audit(db, { userId: user.id, action: "login", ip: req.ip });
      reply.setCookie(COOKIE, sid, { httpOnly: true, secure: cfg.cookieSecure, sameSite: "strict", path: "/", maxAge: SESSION_DAYS * 86_400 });
      return { id: user.id, email: user.email, role: user.role } satisfies Me;
    },
  );

  app.post("/api/auth/logout", async (req, reply) => {
    const sid = req.cookies[COOKIE];
    if (sid) await db.delete(schema.sessions).where(eq(schema.sessions.idHash, sessionHash(sid)));
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req) => requireMe(req));

  // Change your own password. Other sessions are logged out; this one stays.
  app.post(
    "/api/auth/password",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => req.ip } } },
    async (req) => {
      const me = requireMe(req);
      const { current, next } = changePasswordSchema.parse(req.body);
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, me.id));
      if (!user || !(await verifyPassword(user.passwordHash, current))) throw new HttpError(403, "current password is wrong");
      await db.update(schema.users).set({ passwordHash: await hashPassword(next) }).where(eq(schema.users.id, me.id));
      const keep = sessionHash(req.cookies[COOKIE] ?? "");
      await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, me.id), ne(schema.sessions.idHash, keep)));
      await audit(db, { userId: me.id, action: "password.change", ip: req.ip });
      return { ok: true };
    },
  );

  // --- dashboard ------------------------------------------------------------

  async function viewsFor(rows: ServerRow[]): Promise<ServerView[]> {
    const nodeRows = await nodes.all();
    const users = await db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users);
    const emailOf = new Map(users.map((u) => [u.id, u.email]));
    // One status call per node, then stats for the running servers.
    const statusByNode = new Map<string, Awaited<ReturnType<ReturnType<Nodes["client"]>["list"]>> | Error>();
    await Promise.all(
      nodeRows
        .filter((n) => rows.some((r) => r.nodeId === n.id))
        .map(async (n) => {
          statusByNode.set(n.id, await nodes.client(n).list().catch((e: Error) => e));
        }),
    );
    return Promise.all(
      rows.map(async (r): Promise<ServerView> => {
        const node = nodeRows.find((n) => n.id === r.nodeId);
        const listed = statusByNode.get(r.nodeId);
        const base = {
          id: r.id,
          name: r.name,
          nodeId: r.nodeId,
          nodeName: node?.name ?? r.nodeId,
          ownerEmail: emailOf.get(r.ownerId) ?? "",
          type: r.type,
          version: r.version,
          memoryMb: r.memoryMb,
          cpus: r.cpus,
          port: r.port,
          publicIp: node?.publicIp ?? "",
          address: addressFor(r, node?.publicIp ?? ""),
        };
        if (!node || !listed || listed instanceof Error) return { ...base, status: null, stats: null, error: "node unreachable" };
        const status = listed.find((s) => s.id === r.id) ?? { id: r.id, state: "missing" as const };
        const running = status.state === "running" || status.state === "starting";
        const stats = running ? await nodes.client(node).stats(r.id).catch(() => null) : null;
        return { ...base, status, stats };
      }),
    );
  }

  async function nodeViews(): Promise<NodeView[]> {
    return Promise.all(
      (await nodes.all()).map(async (n): Promise<NodeView> => {
        const base = { id: n.id, name: n.name, publicIp: n.publicIp, portMin: n.portMin, portMax: n.portMax };
        try {
          return { ...base, info: await nodes.client(n).node() };
        } catch {
          return { ...base, info: null, error: "node unreachable" };
        }
      }),
    );
  }

  app.get("/api/dashboard", async (req): Promise<Dashboard> => {
    const me = requireMe(req);
    const [servers, nodeList] = await Promise.all([viewsFor(await visibleServers(me)), me.role === "admin" ? nodeViews() : null]);
    return { servers: servers.sort((a, b) => a.name.localeCompare(b.name)), nodes: nodeList };
  });

  app.get("/api/servers/:id", async (req) => {
    const me = requireMe(req);
    const { row } = await serverFor(me, (req.params as { id: string }).id);
    const [view] = await viewsFor([row]);
    return view;
  });

  app.get("/api/servers/:id/info", async (req) => {
    const me = requireMe(req);
    const { row, node } = await serverFor(me, (req.params as { id: string }).id);
    return nodes.client(node).info(row.id);
  });

  // --- create -----------------------------------------------------------------

  app.post("/api/servers", async (req, reply) => {
    const me = requireAdmin(req);
    const body = newServerSchema.parse(req.body);

    const id = slugify(body.name);
    if (!id) throw new HttpError(400, "the name needs at least one letter or digit");
    const [clash] = await db.select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.id, id));
    if (clash) throw new HttpError(409, `a server called "${id}" already exists`);

    const allNodes = await nodes.all();
    const node = body.nodeId ? allNodes.find((n) => n.id === body.nodeId) : allNodes[0];
    if (!node) throw new HttpError(400, "no node to put it on");
    const client = nodes.client(node);

    const info = await client.node();
    if (!memoryFits(info.memoryBytes, info.servers.allocatedMemoryBytes, node.reservedMemoryMb, containerBytesFor(body.memoryMb))) {
      throw new HttpError(409, `${node.name} does not have ${body.memoryMb} MB of RAM free`);
    }

    const used = (await db.select({ port: schema.servers.port }).from(schema.servers).where(eq(schema.servers.nodeId, node.id))).map((r) => r.port);
    const port = nextFreePort({ min: node.portMin, max: node.portMax }, used);
    if (port === null) throw new HttpError(409, `${node.name} has no free ports left`);

    const now = new Date();
    await db.insert(schema.servers).values({
      id,
      name: body.name,
      nodeId: node.id,
      ownerId: me.id,
      type: body.type,
      version: body.version,
      memoryMb: body.memoryMb,
      cpus: body.cpus,
      port,
      hostname: null,
      eulaAcceptedBy: me.id,
      eulaAcceptedAt: now,
    });

    try {
      await client.apply({ id, type: body.type, version: body.version, memoryMb: body.memoryMb, cpus: body.cpus, port, eulaAccepted: true });
      await client.power(id, "start");
    } catch (err) {
      // Leave nothing half made: no row without a container.
      await client.remove(id).catch(() => {});
      await db.delete(schema.servers).where(eq(schema.servers.id, id));
      throw err;
    }
    await audit(db, { userId: me.id, action: "server.create", serverId: id, ip: req.ip, detail: { ...body, port, node: node.id } });
    const [row] = await db.select().from(schema.servers).where(eq(schema.servers.id, id));
    const [view] = await viewsFor([row!]);
    return reply.code(201).send(view);
  });

  // --- power, broadcast -------------------------------------------------------

  app.post("/api/servers/:id/power", async (req) => {
    const me = requireMe(req);
    const { row, node } = await serverFor(me, (req.params as { id: string }).id);
    const { action } = powerBodySchema.parse(req.body);
    const status = await nodes.client(node).power(row.id, action);
    await audit(db, { userId: me.id, action: `server.${action}`, serverId: row.id, ip: req.ip });
    return status;
  });

  // Power every server the user can see. Each result is reported; one failure does not stop the rest.
  app.post("/api/servers/power-all", async (req) => {
    const me = requireMe(req);
    const { action } = powerBodySchema.parse(req.body);
    const rows = await visibleServers(me);
    const results = await Promise.all(
      rows.map(async (r) => {
        const node = await nodes.get(r.nodeId);
        try {
          await nodes.client(node!).power(r.id, action);
          return { id: r.id, ok: true };
        } catch (e) {
          return { id: r.id, ok: false, error: (e as Error).message };
        }
      }),
    );
    await audit(db, { userId: me.id, action: `server.${action}-all`, ip: req.ip, detail: results });
    return { results };
  });

  app.post("/api/servers/broadcast", async (req) => {
    const me = requireMe(req);
    const { message } = broadcastSchema.parse(req.body);
    const views = await viewsFor(await visibleServers(me));
    const running = views.filter((v) => v.status?.state === "running");
    const results = await Promise.all(
      running.map(async (v) => {
        const node = await nodes.get(v.nodeId);
        try {
          await nodes.client(node!).command(v.id, `say ${message}`);
          return { id: v.id, ok: true };
        } catch (e) {
          return { id: v.id, ok: false, error: (e as Error).message };
        }
      }),
    );
    await audit(db, { userId: me.id, action: "server.broadcast", ip: req.ip, detail: { message, results } });
    return { results };
  });

  // --- console ----------------------------------------------------------------

  // The browser talks to the panel; the panel relays to the node's agent.
  app.get("/api/servers/:id/console", { websocket: true }, async (socket, req) => {
    const me = req.me;
    let target: { row: ServerRow; node: NodeRow };
    try {
      if (!me) throw new HttpError(401, "not logged in");
      target = await serverFor(me, (req.params as { id: string }).id);
    } catch {
      socket.close(1008, "not allowed");
      return;
    }
    const upstream = nodes.client(target.node).console(target.row.id);
    upstream.on("message", (data) => socket.readyState === socket.OPEN && socket.send(data.toString()));
    upstream.on("close", () => socket.close(1000, "ended"));
    upstream.on("error", () => socket.close(1011, "node unreachable"));
    socket.on("message", (data: Buffer) => {
      const parsed = consoleInSchema.safeParse((() => {
        try {
          return JSON.parse(data.toString("utf8"));
        } catch {
          return null;
        }
      })());
      if (!parsed.success) {
        socket.send(JSON.stringify({ t: "notice", text: "commands must be one line" }));
        return;
      }
      if (upstream.readyState === upstream.OPEN) upstream.send(JSON.stringify(parsed.data));
      void audit(db, { userId: me!.id, action: "console.command", serverId: target.row.id, ip: req.ip, detail: { cmd: parsed.data.cmd } });
    });
    socket.on("close", () => upstream.close());
  });

  // --- files ---------------------------------------------------------------------

  const qp = (req: FastifyRequest, name: string) => String((req.query as Record<string, unknown>)[name] ?? "");
  async function fileTarget(req: FastifyRequest) {
    const me = requireMe(req);
    // Read the address now: after a streamed body the connection details can be gone.
    const ip = req.ip;
    const { row, node } = await serverFor(me, (req.params as { id: string }).id);
    return { me, ip, id: row.id, client: nodes.client(node) };
  }

  app.get("/api/servers/:id/files", async (req) => {
    const t = await fileTarget(req);
    return t.client.listFiles(t.id, qp(req, "path"));
  });

  app.get("/api/servers/:id/files/content", async (req) => {
    const t = await fileTarget(req);
    return t.client.readFile(t.id, qp(req, "path"));
  });

  app.put("/api/servers/:id/files/content", { bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
    const t = await fileTarget(req);
    const { text } = (req.body ?? {}) as { text?: unknown };
    if (typeof text !== "string") throw new HttpError(400, "text is required");
    const path = qp(req, "path");
    await t.client.writeFile(t.id, path, text);
    await audit(db, { userId: t.me.id, action: "file.write", serverId: t.id, ip: t.ip, detail: { path, bytes: Buffer.byteLength(text) } });
    return reply.code(204).send();
  });

  app.get("/api/servers/:id/files/download", async (req, reply) => {
    const t = await fileTarget(req);
    const path = qp(req, "path");
    const res = await t.client.download(t.id, path);
    for (const h of ["content-type", "content-length", "content-disposition"]) {
      const v = res.headers[h];
      if (typeof v === "string") reply.header(h, v);
    }
    await audit(db, { userId: t.me.id, action: "file.download", serverId: t.id, ip: t.ip, detail: { path } });
    return reply.send(res.body);
  });

  // Raw upload pieces stream through to the node.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
  app.post("/api/servers/:id/files/upload", async (req) => {
    const t = await fileTarget(req);
    const path = qp(req, "path");
    const offset = Number(qp(req, "offset") || "0");
    const done = qp(req, "done") === "1";
    const result = await t.client.uploadChunk(t.id, path, offset, done, req.body as Readable);
    if (done) await audit(db, { userId: t.me.id, action: "file.upload", serverId: t.id, ip: t.ip, detail: { path, bytes: result.size } });
    return result;
  });

  app.post("/api/servers/:id/files/mkdir", async (req, reply) => {
    const t = await fileTarget(req);
    const { path } = (req.body ?? {}) as { path?: unknown };
    await t.client.mkdir(t.id, String(path ?? ""));
    await audit(db, { userId: t.me.id, action: "file.mkdir", serverId: t.id, ip: t.ip, detail: { path } });
    return reply.code(204).send();
  });

  app.post("/api/servers/:id/files/rename", async (req, reply) => {
    const t = await fileTarget(req);
    const { from, to } = (req.body ?? {}) as { from?: unknown; to?: unknown };
    await t.client.rename(t.id, String(from ?? ""), String(to ?? ""));
    await audit(db, { userId: t.me.id, action: "file.rename", serverId: t.id, ip: t.ip, detail: { from, to } });
    return reply.code(204).send();
  });

  app.delete("/api/servers/:id/files", async (req) => {
    const t = await fileTarget(req);
    const path = qp(req, "path");
    const result = await t.client.removeFile(t.id, path);
    await audit(db, { userId: t.me.id, action: "file.delete", serverId: t.id, ip: t.ip, detail: { path, trashedTo: result.trashedTo } });
    return { ok: true };
  });

  // --- nodes (admin) ------------------------------------------------------------

  app.get("/api/nodes", async (req) => {
    requireAdmin(req);
    return nodeViews();
  });

  // --- web app --------------------------------------------------------------------

  if (cfg.webDist) {
    await app.register(fastifyStatic, { root: cfg.webDist, wildcard: false });
    // Single-page app: unknown paths get index.html; unknown /api paths get a 404.
    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}

