import { describe, expect, it } from "vitest";
import { consoleInSchema, serverIdSchema, serverSpecSchema } from "./index.js";

describe("serverIdSchema", () => {
  it.each(["homeworld", "a", "mc-1", "x".repeat(32)])("accepts %s", (id) => {
    expect(serverIdSchema.safeParse(id).success).toBe(true);
  });

  it.each(["", "Home", "-a", "a-", "a_b", "../etc", "a b", "x".repeat(33)])("rejects %j", (id) => {
    expect(serverIdSchema.safeParse(id).success).toBe(false);
  });
});

describe("serverSpecSchema", () => {
  const good = { id: "homeworld", type: "PAPER", version: "1.21.1", memoryMb: 4096, cpus: 2, port: 25565, eulaAccepted: true };

  it("accepts a normal spec", () => {
    expect(serverSpecSchema.safeParse(good).success).toBe(true);
  });

  it("refuses a spec without the EULA accepted", () => {
    expect(serverSpecSchema.safeParse({ ...good, eulaAccepted: false }).success).toBe(false);
  });

  it("refuses a version that is not a release number", () => {
    expect(serverSpecSchema.safeParse({ ...good, version: "1.21; rm -rf /" }).success).toBe(false);
  });
});

describe("consoleInSchema", () => {
  it("accepts one command", () => {
    expect(consoleInSchema.safeParse({ t: "cmd", cmd: "say hi" }).success).toBe(true);
  });

  it("refuses a command with a newline in it", () => {
    expect(consoleInSchema.safeParse({ t: "cmd", cmd: "say hi\nop griefer" }).success).toBe(false);
  });
});
