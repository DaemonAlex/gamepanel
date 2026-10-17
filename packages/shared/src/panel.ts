import { z } from "zod";
import { powerActionSchema, serverTypeSchema, type NodeInfo, type ServerStats, type ServerStatus } from "./server.js";

// Shapes the panel API and the web app share.

export type Role = "admin" | "owner" | "subuser";

export interface Me {
  id: string;
  email: string;
  role: Role;
  totpEnabled?: boolean;
}

export const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(500),
  // Six-digit code from an authenticator app, when two-step login is on.
  code: z.string().regex(/^\d{6}$/).optional(),
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
  diskGb: z.number().int().min(2).max(1000).default(20),
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
  diskGb: number;
  port: number;
  publicIp: string;
  // What the viewer may do here ("all" for owners and admins).
  perms: string[];
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

// --- plugins and mods ---

export interface PluginItem {
  file: string;
  name: string;
  version: string;
  enabled: boolean;
  bytes: number;
  sha1: string;
}

export interface PluginUpdate {
  version: string;
  url: string;
  filename: string;
  // Modrinth publishes SHA-512, Hangar SHA-256.
  sha512?: string;
  sha256?: string;
  // A jump in the first version number (e.g. 4.x to 5.x): may change configs or commands.
  major?: boolean;
}

export interface PluginsView {
  // "plugins" for Paper/Purpur, "mods" for Fabric/Forge/NeoForge, null for Vanilla.
  folder: "plugins" | "mods" | null;
  mcVersion: string;
  items: (PluginItem & { update: PluginUpdate | null })[];
}

export interface CatalogHit {
  source: "modrinth" | "hangar";
  id: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  icon: string | null;
  url: string;
}

export const installSchema = z.object({
  source: z.enum(["modrinth", "hangar"]),
  id: z.string().min(1).max(120).regex(/^[A-Za-z0-9_./-]+$/),
});

// --- logs ---

export interface LogFile {
  path: string;
  kind: "log" | "crash";
  bytes: number;
  modified: string;
}

export interface LogRead {
  path: string;
  lines: [number, string][];
  total: number;
  matched: number;
  truncated: boolean;
}

// --- version change ---

export const versionChangeSchema = z.object({
  type: z.enum(["VANILLA", "PAPER", "PURPUR", "FABRIC", "FORGE", "NEOFORGE"]),
  version: z.string().regex(/^(LATEST|\d+\.\d+(?:\.\d+)?)$/),
});

export interface VersionJob {
  state: "backing-up" | "applying" | "done" | "failed";
  from: { type: string; version: string };
  to: { type: string; version: string };
  backup?: string;
  error?: string;
  startedAt: string;
}

// --- people and access ---

// What a subuser may be allowed on a server. Owners and admins have all of them.
export const serverPerms = ["console", "power", "players", "files", "plugins", "backups", "schedules", "logs", "settings"] as const;
export type ServerPerm = (typeof serverPerms)[number];
export const permLabels: Record<ServerPerm, string> = {
  console: "Console and commands",
  power: "Start, stop, restart",
  players: "Players (kick, ban, op, whitelist)",
  files: "Files",
  plugins: "Plugins and mods",
  backups: "Backups and restore",
  schedules: "Schedules",
  logs: "Logs",
  settings: "Settings and version",
};

export const inviteSchema = z.object({
  email: z.string().email().max(200),
  role: z.enum(["admin", "owner", "subuser"]).default("owner"),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(100),
  password: z.string().min(12, "use at least 12 characters").max(500),
});

export const quotaSchema = z.object({
  maxServers: z.number().int().min(0).max(100),
  maxMemoryMb: z.number().int().min(0).max(262144),
  maxDiskGb: z.number().int().min(0).max(10000),
});

export const accessSchema = z.object({
  email: z.string().email().max(200),
  perms: z.array(z.enum(serverPerms)).max(serverPerms.length),
});

export interface UserView {
  id: string;
  email: string;
  role: Role;
  disabled: boolean;
  totpEnabled: boolean;
  quota: { maxServers: number; maxMemoryMb: number; maxDiskGb: number };
  usage: { servers: number; memoryMb: number; diskGb: number };
  createdAt: string;
}

export interface InviteView {
  email: string;
  role: Role;
  kind: "invite" | "reset";
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

export interface AccessView {
  userId: string;
  email: string;
  perms: ServerPerm[];
}
