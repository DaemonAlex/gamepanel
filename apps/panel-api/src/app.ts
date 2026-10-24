import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { and, asc, eq, gt, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  broadcastSchema,
  changePasswordSchema,
  consoleInSchema,
  loginSchema,
  newServerSchema,
  powerBodySchema,
  metricRanges,
  playerActionSchema,
  backupNameSchema,
  scheduleSchema,
  installSchema,
  versionChangeSchema,
  versionCheckSchema,
  dbCreateSchema,
  dbNameSchema,
  dbQuerySchema,
  dbRowEditSchema,
  dbRowsQuerySchema,
  type PluginsView,
  type PluginReadiness,
  type VersionJob,
  type VersionsView,
  type BackupsView,
  type ScheduleView,
  checkProperty,
  propertyChangesSchema,
  whitelistToggleSchema,
  type Dashboard,
  type MetricRange,
  type ServerPerm,
  acceptInviteSchema,
  accessSchema,
  inviteSchema,
  quotaSchema,
  serverPerms,
  type AccessView,
  type InviteView,
  type UserView,
  type Me,
  type NodeView,
  type ServerView,
} from "@gamepanel/shared";
import type { Readable } from "node:stream";
import { AgentError } from "./agent/client.js";
import { hashPassword, newSessionId, open as openSecret, seal, sessionHash, verifyPassword } from "./auth/crypto.js";
import { newSecret, otpauthUri, verifyCode } from "./auth/totp.js";
import type { PanelConfig } from "./config.js";
import { schema, type Db } from "./db/index.js";
import { containerBytesFor, memoryFits, nextFreePort } from "./services/allocation.js";
import { audit } from "./services/audit.js";
import { resolve as resolvePlugin, search as searchCatalog, updates as pluginUpdates } from "./services/catalog.js";
import { pluginReadiness as checkPluginReadiness, versionsView } from "./services/versions.js";
import { computeWarnings, nodeSeries, serverSeries, sparks, warningInput } from "./services/metrics.js";
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
  cfg: Pick<PanelConfig, "cookieSecure" | "webDist" | "serverDomain" | "appSecret">;
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

  // Admins see every server; owners their own; subusers the ones shared with them.
  // perm narrows the list to servers where the viewer may do that.
  async function accessFor(me: Me): Promise<Map<string, string[]>> {
    const rows = await db.select().from(schema.serverAccess).where(eq(schema.serverAccess.userId, me.id));
    return new Map(rows.map((r) => [r.serverId, r.perms]));
  }

  function permsOn(me: Me, row: ServerRow, access: Map<string, string[]>): string[] | null {
    if (me.role === "admin" || row.ownerId === me.id) return ["all"];
    return access.get(row.id) ?? null;
  }

  const allows = (perms: string[] | null, perm: ServerPerm | "view") => !!perms && (perm === "view" || perms.includes("all") || perms.includes(perm));

  async function visibleServers(me: Me, perm: ServerPerm | "view" = "view"): Promise<ServerRow[]> {
    const rows = await db.select().from(schema.servers);
    const access = me.role === "admin" ? new Map<string, string[]>() : await accessFor(me);
    return rows.filter((r) => allows(permsOn(me, r, access), perm));
  }

  async function serverFor(me: Me, id: string, perm: ServerPerm | "view"): Promise<{ row: ServerRow; node: NodeRow; perms: string[] }> {
    const [row] = await db.select().from(schema.servers).where(eq(schema.servers.id, id));
    const perms = row ? permsOn(me, row, me.role === "admin" ? new Map() : await accessFor(me)) : null;
    // Same answer for "missing", "not yours" and "not allowed to see": ids cannot be probed.
    if (!row || !perms) throw new HttpError(404, "server not found");
    if (!allows(perms, perm)) throw new HttpError(403, `you do not have ${perm} rights on this server`);
    const node = await nodes.get(row.nodeId);
    if (!node) throw new HttpError(500, "server's node is missing");
    return { row, node, perms };
  }

  // --- auth -----------------------------------------------------------------

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => req.ip } } },
    async (req, reply) => {
      const { email, password, code } = loginSchema.parse(req.body);
      const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase()));
      const ok = user && !user.disabled && (await verifyPassword(user.passwordHash, password));
      if (!ok) {
        await audit(db, { userId: user?.id ?? null, action: "login.failed", ip: req.ip, detail: { email } });
        throw new HttpError(401, "wrong email or password");
      }
      if (user.totpEnabled && user.totpSecretEnc) {
        if (!code) return reply.code(401).send({ error: "enter the code from your authenticator app", needCode: true });
        if (!verifyCode(openSecret(cfg.appSecret, user.totpSecretEnc), code)) {
          await audit(db, { userId: user.id, action: "login.badcode", ip: req.ip });
          return reply.code(401).send({ error: "that code is not right", needCode: true });
        }
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

  app.get("/api/me", async (req) => {
    const me = requireMe(req);
    const [u] = await db.select({ totp: schema.users.totpEnabled }).from(schema.users).where(eq(schema.users.id, me.id));
    return { ...me, totpEnabled: !!u?.totp };
  });

  // --- two-step login ---------------------------------------------------------------

  app.post("/api/auth/totp/setup", async (req) => {
    const me = requireMe(req);
    const secret = newSecret();
    // Stored but not on until a code from the app proves it was scanned.
    await db.update(schema.users).set({ totpSecretEnc: seal(cfg.appSecret, secret), totpEnabled: false }).where(eq(schema.users.id, me.id));
    return { secret, uri: otpauthUri(secret, me.email) };
  });

  app.post("/api/auth/totp/enable", async (req) => {
    const me = requireMe(req);
    const code = String((req.body as { code?: unknown } | undefined)?.code ?? "");
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, me.id));
    if (!u?.totpSecretEnc || !verifyCode(openSecret(cfg.appSecret, u.totpSecretEnc), code)) throw new HttpError(400, "that code is not right; check the time on your phone");
    await db.update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, me.id));
    await audit(db, { userId: me.id, action: "totp.on", ip: req.ip });
    return { ok: true };
  });

  app.post("/api/auth/totp/disable", async (req) => {
    const me = requireMe(req);
    const code = String((req.body as { code?: unknown } | undefined)?.code ?? "");
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, me.id));
    if (!u?.totpEnabled || !u.totpSecretEnc || !verifyCode(openSecret(cfg.appSecret, u.totpSecretEnc), code)) throw new HttpError(400, "that code is not right");
    await db.update(schema.users).set({ totpEnabled: false, totpSecretEnc: null }).where(eq(schema.users.id, me.id));
    await audit(db, { userId: me.id, action: "totp.off", ip: req.ip });
    return { ok: true };
  });

  // --- people (admin) ------------------------------------------------------------------

  const INVITE_DAYS = 7;
  async function makeLink(kind: "invite" | "reset", email: string, role: Me["role"], createdBy: string, userId: string | null) {
    const token = newSessionId();
    await db.insert(schema.invites).values({ tokenHash: sessionHash(token), kind, email: email.toLowerCase(), role, userId, createdBy, expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) });
    return { path: `/invite/${token}`, expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString() };
  }

  app.get("/api/users", async (req): Promise<UserView[]> => {
    requireAdmin(req);
    const users = await db.select().from(schema.users);
    const servers = await db.select().from(schema.servers);
    return users
      .map((u) => {
        const mine = servers.filter((s) => s.ownerId === u.id);
        return {
          id: u.id,
          email: u.email,
          role: u.role,
          disabled: u.disabled,
          totpEnabled: u.totpEnabled,
          quota: { maxServers: u.maxServers, maxMemoryMb: u.maxMemoryMb, maxDiskGb: u.maxDiskGb },
          usage: { servers: mine.length, memoryMb: mine.reduce((n, s) => n + s.memoryMb, 0), diskGb: mine.reduce((n, s) => n + s.diskGb, 0) },
          createdAt: u.createdAt.toISOString(),
        };
      })
      .sort((a, b) => a.email.localeCompare(b.email));
  });

  app.get("/api/invites", async (req): Promise<InviteView[]> => {
    requireAdmin(req);
    const rows = await db.select().from(schema.invites);
    return rows
      .map((r) => ({ email: r.email, role: r.role, kind: r.kind as "invite" | "reset", expiresAt: r.expiresAt.toISOString(), usedAt: r.usedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });

  app.post("/api/users/invite", async (req) => {
    const me = requireAdmin(req);
    const { email, role } = inviteSchema.parse(req.body);
    const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email.toLowerCase()));
    if (exists) throw new HttpError(409, "that email already has an account");
    const link = await makeLink("invite", email, role, me.id, null);
    await audit(db, { userId: me.id, action: "user.invite", ip: req.ip, detail: { email, role } });
    return link;
  });

  app.post("/api/users/:uid/reset", async (req) => {
    const me = requireAdmin(req);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, (req.params as { uid: string }).uid));
    if (!u) throw new HttpError(404, "user not found");
    const link = await makeLink("reset", u.email, u.role, me.id, u.id);
    await audit(db, { userId: me.id, action: "user.reset-link", ip: req.ip, detail: { user: u.email } });
    return link;
  });

  app.put("/api/users/:uid", async (req) => {
    const me = requireAdmin(req);
    const uid = (req.params as { uid: string }).uid;
    const body = (req.body ?? {}) as { disabled?: unknown; role?: unknown; quota?: unknown };
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, uid));
    if (!u) throw new HttpError(404, "user not found");
    if (uid === me.id && (body.disabled === true || (body.role !== undefined && body.role !== "admin"))) throw new HttpError(400, "you cannot lock yourself out");
    const set: Partial<typeof schema.users.$inferInsert> = {};
    if (typeof body.disabled === "boolean") set.disabled = body.disabled;
    if (body.role !== undefined) set.role = inviteSchema.shape.role.parse(body.role);
    if (body.quota !== undefined) Object.assign(set, quotaSchema.parse(body.quota));
    await db.update(schema.users).set(set).where(eq(schema.users.id, uid));
    // Turning someone off ends their sessions now.
    if (set.disabled) await db.delete(schema.sessions).where(eq(schema.sessions.userId, uid));
    await audit(db, { userId: me.id, action: "user.update", ip: req.ip, detail: { user: u.email, ...set } });
    return { ok: true };
  });

  // --- invite links (public) -------------------------------------------------------------

  async function liveInvite(token: string) {
    const [inv] = await db.select().from(schema.invites).where(eq(schema.invites.tokenHash, sessionHash(token)));
    if (!inv || inv.usedAt || inv.expiresAt < new Date()) throw new HttpError(404, "this link has expired or was already used");
    return inv;
  }

  app.get("/api/invite/:token", async (req) => {
    const inv = await liveInvite((req.params as { token: string }).token);
    return { email: inv.email, kind: inv.kind };
  });

  app.post("/api/invite/accept", { config: { rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: (r: FastifyRequest) => r.ip } } }, async (req, reply) => {
    const { token, password } = acceptInviteSchema.parse(req.body);
    const inv = await liveInvite(token);
    let userId: string;
    if (inv.kind === "reset" && inv.userId) {
      userId = inv.userId;
      await db.update(schema.users).set({ passwordHash: await hashPassword(password) }).where(eq(schema.users.id, userId));
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
    } else {
      userId = randomUUID();
      await db.insert(schema.users).values({ id: userId, email: inv.email, passwordHash: await hashPassword(password), role: inv.role });
      if (inv.giveServerId) {
        await db.update(schema.servers).set({ ownerId: userId }).where(eq(schema.servers.id, inv.giveServerId));
        await audit(db, { userId, action: "server.owner", serverId: inv.giveServerId, ip: req.ip, detail: { to: inv.email, via: "invite" } });
      }
    }
    await db.update(schema.invites).set({ usedAt: new Date() }).where(eq(schema.invites.tokenHash, inv.tokenHash));
    const sid = newSessionId();
    await db.insert(schema.sessions).values({ idHash: sessionHash(sid), userId, expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) });
    await audit(db, { userId, action: inv.kind === "reset" ? "user.reset" : "user.join", ip: req.ip, detail: { email: inv.email } });
    reply.setCookie(COOKIE, sid, { httpOnly: true, secure: cfg.cookieSecure, sameSite: "strict", path: "/", maxAge: SESSION_DAYS * 86_400 });
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    return { id: u!.id, email: u!.email, role: u!.role } satisfies Me;
  });

  // --- who else can use a server (owner or admin) -------------------------------------

  async function ownServer(req: FastifyRequest) {
    const me = requireMe(req);
    const t = await serverFor(me, (req.params as { id: string }).id, "view");
    if (!t.perms.includes("all")) throw new HttpError(403, "only the owner can share this server");
    return { me, ...t };
  }

  app.get("/api/servers/:id/access", async (req): Promise<AccessView[]> => {
    const { row } = await ownServer(req);
    const rows = await db
      .select({ userId: schema.serverAccess.userId, perms: schema.serverAccess.perms, email: schema.users.email })
      .from(schema.serverAccess)
      .innerJoin(schema.users, eq(schema.users.id, schema.serverAccess.userId))
      .where(eq(schema.serverAccess.serverId, row.id));
    return rows.map((r) => ({ userId: r.userId, email: r.email, perms: r.perms as AccessView["perms"] }));
  });

  app.put("/api/servers/:id/access", async (req) => {
    const { me, row } = await ownServer(req);
    const { email, perms } = accessSchema.parse(req.body);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase()));
    if (!u) throw new HttpError(404, "no account with that email; ask an admin to invite them first");
    if (u.id === row.ownerId) throw new HttpError(400, "that is the owner");
    const clean = [...new Set(perms)].filter((p) => (serverPerms as readonly string[]).includes(p));
    await db.insert(schema.serverAccess).values({ serverId: row.id, userId: u.id, perms: clean }).onConflictDoUpdate({ target: [schema.serverAccess.serverId, schema.serverAccess.userId], set: { perms: clean } });
    await audit(db, { userId: me.id, action: "access.set", serverId: row.id, ip: req.ip, detail: { email: u.email, perms: clean } });
    return { ok: true };
  });

  app.delete("/api/servers/:id/access/:uid", async (req) => {
    const { me, row } = await ownServer(req);
    const uid = (req.params as { uid: string }).uid;
    await db.delete(schema.serverAccess).where(and(eq(schema.serverAccess.serverId, row.id), eq(schema.serverAccess.userId, uid)));
    await audit(db, { userId: me.id, action: "access.remove", serverId: row.id, ip: req.ip, detail: { user: uid } });
    return { ok: true };
  });

  // Disk cap of one server (admins).
  app.put("/api/servers/:id/disk", async (req) => {
    const me = requireAdmin(req);
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "view");
    const gb = Number((req.body as { gb?: unknown } | undefined)?.gb);
    if (!Number.isInteger(gb) || gb < 1 || gb > 10000) throw new HttpError(400, "disk must be 1 to 10000 GB");
    const usage = await nodes.client(node).setDisk(row.id, gb);
    await db.update(schema.servers).set({ diskGb: gb }).where(eq(schema.servers.id, row.id));
    await audit(db, { userId: me.id, action: "server.disk", serverId: row.id, ip: req.ip, detail: { from: row.diskGb, to: gb } });
    return usage;
  });

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

  async function viewsFor(rows: ServerRow[], me: Me): Promise<ServerView[]> {
    const access = me.role === "admin" ? new Map<string, string[]>() : await accessFor(me);
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
          diskGb: r.diskGb,
          perms: permsOn(me, r, access) ?? [],
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
    const [servers, nodeList] = await Promise.all([viewsFor(await visibleServers(me), me), me.role === "admin" ? nodeViews() : null]);
    const ids = servers.map((s) => s.id);
    const input = await warningInput(db, servers);
    // Owners see warnings about their own servers; node warnings are for admins.
    const warnings = computeWarnings({ servers, ...input, nodes: me.role === "admin" ? input.nodes : [] });
    return { servers: servers.sort((a, b) => a.name.localeCompare(b.name)), nodes: nodeList, warnings, sparks: await sparks(db, ids) };
  });

  function rangeOf(req: FastifyRequest): MetricRange {
    const r = (req.query as { range?: string }).range ?? "1h";
    if (!(metricRanges as readonly string[]).includes(r)) throw new HttpError(400, "range must be 1h, 24h or 7d");
    return r as MetricRange;
  }

  app.get("/api/servers/:id/metrics", async (req) => {
    const me = requireMe(req);
    const { row } = await serverFor(me, (req.params as { id: string }).id, "view");
    return serverSeries(db, row.id, rangeOf(req));
  });

  app.get("/api/nodes/:id/metrics", async (req) => {
    requireAdmin(req);
    const node = await nodes.get((req.params as { id: string }).id);
    if (!node) throw new HttpError(404, "node not found");
    return nodeSeries(db, node.id, rangeOf(req));
  });

  app.get("/api/servers/:id", async (req) => {
    const me = requireMe(req);
    const { row } = await serverFor(me, (req.params as { id: string }).id, "view");
    const [view] = await viewsFor([row], me);
    return view;
  });

  app.get("/api/servers/:id/info", async (req) => {
    const me = requireMe(req);
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "view");
    return nodes.client(node).info(row.id);
  });

  // --- create -----------------------------------------------------------------

  app.post("/api/servers", async (req, reply) => {
    const me = requireMe(req);
    if (me.role === "subuser") throw new HttpError(403, "your account cannot create servers");
    const body = newServerSchema.parse(req.body);
    // Owners stay within their quota; admins have none.
    if (me.role !== "admin") {
      const [u] = await db.select().from(schema.users).where(eq(schema.users.id, me.id));
      const mine = await db.select().from(schema.servers).where(eq(schema.servers.ownerId, me.id));
      const ram = mine.reduce((n, s) => n + s.memoryMb, 0) + body.memoryMb;
      const disk = mine.reduce((n, s) => n + s.diskGb, 0) + body.diskGb;
      if (mine.length + 1 > u!.maxServers) throw new HttpError(403, `your limit is ${u!.maxServers} server${u!.maxServers === 1 ? "" : "s"}`);
      if (ram > u!.maxMemoryMb) throw new HttpError(403, `that would use ${ram} MB of RAM; your limit is ${u!.maxMemoryMb} MB`);
      if (disk > u!.maxDiskGb) throw new HttpError(403, `that would use ${disk} GB of disk; your limit is ${u!.maxDiskGb} GB`);
    }

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
      diskGb: body.diskGb,
      port,
      hostname: null,
      eulaAcceptedBy: me.id,
      eulaAcceptedAt: now,
    });

    try {
      await client.apply({ id, type: body.type, version: body.version, memoryMb: body.memoryMb, cpus: body.cpus, diskGb: body.diskGb, port, eulaAccepted: true });
      await client.power(id, "start");
    } catch (err) {
      // Leave nothing half made: no row without a container.
      await client.remove(id).catch(() => {});
      await db.delete(schema.servers).where(eq(schema.servers.id, id));
      throw err;
    }
    await audit(db, { userId: me.id, action: "server.create", serverId: id, ip: req.ip, detail: { ...body, port, node: node.id } });
    const [row] = await db.select().from(schema.servers).where(eq(schema.servers.id, id));
    const [view] = await viewsFor([row!], me);
    return reply.code(201).send(view);
  });

  // --- power, broadcast -------------------------------------------------------

  app.post("/api/servers/:id/power", async (req) => {
    const me = requireMe(req);
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "power");
    const { action } = powerBodySchema.parse(req.body);
    const status = await nodes.client(node).power(row.id, action);
    await audit(db, { userId: me.id, action: `server.${action}`, serverId: row.id, ip: req.ip });
    return status;
  });

  // Power every server the user can see. Each result is reported; one failure does not stop the rest.
  app.post("/api/servers/power-all", async (req) => {
    const me = requireMe(req);
    const { action } = powerBodySchema.parse(req.body);
    const rows = await visibleServers(me, "power");
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
    const views = await viewsFor(await visibleServers(me, "console"), me);
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
      target = await serverFor(me, (req.params as { id: string }).id, "console");
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

  // --- plugins and mods ------------------------------------------------------------

  const folderFor = (type: string): "plugins" | "mods" | null =>
    type === "PAPER" || type === "PURPUR" ? "plugins" : type === "FABRIC" || type === "FORGE" || type === "NEOFORGE" ? "mods" : null;

  // The exact Minecraft version: the server records it once it has run; before
  // that the version it was created with.
  async function mcVersionOf(row: ServerRow, node: NodeRow): Promise<string> {
    if (row.version !== "LATEST") return row.version;
    const info = await nodes.client(node).info(row.id).catch(() => null);
    return info?.build?.match(/MC: ([\d.]+)/)?.[1] ?? row.version;
  }

  async function pluginTarget(req: FastifyRequest) {
    const me = requireMe(req);
    const ip = req.ip;
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "plugins");
    const folder = folderFor(row.type);
    if (!folder) throw new HttpError(400, "Vanilla servers have no plugins or mods");
    return { me, ip, row, node, folder, client: nodes.client(node) };
  }

  app.get("/api/servers/:id/plugins", async (req): Promise<PluginsView> => {
    const me = requireMe(req);
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "plugins");
    const folder = folderFor(row.type);
    const mcVersion = await mcVersionOf(row, node);
    if (!folder) return { folder: null, mcVersion, items: [] };
    const items = await nodes.client(node).plugins(row.id, folder);
    const ups = await pluginUpdates(items.map((i) => i.sha1).filter(Boolean), row.type, mcVersion);
    return { folder, mcVersion, items: items.map((i) => ({ ...i, update: ups[i.sha1] ?? null })) };
  });

  app.get("/api/servers/:id/plugins/search", async (req) => {
    const t = await pluginTarget(req);
    const q = String((req.query as { q?: string }).q ?? "").trim().slice(0, 100);
    if (!q) return [];
    return searchCatalog(q, t.row.type, await mcVersionOf(t.row, t.node)).catch((e: Error) => {
      throw new HttpError(502, e.message);
    });
  });

  app.post("/api/servers/:id/plugins/install", async (req) => {
    const t = await pluginTarget(req);
    const { source, id } = installSchema.parse(req.body);
    const mc = await mcVersionOf(t.row, t.node);
    const file = await resolvePlugin(source, id, t.row.type, mc).catch((e: Error) => {
      throw new HttpError(404, e.message);
    });
    const result = await t.client.installPlugin(t.row.id, t.folder, file);
    await audit(db, { userId: t.me.id, action: "plugin.install", serverId: t.row.id, ip: t.ip, detail: { source, id, version: file.version, file: result.file } });
    return { ...result, version: file.version };
  });

  // Update one installed jar to the newest version that fits; the old jar goes to the trash.
  app.post("/api/servers/:id/plugins/update", async (req) => {
    const t = await pluginTarget(req);
    const file = String((req.body as { file?: unknown } | undefined)?.file ?? "");
    const item = (await t.client.plugins(t.row.id, t.folder)).find((i) => i.file === file);
    if (!item) throw new HttpError(404, "plugin not found");
    const up = (await pluginUpdates([item.sha1], t.row.type, await mcVersionOf(t.row, t.node)))[item.sha1];
    if (!up) throw new HttpError(409, "no newer version for this server");
    const result = await t.client.installPlugin(t.row.id, t.folder, up);
    if (result.file !== item.file) await t.client.removeFile(t.row.id, `${t.folder}/${item.file}`);
    await audit(db, { userId: t.me.id, action: "plugin.update", serverId: t.row.id, ip: t.ip, detail: { from: item.file, to: result.file, version: up.version } });
    return { ...result, version: up.version };
  });

  app.post("/api/servers/:id/plugins/enabled", async (req) => {
    const t = await pluginTarget(req);
    const { file, on } = (req.body ?? {}) as { file?: unknown; on?: unknown };
    const r = await t.client.setPluginEnabled(t.row.id, t.folder, String(file ?? ""), on === true);
    await audit(db, { userId: t.me.id, action: on === true ? "plugin.enable" : "plugin.disable", serverId: t.row.id, ip: t.ip, detail: { file, now: r.file } });
    return r;
  });

  app.delete("/api/servers/:id/plugins/:file", async (req) => {
    const t = await pluginTarget(req);
    const file = String((req.params as { file?: string }).file ?? "");
    if (!/^[^/\\]+\.jar(\.disabled)?$/.test(file)) throw new HttpError(400, "not a plugin file");
    const r = await t.client.removeFile(t.row.id, `${t.folder}/${file}`);
    await audit(db, { userId: t.me.id, action: "plugin.delete", serverId: t.row.id, ip: t.ip, detail: { file, trashedTo: r.trashedTo } });
    return { ok: true };
  });

  // --- databases -----------------------------------------------------------------------
  // MariaDB databases owned by a server. Reading uses a read-only login on the
  // node; every change is logged and snapshotted there first.

  async function dbTarget(req: FastifyRequest, withName = true) {
    const me = requireMe(req);
    const params = req.params as { id: string; db?: string };
    const { row, node } = await serverFor(me, params.id, "databases");
    const name = withName ? dbNameSchema.parse(params.db) : "";
    return { me, ip: req.ip, id: row.id, name, client: nodes.client(node) };
  }

  app.get("/api/servers/:id/databases", async (req) => {
    const t = await dbTarget(req, false);
    return t.client.databases(t.id);
  });

  app.post("/api/servers/:id/databases", async (req) => {
    const t = await dbTarget(req, false);
    const { label } = dbCreateSchema.parse(req.body);
    const created = await t.client.createDatabase(t.id, label);
    await audit(db, { userId: t.me.id, action: "database.create", serverId: t.id, ip: t.ip, detail: { name: created.name } });
    return created;
  });

  app.get("/api/servers/:id/databases/:db/password", async (req) => {
    const t = await dbTarget(req);
    await audit(db, { userId: t.me.id, action: "database.password.view", serverId: t.id, ip: t.ip, detail: { name: t.name } });
    return t.client.databasePassword(t.id, t.name);
  });

  app.post("/api/servers/:id/databases/:db/password", async (req) => {
    const t = await dbTarget(req);
    const r = await t.client.resetDatabasePassword(t.id, t.name);
    await audit(db, { userId: t.me.id, action: "database.password.reset", serverId: t.id, ip: t.ip, detail: { name: t.name } });
    return r;
  });

  app.delete("/api/servers/:id/databases/:db", async (req) => {
    const t = await dbTarget(req);
    const r = await t.client.deleteDatabase(t.id, t.name);
    await audit(db, { userId: t.me.id, action: "database.delete", serverId: t.id, ip: t.ip, detail: { name: t.name, snapshot: r.snapshot } });
    return r;
  });

  app.get("/api/servers/:id/databases/:db/tables", async (req) => {
    const t = await dbTarget(req);
    return t.client.databaseTables(t.id, t.name);
  });

  app.get("/api/servers/:id/databases/:db/rows", async (req) => {
    const t = await dbTarget(req);
    const q = dbRowsQuerySchema.parse(req.query);
    return t.client.databaseRows(t.id, t.name, q.table, q.page, q.pageSize);
  });

  app.post("/api/servers/:id/databases/:db/query", async (req) => {
    const t = await dbTarget(req);
    const q = dbQuerySchema.parse(req.body);
    const r = await t.client.databaseQuery(t.id, t.name, q.sql, q.write);
    if (q.write) await audit(db, { userId: t.me.id, action: "database.query.write", serverId: t.id, ip: t.ip, detail: { name: t.name, sql: q.sql.slice(0, 2000), affected: r.affected, snapshot: r.snapshot } });
    return r;
  });

  app.post("/api/servers/:id/databases/:db/rows/update", { bodyLimit: 1024 * 1024 }, async (req) => {
    const t = await dbTarget(req);
    const e = dbRowEditSchema.parse(req.body);
    if (!e.set || !Object.keys(e.set).length) throw new HttpError(400, "nothing to change");
    const r = await t.client.databaseRowUpdate(t.id, t.name, { table: e.table, key: e.key, set: e.set });
    await audit(db, { userId: t.me.id, action: "database.row.update", serverId: t.id, ip: t.ip, detail: { name: t.name, table: e.table, key: e.key, columns: Object.keys(e.set), snapshot: r.snapshot } });
    return r;
  });

  app.post("/api/servers/:id/databases/:db/rows/delete", { bodyLimit: 1024 * 1024 }, async (req) => {
    const t = await dbTarget(req);
    const e = dbRowEditSchema.parse(req.body);
    const r = await t.client.databaseRowDelete(t.id, t.name, { table: e.table, key: e.key });
    await audit(db, { userId: t.me.id, action: "database.row.delete", serverId: t.id, ip: t.ip, detail: { name: t.name, table: e.table, key: e.key, snapshot: r.snapshot } });
    return r;
  });

  // --- logs --------------------------------------------------------------------------

  app.get("/api/servers/:id/logs", async (req) => {
    const me = requireMe(req);
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "logs");
    return nodes.client(node).logs(row.id);
  });

  app.get("/api/servers/:id/logs/read", async (req) => {
    const me = requireMe(req);
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "logs");
    const q = req.query as { path?: string; search?: string };
    return nodes.client(node).readLog(row.id, String(q.path ?? ""), String(q.search ?? "").slice(0, 200));
  });

  // --- version change ------------------------------------------------------------------
  // Backup first (always), then switch type or version. Runs in the background
  // because a backup can take minutes; the page polls the job.

  const versionJobs = new Map<string, VersionJob>();

  // Released versions for this server's type, and the one to suggest.
  app.get("/api/servers/:id/versions", async (req): Promise<VersionsView> => {
    const me = requireMe(req);
    const { row } = await serverFor(me, (req.params as { id: string }).id, "settings");
    return versionsView(row.type, row.version).catch((e: Error) => {
      throw new HttpError(502, e.message);
    });
  });

  // Whether each installed plugin has a version for the Minecraft version picked.
  app.get("/api/servers/:id/versions/check", async (req): Promise<PluginReadiness[]> => {
    const me = requireMe(req);
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "settings");
    const { to } = versionCheckSchema.parse(req.query);
    const folder = folderFor(row.type);
    if (!folder) return [];
    const items = await nodes.client(node).plugins(row.id, folder);
    return checkPluginReadiness(items, row.type, to);
  });

  app.get("/api/servers/:id/version-job", async (req) => {
    const me = requireMe(req);
    const { row } = await serverFor(me, (req.params as { id: string }).id, "settings");
    return versionJobs.get(row.id) ?? null;
  });

  app.post("/api/servers/:id/version", async (req, reply) => {
    const me = requireMe(req);
    const ip = req.ip;
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "settings");
    const to = versionChangeSchema.parse(req.body);
    const running = versionJobs.get(row.id);
    if (running && (running.state === "backing-up" || running.state === "applying")) throw new HttpError(409, "a version change is already running");
    const client = nodes.client(node);
    const status = await client.status(row.id);
    if (status.state !== "stopped" && status.state !== "created") throw new HttpError(409, "stop the server first");
    const job: VersionJob = { state: "backing-up", from: { type: row.type, version: row.version }, to, startedAt: new Date().toISOString() };
    versionJobs.set(row.id, job);
    await audit(db, { userId: me.id, action: "server.version", serverId: row.id, ip, detail: { from: job.from, to } });

    void (async () => {
      try {
        const b = await client.startBackup(row.id, "manual", row.backupKeep + 1);
        for (;;) {
          await new Promise((r) => setTimeout(r, 3000));
          const j = (await client.backups(row.id)).jobs.find((x) => x.id === b.id);
          if (!j || j.state === "failed") throw new Error(`backup failed${j?.error ? `: ${j.error}` : ""}; nothing was changed`);
          if (j.state === "done") {
            if (j.backup) job.backup = j.backup;
            break;
          }
        }
        job.state = "applying";
        await client.apply({ id: row.id, type: to.type, version: to.version, memoryMb: row.memoryMb, cpus: row.cpus, diskGb: row.diskGb, port: row.port, eulaAccepted: true });
        await db.update(schema.servers).set({ type: to.type, version: to.version }).where(eq(schema.servers.id, row.id));
        job.state = "done";
      } catch (err) {
        job.state = "failed";
        job.error = (err as Error).message;
      }
    })();
    return reply.code(202).send(job);
  });

  // --- backups -------------------------------------------------------------------

  app.get("/api/servers/:id/backups", async (req): Promise<BackupsView> => {
    const me = requireMe(req);
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "backups");
    return { ...(await nodes.client(node).backups(row.id)), keep: row.backupKeep };
  });

  app.post("/api/servers/:id/backups", async (req) => {
    const me = requireMe(req);
    const ip = req.ip;
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "backups");
    const job = await nodes.client(node).startBackup(row.id, "manual", row.backupKeep);
    await audit(db, { userId: me.id, action: "backup.start", serverId: row.id, ip, detail: { job: job.id } });
    return job;
  });

  app.post("/api/servers/:id/backups/restore", async (req) => {
    const me = requireMe(req);
    const ip = req.ip;
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "backups");
    const name = backupNameSchema.parse((req.body as { name?: unknown } | undefined)?.name);
    const job = await nodes.client(node).restoreBackup(row.id, name);
    await audit(db, { userId: me.id, action: "backup.restore", serverId: row.id, ip, detail: { name, job: job.id } });
    return job;
  });

  app.put("/api/servers/:id/backups/keep", async (req) => {
    const me = requireMe(req);
    const ip = req.ip;
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "backups");
    const keep = Number((req.body as { keep?: unknown } | undefined)?.keep);
    if (!Number.isInteger(keep) || keep < 1 || keep > 100) throw new HttpError(400, "keep a number of backups from 1 to 100");
    await db.update(schema.servers).set({ backupKeep: keep }).where(eq(schema.servers.id, row.id));
    const { removed } = await nodes.client(node).pruneBackups(row.id, keep);
    await audit(db, { userId: me.id, action: "backup.keep", serverId: row.id, ip, detail: { from: row.backupKeep, to: keep, removed } });
    return { keep, removed };
  });

  app.delete("/api/servers/:id/backups/:name", async (req) => {
    const me = requireMe(req);
    const ip = req.ip;
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "backups");
    const name = backupNameSchema.parse((req.params as { name?: unknown }).name);
    await nodes.client(node).removeBackup(row.id, name);
    await audit(db, { userId: me.id, action: "backup.delete", serverId: row.id, ip, detail: { name } });
    return { ok: true };
  });

  app.get("/api/servers/:id/backups/:name/download", async (req, reply) => {
    const me = requireMe(req);
    const ip = req.ip;
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "backups");
    const name = backupNameSchema.parse((req.params as { name?: unknown }).name);
    const res = await nodes.client(node).downloadBackup(row.id, name);
    for (const h of ["content-type", "content-length", "content-disposition"]) {
      const v = res.headers[h];
      if (typeof v === "string") reply.header(h, v);
    }
    await audit(db, { userId: me.id, action: "backup.download", serverId: row.id, ip, detail: { name } });
    return reply.send(res.body);
  });

  // --- schedules -----------------------------------------------------------------

  const toView = (r: typeof schema.schedules.$inferSelect): ScheduleView => ({
    id: r.id,
    serverId: r.serverId,
    action: r.action as ScheduleView["action"],
    payload: r.payload,
    kind: r.kind as ScheduleView["kind"],
    minutes: r.minutes,
    time: r.time,
    days: r.days,
    tz: r.tz,
    enabled: r.enabled,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastResult: r.lastResult,
  });

  app.get("/api/servers/:id/schedules", async (req) => {
    const me = requireMe(req);
    const { row } = await serverFor(me, (req.params as { id: string }).id, "schedules");
    const rows = await db.select().from(schema.schedules).where(eq(schema.schedules.serverId, row.id)).orderBy(asc(schema.schedules.createdAt));
    return rows.map(toView);
  });

  app.post("/api/servers/:id/schedules", async (req, reply) => {
    const me = requireMe(req);
    const ip = req.ip;
    const { row } = await serverFor(me, (req.params as { id: string }).id, "schedules");
    const s = scheduleSchema.parse(req.body);
    if (!Intl.supportedValuesOf("timeZone").includes(s.tz) && s.tz !== "UTC") throw new HttpError(400, "unknown time zone");
    const [created] = await db.insert(schema.schedules).values({ id: randomUUID(), serverId: row.id, ...s }).returning();
    await audit(db, { userId: me.id, action: "schedule.create", serverId: row.id, ip, detail: s });
    return reply.code(201).send(toView(created!));
  });

  app.put("/api/servers/:id/schedules/:sid", async (req) => {
    const me = requireMe(req);
    const ip = req.ip;
    const { row } = await serverFor(me, (req.params as { id: string }).id, "schedules");
    const sid = String((req.params as { sid?: unknown }).sid);
    const s = scheduleSchema.parse(req.body);
    const [updated] = await db.update(schema.schedules).set(s).where(and(eq(schema.schedules.id, sid), eq(schema.schedules.serverId, row.id))).returning();
    if (!updated) throw new HttpError(404, "schedule not found");
    await audit(db, { userId: me.id, action: "schedule.update", serverId: row.id, ip, detail: { id: sid, ...s } });
    return toView(updated);
  });

  app.delete("/api/servers/:id/schedules/:sid", async (req) => {
    const me = requireMe(req);
    const ip = req.ip;
    const { row } = await serverFor(me, (req.params as { id: string }).id, "schedules");
    const sid = String((req.params as { sid?: unknown }).sid);
    const gone = await db.delete(schema.schedules).where(and(eq(schema.schedules.id, sid), eq(schema.schedules.serverId, row.id))).returning();
    if (!gone.length) throw new HttpError(404, "schedule not found");
    await audit(db, { userId: me.id, action: "schedule.delete", serverId: row.id, ip, detail: { id: sid } });
    return { ok: true };
  });

  // --- settings ------------------------------------------------------------------

  app.get("/api/servers/:id/properties", async (req) => {
    const me = requireMe(req);
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "settings");
    return nodes.client(node).properties(row.id);
  });

  app.put("/api/servers/:id/properties", async (req) => {
    const me = requireMe(req);
    const ip = req.ip;
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "settings");
    const { changes } = propertyChangesSchema.parse(req.body);
    // Check here too, so a bad value never reaches the node.
    for (const [k, v] of Object.entries(changes)) {
      const r = checkProperty(k, v);
      if (!r.ok) throw new HttpError(400, r.error);
    }
    const client = nodes.client(node);
    const before = (await client.properties(row.id)).values;
    const result = await client.setProperties(row.id, changes);
    const diff = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, { from: before[k] ?? null, to: v }]));
    await audit(db, { userId: me.id, action: "settings.save", serverId: row.id, ip, detail: { diff, backup: result.backup } });
    return result;
  });

  // --- players -------------------------------------------------------------------

  app.get("/api/servers/:id/players", async (req) => {
    const me = requireMe(req);
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "players");
    return nodes.client(node).players(row.id);
  });

  app.post("/api/servers/:id/players/action", async (req) => {
    const me = requireMe(req);
    const ip = req.ip;
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "players");
    const action = playerActionSchema.parse(req.body);
    const result = await nodes.client(node).playerAction(row.id, action);
    await audit(db, { userId: me.id, action: `player.${action.action}`, serverId: row.id, ip, detail: { ...action, answer: result.answer } });
    return result;
  });

  app.post("/api/servers/:id/players/whitelist", async (req) => {
    const me = requireMe(req);
    const ip = req.ip;
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "players");
    const { on } = whitelistToggleSchema.parse(req.body);
    const result = await nodes.client(node).setWhitelist(row.id, on);
    await audit(db, { userId: me.id, action: on ? "whitelist.on" : "whitelist.off", serverId: row.id, ip, detail: result });
    return result;
  });

  // --- files ---------------------------------------------------------------------

  const qp = (req: FastifyRequest, name: string) => String((req.query as Record<string, unknown>)[name] ?? "");
  async function fileTarget(req: FastifyRequest) {
    const me = requireMe(req);
    // Read the address now: after a streamed body the connection details can be gone.
    const ip = req.ip;
    const { row, node } = await serverFor(me, (req.params as { id: string }).id, "files");
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

