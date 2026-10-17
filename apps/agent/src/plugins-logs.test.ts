import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerFiles } from "./files.js";
import { readLog, listLogs } from "./logs.js";
import { installFromUrl, listPlugins, setEnabled } from "./plugins.js";

let base: string;
let root: string;
let files: ServerFiles;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "gp-pl-"));
  root = join(base, "s");
  await mkdir(join(root, "plugins"), { recursive: true });
  await mkdir(join(root, "logs"), { recursive: true });
  await mkdir(join(root, "crash-reports"), { recursive: true });
  files = new ServerFiles(root, join(base, "trash"), userInfo().uid);
});
afterEach(() => rm(base, { recursive: true, force: true }));

const jar = Buffer.from("not really a jar");
const sha512 = createHash("sha512").update(jar).digest("hex");
const fakeFetch = (async () => new Response(jar)) as unknown as typeof fetch;

describe("plugins", () => {
  it("installs from Modrinth when the hash matches", async () => {
    const r = await installFromUrl(files, "plugins", { url: "https://cdn.modrinth.com/data/x/versions/y/WorldEdit.jar", filename: "WorldEdit.jar", sha512 }, fakeFetch);
    expect(r).toEqual({ file: "WorldEdit.jar", bytes: jar.length });
    expect(await readdir(join(root, "plugins"))).toEqual(["WorldEdit.jar"]);
  });

  it("installs nothing when the hash does not match", async () => {
    await expect(installFromUrl(files, "plugins", { url: "https://cdn.modrinth.com/x.jar", filename: "x.jar", sha512: "ab".repeat(64) }, fakeFetch)).rejects.toThrow(/does not match/);
    expect(await readdir(join(root, "plugins"))).toEqual([]);
  });

  it.each([
    ["http://cdn.modrinth.com/x.jar", "x.jar", /only allowed/],
    ["https://evil.example.com/x.jar", "x.jar", /only allowed/],
    ["https://cdn.modrinth.com/x.jar", "../x.jar", /jar file name/],
    ["https://cdn.modrinth.com/x.jar", "x.sh", /jar file name/],
  ])("refuses %s as %s", async (url, filename, msg) => {
    await expect(installFromUrl(files, "plugins", { url, filename, sha512 }, fakeFetch)).rejects.toThrow(msg);
  });

  it("needs a published hash", async () => {
    await expect(installFromUrl(files, "plugins", { url: "https://cdn.modrinth.com/x.jar", filename: "x.jar" }, fakeFetch)).rejects.toThrow(/hash/);
  });

  it("turns a plugin off and on by renaming it", async () => {
    await writeFile(join(root, "plugins", "Essentials.jar"), "x");
    expect(await setEnabled(files, "plugins", "Essentials.jar", false)).toBe("Essentials.jar.disabled");
    expect((await listPlugins(files, "plugins")).map((p) => [p.file, p.enabled])).toEqual([["Essentials.jar.disabled", false]]);
    expect(await setEnabled(files, "plugins", "Essentials.jar.disabled", true)).toBe("Essentials.jar");
    await expect(setEnabled(files, "plugins", "notes.txt", false)).rejects.toThrow(/not a plugin/);
  });
});

describe("logs", () => {
  beforeEach(async () => {
    await writeFile(join(root, "logs", "latest.log"), "[10:00] Done (10.6s)!\n[10:01] Steve joined the game\n[10:02] Steve left the game\n");
    await writeFile(join(root, "logs", "2026-10-16-1.log.gz"), gzipSync("[09:00] old line\n[09:01] ERROR something broke\n"));
    await writeFile(join(root, "crash-reports", "crash-2026-10-16.txt"), "---- Minecraft Crash Report ----\n");
  });

  it("lists logs with latest.log first", async () => {
    expect((await listLogs(files)).map((l) => [l.path, l.kind])[0]).toEqual(["logs/latest.log", "log"]);
    expect((await listLogs(files)).map((l) => l.kind)).toContain("crash");
  });

  it("reads and searches, keeping line numbers", async () => {
    const r = await readLog(files, "logs/latest.log", { search: "steve" });
    expect(r.lines).toEqual([
      [2, "[10:01] Steve joined the game"],
      [3, "[10:02] Steve left the game"],
    ]);
    expect(r.total).toBe(3);
  });

  it("opens old zipped logs", async () => {
    expect((await readLog(files, "logs/2026-10-16-1.log.gz", { search: "error" })).lines).toEqual([[2, "[09:01] ERROR something broke"]]);
  });

  it.each(["server.properties", "logs/../server.properties", "../../etc/passwd", "world/level.dat"])("refuses %s", async (p) => {
    await expect(readLog(files, p)).rejects.toThrow();
  });
});
