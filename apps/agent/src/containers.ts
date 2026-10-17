import type { ContainerCreateOptions } from "dockerode";
import type { ServerId, ServerSpec } from "@gamepanel/shared";
import type { AgentConfig } from "./config.js";

// Turning a server spec into Docker settings. Kept free of Docker calls so the
// security-relevant choices here can be tested on their own.

export const LABEL = "gamepanel.server";
// The image's own graceful stop waits up to 60 s (STOP_DURATION). Docker must wait longer.
const STOP_DURATION_S = 60;
export const STOP_TIMEOUT_S = 75;
// Inside the container the server always uses Minecraft's default port.
const GAME_PORT = "25565/tcp";
// The user the game runs as. Not 1000: on the node that id is the "debian" login,
// which has sudo, so a container breakout would land on a real account. 2000 has none.
export const MC_UID = 2000;
const RCON_FILE_IN_CONTAINER = "/run/gp/rcon-password";

export function containerName(id: ServerId): string {
  return `gp-${id}`;
}

export function serverDir(cfg: AgentConfig, id: ServerId): string {
  return `${cfg.dataRoot}/${id}`;
}

export function rconPasswordFile(cfg: AgentConfig, id: ServerId): string {
  return `${cfg.secretsRoot}/${id}/rcon-password`;
}

// Which Java a Minecraft version needs, as an itzg image tag suffix.
// 1.20.5 moved to Java 21; 1.17 moved to 17; the yearly 26.x releases need 25.
export function javaTagFor(version: string): "java8" | "java17" | "java21" | "java25" {
  if (version === "LATEST") return "java25";
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (major >= 26) return "java25";
  if (minor > 20 || (minor === 20 && patch >= 5)) return "java21";
  if (minor >= 17) return "java17";
  return "java8";
}

export function imageFor(cfg: AgentConfig, spec: ServerSpec): string {
  return `${cfg.imageRepo}:${cfg.imageRelease}-${javaTagFor(spec.version)}`;
}

// The heap is set by MEMORY. The JVM also needs memory outside the heap, so the
// container gets 25% more, and never less than 512 MiB more.
export function containerMemoryBytes(heapMb: number): number {
  const extraMb = Math.max(Math.ceil(heapMb * 0.25), 512);
  return (heapMb + extraMb) * 1024 * 1024;
}

export function buildCreateOptions(cfg: AgentConfig, spec: ServerSpec): ContainerCreateOptions {
  const memory = containerMemoryBytes(spec.memoryMb);
  const env = [
    "EULA=TRUE",
    `TYPE=${spec.type}`,
    `VERSION=${spec.version}`,
    `MEMORY=${spec.memoryMb}M`,
    // Lets the agent send console commands with mc-send-to-console.
    "CREATE_CONSOLE_IN_PIPE=true",
    `RCON_PASSWORD_FILE=${RCON_FILE_IN_CONTAINER}`,
    `STOP_DURATION=${STOP_DURATION_S}`,
    // The agent creates the folder already owned by MC_UID.
    "SKIP_CHOWN_DATA=true",
  ];
  if (spec.motd) env.push(`MOTD=${spec.motd}`);

  return {
    name: containerName(spec.id),
    Image: imageFor(cfg, spec),
    Env: env,
    // Run as an unprivileged user from the start, so nothing in the container runs as root.
    User: `${MC_UID}:${MC_UID}`,
    Labels: { [LABEL]: spec.id },
    ExposedPorts: { [GAME_PORT]: {} },
    StopTimeout: STOP_TIMEOUT_S,
    Tty: false,
    OpenStdin: false,
    HostConfig: {
      Binds: [`${serverDir(cfg, spec.id)}:/data`, `${rconPasswordFile(cfg, spec.id)}:${RCON_FILE_IN_CONTAINER}:ro`],
      // Only the game port is published, on the node's own address. RCON (25575) never is.
      PortBindings: { [GAME_PORT]: [{ HostIp: cfg.bindIp, HostPort: String(spec.port) }] },
      NetworkMode: cfg.network,
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(spec.cpus * 1e9),
      PidsLimit: 512,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      RestartPolicy: { Name: "unless-stopped" },
    },
  };
}
