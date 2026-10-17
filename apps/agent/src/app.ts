import type { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { consoleInSchema, powerActionSchema, serverIdSchema, serverSpecSchema, type ConsoleOut } from "@gamepanel/shared";
import { tokenMatches } from "./auth.js";
import { FileError } from "./files.js";
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
