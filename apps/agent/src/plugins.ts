import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { describeJar } from "./info.js";
import { FileError, type ServerFiles } from "./files.js";

// Plugins (Paper, Purpur) and mods (Fabric, Forge, NeoForge): list, turn off
// and on, and install a file from Modrinth or Hangar after checking its hash.

export interface PluginItem {
  file: string;
  name: string;
  version: string;
  enabled: boolean;
  bytes: number;
  // Fingerprint the plugin sites use to identify a file (for update checks).
  sha1: string;
}

const DISABLED = ".disabled";
// Only the plugin sites' own file servers.
export const DOWNLOAD_HOSTS = ["cdn.modrinth.com", "hangarcdn.papermc.io"];
// Matches the largest single upload piece the file layer takes.
const MAX_JAR_BYTES = 100 * 1024 * 1024;

export function folderFor(type: string): "plugins" | "mods" | null {
  if (type === "PAPER" || type === "PURPUR") return "plugins";
  if (type === "FABRIC" || type === "FORGE" || type === "NEOFORGE") return "mods";
  return null;
}

// A jar file name we are willing to write: plain name, ends in .jar.
export function checkJarName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,150}\.jar$/.test(name)) throw new FileError("not a jar file name");
  return name;
}

export async function listPlugins(files: ServerFiles, folder: string): Promise<PluginItem[]> {
  const entries = await files.list(folder).catch(() => []);
  const out: PluginItem[] = [];
  for (const e of entries) {
    if (e.type !== "file") continue;
    const enabled = e.name.endsWith(".jar");
    if (!enabled && !e.name.endsWith(`.jar${DISABLED}`)) continue;
    const path = await files.safeFile(`${folder}/${e.name}`).catch(() => null);
    const d = path ? await describeJar(path) : null;
    const sha1 = path ? createHash("sha1").update(await readFile(path)).digest("hex") : "";
    out.push({ file: e.name, name: d?.name || e.name.replace(/\.jar(\.disabled)?$/, ""), version: d?.version ?? "", enabled, bytes: e.size, sha1 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export async function setEnabled(files: ServerFiles, folder: string, file: string, on: boolean): Promise<string> {
  const isOn = file.endsWith(".jar");
  if (!isOn && !file.endsWith(`.jar${DISABLED}`)) throw new FileError("not a plugin file");
  if (isOn === on) return file;
  const to = on ? file.slice(0, -DISABLED.length) : `${file}${DISABLED}`;
  await files.rename(`${folder}/${file}`, `${folder}/${to}`);
  return to;
}

export interface InstallRequest {
  url: string;
  filename: string;
  // At least one, as published by the site.
  sha512?: string;
  sha256?: string;
  sha1?: string;
}

// Download from an allowed host, check the hash, then write it into the folder.
export async function installFromUrl(files: ServerFiles, folder: string, req: InstallRequest, fetcher: typeof fetch = fetch): Promise<{ file: string; bytes: number }> {
  const name = checkJarName(req.filename);
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new FileError("bad download address");
  }
  if (url.protocol !== "https:" || !DOWNLOAD_HOSTS.includes(url.hostname)) throw new FileError(`downloads are only allowed from ${DOWNLOAD_HOSTS.join(", ")}`);
  const algo = req.sha512 ? "sha512" : req.sha256 ? "sha256" : req.sha1 ? "sha1" : null;
  const want = (req.sha512 ?? req.sha256 ?? req.sha1 ?? "").toLowerCase();
  if (!algo || !/^[0-9a-f]+$/.test(want)) throw new FileError("a published hash is needed to install");

  const res = await fetcher(url, { redirect: "error" });
  if (!res.ok || !res.body) throw new FileError(`download failed (${res.status})`, 502);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += c.length;
    if (bytes > MAX_JAR_BYTES) throw new FileError("file is too big for a plugin", 413);
    chunks.push(Buffer.from(c));
  }
  const data = Buffer.concat(chunks);
  const got = createHash(algo).update(data).digest("hex");
  if (got !== want) throw new FileError("the download does not match its published hash; nothing was installed", 422);

  // Upload in one piece through the file layer (link-safe, owned by the game user).
  await files.mkdir(folder).catch(() => {});
  await files.uploadChunk(`${folder}/${name}`, 0, true, Readable.from([data]));
  return { file: name, bytes };
}
