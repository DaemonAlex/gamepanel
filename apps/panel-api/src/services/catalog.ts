import type { CatalogHit, PluginUpdate } from "@gamepanel/shared";

// Plugin and mod catalogues: Modrinth (plugins and mods) and Hangar (Paper
// plugins). Only files hosted on the sites' own servers, with a published
// hash, are ever handed to a node.

const UA = { "User-Agent": "DaemonsGamePanel/1.0 (self-hosted panel)" };

// Modrinth loader names that run on each server type.
export function loadersFor(type: string): string[] {
  switch (type) {
    case "PAPER":
      return ["paper", "spigot", "bukkit"];
    case "PURPUR":
      return ["purpur", "paper", "spigot", "bukkit"];
    case "FABRIC":
      return ["fabric"];
    case "FORGE":
      return ["forge"];
    case "NEOFORGE":
      return ["neoforge"];
    default:
      return [];
  }
}

async function getJson<T>(url: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<T> {
  const res = await fetcher(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`catalogue answered ${res.status}`);
  return (await res.json()) as T;
}

export async function search(q: string, type: string, mcVersion: string, fetcher: typeof fetch = fetch): Promise<CatalogHit[]> {
  const loaders = loadersFor(type);
  if (!loaders.length) return [];
  const isMod = ["FABRIC", "FORGE", "NEOFORGE"].includes(type);
  const facets = [loaders.map((l) => `categories:${l}`), [`versions:${mcVersion}`], [`project_type:${isMod ? "mod" : "plugin"}`]];
  const mr = getJson<{ hits: { slug: string; title: string; description: string; author: string; downloads: number; icon_url: string | null }[] }>(
    `https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&limit=15&facets=${encodeURIComponent(JSON.stringify(facets))}`,
    {},
    fetcher,
  ).then((d) =>
    d.hits.map(
      (h): CatalogHit => ({ source: "modrinth", id: h.slug, title: h.title, description: h.description, author: h.author, downloads: h.downloads, icon: h.icon_url || null, url: `https://modrinth.com/project/${h.slug}` }),
    ),
  );
  const hg = isMod
    ? Promise.resolve([] as CatalogHit[])
    : getJson<{ result: { name: string; description: string; namespace: { owner: string; slug: string }; stats: { downloads: number }; avatarUrl: string | null }[] }>(
        `https://hangar.papermc.io/api/v1/projects?q=${encodeURIComponent(q)}&limit=10&platform=PAPER&version=${encodeURIComponent(mcVersion)}`,
        {},
        fetcher,
      ).then((d) =>
        d.result.map(
          (p): CatalogHit => ({
            source: "hangar",
            id: `${p.namespace.owner}/${p.namespace.slug}`,
            title: p.name,
            description: p.description,
            author: p.namespace.owner,
            downloads: p.stats.downloads,
            icon: p.avatarUrl,
            url: `https://hangar.papermc.io/${p.namespace.owner}/${p.namespace.slug}`,
          }),
        ),
      );
  const [a, b] = await Promise.allSettled([mr, hg]);
  const all = [...(a.status === "fulfilled" ? a.value : []), ...(b.status === "fulfilled" ? b.value : [])];
  if (a.status === "rejected" && b.status === "rejected") throw new Error("plugin sites could not be reached");
  return all.sort((x, y) => y.downloads - x.downloads);
}

// The newest file of a project that fits this server, with its published hash.
export async function resolve(source: "modrinth" | "hangar", id: string, type: string, mcVersion: string, fetcher: typeof fetch = fetch): Promise<PluginUpdate> {
  if (source === "modrinth") {
    const versions = await getJson<{ version_number: string; files: { url: string; filename: string; primary: boolean; hashes: { sha512: string } }[] }[]>(
      `https://api.modrinth.com/v2/project/${encodeURIComponent(id)}/version?loaders=${encodeURIComponent(JSON.stringify(loadersFor(type)))}&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`,
      {},
      fetcher,
    );
    const v = versions[0];
    const f = v?.files.find((x) => x.primary) ?? v?.files[0];
    if (!v || !f) throw new Error(`no version of ${id} for Minecraft ${mcVersion}`);
    return { version: v.version_number, url: f.url, filename: f.filename, sha512: f.hashes.sha512 };
  }
  const [owner, slug] = id.split("/");
  if (!owner || !slug) throw new Error("bad Hangar project");
  const d = await getJson<{ result: { name: string; downloads: Record<string, { fileInfo: { name: string; sha256Hash: string } | null; downloadUrl: string | null; externalUrl: string | null }> }[] }>(
    `https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/versions?limit=1&platform=PAPER&platformVersion=${encodeURIComponent(mcVersion)}`,
    {},
    fetcher,
  );
  const v = d.result[0];
  const dl = v?.downloads.PAPER;
  if (!v || !dl?.downloadUrl || !dl.fileInfo) throw new Error(`no downloadable version of ${id} for Minecraft ${mcVersion} (files hosted elsewhere are not installed)`);
  // Hangar gives SHA-256; the node checks whichever hash it is handed.
  return { version: v.name, url: dl.downloadUrl, filename: dl.fileInfo.name, sha256: dl.fileInfo.sha256Hash };
}

// For installed jars: Modrinth recognises files by SHA-1. An update is offered
// only when it is a stable release, a different version, and published later
// than the one installed (the newest one tagged for this Minecraft version can
// be older than what is installed). Jars Modrinth does not know get nothing.
type MrVersion = {
  id: string;
  version_number: string;
  version_type: string;
  date_published: string;
  files: { url: string; filename: string; primary: boolean; hashes: { sha1: string; sha512: string } }[];
};

const firstNumber = (v: string) => Number(v.match(/\d+/)?.[0] ?? NaN);

export async function updates(sha1s: string[], type: string, mcVersion: string, fetcher: typeof fetch = fetch): Promise<Record<string, PluginUpdate>> {
  if (!sha1s.length || !loadersFor(type).length) return {};
  const post = (path: string, body: unknown) =>
    getJson<Record<string, MrVersion>>(`https://api.modrinth.com/v2/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, fetcher).catch(
      () => ({}) as Record<string, MrVersion>,
    );
  const [current, latest] = await Promise.all([
    post("version_files", { hashes: sha1s, algorithm: "sha1" }),
    post("version_files/update", { hashes: sha1s, algorithm: "sha1", loaders: loadersFor(type), game_versions: [mcVersion] }),
  ]);
  const out: Record<string, PluginUpdate> = {};
  for (const [sha1, v] of Object.entries(latest)) {
    const now = current[sha1];
    // Same number = same release (sites list e.g. Paper and Bukkit builds separately).
    if (!now || v.id === now.id || v.version_number === now.version_number || v.version_type !== "release") continue;
    if (new Date(v.date_published) <= new Date(now.date_published)) continue;
    const f = v.files.find((x) => x.primary) ?? v.files[0];
    if (!f || f.hashes.sha1 === sha1) continue;
    const major = firstNumber(v.version_number) > firstNumber(now.version_number);
    out[sha1] = { version: v.version_number, url: f.url, filename: f.filename, sha512: f.hashes.sha512, ...(major ? { major } : {}) };
  }
  return out;
}
