import { describe, expect, it } from "vitest";
import { checkProperty } from "./properties.js";

describe("checkProperty", () => {
  it.each([
    ["motd", "§5Perpetual §6Wonders", "§5Perpetual §6Wonders"],
    ["max-players", "20", "20"],
    ["max-players", "020", "20"],
    ["pvp", "false", "false"],
    ["gamemode", "creative", "creative"],
  ])("accepts %s=%s", (k, v, out) => expect(checkProperty(k, v)).toEqual({ ok: true, value: out }));

  it.each([
    ["server-port", "25566"],
    ["rcon.password", "x"],
    ["max-players", "0"],
    ["max-players", "1.5"],
    ["view-distance", "64"],
    ["pvp", "yes"],
    ["gamemode", "god"],
    ["motd", "line one\nenable-rcon=false"],
    ["made-up-key", "1"],
  ])("refuses %s=%j", (k, v) => expect(checkProperty(k, v).ok).toBe(false));
});
