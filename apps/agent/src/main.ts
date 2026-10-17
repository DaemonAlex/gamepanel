import { readFileSync } from "node:fs";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Servers } from "./servers.js";

const cfg = loadConfig();
const servers = new Servers(cfg);
await servers.ensureNetwork();

const app = await buildApp(cfg.token, servers, {
  logger: true,
  ...(cfg.tls ? { https: { cert: readFileSync(cfg.tls.certPath), key: readFileSync(cfg.tls.keyPath) } } : {}),
});

await app.listen({ host: cfg.host, port: cfg.port });
