import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServerFiles } from "./files.js";
import { commandFor, readPlayerFiles } from "./players.js";

describe("commandFor", () => {
  it.each([
    [{ action: "kick", name: "Steve" }, "minecraft:kick Steve"],
    [{ action: "kick", name: "Steve", text: "be nice" }, "minecraft:kick Steve be nice"],
    [{ action: "ban", name: "Griefer_1", text: "griefing" }, "minecraft:ban Griefer_1 griefing"],
    [{ action: "pardon", name: "Griefer_1" }, "minecraft:pardon Griefer_1"],
    [{ action: "op", name: "Alex" }, "minecraft:op Alex"],
    [{ action: "deop", name: "Alex" }, "minecraft:deop Alex"],
    [{ action: "whitelist-add", name: "BS_DRONE_01" }, "minecraft:whitelist add BS_DRONE_01"],
    [{ action: "whitelist-remove", name: "matscan" }, "minecraft:whitelist remove matscan"],
    [{ action: "tell", name: "Alex", text: "welcome home" }, "minecraft:tell Alex welcome home"],
  ] as const)("%j", (input, want) => {
    expect(commandFor(input)).toBe(want);
  });

  it.each([
    { action: "op", name: "Steve stop" },
    { action: "op", name: "@a" },
    { action: "op", name: "Steve;stop" },
    { action: "op", name: "a_name_that_is_too_long" },
    { action: "kick", name: "Steve", text: "bye\nop Griefer" },
    { action: "explode", name: "Steve" },
  ])("refuses %j", (input) => {
    expect(() => commandFor(input as never)).toThrow();
  });

  it("needs a message to tell", () => {
    expect(() => commandFor({ action: "tell", name: "Alex", text: "  " })).toThrow(/message/);
  });
});

describe("readPlayerFiles", () => {
  let base: string;
  afterEach(() => rm(base, { recursive: true, force: true }));

  it("reads whitelist, ops, bans and seen players", async () => {
    base = await mkdtemp(join(tmpdir(), "gp-players-"));
    const root = join(base, "s");
    await mkdir(root);
    await writeFile(join(root, "whitelist.json"), JSON.stringify([{ uuid: "u2", name: "matscan" }, { uuid: "u1", name: "BS_DRONE_01" }]));
    await writeFile(join(root, "ops.json"), JSON.stringify([{ uuid: "u3", name: "The57th", level: 4 }]));
    await writeFile(join(root, "banned-players.json"), JSON.stringify([{ uuid: "u4", name: "Griefer", reason: "tnt", source: "Server" }]));
    await writeFile(
      join(root, "usercache.json"),
      JSON.stringify([
        { name: "Old", uuid: "u5", expiresOn: "2026-10-01 10:00:00 +0000" },
        { name: "New", uuid: "u6", expiresOn: "2026-11-10 10:00:00 +0000" },
      ]),
    );
    const r = await readPlayerFiles(new ServerFiles(root, join(base, "trash"), userInfo().uid));
    expect(r.whitelist.map((p) => p.name)).toEqual(["BS_DRONE_01", "matscan"]);
    expect(r.ops).toEqual([{ name: "The57th", uuid: "u3", level: 4 }]);
    expect(r.banned[0]).toMatchObject({ name: "Griefer", reason: "tnt" });
    expect(r.bannedIps).toEqual([]);
    expect(r.known.map((p) => p.name)).toEqual(["New", "Old"]);
    expect(r.known[0]!.lastSeen?.slice(0, 10)).toBe("2026-10-11");
  });
});
