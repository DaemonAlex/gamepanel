import { mkdir, readdir, rm, stat } from "node:fs/promises";
import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentConfig } from "./config.js";
import { DB_CONTAINER, Databases } from "./databases.js";

// End-to-end against real Docker and MariaDB. Runs only with DB_IT=1, on a
// throwaway machine: it creates and removes the gp-db container and its data.
//   DB_IT=1 GP_IT_ROOT=/tmp/gp-it vitest run src/databases.it.test.ts

const ROOT = process.env.GP_IT_ROOT ?? "/tmp/gp-it";
const cfg = {
  dataRoot: `${ROOT}/servers`,
  secretsRoot: `${ROOT}/secrets`,
  backupRoot: `${ROOT}/backups`,
} as AgentConfig;
const docker = new Docker();
const dbs = new Databases(cfg, docker);
const GAME = "gp-ittest";

async function cleanup() {
  for (const name of [GAME, DB_CONTAINER]) await docker.getContainer(name).remove({ force: true }).catch(() => {});
  for (const n of await docker.listNetworks({ filters: { name: ["gp-db-ittest"] } })) await docker.getNetwork(n.Id).remove().catch(() => {});
  await rm(ROOT, { recursive: true, force: true });
}

async function execIn(container: string, cmd: string[]): Promise<{ code: number; out: string }> {
  const e = await docker.getContainer(container).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const s = await e.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];
  s.on("data", (d: Buffer) => chunks.push(d));
  await new Promise((r) => s.on("end", r));
  return { code: (await e.inspect()).ExitCode ?? -1, out: Buffer.concat(chunks).toString() };
}

describe.skipIf(!process.env.DB_IT)("databases (real MariaDB)", () => {
  let password = "";

  beforeAll(async () => {
    await cleanup();
    await mkdir(`${ROOT}/servers/ittest`, { recursive: true });
    // A stand-in game server: the MariaDB image has a client to test the link with.
    await docker.createContainer({ name: GAME, Image: "mariadb:11.4", Entrypoint: ["sleep", "3600"] }).catch(async () => {
      await new Promise<void>(async (res, rej) => docker.modem.followProgress(await docker.pull("mariadb:11.4"), (e: Error | null) => (e ? rej(e) : res())));
      await docker.createContainer({ name: GAME, Image: "mariadb:11.4", Entrypoint: ["sleep", "3600"] });
    });
    await docker.getContainer(GAME).start();
  }, 300_000);

  afterAll(cleanup, 120_000);

  it("creates a database with a plugin login and links the server to it", async () => {
    const d = await dbs.create("ittest", "coreprotect");
    password = d.password;
    expect(d).toMatchObject({ name: "ittest_coreprotect", user: "ittest_coreprotect", host: "gp-db", port: 3306 });
    // The game container reaches it as gp-db with the plugin login.
    const r = await execIn(GAME, ["mariadb", "-h", "gp-db", "-u", d.user, `-p${d.password}`, d.name, "-e", "CREATE TABLE co_user (id INT PRIMARY KEY, user VARCHAR(40), meta BLOB); INSERT INTO co_user VALUES (1,'Eric',x'cafe'),(2,'Damon',NULL)"]);
    expect(r.code).toBe(0);
    expect((await dbs.list("ittest")).databases[0]).toMatchObject({ name: "ittest_coreprotect", tables: 1 });
  }, 300_000);

  it("makes the link an internal network (no route out)", async () => {
    const net = (await docker.getNetwork("gp-db-ittest").inspect()) as { Internal: boolean; Options: Record<string, string> };
    expect(net.Internal).toBe(true);
    expect(net.Options["com.docker.network.bridge.name"]).toMatch(/^gpdb[0-9a-f]{10}$/);
  });

  it("lists tables and pages through rows", async () => {
    expect(await dbs.tables("ittest", "ittest_coreprotect")).toEqual([expect.objectContaining({ name: "co_user", primaryKey: ["id"] })]);
    const rows = await dbs.rows("ittest", "ittest_coreprotect", "co_user", 0, 50);
    expect(rows.total).toBe(2);
    expect(rows.rows).toEqual([
      ["1", "Eric", "0xcafe"],
      ["2", "Damon", null],
    ]);
    expect(rows.columnInfo.find((c) => c.name === "meta")?.binary).toBe(true);
  });

  it("reads with the read-only login and refuses changes unless asked", async () => {
    const r = await dbs.query("ittest", "ittest_coreprotect", "SELECT user FROM co_user ORDER BY id", false);
    expect(r.rows).toEqual([["Eric"], ["Damon"]]);
    await expect(dbs.query("ittest", "ittest_coreprotect", "DELETE FROM co_user", false)).rejects.toThrow(/Allow changes/);
    await expect(dbs.query("ittest", "ittest_coreprotect", "DROP TABLE co_user", false)).rejects.toThrow(/Allow changes/);
    expect((await dbs.rows("ittest", "ittest_coreprotect", "co_user", 0, 50)).total).toBe(2);
  });

  it("edits and deletes one row, snapshotting the table first", async () => {
    const u = await dbs.updateRow("ittest", "ittest_coreprotect", "co_user", { id: "2" }, { user: "Damon2" });
    expect(u.affected).toBe(1);
    expect(u.snapshot).toMatch(/^ittest_coreprotect-.*-co_user\.sql\.gz$/);
    await expect(dbs.updateRow("ittest", "ittest_coreprotect", "co_user", { id: "1" }, { meta: "x" })).rejects.toThrow(/binary/);
    expect((await dbs.deleteRow("ittest", "ittest_coreprotect", "co_user", { id: "2" })).affected).toBe(1);
    await expect(dbs.deleteRow("ittest", "ittest_coreprotect", "co_user", { id: "2" })).rejects.toThrow(/no longer exists/);
    const snaps = await readdir(`${ROOT}/backups/db-snapshots/ittest`);
    expect(snaps.length).toBe(2);
    expect((await stat(`${ROOT}/backups/db-snapshots/ittest/${snaps[0]}`)).size).toBeGreaterThan(100);
  }, 120_000);

  it("runs a change when asked, after a full snapshot", async () => {
    const r = await dbs.query("ittest", "ittest_coreprotect", "INSERT INTO co_user (id, user) VALUES (3, 'New')", true);
    expect(r.affected).toBe(1);
    expect(r.snapshot).toMatch(/^ittest_coreprotect-[^-].*\.sql\.gz$/);
  }, 120_000);

  it("puts dumps in the server folder for a backup and cleans them up", async () => {
    const dir = `${ROOT}/servers/ittest`;
    const done = await dbs.dumpForBackup("ittest", dir);
    expect(await readdir(`${dir}/.gp-database`)).toEqual(["ittest_coreprotect.sql.gz"]);
    await done();
    await expect(readdir(`${dir}/.gp-database`)).rejects.toThrow();
  }, 120_000);

  it("re-links a replaced game container", async () => {
    await docker.getNetwork("gp-db-ittest").disconnect({ Container: GAME });
    await dbs.relink("ittest");
    const r = await execIn(GAME, ["mariadb", "-h", "gp-db", "-u", "ittest_coreprotect", `-p${password}`, "-e", "SELECT 1"]);
    expect(r.code).toBe(0);
  }, 60_000);

  it("changes the password and deletes with a snapshot", async () => {
    const { password: next } = await dbs.resetPassword("ittest", "ittest_coreprotect");
    expect(next).not.toBe(password);
    expect((await execIn(GAME, ["mariadb", "-h", "gp-db", "-u", "ittest_coreprotect", `-p${password}`, "-e", "SELECT 1"])).code).not.toBe(0);
    const r = await dbs.remove("ittest", "ittest_coreprotect");
    expect(r.snapshot).toMatch(/\.sql\.gz$/);
    expect((await dbs.list("ittest")).databases).toEqual([]);
  }, 120_000);
});
