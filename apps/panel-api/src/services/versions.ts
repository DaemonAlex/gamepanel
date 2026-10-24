import type { PluginItem, PluginReadiness, VersionsView } from "@gamepanel/shared";
import { loadersFor } from "./catalog.js";

// Which Minecraft versions a server can move to, and whether its plugins are
// ready for one. Release lists come from the projects themselves (PaperMC,
// Purpur, Mojang); plugin checks from Modrinth and Hangar, as for updates.

const UA = { "User-Agent": "DaemonsGamePanel/1.0 (self-hosted panel)" };
const RELEASE = /^\d+\.\d+(?:\.\d+)?$/;

async function getJson<T>(url: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<T> {
  const res = await fetcher(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`version list answered ${res.status}`);
  return (await res.json()) as T;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// The line a version belongs to: 1.21.4 and 1.21.11 share "1.21"; the yearly
// releases (26.1, 26.3) share "26".
const lineOf = (v: string) => (v.startsWith("1.") ? v.split(".").slice(0, 2).join(".") : v.split(".")[0]!);

// Released versions, newest first, or null when this type is not looked up.
async function releases(type: string, fetcher: typeof fetch): Promise<string[] | null> {
  let ids: string[];
  switch (type) {
    case "PAPER": {
      const d = await getJson<{ versions: { version: { id: string } }[] }>("https://fill.papermc.io/v3/projects/paper/versions", {}, fetcher);
      ids = d.versions.map((v) => v.version.id);
      break;
    }
    case "PURPUR": {
      const d = await getJson<{ versions: string[] }>("https://api.purpurmc.org/v2/purpur", {}, fetcher);
      ids = d.versions;
      break;
    }
    case "VANILLA": {
      const d = await getJson<{ versions: { id: string; type: string }[] }>("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", {}, fetcher);
      ids = d.versions.filter((v) => v.type === "release").map((v) => v.id);
      break;
    }
    default:
      return null;
  }
  return [...new Set(ids.filter((v) => RELEASE.test(v)))].sort((a, b) => compareVersions(b, a));
}

// Paper lists a new Minecraft version before its builds are marked stable;
// only suggest versions that have a stable build.
async function paperStable(version: string, fetcher: typeof fetch): Promise<boolean> {
  const builds = await getJson<{ channel: string }[]>(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`, {}, fetcher).catch(() => []);
  return builds.some((b) => b.channel === "STABLE");
}

const cache = new Map<string, { at: number; list: string[] | null }>();
const CACHE_MS = 60 * 60_000;

export async function versionsView(type: string, current: string, fetcher: typeof fetch = fetch, useCache = true): Promise<VersionsView> {
  let hit = useCache ? cache.get(type) : undefined;
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    hit = { at: Date.now(), list: await releases(type, fetcher) };
    if (useCache) cache.set(type, hit);
  }
  const list = hit.list;
  if (!list) return { type, current, listed: false, available: [], latest: null, suggested: null };

  const usable = async (v: string) => type !== "PAPER" || (await paperStable(v, fetcher));
  const firstUsable = async (vs: string[]) => {
    for (const v of vs.slice(0, 5)) if (await usable(v)) return v;
    return null;
  };
  const newer = current === "LATEST" ? [] : list.filter((v) => compareVersions(v, current) > 0);
  const latest = await firstUsable(list);
  const sameLine = await firstUsable(newer.filter((v) => lineOf(v) === lineOf(current)));
  const suggested = sameLine ?? (latest && newer.includes(latest) ? latest : null);
  return { type, current, listed: true, available: list, latest, suggested };
}

// --- plugin readiness ------------------------------------------------------------------

type MrVersion = { version_number: string; version_type: string };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Modrinth by project slug when the name matches the project's title.
async function modrinthByName(name: string, loaders: string[], to: string, fetcher: typeof fetch): Promise<PluginReadiness["status"] | { version: string }> {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!slug) return "unknown";
  const project = await getJson<{ title: string; slug: string }>(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}`, {}, fetcher).catch(() => null);
  if (!project || (norm(project.title) !== norm(name) && norm(project.slug) !== norm(name))) return "unknown";
  const vs = await getJson<MrVersion[]>(
    `https://api.modrinth.com/v2/project/${encodeURIComponent(project.slug)}/version?loaders=${encodeURIComponent(JSON.stringify(loaders))}&game_versions=${encodeURIComponent(JSON.stringify([to]))}`,
    {},
    fetcher,
  ).catch(() => null);
  if (!vs) return "unknown";
  const v = vs.find((x) => x.version_type === "release") ?? vs[0];
  return v ? { version: v.version_number } : "not-yet";
}

// Hangar by exact project name (Paper plugins only).
async function hangarByName(name: string, to: string, fetcher: typeof fetch): Promise<PluginReadiness["status"] | { version: string }> {
  const d = await getJson<{ result: { name: string; namespace: { owner: string; slug: string } }[] }>(
    `https://hangar.papermc.io/api/v1/projects?q=${encodeURIComponent(name)}&limit=5`,
    {},
    fetcher,
  ).catch(() => null);
  const p = d?.result.find((x) => norm(x.name) === norm(name));
  if (!p) return "unknown";
  const v = await getJson<{ result: { name: string }[] }>(
    `https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(p.namespace.owner)}/${encodeURIComponent(p.namespace.slug)}/versions?limit=1&platform=PAPER&platformVersion=${encodeURIComponent(to)}`,
    {},
    fetcher,
  ).catch(() => null);
  if (!v) return "unknown";
  return v.result[0] ? { version: v.result[0].name } : "not-yet";
}

export async function pluginReadiness(items: PluginItem[], type: string, to: string, fetcher: typeof fetch = fetch): Promise<PluginReadiness[]> {
  const loaders = loadersFor(type);
  const sha1s = items.map((i) => i.sha1).filter(Boolean);
  const post = (path: string, body: unknown) =>
    sha1s.length && loaders.length
      ? getJson<Record<string, MrVersion>>(`https://api.modrinth.com/v2/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, fetcher).catch(
          () => ({}) as Record<string, MrVersion>,
        )
      : Promise.resolve({} as Record<string, MrVersion>);
  // Files Modrinth recognises, and for those, the newest version that fits the target.
  const [known, fits] = await Promise.all([
    post("version_files", { hashes: sha1s, algorithm: "sha1" }),
    post("version_files/update", { hashes: sha1s, algorithm: "sha1", loaders, game_versions: [to] }),
  ]);
  const isPaperFamily = type === "PAPER" || type === "PURPUR";

  return Promise.all(
    items.map(async (i): Promise<PluginReadiness> => {
      const base = { file: i.file, name: i.name, installed: i.version };
      const fit = fits[i.sha1];
      if (fit) return { ...base, status: "ready", version: fit.version_number, source: "modrinth" };
      if (known[i.sha1]) return { ...base, status: "not-yet", source: "modrinth" };
      // A jar from somewhere else: look the plugin up by name instead.
      const mr = loaders.length ? await modrinthByName(i.name, loaders, to, fetcher) : "unknown";
      if (typeof mr === "object") return { ...base, status: "ready", version: mr.version, source: "modrinth" };
      if (mr === "not-yet") return { ...base, status: "not-yet", source: "modrinth" };
      if (isPaperFamily) {
        const hg = await hangarByName(i.name, to, fetcher);
        if (typeof hg === "object") return { ...base, status: "ready", version: hg.version, source: "hangar" };
        if (hg === "not-yet") return { ...base, status: "not-yet", source: "hangar" };
      }
      return { ...base, status: "unknown" };
    }),
  );
}
