import { z } from "zod";
import { powerActionSchema, serverTypeSchema, type NodeInfo, type ServerStats, type ServerStatus } from "./server.js";

// Shapes the panel API and the web app share.

export type Role = "admin" | "owner" | "subuser";

export interface Me {
  id: string;
  email: string;
  role: Role;
}

export const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(500),
});

export const newServerSchema = z.object({
  name: z.string().trim().min(1).max(40),
  type: serverTypeSchema,
  version: z.string().regex(/^(LATEST|\d+\.\d+(?:\.\d+)?)$/),
  memoryMb: z.number().int().min(1024).max(16384),
  cpus: z.number().min(0.5).max(8).default(2),
  nodeId: z.string().optional(),
  // The create screen shows the Minecraft EULA; the box must be ticked.
  eulaAccepted: z.literal(true),
});
export type NewServer = z.infer<typeof newServerSchema>;

export const powerBodySchema = z.object({ action: powerActionSchema });

export const broadcastSchema = z.object({
  message: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/),
});

export interface ServerView {
  id: string;
  name: string;
  nodeId: string;
  nodeName: string;
  ownerEmail: string;
  type: string;
  version: string;
  memoryMb: number;
  cpus: number;
  port: number;
  publicIp: string;
  // What players type: the hostname, or ip:port until DNS is set.
  address: string;
  status: ServerStatus | null;
  stats: ServerStats | null;
  // Set when the node's agent could not be reached.
  error?: string;
}

export interface NodeView {
  id: string;
  name: string;
  publicIp: string;
  portMin: number;
  portMax: number;
  info: NodeInfo | null;
  error?: string;
}

export interface Dashboard {
  servers: ServerView[];
  // Only for admins.
  nodes: NodeView[] | null;
}
