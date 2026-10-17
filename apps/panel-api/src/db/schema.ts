import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["admin", "owner", "subuser"]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull().default("owner"),
  disabled: boolean("disabled").notNull().default(false),
  // Two-step login (authenticator app). The secret is encrypted with APP_SECRET.
  totpSecretEnc: text("totp_secret_enc"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  // Quotas for owners (admins have none).
  maxServers: integer("max_servers").notNull().default(1),
  maxMemoryMb: integer("max_memory_mb").notNull().default(4096),
  maxDiskGb: integer("max_disk_gb").notNull().default(20),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("users_email_lower").on(sql`lower(${t.email})`)]);

// One-time links: an invite to join, or a password reset. Only the hash of the token is stored.
export const invites = pgTable("invites", {
  tokenHash: text("token_hash").primaryKey(),
  kind: text("kind").notNull(),
  email: text("email").notNull(),
  role: roleEnum("role").notNull().default("owner"),
  userId: text("user_id"),
  createdBy: text("created_by").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Only a hash of the session id is stored, so a database leak does not leak live sessions.
export const sessions = pgTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("sessions_user").on(t.userId)]);

// A machine that runs game servers through its agent.
export const nodes = pgTable("nodes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  agentUrl: text("agent_url").notNull(),
  // Encrypted with the panel's APP_SECRET.
  agentTokenEnc: text("agent_token_enc").notNull(),
  // The agent's self-signed certificate, trusted for this node only.
  agentCaPem: text("agent_ca_pem").notNull(),
  publicIp: text("public_ip").notNull(),
  portMin: integer("port_min").notNull(),
  portMax: integer("port_max").notNull(),
  // RAM kept free for the node itself, in MiB.
  reservedMemoryMb: integer("reserved_memory_mb").notNull().default(2048),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const servers = pgTable("servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  nodeId: text("node_id").notNull().references(() => nodes.id),
  ownerId: text("owner_id").notNull().references(() => users.id),
  type: text("type").notNull(),
  version: text("version").notNull(),
  memoryMb: integer("memory_mb").notNull(),
  cpus: real("cpus").notNull(),
  port: integer("port").notNull(),
  // Hostname players use, when DNS is set up for it.
  hostname: text("hostname"),
  // How many backups to keep; older ones are removed after each good backup.
  backupKeep: integer("backup_keep").notNull().default(7),
  // Disk cap for the server folder, enforced on the node.
  diskGb: integer("disk_gb").notNull().default(20),
  eulaAcceptedBy: text("eula_accepted_by").notNull().references(() => users.id),
  eulaAcceptedAt: timestamp("eula_accepted_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("servers_node_port").on(t.nodeId, t.port)]);

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  userId: text("user_id"),
  action: text("action").notNull(),
  serverId: text("server_id"),
  ip: text("ip"),
  detail: jsonb("detail"),
}, (t) => [index("audit_at").on(t.at), index("audit_server").on(t.serverId)]);

// One row every 30 seconds per running server. Kept for 8 days.
export const serverSamples = pgTable("server_samples", {
  serverId: text("server_id").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  cpu: real("cpu").notNull(),
  memBytes: bigint("mem_bytes", { mode: "number" }).notNull(),
  memLimitBytes: bigint("mem_limit_bytes", { mode: "number" }).notNull(),
  players: integer("players"),
  tps: real("tps"),
  mspt: real("mspt"),
  diskBytes: bigint("disk_bytes", { mode: "number" }).notNull(),
  restarts: integer("restarts").notNull(),
}, (t) => [index("server_samples_server_at").on(t.serverId, t.at)]);

// One row every 30 seconds per node.
export const nodeSamples = pgTable("node_samples", {
  nodeId: text("node_id").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  memTotalBytes: bigint("mem_total_bytes", { mode: "number" }).notNull(),
  memAllocatedBytes: bigint("mem_allocated_bytes", { mode: "number" }).notNull(),
  diskTotalBytes: bigint("disk_total_bytes", { mode: "number" }).notNull(),
  diskFreeBytes: bigint("disk_free_bytes", { mode: "number" }).notNull(),
  running: integer("running").notNull(),
}, (t) => [index("node_samples_node_at").on(t.nodeId, t.at)]);

export const schedules = pgTable("schedules", {
  id: text("id").primaryKey(),
  serverId: text("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  payload: text("payload").notNull().default(""),
  kind: text("kind").notNull(),
  minutes: integer("minutes").notNull().default(60),
  time: text("time").notNull().default("04:00"),
  days: jsonb("days").$type<number[]>().notNull(),
  tz: text("tz").notNull().default("UTC"),
  enabled: boolean("enabled").notNull().default(true),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastResult: text("last_result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("schedules_server").on(t.serverId)]);

// People other than the owner who may use a server, and what they may do.
export const serverAccess = pgTable("server_access", {
  serverId: text("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  perms: jsonb("perms").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("server_access_pair").on(t.serverId, t.userId), index("server_access_user").on(t.userId)]);
