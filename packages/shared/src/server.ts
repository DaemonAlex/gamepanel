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
