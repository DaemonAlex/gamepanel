import type { PluginItem } from "@gamepanel/shared";
import { describe, expect, it } from "vitest";
import { compareVersions, pluginReadiness, versionsView } from "./versions.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Routes a fake fetch by URL substring; the first match wins.
const router =
  (routes: [string, (init?: RequestInit) => Response][]) =>
  (async (u: string | URL, init?: RequestInit) => {
    const url = String(u);
    const hit = routes.find(([k]) => url.includes(k));
    return hit ? hit[1](init) : json({}, 404);
  }) as unknown as typeof fetch;

const paperVersions = { versions: ["26.3", "26.3-rc-3", "26.2", "26.1.2", "1.21.11", "1.21.11-rc3", "1.21.10", "1.21.4", "1.20.6"].map((id) => ({ version: { id } })) };
const stable = () => json([{ channel: "STABLE" }]);

describe("versions", () => {
  it("compares version numbers numerically", () => {
    expect(compareVersions("1.21.11", "1.21.4")).toBeGreaterThan(0);
    expect(compareVersions("26.1", "1.21.11")).toBeGreaterThan(0);
    expect(compareVersions("1.21", "1.21.0")).toBe(0);
  });

  it("suggests the newest release in the current line, and lists releases only", async () => {
    const f = router([
      ["/versions/", stable],
      ["fill.papermc.io/v3/projects/paper/versions", () => json(paperVersions)],
    ]);
    const v = await versionsView("PAPER", "1.21.4", f, false);
    expect(v.available).toEqual(["26.3", "26.2", "26.1.2", "1.21.11", "1.21.10", "1.21.4", "1.20.6"]);
    expect(v.latest).toBe("26.3");
    expect(v.suggested).toBe("1.21.11");
  });

  it("moves to the next line when the current one is finished", async () => {
    const f = router([
      ["/versions/", stable],
      ["fill.papermc.io/v3/projects/paper/versions", () => json(paperVersions)],
    ]);
    expect((await versionsView("PAPER", "1.21.11", f, false)).suggested).toBe("26.3");
    expect((await versionsView("PAPER", "26.3", f, false)).suggested).toBeNull();
  });

  it("skips Paper versions that have no stable build yet", async () => {
    const f = router([
      ["/versions/26.3/builds", () => json([{ channel: "BETA" }])],
      ["/versions/", stable],
      ["fill.papermc.io/v3/projects/paper/versions", () => json(paperVersions)],
    ]);
    const v = await versionsView("PAPER", "1.21.11", f, false);
    expect(v.latest).toBe("26.2");
    expect(v.suggested).toBe("26.2");
  });

  it("does not look up mod loaders", async () => {
    const v = await versionsView("FABRIC", "1.21.1", router([]), false);
    expect(v).toMatchObject({ listed: false, available: [], suggested: null });
  });
});

const item = (name: string, sha1: string, version = "1.0"): PluginItem => ({ file: `${name}.jar`, name, version, enabled: true, bytes: 1, sha1 });

describe("plugin readiness", () => {
  it("sorts plugins into ready, not yet and unknown", async () => {
    const f = router([
      // Modrinth by file: a recognises both, b has nothing for the target.
      ["/v2/version_files/update", () => json({ a: { version_number: "2.0", version_type: "release" } })],
      ["/v2/version_files", () => json({ a: { version_number: "1.0", version_type: "release" }, b: { version_number: "1.0", version_type: "release" } })],
      // c is not recognised by file but is on Modrinth by name.
      ["/v2/project/gamma/version", () => json([{ version_number: "3.1", version_type: "release" }])],
      ["/v2/project/gamma", () => json({ title: "Gamma", slug: "gamma" })],
      // d is on Hangar only.
      ["hangar.papermc.io/api/v1/projects/Owner/Delta/versions", () => json({ result: [] })],
      ["hangar.papermc.io/api/v1/projects?q=Delta", () => json({ result: [{ name: "Delta", namespace: { owner: "Owner", slug: "Delta" } }] })],
      // e is nowhere.
      ["hangar.papermc.io/api/v1/projects?q=Eps", () => json({ result: [] })],
    ]);
    const r = await pluginReadiness([item("Alpha", "a"), item("Beta", "b"), item("Gamma", "c"), item("Delta", "d"), item("Eps", "e")], "PAPER", "1.21.11", f);
    expect(r.map((x) => [x.name, x.status, x.version ?? null, x.source ?? null])).toEqual([
      ["Alpha", "ready", "2.0", "modrinth"],
      ["Beta", "not-yet", null, "modrinth"],
      ["Gamma", "ready", "3.1", "modrinth"],
      ["Delta", "not-yet", null, "hangar"],
      ["Eps", "unknown", null, null],
    ]);
  });

  it("does not trust a Modrinth project whose title is a different plugin", async () => {
    const f = router([
      ["/v2/project/morph", () => json({ title: "Morph Mod Something", slug: "morph-mod" })],
      ["hangar.papermc.io", () => json({ result: [] })],
    ]);
    const [r] = await pluginReadiness([item("Morph", "")], "PAPER", "1.21.11", f);
    expect(r!.status).toBe("unknown");
  });

  it("asks for the target Minecraft version and the server's loaders", async () => {
    let body = "";
    const f = router([
      [
        "/v2/version_files/update",
        (init) => {
          body = String(init?.body);
          return json({});
        },
      ],
      ["/v2/version_files", () => json({})],
      ["hangar", () => json({ result: [] })],
    ]);
    await pluginReadiness([item("X", "x")], "PAPER", "26.3", f);
    expect(JSON.parse(body)).toMatchObject({ hashes: ["x"], game_versions: ["26.3"], loaders: ["paper", "spigot", "bukkit"] });
  });
});
