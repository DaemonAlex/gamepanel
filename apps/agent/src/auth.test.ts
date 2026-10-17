import { describe, expect, it } from "vitest";
import { tokenMatches } from "./auth.js";
import { loadConfig } from "./config.js";

const token = "t".repeat(40);

describe("tokenMatches", () => {
  it("accepts the right token", () => {
    expect(tokenMatches(`Bearer ${token}`, token)).toBe(true);
  });

  it.each([undefined, "", token, `Basic ${token}`, `Bearer ${token}x`, "Bearer "])("refuses %j", (header) => {
    expect(tokenMatches(header, token)).toBe(false);
  });
});

describe("loadConfig", () => {
  const base = { AGENT_TOKEN: token, AGENT_TLS_CERT: "/c", AGENT_TLS_KEY: "/k", AGENT_MC_IMAGE_RELEASE: "2026.9.2", AGENT_BIND_IP: "10.20.20.10" };

  it("loads a full config", () => {
    expect(loadConfig(base).tls).toEqual({ certPath: "/c", keyPath: "/k" });
  });

  it("refuses a short token", () => {
    expect(() => loadConfig({ ...base, AGENT_TOKEN: "short" })).toThrow(/32/);
  });

  it("refuses plain HTTP on anything but loopback", () => {
    expect(() => loadConfig({ ...base, AGENT_INSECURE_HTTP: "1", AGENT_HOST: "0.0.0.0" })).toThrow(/127.0.0.1/);
  });

  it("needs TLS files unless plain HTTP is asked for", () => {
    const { AGENT_TLS_CERT: _c, ...noCert } = base;
    expect(() => loadConfig(noCert)).toThrow(/AGENT_TLS_CERT/);
  });
});
