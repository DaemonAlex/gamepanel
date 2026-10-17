import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

// The app works with any Drizzle Postgres driver: postgres.js in production,
// PGlite (Postgres in memory) in tests.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export { schema };
