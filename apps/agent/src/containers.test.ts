import { describe, expect, it } from "vitest";
import type { ServerSpec } from "@gamepanel/shared";
import type { AgentConfig } from "./config.js";
import { buildCreateOptions, containerMemoryBytes, javaTagFor } from "./containers.js";

const cfg: AgentConfig = {
  token: "t".repeat(40),
  host: "10.20.20.10",
  port: 8443,
  tls: null,
  dataRoot: "/srv/gamepanel/servers",
  secretsRoot: "/srv/gamepanel/secrets",
  imageRepo: "itzg/minecraft-server",
  imageRelease: "2026.9.2",
  network: "gp-net",
  bridgeName: "gp-br0",
  subnet: "172.30.0.0/24",
  backupRoot: "/srv/gamepanel/backups",
  importLimits: { maxBytes: 2 ** 30, maxEntries: 1000 },
  bindIp: "10.20.20.10",
};

const spec: ServerSpec = { id: "homeworld", type: "PAPER", version: "1.21.1", memoryMb: 4096, cpus: 2, port: 25565, eulaAccepted: true };

describe("javaTagFor", () => {
  it.each([
    ["1.12.2", "java8"],
    ["1.16.5", "java8"],
    ["1.17", "java17"],
    ["1.20.4", "java17"],
    ["1.20.5", "java21"],
    ["1.21.1", "java21"],
    ["26.1", "java25"],
    ["LATEST", "java25"],
  ])("%s needs %s", (version, tag) => {
    expect(javaTagFor(version)).toBe(tag);
  });
});

describe("containerMemoryBytes", () => {
  it("adds 25% above the heap", () => {
    expect(containerMemoryBytes(4096)).toBe(5120 * 1024 * 1024);
  });

  it("adds at least 512 MiB for small heaps", () => {
    expect(containerMemoryBytes(1024)).toBe(1536 * 1024 * 1024);
  });
});

describe("buildCreateOptions", () => {
  const o = buildCreateOptions(cfg, spec);
  const h = o.HostConfig!;

  it("pins the image release and picks the Java tag", () => {
    expect(o.Image).toBe("itzg/minecraft-server:2026.9.2-java21");
  });

  it("runs as uid 2000 (no account on the node) with no extra rights", () => {
    expect(o.User).toBe("2000:2000");
    expect(h.CapDrop).toEqual(["ALL"]);
    expect(h.SecurityOpt).toContain("no-new-privileges:true");
    expect(h.Privileged).toBeUndefined();
  });

  it("publishes only the game port, on the node address", () => {
    expect(h.PortBindings).toEqual({ "25565/tcp": [{ HostIp: "10.20.20.10", HostPort: "25565" }] });
    expect(Object.keys(o.ExposedPorts!)).toEqual(["25565/tcp"]);
  });

  it("caps memory with no swap, CPU and process count", () => {
    expect(h.Memory).toBe(h.MemorySwap);
    expect(h.NanoCpus).toBe(2e9);
    expect(h.PidsLimit).toBe(512);
  });

  it("accepts the EULA only through the spec and reads RCON from a read-only file", () => {
    expect(o.Env).toContain("EULA=TRUE");
    expect(o.Env).toContain("RCON_PASSWORD_FILE=/run/gp/rcon-password");
    expect(o.Env).toContain("BROADCAST_RCON_TO_OPS=false");
    expect(o.Env).toContain("USE_AIKAR_FLAGS=true");
    expect(h.Binds).toContain("/srv/gamepanel/secrets/homeworld/rcon-password:/run/gp/rcon-password:ro");
  });

  it("waits longer than the image's own graceful stop", () => {
    expect(o.StopTimeout).toBeGreaterThan(60);
  });
});
