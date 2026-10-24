import type { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import {
  backupNameSchema,
  consoleInSchema,
  dbCreateSchema,
  dbNameSchema,
  dbQuerySchema,
  dbRowEditSchema,
  dbRowsQuerySchema,
  playerActionSchema,
  propertyChangesSchema,
  powerActionSchema,
  serverIdSchema,
  serverSpecSchema,
  whitelistToggleSchema,
  type ConsoleOut,
} from "@gamepanel/shared";
import { tokenMatches } from "./auth.js";
import { BackupError } from "./backups.js";
import { DbError } from "./db-sql.js";
import { FileError } from "./files.js";
import { listLogs, readLog } from "./logs.js";
import { installFromUrl, listPlugins, setEnabled } from "./plugins.js";
import { ImportError } from "./import.js";
import { ConflictError, type Servers } from "./servers.js";

// The agent's HTTP API. Every route needs the bearer token; the panel is the only caller.

function parseId(params: unknown): string {
  return serverIdSchema.parse((params as { id?: unknown }).id);
}

export async function buildApp(token: string, servers: Servers, opts: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 64 * 1024, ...opts });
  await app.register(websocket, { options: { maxPayload: 4 * 1024 } });

  app.addHook("onRequest", async (req, reply) => {
    if (!tokenMatches(req.headers.authorization, token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ConflictError) return reply.code(409).send({ error: err.message });
    if (err instanceof ImportError) return reply.code(422).send({ error: err.message });
    if (err instanceof FileError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof BackupError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof DbError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid request" });
    app.log.error(err);
    return reply.code(500).send({ error: "agent error" });
  });

  app.get("/v1/health", async () => ({ ok: true }));

  app.get("/v1/node", async () => servers.nodeInfo());

  app.get("/v1/servers", async () => servers.list());

  app.get("/v1/servers/:id/sample", async (req, reply) => {
    const id = parseId(req.params);
    const status = await servers.status(id);
    if (status.state !== "running" && status.state !== "starting") return reply.code(409).send({ error: "server is not running" });
    return servers.sample(id);
  });

  app.get("/v1/servers/:id/players", async (req) => servers.players(parseId(req.params)));

  app.post("/v1/servers/:id/players/action", async (req) => ({
    answer: await servers.playerAction(parseId(req.params), playerActionSchema.parse(req.body)),
  }));

  app.post("/v1/servers/:id/players/whitelist", async (req) => ({
    answer: await servers.setWhitelist(parseId(req.params), whitelistToggleSchema.parse(req.body).on),
  }));

  app.get("/v1/servers/:id/properties", async (req) => ({ values: await servers.properties(parseId(req.params)) }));

  app.put("/v1/servers/:id/properties", async (req) => servers.setProperties(parseId(req.params), propertyChangesSchema.parse(req.body).changes));

  // --- plugins and mods ------------------------------------------------------
  const folderOf = (req: { query: unknown }) => {
    const f = (req.query as { folder?: string }).folder;
    if (f !== "plugins" && f !== "mods") throw new FileError("folder must be plugins or mods");
    return f;
  };

  app.get("/v1/servers/:id/plugins", async (req) => listPlugins(servers.files(parseId(req.params)), folderOf(req)));

  app.post("/v1/servers/:id/plugins/enabled", async (req) => {
    const { file, on } = (req.body ?? {}) as { file?: unknown; on?: unknown };
    return { file: await setEnabled(servers.files(parseId(req.params)), folderOf(req), String(file ?? ""), on === true) };
  });

  app.post("/v1/servers/:id/plugins/install", async (req) => {
    const b = (req.body ?? {}) as { url?: unknown; filename?: unknown; sha512?: unknown; sha256?: unknown; sha1?: unknown };
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return installFromUrl(servers.files(parseId(req.params)), folderOf(req), {
      url: String(b.url ?? ""),
      filename: String(b.filename ?? ""),
      ...(str(b.sha512) ? { sha512: str(b.sha512)! } : {}),
      ...(str(b.sha256) ? { sha256: str(b.sha256)! } : {}),
      ...(str(b.sha1) ? { sha1: str(b.sha1)! } : {}),
    });
  });

  // --- databases ---------------------------------------------------------------
  const dbOf = (params: unknown) => ({ id: parseId(params), db: dbNameSchema.parse((params as { db?: unknown }).db) });

  app.get("/v1/servers/:id/databases", async (req) => servers.databases.list(parseId(req.params)));

  app.post("/v1/servers/:id/databases", async (req) => servers.databases.create(parseId(req.params), dbCreateSchema.parse(req.body).label));

  app.get("/v1/servers/:id/databases/:db/password", async (req) => {
    const { id, db } = dbOf(req.params);
    return servers.databases.password(id, db);
  });

  app.post("/v1/servers/:id/databases/:db/password", async (req) => {
    const { id, db } = dbOf(req.params);
    return servers.databases.resetPassword(id, db);
  });

  app.delete("/v1/servers/:id/databases/:db", async (req) => {
    const { id, db } = dbOf(req.params);
    return servers.databases.remove(id, db);
  });

  app.get("/v1/servers/:id/databases/:db/tables", async (req) => {
    const { id, db } = dbOf(req.params);
    return servers.databases.tables(id, db);
  });

  app.get("/v1/servers/:id/databases/:db/rows", async (req) => {
    const { id, db } = dbOf(req.params);
    const q = dbRowsQuerySchema.parse(req.query);
    return servers.databases.rows(id, db, q.table, q.page, q.pageSize);
  });

  app.post("/v1/servers/:id/databases/:db/query", async (req) => {
    const { id, db } = dbOf(req.params);
    const q = dbQuerySchema.parse(req.body);
    return servers.databases.query(id, db, q.sql, q.write);
  });

  app.post("/v1/servers/:id/databases/:db/rows/update", { bodyLimit: 1024 * 1024 }, async (req) => {
    const { id, db } = dbOf(req.params);
    const e = dbRowEditSchema.parse(req.body);
    return servers.databases.updateRow(id, db, e.table, e.key, e.set ?? {});
  });

  app.post("/v1/servers/:id/databases/:db/rows/delete", { bodyLimit: 1024 * 1024 }, async (req) => {
    const { id, db } = dbOf(req.params);
    const e = dbRowEditSchema.parse(req.body);
    return servers.databases.deleteRow(id, db, e.table, e.key);
  });

  // --- logs --------------------------------------------------------------------
  app.get("/v1/servers/:id/logs", async (req) => listLogs(servers.files(parseId(req.params))));

  app.get("/v1/servers/:id/logs/read", async (req) => {
    const qy = req.query as { path?: string; search?: string; tail?: string };
    return readLog(servers.files(parseId(req.params)), String(qy.path ?? ""), {
      ...(qy.search ? { search: qy.search.slice(0, 200) } : {}),
      ...(qy.tail ? { tail: Number(qy.tail) } : {}),
    });
  });

  // --- backups ---------------------------------------------------------------
  const bname = (params: unknown) => backupNameSchema.parse((params as { name?: unknown }).name);

  app.get("/v1/servers/:id/backups", async (req) => {
    const id = parseId(req.params);
    return { backups: await servers.backups.list(id), jobs: servers.backups.jobsFor(id) };
  });

  app.post("/v1/servers/:id/backups", async (req) => {
    const { reason, keep } = (req.body ?? {}) as { reason?: unknown; keep?: unknown };
    const k = keep === undefined ? undefined : Number(keep);
    if (k !== undefined && (!Number.isInteger(k) || k < 1 || k > 1000)) throw new BackupError("keep must be 1 to 1000", 400);
    return servers.backups.start(parseId(req.params), reason === "schedule" ? "schedule" : "manual", k);
  });

  app.post("/v1/servers/:id/backups/restore", async (req) => {
    const { name } = (req.body ?? {}) as { name?: unknown };
    return servers.backups.restore(parseId(req.params), backupNameSchema.parse(name));
  });

  app.post("/v1/servers/:id/backups/prune", async (req) => {
    const { keep } = (req.body ?? {}) as { keep?: unknown };
    const n = Number(keep);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new BackupError("keep must be 1 to 1000", 400);
    return { removed: await servers.backups.prune(parseId(req.params), n) };
  });

  app.get("/v1/servers/:id/backups/:name/download", async (req, reply) => {
    const name = bname(req.params);
    const b = await servers.backups.download(parseId(req.params), name);
    reply.header("content-type", "application/gzip");
    reply.header("content-length", String(b.bytes));
    reply.header("content-disposition", `attachment; filename="${name}"`);
    return reply.send(b.stream);
  });

  app.delete("/v1/servers/:id/backups/:name", async (req, reply) => {
    await servers.backups.remove(parseId(req.params), bname(req.params));
    return reply.code(204).send();
  });

  // Disk cap for a server folder (XFS project quota), and current use against it.
  app.put("/v1/servers/:id/disk", async (req) => {
    const id = parseId(req.params);
    const gb = Number((req.body as { gb?: unknown } | undefined)?.gb);
    if (!Number.isInteger(gb) || gb < 1 || gb > 10000) throw new FileError("gb must be 1 to 10000");
    return servers.setDisk(id, gb);
  });

  app.get("/v1/servers/:id/disk", async (req) => servers.quotas.usage(parseId(req.params)));

  app.get("/v1/servers/:id/info", async (req) => servers.info(parseId(req.params)));

  app.get("/v1/servers/:id/stats", async (req, reply) => {
    const id = parseId(req.params);
    const status = await servers.status(id);
    if (status.state !== "running" && status.state !== "starting") return reply.code(409).send({ error: "server is not running" });
    return servers.stats(id);
  });

  app.get("/v1/servers/:id", async (req) => servers.status(parseId(req.params)));

  app.put("/v1/servers/:id", async (req, reply) => {
    const id = parseId(req.params);
    const spec = serverSpecSchema.parse(req.body);
    if (spec.id !== id) return reply.code(400).send({ error: "id in path and body differ" });
    return servers.apply(spec);
  });

  app.post("/v1/servers/:id/power", async (req) => {
    const id = parseId(req.params);
    const { action } = (req.body ?? {}) as { action?: unknown };
    return servers.power(id, powerActionSchema.parse(action));
  });

  // Uploads arrive as a raw stream; the import code enforces its own size caps.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  app.post("/v1/servers/:id/import", async (req) => {
    const id = parseId(req.params);
    const format = (req.query as { format?: string }).format;
    if (format !== "tar.gz" && format !== "zip") throw new ImportError("format must be tar.gz or zip");
    return servers.importArchive(id, format, req.body as Readable);
  });

  // One console command without a WebSocket (broadcasts, scheduled tasks).
  app.post("/v1/servers/:id/command", async (req, reply) => {
    const id = parseId(req.params);
    const { cmd } = consoleInSchema.parse({ t: "cmd", ...((req.body ?? {}) as object) });
    await servers.sendCommand(id, cmd);
    return reply.code(204).send();
  });

  // --- files ------------------------------------------------------------------
  const q = (req: { query: unknown }, name: string) => String((req.query as Record<string, unknown>)[name] ?? "");

  app.get("/v1/servers/:id/files", async (req) => servers.files(parseId(req.params)).list(q(req, "path")));

  app.get("/v1/servers/:id/files/content", async (req) => ({ text: await servers.files(parseId(req.params)).readText(q(req, "path")) }));

  app.put("/v1/servers/:id/files/content", { bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
    const { text } = (req.body ?? {}) as { text?: unknown };
    if (typeof text !== "string") throw new FileError("text is required");
    await servers.files(parseId(req.params)).writeText(q(req, "path"), text);
    return reply.code(204).send();
  });

  app.get("/v1/servers/:id/files/download", async (req, reply) => {
    const f = await servers.files(parseId(req.params)).download(q(req, "path"));
    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", String(f.size));
    reply.header("content-disposition", `attachment; filename="${f.name.replace(/[^\w.-]/g, "_")}"`);
    return reply.send(f.stream);
  });

  app.post("/v1/servers/:id/files/upload", async (req) => {
    const offset = Number(q(req, "offset") || "0");
    if (!Number.isInteger(offset) || offset < 0) throw new FileError("bad offset");
    return servers.files(parseId(req.params)).uploadChunk(q(req, "path"), offset, q(req, "done") === "1", req.body as Readable);
  });

  app.post("/v1/servers/:id/files/mkdir", async (req, reply) => {
    const { path } = (req.body ?? {}) as { path?: unknown };
    await servers.files(parseId(req.params)).mkdir(String(path ?? ""));
    return reply.code(204).send();
  });

  app.post("/v1/servers/:id/files/rename", async (req, reply) => {
    const { from, to } = (req.body ?? {}) as { from?: unknown; to?: unknown };
    await servers.files(parseId(req.params)).rename(String(from ?? ""), String(to ?? ""));
    return reply.code(204).send();
  });

  app.delete("/v1/servers/:id/files", async (req) => ({ trashedTo: await servers.files(parseId(req.params)).remove(q(req, "path")) }));

  app.delete("/v1/servers/:id", async (req, reply) => {
    await servers.removeContainer(parseId(req.params));
    return reply.code(204).send();
  });

  // Live console: server output out, one command per message in.
  app.get("/v1/servers/:id/console", { websocket: true }, async (socket, req) => {
    const send = (msg: ConsoleOut) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    let id: string;
    try {
      id = parseId(req.params);
    } catch {
      socket.close(1008, "bad server id");
      return;
    }

    let stream: Awaited<ReturnType<Servers["logs"]>>;
    try {
      stream = await servers.logs(id);
    } catch {
      send({ t: "notice", text: "server not found" });
      socket.close(1011, "no logs");
      return;
    }

    let partial = "";
    stream.on("data", (chunk: Buffer) => {
      const lines = (partial + chunk.toString("utf8")).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) send({ t: "line", line: line.replace(/\r$/, "") });
    });
    stream.on("end", () => {
      send({ t: "notice", text: "log stream ended" });
      socket.close(1000, "ended");
    });

    socket.on("message", (data: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        send({ t: "notice", text: "message is not JSON" });
        return;
      }
      const msg = consoleInSchema.safeParse(parsed);
      if (!msg.success) {
        send({ t: "notice", text: "commands must be one line" });
        return;
      }
      servers.sendCommand(id, msg.data.cmd).catch(() => send({ t: "notice", text: "command was not delivered" }));
    });

    socket.on("close", () => stream.destroy());
  });

  return app;
}
