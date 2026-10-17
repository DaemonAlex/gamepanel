import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import yazl from "yazl";
import { detect, extractArchive, findLayout, fixServerProperties, ImportError, safeRelPath } from "./import.js";

const limits = { maxBytes: 10 * 2 ** 20, maxEntries: 1000 };
let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gp-import-"));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

// Build a .tar.gz with GNU tar from files laid out under `src`.
function tarGz(src: string, out: string, extra: string[] = []): string {
  execFileSync("tar", ["-czf", out, "-C", src, ...extra, "."]);
  return out;
}

async function zipOf(files: Record<string, string | { link: string }>, out: string): Promise<string> {
  const z = new yazl.ZipFile();
  for (const [name, body] of Object.entries(files)) {
    if (typeof body === "string") z.addBuffer(Buffer.from(body), name);
    // A symlink entry: file type bits 0o120000 in the external attributes.
    else z.addBuffer(Buffer.from(body.link), name, { mode: 0o120777 });
  }
  z.end();
  await pipeline(z.outputStream, createWriteStream(out));
  return out;
}

describe("safeRelPath", () => {
  it.each([
    ["world/level.dat", "world/level.dat"],
    ["./world/region/r.0.0.mca", "world/region/r.0.0.mca"],
  ])("keeps %s", (input, want) => expect(safeRelPath(input)).toBe(want));

  it.each(["", "/etc/passwd", "../x", "a/../../x", "C:/x", "a\\b", "a\0b", "."])("refuses %j", (input) => {
    expect(safeRelPath(input)).toBeNull();
  });
});

describe("fixServerProperties", () => {
  it("sets the port to 25565 and keeps everything else", () => {
    const out = fixServerProperties("motd=Hi\nserver-port=25590\nquery.port=25590\n");
    expect(out).toBe("motd=Hi\nserver-port=25565\nquery.port=25565\n");
  });

  it("adds the port when it is missing", () => {
    expect(fixServerProperties("motd=Hi\n")).toBe("motd=Hi\nserver-port=25565\n");
  });
});

describe("tar.gz import", () => {
  it("unpacks a server folder wrapped in a top folder", async () => {
    const src = join(work, "src");
    await mkdir(join(src, "MyServer", "world"), { recursive: true });
    await mkdir(join(src, "MyServer", "Beyrouth"), { recursive: true });
    await writeFile(join(src, "MyServer", "world", "level.dat"), "x");
    await writeFile(join(src, "MyServer", "Beyrouth", "level.dat"), "x");
    await writeFile(join(src, "MyServer", "server.properties"), "server-port=25590\n");
    await writeFile(join(src, "MyServer", "version_history.json"), '{"currentVersion":"1.21.4-33-321d17c (MC: 1.21.4)"}');
    const archive = tarGz(src, join(work, "a.tar.gz"));

    const dest = join(work, "out");
    await extractArchive("tar.gz", createReadStream(archive), dest, join(work, "tmp"), limits);
    const layout = await findLayout(dest);
    expect(layout.kind).toBe("server");
    expect(layout.worlds).toEqual(["Beyrouth", "world"]);
    expect(await detect(layout.root)).toEqual({ type: "PAPER", version: "1.21.4", plugins: 0, mods: 0 });
  });

  it("treats a bare world as a world", async () => {
    const src = join(work, "src");
    await mkdir(join(src, "region"), { recursive: true });
    await writeFile(join(src, "level.dat"), "x");
    const dest = join(work, "out");
    await extractArchive("tar.gz", createReadStream(tarGz(src, join(work, "a.tar.gz"))), dest, join(work, "tmp"), limits);
    expect((await findLayout(dest)).kind).toBe("world");
  });

  it("refuses an archive with a symlink in it", async () => {
    const src = join(work, "src");
    await mkdir(src);
    await writeFile(join(src, "level.dat"), "x");
    await symlink("/etc/passwd", join(src, "sneaky"));
    const dest = join(work, "out");
    await expect(extractArchive("tar.gz", createReadStream(tarGz(src, join(work, "a.tar.gz"))), dest, join(work, "tmp"), limits)).rejects.toThrow(
      ImportError,
    );
  });

  it("refuses a path that climbs out of the folder", async () => {
    const src = join(work, "src");
    await mkdir(src);
    await writeFile(join(src, "evil.txt"), "x");
    const archive = join(work, "a.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", src, "-P", "--transform", "s,^,../../,", "evil.txt"]);
    const dest = join(work, "out");
    await expect(extractArchive("tar.gz", createReadStream(archive), dest, join(work, "tmp"), limits)).rejects.toThrow();
    // Nothing was written next to the destination either.
    expect(await readdir(work)).not.toContain("evil.txt");
  });

  it("stops when the unpacked size goes over the cap", async () => {
    const src = join(work, "src");
    await mkdir(src);
    await writeFile(join(src, "big.bin"), Buffer.alloc(11 * 2 ** 20));
    const dest = join(work, "out");
    await expect(extractArchive("tar.gz", createReadStream(tarGz(src, join(work, "a.tar.gz"))), dest, join(work, "tmp"), limits)).rejects.toThrow(
      /GiB/,
    );
  });
});

describe("zip import", () => {
  it("unpacks a world", async () => {
    const archive = await zipOf({ "World/level.dat": "x", "World/region/r.0.0.mca": "y" }, join(work, "a.zip"));
    const dest = join(work, "out");
    await extractArchive("zip", createReadStream(archive), dest, join(work, "tmp.zip"), limits);
    const layout = await findLayout(dest);
    expect(layout.kind).toBe("world");
    expect(await readFile(join(layout.root, "region", "r.0.0.mca"), "utf8")).toBe("y");
  });

  it("refuses a symlink entry", async () => {
    const archive = await zipOf({ "level.dat": "x", link: { link: "/etc/passwd" } }, join(work, "a.zip"));
    await expect(extractArchive("zip", createReadStream(archive), join(work, "out"), join(work, "tmp.zip"), limits)).rejects.toThrow(ImportError);
  });

  it("refuses an archive with no world in it", async () => {
    const archive = await zipOf({ "readme.txt": "hello" }, join(work, "a.zip"));
    const dest = join(work, "out");
    await extractArchive("zip", createReadStream(archive), dest, join(work, "tmp.zip"), limits);
    await expect(findLayout(dest)).rejects.toThrow(/level.dat/);
  });
});
