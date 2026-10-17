import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanRel, FileError, ServerFiles } from "./files.js";

let base: string;
let root: string;
let files: ServerFiles;
const me = userInfo().uid;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "gp-files-"));
  root = join(base, "server");
  await mkdir(join(root, "plugins"), { recursive: true });
  await writeFile(join(root, "server.properties"), "motd=Hi\n");
  await writeFile(join(base, "secret.txt"), "host secret");
  files = new ServerFiles(root, join(base, "trash"), me);
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe("cleanRel", () => {
  it.each([
    ["", ""],
    ["/", ""],
    ["./plugins//x.yml", "plugins/x.yml"],
  ])("cleans %j", (a, b) => expect(cleanRel(a)).toBe(b));

  it.each(["../x", "a/../../x", "a\\b", "a\0b"])("refuses %j", (a) => expect(() => cleanRel(a)).toThrow(FileError));
});

describe("ServerFiles", () => {
  it("lists folders first, then files", async () => {
    const list = await files.list("");
    expect(list.map((e) => `${e.type}:${e.name}`)).toEqual(["dir:plugins", "file:server.properties"]);
  });

  it("reads and writes a config", async () => {
    expect(await files.readText("server.properties")).toBe("motd=Hi\n");
    await files.writeText("server.properties", "motd=Changed\n");
    expect(await readFile(join(root, "server.properties"), "utf8")).toBe("motd=Changed\n");
  });

  it("will not read through a link that points outside", async () => {
    await symlink(join(base, "secret.txt"), join(root, "sneaky.txt"));
    await expect(files.readText("sneaky.txt")).rejects.toThrow(/leaves the server folder/);
    await expect(files.download("sneaky.txt")).rejects.toThrow(/leaves the server folder/);
  });

  it("will not list a linked folder outside", async () => {
    await symlink(base, join(root, "up"));
    await expect(files.list("up")).rejects.toThrow(/leaves the server folder/);
  });

  it("will not write through a link", async () => {
    await symlink(join(base, "secret.txt"), join(root, "sneaky.txt"));
    await expect(files.writeText("sneaky.txt", "x")).rejects.toThrow(/link/);
    expect(await readFile(join(base, "secret.txt"), "utf8")).toBe("host secret");
  });

  it("will not write into a linked folder outside", async () => {
    await symlink(base, join(root, "up"));
    await expect(files.writeText("up/new.txt", "x")).rejects.toThrow(/leaves the server folder/);
  });

  it("refuses binary files in the editor", async () => {
    await writeFile(join(root, "level.dat"), Buffer.from([0x1f, 0x8b, 0, 1]));
    await expect(files.readText("level.dat")).rejects.toThrow(/not a text file/);
  });

  it("uploads in pieces and only shows the file when done", async () => {
    await files.uploadChunk("plugins/big.jar", 0, false, Readable.from([Buffer.from("abc")]));
    expect((await files.list("plugins")).map((e) => e.name)).toEqual([]);
    await expect(files.uploadChunk("plugins/big.jar", 1, false, Readable.from([Buffer.from("x")]))).rejects.toThrow(/at 3 bytes/);
    await files.uploadChunk("plugins/big.jar", 3, true, Readable.from([Buffer.from("def")]));
    expect(await readFile(join(root, "plugins", "big.jar"), "utf8")).toBe("abcdef");
  });

  it("makes folders and renames", async () => {
    await files.mkdir("worlds");
    await files.rename("server.properties", "worlds/server.properties");
    expect((await files.list("worlds")).map((e) => e.name)).toEqual(["server.properties"]);
    await expect(files.rename("plugins", "worlds/server.properties")).rejects.toThrow(/already there/);
  });

  it("moves deleted things to the trash instead of erasing them", async () => {
    const dest = await files.remove("server.properties");
    expect(await readFile(dest, "utf8")).toBe("motd=Hi\n");
    expect((await files.list("")).map((e) => e.name)).toEqual(["plugins"]);
  });

  it("deletes a link itself, not what it points at", async () => {
    await symlink(join(base, "secret.txt"), join(root, "sneaky.txt"));
    await files.remove("sneaky.txt");
    expect(await readFile(join(base, "secret.txt"), "utf8")).toBe("host secret");
    expect(await readdir(root)).not.toContain("sneaky.txt");
  });

  it("will not delete or rename the server folder itself", async () => {
    await expect(files.remove("")).rejects.toThrow(FileError);
    await expect(files.rename("", "x")).rejects.toThrow(FileError);
  });
});
