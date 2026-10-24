import { describe, expect, it } from "vitest";
import { decodeValue, encodeValue, readProperties, withoutSecrets, writeProperties } from "./properties-file.js";

const sample = "#Minecraft server properties\n#Fri Oct 17\nmotd=\\u00A75Perpetual \\u00A76Wonders\nmax-players=20\npvp=true\nlevel-type=minecraft\\:normal\n";

describe("properties file", () => {
  it("reads escaped values", () => {
    expect(readProperties(sample)).toMatchObject({ motd: "§5Perpetual §6Wonders", "max-players": "20", "level-type": "minecraft:normal" });
  });

  it("reads raw UTF-8 values too", () => {
    expect(readProperties("motd=§5Hi\n").motd).toBe("§5Hi");
  });

  it("changes only the given keys and keeps comments and order", () => {
    const out = writeProperties(sample, { "max-players": "30", pvp: "false" });
    expect(out).toBe(sample.replace("max-players=20", "max-players=30").replace("pvp=true", "pvp=false"));
  });

  it("adds missing keys at the end, before the trailing newline", () => {
    expect(writeProperties("a=1\n", { b: "2" })).toBe("a=1\nb=2\n");
  });

  it("round-trips colour codes, colons and backslashes", () => {
    const v = "§6Gold: a\\b = c";
    expect(encodeValue(v)).toBe("\\u00a76Gold\\: a\\\\b \\= c");
    expect(decodeValue(encodeValue(v))).toBe(v);
    expect(readProperties(writeProperties("motd=x\n", { motd: v })).motd).toBe(v);
  });

  it("never hands out the RCON password", () => {
    expect(withoutSecrets({ motd: "x", "rcon.password": "secret" })).toEqual({ motd: "x" });
  });
});
