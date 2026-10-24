import { readFileSync } from "node:fs";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Servers } from "./servers.js";

const cfg = loadConfig();
const servers = new Servers(cfg);
await servers.ensureNetwork();
// Put back each server's private database link (best effort; the routes retry it).
await servers
  .list()
  .then((all) => servers.databases.relinkAll(all.map((s) => s.id)))
  .catch(() => {});

const app = await buildApp(cfg.token, servers, {
  logger: true,
  ...(cfg.tls ? { https: { cert: readFileSync(cfg.tls.certPath), key: readFileSync(cfg.tls.keyPath) } } : {}),
});

await app.listen({ host: cfg.host, port: cfg.port });
