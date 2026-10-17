import { sql } from "drizzle-orm";
import { bigserial, boolean, index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["admin", "owner", "subuser"]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull().default("owner"),
  disabled: boolean("disabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("users_email_lower").on(sql`lower(${t.email})`)]);

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
