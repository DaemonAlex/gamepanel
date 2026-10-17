import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { schema, type Db } from "./db/index.js";
import { startSampler } from "./services/metrics.js";
import { startScheduler } from "./services/schedules.js";
import { Nodes } from "./services/nodes.js";

const cfg = loadConfig();
const sql = postgres(cfg.databaseUrl, { max: 10 });
const db = drizzle(sql, { schema }) as unknown as Db;

// Apply any new migrations before serving.
await migrate(drizzle(sql), { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });

const nodes = new Nodes(db, cfg.appSecret);
const app = await buildApp({ cfg, db, nodes }, { logger: true });
await app.listen({ host: cfg.host, port: cfg.port });
// Graph and warning history: every running server and node, every 30 seconds.
startSampler(db, nodes, (err) => app.log.error(err));
// Scheduled backups, restarts, saves, commands and messages.
startScheduler(db, nodes, (err) => app.log.error(err));
