import { describe, expect, it, vi } from "vitest";
import { loadersFor, resolve, search, updates } from "./catalog.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("catalog", () => {
  it("picks loaders per server type", () => {
    expect(loadersFor("PAPER")).toEqual(["paper", "spigot", "bukkit"]);
    expect(loadersFor("FABRIC")).toEqual(["fabric"]);
    expect(loadersFor("VANILLA")).toEqual([]);
  });

  it("searches both sites for plugins, filtered to the server", async () => {
    const urls: string[] = [];
    const f = vi.fn(async (u: string | URL) => {
      urls.push(String(u));
      return String(u).includes("modrinth")
        ? json({ hits: [{ slug: "worldedit", title: "WorldEdit", description: "d", author: "EngineHub", downloads: 10, icon_url: "" }] })
        : json({ result: [{ name: "WorldEdit", description: "d", namespace: { owner: "EngineHub", slug: "WorldEdit" }, stats: { downloads: 20 }, avatarUrl: null }] });
    }) as unknown as typeof fetch;
    const hits = await search("worldedit", "PAPER", "1.21.4", f);
    expect(hits.map((h) => `${h.source}:${h.id}`)).toEqual(["hangar:EngineHub/WorldEdit", "modrinth:worldedit"]);
    expect(decodeURIComponent(urls[0]!)).toContain('"versions:1.21.4"');
    expect(decodeURIComponent(urls[0]!)).toContain('"categories:paper"');
  });

  it("searches only Modrinth for mods", async () => {
    const f = vi.fn(async () => json({ hits: [] })) as unknown as typeof fetch;
    await search("sodium", "FABRIC", "1.21.1", f);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("resolves a Modrinth project to its primary file and hash", async () => {
    const f = (async () =>
      json([{ version_number: "7.3", files: [{ url: "https://cdn.modrinth.com/a.jar", filename: "a.jar", primary: true, hashes: { sha512: "abc" } }] }])) as unknown as typeof fetch;
    expect(await resolve("modrinth", "worldedit", "PAPER", "1.21.4", f)).toEqual({ version: "7.3", url: "https://cdn.modrinth.com/a.jar", filename: "a.jar", sha512: "abc" });
  });

  it("refuses Hangar versions hosted elsewhere", async () => {
    const f = (async () => json({ result: [{ name: "1.0", downloads: { PAPER: { fileInfo: null, downloadUrl: null, externalUrl: "https://example.com/x.jar" } } }] })) as unknown as typeof fetch;
    await expect(resolve("hangar", "Owner/Proj", "PAPER", "1.21.4", f)).rejects.toThrow(/hosted elsewhere/);
  });

  it("offers only newer stable releases, and flags big jumps", async () => {
    const v = (id: string, num: string, date: string, sha1: string, type = "release") => ({
      id, version_number: num, version_type: type, date_published: date,
      files: [{ url: `https://cdn.modrinth.com/${id}.jar`, filename: `${id}.jar`, primary: true, hashes: { sha1, sha512: "s" } }],
    });
    const current = {
      ess: v("e22", "2.22.0", "2026-09-01", "ess"),
      fawe: v("f161", "2.16.1", "2026-08-01", "fawe"),
      mv: v("m4316", "4.3.16", "2025-04-08", "mv"),
      lp: v("l1", "5.4.0", "2025-01-01", "lp"),
      cp: v("c1", "22.4", "2024-01-01", "cp"),
    };
    const latest = {
      // newest tagged for this Minecraft version is older than installed
      ess: v("e21", "2.21.0", "2025-12-01", "ess21"),
      // same version number, listed as a separate (later) version with another file
      fawe: v("f161b", "2.16.1", "2026-08-02", "fawe-bukkit"),
      // pre-release
      mv: v("m582", "5.8.2-pre", "2026-10-01", "mv5", "beta"),
      // a real update
      lp: v("l2", "5.5.71", "2026-10-01", "lp2"),
      // a real major update
      cp: v("c2", "24.1", "2026-09-01", "cp2"),
    };
    const f = (async (u: string | URL) => json(String(u).endsWith("/update") ? latest : current)) as unknown as typeof fetch;
    const u = await updates(["ess", "fawe", "mv", "lp", "cp"], "PAPER", "1.21.4", f);
    expect(Object.keys(u).sort()).toEqual(["cp", "lp"]);
    expect(u.lp).toMatchObject({ version: "5.5.71" });
    expect(u.lp!.major).toBeUndefined();
    expect(u.cp).toMatchObject({ version: "24.1", major: true });
  });
});
