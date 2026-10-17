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

export const changePasswordSchema = z.object({
  current: z.string().min(1).max(500),
  next: z.string().min(12, "use at least 12 characters").max(500),
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
  warnings: Warning[];
  // Last hour per server, one point a minute, for the small trend lines.
  sparks: Record<string, { cpu: number[]; players: number[] }>;
}

export const metricRanges = ["1h", "24h", "7d"] as const;
export type MetricRange = (typeof metricRanges)[number];

// One averaged point of a server's history.
export interface MetricPoint {
  t: string;
  cpu: number;
  memBytes: number;
  memLimitBytes: number;
  players: number | null;
  tps: number | null;
  mspt: number | null;
  diskBytes: number;
}

export interface NodeMetricPoint {
  t: string;
  memAllocatedBytes: number;
  memTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  running: number;
}

export interface Warning {
  level: "warn" | "bad";
  serverId?: string;
  nodeId?: string;
  text: string;
}

// --- schedules ---

export const scheduleActions = ["backup", "restart", "save", "command", "message"] as const;
export type ScheduleAction = (typeof scheduleActions)[number];

export const scheduleSchema = z
  .object({
    action: z.enum(scheduleActions),
    // Command (without /) or chat message, for those two actions.
    payload: z.string().max(200).regex(/^[^\r\n]*$/).default(""),
    // "interval": every `minutes`. "daily": at `time` on the chosen `days` (0 = Sunday).
    kind: z.enum(["interval", "daily"]),
    minutes: z.number().int().min(5).max(10080).default(60),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("04:00"),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
    // IANA time zone the time is in, e.g. "America/New_York".
    tz: z.string().max(64).default("UTC"),
    enabled: z.boolean().default(true),
  })
  .refine((s) => !["command", "message"].includes(s.action) || s.payload.trim().length > 0, { message: "say what to run or send", path: ["payload"] });
export type ScheduleInput = z.infer<typeof scheduleSchema>;

export interface ScheduleView extends ScheduleInput {
  id: string;
  serverId: string;
  lastRunAt: string | null;
  lastResult: string | null;
}

export interface BackupsView {
  backups: import("./server.js").BackupEntry[];
  jobs: import("./server.js").BackupJob[];
  keep: number;
}
