import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import yauzl from "yauzl";
import type { ServerFiles } from "./files.js";

// Reading what a server folder says about itself. Everything goes through
// ServerFiles, so links planted in the folder cannot point the agent elsewhere.

// Total size of a folder without following links. Cached per folder for a few
// minutes: walking a big world is slow.
const sizeCache = new Map<string, { at: number; bytes: number }>();
export async function folderBytes(dir: string, maxAgeMs = 5 * 60_000): Promise<number> {
  const hit = sizeCache.get(dir);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.bytes;
  let total = 0;
  const walk = async (d: string) => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      const s = await lstat(p).catch(() => null);
      if (!s) continue;
      if (s.isDirectory()) await walk(p);
      else total += s.size;
    }
  };
  await walk(dir);
  sizeCache.set(dir, { at: Date.now(), bytes: total });
  return total;
}

// Read one small text entry from a jar, or null.
async function jarEntry(path: string, names: string[]): Promise<{ name: string; text: string } | null> {
  const zip = await yauzl.openPromise(path, { strictFileNames: false }).catch(() => null);
  if (!zip) return null;
  try {
    for await (const entry of zip.eachEntry()) {
      if (!names.includes(entry.fileName) || entry.uncompressedSize > 256 * 1024) continue;
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      return { name: entry.fileName, text: Buffer.concat(chunks).toString("utf8") };
    }
    return null;
  } finally {
    zip.close();
  }
}

const yamlField = (text: string, key: string) => text.match(new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n#]+)`, "m"))?.[1]?.trim();

// Name and version of a plugin (plugin.yml / paper-plugin.yml) or a mod
// (fabric.mod.json, quilt.mod.json, META-INF/mods.toml, META-INF/neoforge.mods.toml).
export async function describeJar(path: string): Promise<{ name: string; version: string } | null> {
  const e = await jarEntry(path, ["plugin.yml", "paper-plugin.yml", "fabric.mod.json", "quilt.mod.json", "META-INF/mods.toml", "META-INF/neoforge.mods.toml"]);
  if (!e) return null;
  try {
    if (e.name.endsWith(".yml")) {
      const name = yamlField(e.text, "name");
      return name ? { name, version: yamlField(e.text, "version") ?? "" } : null;
    }
    if (e.name === "fabric.mod.json") {
      const j = JSON.parse(e.text) as { name?: string; id?: string; version?: string };
      return { name: j.name ?? j.id ?? "", version: j.version ?? "" };
    }
    if (e.name === "quilt.mod.json") {
      const j = JSON.parse(e.text) as { quilt_loader?: { id?: string; version?: string; metadata?: { name?: string } } };
      return { name: j.quilt_loader?.metadata?.name ?? j.quilt_loader?.id ?? "", version: j.quilt_loader?.version ?? "" };
    }
    const name = e.text.match(/displayName\s*=\s*"([^"]+)"/)?.[1] ?? e.text.match(/modId\s*=\s*"([^"]+)"/)?.[1];
    return name ? { name, version: e.text.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? "" } : null;
  } catch {
    return null;
  }
}

// Plugins or mods in one folder of the server, described from their jars.
// Cached by file name, size and time, since opening every jar each poll is wasteful.
const jarCache = new Map<string, { name: string; version: string } | null>();
export async function listJars(files: ServerFiles, folder: string): Promise<{ file: string; name: string; version: string }[]> {
  const entries = await files.list(folder).catch(() => []);
  const out: { file: string; name: string; version: string }[] = [];
  for (const e of entries) {
    if (e.type !== "file" || !e.name.endsWith(".jar")) continue;
    const path = await files.safeFile(`${folder}/${e.name}`).catch(() => null);
    if (!path) continue;
    const key = `${path}:${e.size}:${e.modified}`;
    if (!jarCache.has(key)) jarCache.set(key, await describeJar(path));
    const d = jarCache.get(key);
    out.push({ file: e.name, name: d?.name || e.name.replace(/\.jar$/, ""), version: d?.version ?? "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
