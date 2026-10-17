import { createWriteStream } from "node:fs";
import { lchown, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import yauzl from "yauzl";

// Unpacking an uploaded world or server folder. The archive comes from a user,
// so it is treated as hostile: only plain files and folders, no links, nothing
// that lands outside the staging folder, and hard caps on size and entry count.

export type ArchiveFormat = "tar.gz" | "zip";

export interface ImportLimits {
  // Total unpacked bytes.
  maxBytes: number;
  maxEntries: number;
}

export class ImportError extends Error {}

// A path inside the archive is safe if it stays inside the folder it is unpacked into.
export function safeRelPath(name: string): string | null {
  if (!name || name.includes("\0") || name.includes("\\")) return null;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

function budget(limits: ImportLimits) {
  let bytes = 0;
  let entries = 0;
  return {
    entry(size: number) {
      entries += 1;
      bytes += size;
      if (entries > limits.maxEntries) throw new ImportError(`archive has more than ${limits.maxEntries} entries`);
      if (bytes > limits.maxBytes) throw new ImportError(`archive unpacks to more than ${Math.floor(limits.maxBytes / 2 ** 30)} GiB`);
    },
    get bytes() {
      return bytes;
    },
    get entries() {
      return entries;
    },
  };
}

async function extractTarGz(source: Readable, dest: string, limits: ImportLimits): Promise<number> {
  const b = budget(limits);
  let failure: Error | null = null;
  const allowed = new Set(["File", "OldFile", "ContiguousFile", "Directory"]);

  const extractor = tar.x({
    cwd: dest,
    strict: true,
    preserveOwner: false,
    // Never trust the archive's permission bits; files get normal modes.
    noChmod: true,
    filter: (path, entry) => {
      if (failure) return false;
      const type = "type" in entry ? entry.type : "File";
      const size = "size" in entry && typeof entry.size === "number" ? entry.size : 0;
      // The archive's own top entry ("./") is the destination folder itself.
      if (type === "Directory" && /^(\.\/?)?$/.test(path)) return false;
      try {
        if (!allowed.has(type)) throw new ImportError(`archive contains a ${type} entry (${path}); only files and folders are allowed`);
        if (!safeRelPath(path)) throw new ImportError(`archive path leaves the folder: ${path}`);
        b.entry(size);
      } catch (err) {
        failure = err as Error;
        source.destroy(failure);
        return false;
      }
      return true;
    },
  });

  try {
    await pipeline(source, extractor);
  } catch (err) {
    throw failure ?? err;
  }
  if (failure) throw failure;
  return b.entries;
}

// Count bytes on the way in, so a huge upload stops early instead of filling the disk.
function capBytes(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      if (seen > max) done(new ImportError("upload is too large"));
      else done(null, chunk);
    },
  });
}

async function extractZip(source: Readable, dest: string, tmpFile: string, limits: ImportLimits): Promise<number> {
  // Zip needs random access, so the upload is saved first.
  await pipeline(source, capBytes(limits.maxBytes), createWriteStream(tmpFile, { flags: "wx", mode: 0o600 }));
  const b = budget(limits);
  const zip = await yauzl.openPromise(tmpFile, { validateEntrySizes: true, strictFileNames: true });
  try {
    for await (const entry of zip.eachEntry()) {
      const rel = safeRelPath(entry.fileName);
      if (!rel) throw new ImportError(`archive path leaves the folder: ${entry.fileName}`);
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      const isDir = entry.fileName.endsWith("/");
      if (mode !== 0 && mode !== 0o100000 && mode !== 0o040000) {
        throw new ImportError(`archive contains a link or special file (${entry.fileName}); only files and folders are allowed`);
      }
      b.entry(entry.uncompressedSize);
      const target = join(dest, rel);
      if (isDir) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await pipeline(await zip.openReadStreamPromise(entry), createWriteStream(target, { flags: "wx", mode: 0o640 }));
    }
  } finally {
    zip.close();
    await rm(tmpFile, { force: true });
  }
  return b.entries;
}

export async function extractArchive(format: ArchiveFormat, source: Readable, dest: string, tmpFile: string, limits: ImportLimits): Promise<number> {
  await mkdir(dest, { recursive: true, mode: 0o750 });
  return format === "zip" ? extractZip(source, dest, tmpFile, limits) : extractTarGz(source, dest, limits);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface Layout {
  // "server": a whole server folder. "world": just one world, to go in /data/world.
  kind: "server" | "world";
  // Folder inside the staging folder that holds it.
  root: string;
  // World folders found (those with a level.dat).
  worlds: string[];
}

// Many archives wrap everything in one top folder. Step into it until the
// contents look like a server or a world.
export async function findLayout(staging: string): Promise<Layout> {
  let root = staging;
  for (let depth = 0; depth < 4; depth++) {
    const names = await readdir(root, { withFileTypes: true });
    const worlds: string[] = [];
    for (const d of names) {
      if (d.isDirectory() && (await exists(join(root, d.name, "level.dat")))) worlds.push(d.name);
    }
    worlds.sort();
    // server.properties marks a whole server folder.
    if (await exists(join(root, "server.properties"))) {
      if (worlds.length === 0) break;
      return { kind: "server", root, worlds };
    }
    if (await exists(join(root, "level.dat"))) return { kind: "world", root, worlds: ["world"] };
    // A single wrapping folder: step into it.
    const only = names.length === 1 ? names[0] : undefined;
    if (only?.isDirectory()) {
      root = join(root, only.name);
      continue;
    }
    // Several worlds side by side, with no server.properties.
    if (worlds.length > 0) return { kind: "server", root, worlds };
    break;
  }
  throw new ImportError("no Minecraft world found (no level.dat)");
}

// Inside the container the server always listens on 25565. An imported
// server.properties may say otherwise, which would break the port mapping.
export function fixServerProperties(text: string): string {
  const lines = text.split(/\r?\n/);
  let found = false;
  const out = lines.map((line) => {
    if (/^server-port\s*=/.test(line)) {
      found = true;
      return "server-port=25565";
    }
    if (/^query\.port\s*=/.test(line)) return "query.port=25565";
    return line;
  });
  if (!found) out.splice(out.length && out[out.length - 1] === "" ? out.length - 1 : out.length, 0, "server-port=25565");
  return out.join("\n");
}

export async function fixServerPropertiesFile(root: string): Promise<void> {
  const path = join(root, "server.properties");
  if (!(await exists(path))) return;
  await writeFile(path, fixServerProperties(await readFile(path, "utf8")));
}

// What the archive says it was running, to prefill the server settings.
export interface Detected {
  type?: "PAPER" | "PURPUR" | "FABRIC" | "FORGE" | "NEOFORGE" | "VANILLA";
  version?: string;
  plugins: number;
  mods: number;
}

export async function detect(root: string): Promise<Detected> {
  const result: Detected = { plugins: 0, mods: 0 };
  const jars = async (dir: string) => {
    try {
      return (await readdir(join(root, dir))).filter((n) => n.endsWith(".jar")).length;
    } catch {
      return 0;
    }
  };
  result.plugins = await jars("plugins");
  result.mods = await jars("mods");

  // Paper and Purpur record the version they ran.
  try {
    const history = JSON.parse(await readFile(join(root, "version_history.json"), "utf8")) as { currentVersion?: string };
    const mc = history.currentVersion?.match(/MC: (\d+\.\d+(?:\.\d+)?)/)?.[1];
    if (mc) result.version = mc;
    result.type = history.currentVersion?.toLowerCase().includes("purpur") ? "PURPUR" : "PAPER";
  } catch {
    // Not a Paper or Purpur server, or no history file.
  }
  if (!result.type) {
    if (await exists(join(root, ".fabric"))) result.type = "FABRIC";
    else if (await exists(join(root, "libraries", "net", "neoforged"))) result.type = "NEOFORGE";
    else if (await exists(join(root, "libraries", "net", "minecraftforge"))) result.type = "FORGE";
  }
  return result;
}

// Give every file to the game user. lchown never follows links (there are none anyway).
export async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  await lchown(path, uid, gid);
  const s = await lstat(path);
  if (!s.isDirectory()) return;
  for (const name of await readdir(path)) await chownTree(posix.join(path, name), uid, gid);
}
