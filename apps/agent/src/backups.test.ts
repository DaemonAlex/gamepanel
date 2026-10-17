import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupName, Backups, LocalStore } from "./backups.js";

let base: string;
let dataRoot: string;
let running: boolean;
const rcon = vi.fn(async (_id: string, cmds: string[]) => cmds.map(() => ""));

function make() {
  return new Backups(new LocalStore(join(base, "archives")), {
    serverDir: (id) => join(dataRoot, id),
    dataRoot,
    preRestoreRoot: join(base, "pre-restore"),
    isRunning: async () => running,
    rcon,
    uid: userInfo().uid,
  });
}

async function waitFor(b: Backups, id: string) {
  for (let i = 0; i < 200; i++) {
    const j = b.jobsFor(id)[0];
    if (j && j.state !== "running") return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("job did not finish");
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "gp-backups-"));
  dataRoot = join(base, "servers");
  const s = join(dataRoot, "pw");
  await mkdir(join(s, "world"), { recursive: true });
  await mkdir(join(s, "libraries"), { recursive: true });
  await writeFile(join(s, "world", "level.dat"), "world-v1");
  await writeFile(join(s, "server.properties"), "motd=Hi\nserver-port=25565\n");
  await writeFile(join(s, "libraries", "big.jar"), "re-downloaded on start");
  await writeFile(join(base, "secret"), "host secret");
  await symlink(join(base, "secret"), join(s, "sneaky"));
  running = false;
  rcon.mockClear();
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe("backups", () => {
  it("backs up and restores, leaving out re-downloaded files and links", async () => {
    const b = make();
    await b.start("pw");
    const job = await waitFor(b, "pw");
    expect(job).toMatchObject({ state: "done", kind: "backup" });
    const [entry] = await b.list("pw");
    expect(entry).toMatchObject({ name: job.backup, reason: "manual" });
    expect(entry!.bytes).toBeGreaterThan(0);

    // Change the world, then restore.
    await writeFile(join(dataRoot, "pw", "world", "level.dat"), "world-v2");
    await b.restore("pw", entry!.name);
    const r = await waitFor(b, "pw");
    expect(r).toMatchObject({ state: "done", kind: "restore" });
    expect(await readFile(join(dataRoot, "pw", "world", "level.dat"), "utf8")).toBe("world-v1");
    const names = await readdir(join(dataRoot, "pw"));
    expect(names).not.toContain("libraries");
    expect(names).not.toContain("sneaky");

    // The folder that was there is kept, not deleted.
    const aside = await readdir(join(base, "pre-restore"));
    expect(aside).toHaveLength(1);
    expect(await readFile(join(base, "pre-restore", aside[0]!, "world", "level.dat"), "utf8")).toBe("world-v2");
  });

  it("pauses world saving around a backup of a running server", async () => {
    running = true;
    const b = make();
    await b.start("pw");
    await waitFor(b, "pw");
    expect(rcon.mock.calls.map((c) => c[1])).toEqual([["save-off", "save-all flush"], ["save-on"]]);
  });

  it("will not restore over a running server", async () => {
    const b = make();
    await b.start("pw");
    const job = await waitFor(b, "pw");
    running = true;
    await expect(b.restore("pw", job.backup!)).rejects.toThrow(/stop the server/);
  });

  it("runs one job per server at a time", async () => {
    const b = make();
    await b.start("pw");
    await expect(b.start("pw")).rejects.toThrow(/already running/);
    await waitFor(b, "pw");
  });

  it("keeps only the newest N", async () => {
    const b = make();
    const store = new LocalStore(join(base, "archives"));
    for (const d of ["2026-10-01", "2026-10-02", "2026-10-03"]) {
      const w = await store.writer("pw", backupName("manual", new Date(`${d}T00:00:00Z`)));
      w.stream.end("x");
      await new Promise((r) => w.stream.on("finish", r));
      await w.commit();
    }
    const removed = await b.prune("pw", 2);
    expect(removed).toEqual(["2026-10-01T00-00-00-000Z-manual.tar.gz"]);
    expect((await b.list("pw")).map((x) => x.name.slice(0, 10))).toEqual(["2026-10-03", "2026-10-02"]);
  });

  it("trims old backups after a good backup when asked", async () => {
    const b = make();
    const store = new LocalStore(join(base, "archives"));
    const w = await store.writer("pw", backupName("manual", new Date("2026-01-01T00:00:00Z")));
    w.stream.end("old");
    await new Promise((r) => w.stream.on("finish", r));
    await w.commit();
    await b.start("pw", "schedule", 1);
    await waitFor(b, "pw");
    await new Promise((r) => setTimeout(r, 50));
    const list = await b.list("pw");
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toBe("schedule");
  });

  it("refuses names that are not backups", async () => {
    const b = make();
    await expect(b.download("pw", "../../etc/passwd")).rejects.toThrow();
  });
});
