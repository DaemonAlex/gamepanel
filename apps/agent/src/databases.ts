import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type Docker from "dockerode";
import mysql from "mysql2/promise";
import type { ColumnInfo, DatabaseInfo, DatabasesView, QueryResult, ServerId, TableInfo, TableRows } from "@gamepanel/shared";
import type { AgentConfig } from "./config.js";
import { containerName } from "./containers.js";
import { buildDelete, buildExists, buildUpdate, DbError, dbNameFor, formatCell, isBinaryType, linkBridge, linkNetwork, quoteId, readOnlyUser, stamp } from "./db-sql.js";

// One MariaDB per node, run as a container. Plugins reach it as "gp-db" over a
// private network per server (gp-db-<id>, internal: no internet, no other
// servers). The agent reaches it on 127.0.0.1 only. Each database has two
// logins: one for plugins (full rights on that database only) and a read-only
// one the panel uses unless the user asks to change data.

export const DB_CONTAINER = "gp-db";
const DB_IMAGE = "mariadb:11.4";
const AGENT_PORT = 33306;
// Not the game-server label: these are services, not servers.
const SERVICE_LABEL = "gamepanel.service";
const MAX_PER_SERVER = 5;
const MAX_ROWS = 1000;
const SNAPSHOTS_KEPT = 10;

interface Registered {
  name: string;
  user: string;
  password: string;
  readPassword: string;
  createdAt: string;
}

const isNotFound = (err: unknown) => (err as { statusCode?: number })?.statusCode === 404;
const password = () => randomBytes(18).toString("base64url");

export class Databases {
  private rootPool: mysql.Pool | null = null;

  constructor(
    private readonly cfg: AgentConfig,
    private readonly docker: Docker,
  ) {}

  private get base() {
    return this.cfg.dataRoot.replace(/\/servers$/, "");
  }
  private get rootFile() {
    return `${this.cfg.secretsRoot}/db/root-password`;
  }
  private registryFile(id: ServerId) {
    return `${this.cfg.secretsRoot}/${id}/databases.json`;
  }

  // --- the service ---------------------------------------------------------------

  async running(): Promise<boolean> {
    try {
      return (await this.docker.getContainer(DB_CONTAINER).inspect()).State.Running;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  private async rootPassword(): Promise<string> {
    try {
      return (await readFile(this.rootFile, "utf8")).trim();
    } catch {
      await mkdir(dirname(this.rootFile), { recursive: true, mode: 0o700 });
      const pw = password();
      await writeFile(this.rootFile, pw, { flag: "wx", mode: 0o400 });
      return pw;
    }
  }

  // Create and start the database service the first time it is needed.
  async ensureService(): Promise<void> {
    const pw = await this.rootPassword();
    let info: Docker.ContainerInspectInfo | null = null;
    try {
      info = await this.docker.getContainer(DB_CONTAINER).inspect();
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    if (!info) {
      await this.pull(DB_IMAGE);
      const dataDir = `${this.base}/db`;
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await this.docker.createContainer({
        name: DB_CONTAINER,
        Image: DB_IMAGE,
        Env: ["MARIADB_ROOT_PASSWORD_FILE=/run/secrets/db-root", "MARIADB_AUTO_UPGRADE=1"],
        Cmd: ["--innodb-buffer-pool-size=512M", "--max-connections=200", "--skip-name-resolve", "--character-set-server=utf8mb4", "--collation-server=utf8mb4_unicode_ci"],
        Labels: { [SERVICE_LABEL]: "database" },
        HostConfig: {
          Binds: [`${dataDir}:/var/lib/mysql`, `${this.rootFile}:/run/secrets/db-root:ro`],
          PortBindings: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: String(AGENT_PORT) }] },
          RestartPolicy: { Name: "unless-stopped" },
          Memory: 2 * 1024 ** 3,
          SecurityOpt: ["no-new-privileges"],
        },
      });
    }
    if (!info?.State.Running) await this.docker.getContainer(DB_CONTAINER).start();
    // The first start initialises the data folder; wait until it answers.
    for (let i = 0; i < 60; i++) {
      try {
        const c = await mysql.createConnection({ host: "127.0.0.1", port: AGENT_PORT, user: "root", password: pw, connectTimeout: 2000 });
        await c.end();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new DbError("the database service did not start", 503);
  }

  private async pull(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => this.docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve())));
  }

  private async root(): Promise<mysql.Pool> {
    if (!this.rootPool) {
      this.rootPool = mysql.createPool({
        host: "127.0.0.1",
        port: AGENT_PORT,
        user: "root",
        password: await this.rootPassword(),
        connectionLimit: 4,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
      });
    }
    return this.rootPool;
  }

  // --- the private link -----------------------------------------------------------

  // Connect the server's container and the database service on the server's own
  // internal network. Safe to call any time; does nothing if already linked.
  async link(id: ServerId): Promise<void> {
    const name = linkNetwork(id);
    const found = await this.docker.listNetworks({ filters: { name: [name] } });
    if (!found.some((n) => n.Name === name)) {
      await this.docker.createNetwork({
        Name: name,
        Driver: "bridge",
        Internal: true,
        Options: { "com.docker.network.bridge.name": linkBridge(id) },
        Labels: { [SERVICE_LABEL]: "db-link", "gamepanel.server-id": id },
      });
    }
    const net = this.docker.getNetwork(name);
    const members = Object.values(((await net.inspect()) as { Containers?: Record<string, { Name: string }> }).Containers ?? {}).map((c) => c.Name);
    for (const container of [DB_CONTAINER, containerName(id)]) {
      if (members.includes(container)) continue;
      try {
        await net.connect({ Container: container });
      } catch (err) {
        // The game container may not exist yet; it is linked when it is created.
        if (!isNotFound(err)) throw err;
      }
    }
  }

  // After the agent starts or a server's container is replaced.
  async relink(id: ServerId): Promise<void> {
    if ((await this.registry(id)).length && (await this.running())) await this.link(id);
  }

  async relinkAll(ids: ServerId[]): Promise<void> {
    for (const id of ids) await this.relink(id).catch(() => {});
  }

  // --- registry (per server, beside its RCON secret) -------------------------------

  private async registry(id: ServerId): Promise<Registered[]> {
    try {
      return JSON.parse(await readFile(this.registryFile(id), "utf8")) as Registered[];
    } catch {
      return [];
    }
  }

  private async saveRegistry(id: ServerId, list: Registered[]): Promise<void> {
    await mkdir(dirname(this.registryFile(id)), { recursive: true, mode: 0o711 });
    const tmp = `${this.registryFile(id)}.tmp`;
    await writeFile(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
    await rename(tmp, this.registryFile(id));
  }

  private async entry(id: ServerId, name: string): Promise<Registered> {
    const e = (await this.registry(id)).find((r) => r.name === name);
    if (!e) throw new DbError("database not found", 404);
    return e;
  }

  // --- databases ------------------------------------------------------------------

  async list(id: ServerId): Promise<DatabasesView> {
    const reg = await this.registry(id);
    if (!(await this.running())) return { ready: false, databases: reg.map((r) => this.info(r, 0, 0)) };
    const sizes = new Map<string, { bytes: number; tables: number }>();
    if (reg.length) {
      const [rows] = await (await this.root()).query<mysql.RowDataPacket[]>(
        "SELECT TABLE_SCHEMA s, COUNT(*) t, COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) b FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (?) GROUP BY TABLE_SCHEMA",
        [reg.map((r) => r.name)],
      );
      for (const r of rows) sizes.set(String(r.s), { bytes: Number(r.b), tables: Number(r.t) });
    }
    return { ready: true, databases: reg.map((r) => this.info(r, sizes.get(r.name)?.bytes ?? 0, sizes.get(r.name)?.tables ?? 0)) };
  }

  private info(r: Registered, bytes: number, tables: number): DatabaseInfo {
    return { name: r.name, user: r.user, host: DB_CONTAINER, port: 3306, bytes, tables, createdAt: r.createdAt };
  }

  async create(id: ServerId, label: string): Promise<DatabaseInfo & { password: string }> {
    await this.ensureService();
    const reg = await this.registry(id);
    if (reg.length >= MAX_PER_SERVER) throw new DbError(`a server can have at most ${MAX_PER_SERVER} databases`, 409);
    const name = dbNameFor(id, label);
    const db = await this.root();
    const [exists] = await db.query<mysql.RowDataPacket[]>("SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [name]);
    if (exists.length || reg.some((r) => r.name === name)) throw new DbError("a database with that name already exists", 409);
    const e: Registered = { name, user: name, password: password(), readPassword: password(), createdAt: new Date().toISOString() };
    await db.query(`CREATE DATABASE ${quoteId(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await db.query("CREATE USER ?@'%' IDENTIFIED BY ?", [e.user, e.password]);
    await db.query(`GRANT ALL PRIVILEGES ON ${quoteId(name)}.* TO ?@'%'`, [e.user]);
    await db.query("CREATE USER ?@'%' IDENTIFIED BY ?", [readOnlyUser(e.user), e.readPassword]);
    await db.query(`GRANT SELECT, SHOW VIEW ON ${quoteId(name)}.* TO ?@'%'`, [readOnlyUser(e.user)]);
    await this.saveRegistry(id, [...reg, e]);
    await this.link(id);
    return { ...this.info(e, 0, 0), password: e.password };
  }

  async password(id: ServerId, name: string): Promise<{ password: string }> {
    return { password: (await this.entry(id, name)).password };
  }

  // New password for the plugin login. Plugin configs must be updated after this.
  async resetPassword(id: ServerId, name: string): Promise<{ password: string }> {
    const reg = await this.registry(id);
    const e = reg.find((r) => r.name === name);
    if (!e) throw new DbError("database not found", 404);
    e.password = password();
    await (await this.root()).query("ALTER USER ?@'%' IDENTIFIED BY ?", [e.user, e.password]);
    await this.saveRegistry(id, reg);
    return { password: e.password };
  }

  // A snapshot is always taken first; it stays in the node's backup folder.
  async remove(id: ServerId, name: string): Promise<{ snapshot: string }> {
    const reg = await this.registry(id);
    const e = reg.find((r) => r.name === name);
    if (!e) throw new DbError("database not found", 404);
    const snapshot = await this.snapshot(id, name);
    const db = await this.root();
    await db.query(`DROP DATABASE IF EXISTS ${quoteId(name)}`);
    await db.query("DROP USER IF EXISTS ?@'%'", [e.user]);
    await db.query("DROP USER IF EXISTS ?@'%'", [readOnlyUser(e.user)]);
    await this.saveRegistry(
      id,
      reg.filter((r) => r.name !== name),
    );
    return { snapshot };
  }

  // --- looking inside -------------------------------------------------------------

  private async connect(e: Registered, write: boolean): Promise<mysql.Connection> {
    const c = await mysql.createConnection({
      host: "127.0.0.1",
      port: AGENT_PORT,
      user: write ? e.user : readOnlyUser(e.user),
      password: write ? e.password : e.readPassword,
      database: e.name,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
      connectTimeout: 5000,
    });
    // No single panel query may run longer than 30 seconds.
    await c.query("SET SESSION max_statement_time = 30");
    return c;
  }

  async tables(id: ServerId, name: string): Promise<TableInfo[]> {
    await this.entry(id, name);
    const db = await this.root();
    const [t] = await db.query<mysql.RowDataPacket[]>(
      "SELECT TABLE_NAME n, COALESCE(TABLE_ROWS, 0) r, COALESCE(DATA_LENGTH + INDEX_LENGTH, 0) b FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
      [name],
    );
    const [k] = await db.query<mysql.RowDataPacket[]>(
      "SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY TABLE_NAME, ORDINAL_POSITION",
      [name],
    );
    return t.map((r) => ({ name: String(r.n), rows: Number(r.r), bytes: Number(r.b), primaryKey: k.filter((x) => x.t === r.n).map((x) => String(x.c)) }));
  }

  private async table(id: ServerId, name: string, table: string): Promise<{ info: TableInfo; columns: ColumnInfo[] }> {
    const info = (await this.tables(id, name)).find((t) => t.name === table);
    if (!info) throw new DbError("table not found", 404);
    const [cols] = await (await this.root()).query<mysql.RowDataPacket[]>(
      "SELECT COLUMN_NAME n, COLUMN_TYPE t, DATA_TYPE d, IS_NULLABLE nl FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
      [name, table],
    );
    return { info, columns: cols.map((c) => ({ name: String(c.n), type: String(c.t), nullable: c.nl === "YES", binary: isBinaryType(String(c.d)) })) };
  }

  async rows(id: ServerId, name: string, table: string, page: number, pageSize: number): Promise<TableRows> {
    const e = await this.entry(id, name);
    const { info, columns } = await this.table(id, name, table);
    const c = await this.connect(e, false);
    try {
      // Exact counts are slow on big tables; the estimate is fine there.
      let total = info.rows;
      if (total < 100_000) {
        const [n] = await c.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) n FROM ${quoteId(table)}`);
        total = Number(n[0]?.n ?? 0);
      }
      const order = info.primaryKey.length ? ` ORDER BY ${info.primaryKey.map(quoteId).join(", ")}` : "";
      const [rows] = await c.query<mysql.RowDataPacket[]>({ sql: `SELECT * FROM ${quoteId(table)}${order} LIMIT ? OFFSET ?`, rowsAsArray: true }, [pageSize, page * pageSize]);
      return {
        columns: columns.map((x) => x.name),
        columnInfo: columns,
        primaryKey: info.primaryKey,
        rows: (rows as unknown as unknown[][]).map((r) => r.map(formatCell)),
        truncated: false,
        page,
        pageSize,
        total,
      };
    } finally {
      await c.end();
    }
  }

  // One statement. Read-only unless `write`; a write takes a snapshot first.
  async query(id: ServerId, name: string, sql: string, write: boolean): Promise<QueryResult> {
    const e = await this.entry(id, name);
    const snapshot = write ? await this.snapshot(id, name) : undefined;
    const c = await this.connect(e, write);
    try {
      const [res, fields] = await c.query({ sql, rowsAsArray: true });
      if (Array.isArray(res)) {
        const rows = res as unknown as unknown[][];
        return { columns: (fields ?? []).map((f) => f.name), rows: rows.slice(0, MAX_ROWS).map((r) => r.map(formatCell)), truncated: rows.length > MAX_ROWS, ...(snapshot ? { snapshot } : {}) };
      }
      return { columns: [], rows: [], affected: (res as mysql.ResultSetHeader).affectedRows, truncated: false, ...(snapshot ? { snapshot } : {}) };
    } catch (err) {
      throw this.friendly(err, write);
    } finally {
      await c.end();
    }
  }

  async updateRow(id: ServerId, name: string, table: string, key: Record<string, string | null>, set: Record<string, string | null>): Promise<QueryResult> {
    const { info, columns } = await this.table(id, name, table);
    const q = buildUpdate(table, info.primaryKey, new Set(columns.filter((x) => x.binary).map((x) => x.name)), key, set);
    return this.runEdit(id, name, table, q, buildExists(table, info.primaryKey, key));
  }

  async deleteRow(id: ServerId, name: string, table: string, key: Record<string, string | null>): Promise<QueryResult> {
    const { info } = await this.table(id, name, table);
    return this.runEdit(id, name, table, buildDelete(table, info.primaryKey, key), buildExists(table, info.primaryKey, key));
  }

  private async runEdit(id: ServerId, name: string, table: string, q: { sql: string; params: (string | null)[] }, exists: { sql: string; params: (string | null)[] }): Promise<QueryResult> {
    const e = await this.entry(id, name);
    const check = await this.connect(e, false);
    try {
      const [found] = await check.execute<mysql.RowDataPacket[]>(exists.sql, exists.params);
      if (!found.length) throw new DbError("that row no longer exists", 409);
    } finally {
      await check.end();
    }
    // Only the one table is saved first: a whole big database would take too long per row.
    const snapshot = await this.snapshot(id, name, table);
    const c = await this.connect(e, true);
    try {
      const [res] = await c.execute<mysql.ResultSetHeader>(q.sql, q.params);
      if (res.affectedRows === 0) throw new DbError("nothing changed: the row already has those values", 409);
      return { columns: [], rows: [], affected: res.affectedRows, truncated: false, snapshot };
    } catch (err) {
      throw this.friendly(err, true);
    } finally {
      await c.end();
    }
  }

  private friendly(err: unknown, write: boolean): Error {
    if (err instanceof DbError) return err;
    const e = err as { errno?: number; sqlMessage?: string; message?: string };
    // Access denied for the read-only login: the query tried to change something.
    if (!write && [1044, 1142, 1143, 1227, 1370].includes(e.errno ?? 0)) return new DbError("this query changes data; tick \"Allow changes\" to run it");
    if (e.errno === 1969) return new DbError("the query took longer than 30 seconds and was stopped");
    return new DbError(e.sqlMessage ?? e.message ?? "query failed");
  }

  // --- snapshots and backups ------------------------------------------------------

  private async dump(name: string, table: string | undefined, file: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o750 });
    const exec = await this.docker.getContainer(DB_CONTAINER).exec({
      Cmd: ["mariadb-dump", "--single-transaction", "--quick", "--skip-lock-tables", "--hex-blob", "-uroot", name, ...(table ? [table] : [])],
      Env: [`MYSQL_PWD=${await this.rootPassword()}`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const out = new PassThrough();
    const err: Buffer[] = [];
    const errSink = new PassThrough();
    errSink.on("data", (d: Buffer) => err.push(d));
    this.docker.modem.demuxStream(stream, out, errSink);
    stream.on("end", () => out.end());
    await pipeline(out, createGzip(), createWriteStream(file, { mode: 0o640 }));
    const { ExitCode } = await exec.inspect();
    if (ExitCode !== 0) {
      await rm(file, { force: true });
      throw new DbError(`snapshot failed: ${Buffer.concat(err).toString().trim().slice(0, 200)}`, 500);
    }
  }

  // Saved before every change: <backups>/db-snapshots/<id>/<db>-<time>[-<table>].sql.gz
  async snapshot(id: ServerId, name: string, table?: string): Promise<string> {
    const dir = `${this.cfg.backupRoot}/db-snapshots/${id}`;
    const fileName = `${name}-${stamp()}${table ? `-${table.replace(/[^A-Za-z0-9_-]/g, "_")}` : ""}.sql.gz`;
    await this.dump(name, table, join(dir, fileName));
    // Keep the newest few per database.
    const mine = (await readdir(dir)).filter((f) => f.startsWith(`${name}-`)).sort().reverse();
    for (const old of mine.slice(SNAPSHOTS_KEPT)) await rm(join(dir, old), { force: true });
    return fileName;
  }

  // For server backups: write each database into the server folder before it is
  // archived. Returns the cleanup to run afterwards.
  async dumpForBackup(id: ServerId, serverFolder: string): Promise<() => Promise<void>> {
    const reg = await this.registry(id);
    const dir = join(serverFolder, ".gp-database");
    if (!reg.length || !(await this.running())) return async () => {};
    for (const e of reg) await this.dump(e.name, undefined, join(dir, `${e.name}.sql.gz`));
    await chmod(dir, 0o750);
    return async () => {
      await rm(dir, { recursive: true, force: true });
    };
  }
}
