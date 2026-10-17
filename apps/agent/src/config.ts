// Agent settings come from the environment (an env file on the node, never in git).

export interface AgentConfig {
  token: string;
  host: string;
  port: number;
  tls: { certPath: string; keyPath: string } | null;
  dataRoot: string;
  // Per-server secrets (the RCON password) live outside the server folder, so
  // they never show up in the file manager.
  secretsRoot: string;
  // e.g. "itzg/minecraft-server" and "2026.9.2". The Java tag is added per server.
  imageRepo: string;
  imageRelease: string;
  network: string;
  // The node address that game ports are published on.
  bindIp: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function loadConfig(env: Env = process.env): AgentConfig {
  const token = required(env, "AGENT_TOKEN");
  if (token.length < 32) throw new Error("AGENT_TOKEN must be at least 32 characters");

  const port = Number(env.AGENT_PORT ?? "8443");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_PORT is not a valid port");

  // Plain HTTP is only for tests on loopback. The real agent always runs TLS.
  const insecure = env.AGENT_INSECURE_HTTP === "1";
  const host = env.AGENT_HOST ?? "127.0.0.1";
  if (insecure && host !== "127.0.0.1") throw new Error("AGENT_INSECURE_HTTP is only allowed on 127.0.0.1");

  return {
    token,
    host,
    port,
    tls: insecure ? null : { certPath: required(env, "AGENT_TLS_CERT"), keyPath: required(env, "AGENT_TLS_KEY") },
    dataRoot: env.AGENT_DATA_ROOT ?? "/srv/gamepanel/servers",
    secretsRoot: env.AGENT_SECRETS_ROOT ?? "/srv/gamepanel/secrets",
    imageRepo: env.AGENT_MC_IMAGE_REPO ?? "itzg/minecraft-server",
    imageRelease: required(env, "AGENT_MC_IMAGE_RELEASE"),
    network: env.AGENT_MC_NETWORK ?? "gp-net",
    bindIp: required(env, "AGENT_BIND_IP"),
  };
}
