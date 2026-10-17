import { z } from "zod";

// A server id is used in container names, folder names and DNS labels, so it is
// kept to the safe overlap of all three: lowercase letters, digits and dashes.
export const serverIdSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, "use 1 to 32 lowercase letters, digits or dashes");
export type ServerId = z.infer<typeof serverIdSchema>;

export const serverTypes = ["VANILLA", "PAPER", "PURPUR", "FABRIC", "FORGE", "NEOFORGE"] as const;
export const serverTypeSchema = z.enum(serverTypes);
export type ServerType = z.infer<typeof serverTypeSchema>;

// What the panel asks the agent to run. The agent turns this into a container.
export const serverSpecSchema = z.object({
  id: serverIdSchema,
  type: serverTypeSchema,
  // "LATEST" or a release such as "1.21.1".
  version: z.string().regex(/^(LATEST|\d+\.\d+(?:\.\d+)?)$/),
  // Java heap in MiB. The container gets more than this; see the agent's limits.
  memoryMb: z.number().int().min(512).max(32768),
  cpus: z.number().min(0.5).max(16),
  // Public port players reach. Inside the container the server always uses 25565.
  port: z.number().int().min(1024).max(65535),
  // The create flow must show the Minecraft EULA and the owner must accept it.
  eulaAccepted: z.literal(true),
  motd: z.string().max(120).optional(),
});
export type ServerSpec = z.infer<typeof serverSpecSchema>;

export const serverStates = ["missing", "created", "starting", "running", "stopping", "stopped", "restarting"] as const;
export type ServerState = (typeof serverStates)[number];

export interface ServerStatus {
  id: ServerId;
  state: ServerState;
  // ISO time the container last started, when it is running.
  startedAt?: string;
  // Docker health check result, when the image reports one.
  health?: "starting" | "healthy" | "unhealthy";
}

export const powerActions = ["start", "stop", "restart", "kill"] as const;
export const powerActionSchema = z.enum(powerActions);
export type PowerAction = z.infer<typeof powerActionSchema>;

// Live numbers for one running server.
export interface ServerStats {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  // From a status ping. Null when the server is not answering yet.
  players: { online: number; max: number; names: string[] } | null;
  version: string | null;
}

// What a node has and what is already promised to servers.
export interface NodeInfo {
  memoryBytes: number;
  cpus: number;
  disk: { totalBytes: number; freeBytes: number };
  servers: { total: number; running: number; allocatedMemoryBytes: number };
}

// Everything the Overview shows about one server.
export interface ServerInfo {
  // From server.properties.
  properties: Record<string, string>;
  // Exact build when the server records one (Paper/Purpur), e.g. "1.21.4-232-...".
  build: string | null;
  java: string | null;
  image: string | null;
  restartCount: number;
  lastExit: { code: number; at: string; oomKilled: boolean } | null;
  worlds: { name: string; bytes: number }[];
  diskBytes: number;
  plugins: { file: string; name: string; version: string }[];
  mods: { file: string; name: string; version: string }[];
  // Only while running and answering RCON.
  live: {
    tps: [number, number, number] | null;
    msptAvg: number | null;
    players: { name: string; uuid: string | null }[];
    online: number;
    max: number;
  } | null;
}

// One 30-second sample of a running server, for graphs and warnings.
export interface ServerSample {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  players: number | null;
  tps: number | null;
  msptAvg: number | null;
  diskBytes: number;
  restartCount: number;
}
