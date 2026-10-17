import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { serverIdSchema, serverTypeSchema } from "@gamepanel/shared";
import { hashPassword, newSessionId, seal, sessionHash } from "./auth/crypto.js";
import { loadConfig } from "./config.js";
import { schema } from "./db/index.js";

// Admin jobs run on the panel VM:
//   create-admin --email you@example.com          prints a one-time password
//   add-node --id node1 --name "Node 1" --url https://10.20.20.10:8443 --token-file F --ca-file F --public-ip 1.2.3.4 --ports 25566-25600
//   register-server --id pw --name "Perpetual Wonders" --node node1 --owner you@example.com --type PAPER --version 1.21.4 --memory 6144 --cpus 4 --port 25565 [--hostname pw.mc.example.com]
//     (for a server that already runs on a node; EULA is recorded as accepted by the owner now)
//   invite --email friend@example.com --role subuser|owner|admin [--give-server pw]
//     prints a one-time join link path (7 days); --give-server makes them that server's owner when they join

const cfg = loadConfig();
const sql = postgres(cfg.databaseUrl, { max: 1 });
const db = drizzle(sql, { schema });
const [command, ...rest] = process.argv.slice(2);

function need<T>(v: T | undefined, name: string): T {
  if (v === undefined || v === "") throw new Error(`--${name} is required`);
  return v;
}

try {
  if (command === "create-admin") {
    const { values } = parseArgs({ args: rest, options: { email: { type: "string" } } });
    const email = need(values.email, "email").toLowerCase();
    const password = randomBytes(18).toString("base64url");
    await db.insert(schema.users).values({ id: randomUUID(), email, passwordHash: await hashPassword(password), role: "admin" });
    console.log(`admin ${email} created. One-time password: ${password}`);
  } else if (command === "add-node") {
    const { values: v } = parseArgs({
      args: rest,
      options: {
        id: { type: "string" },
        name: { type: "string" },
        url: { type: "string" },
        "token-file": { type: "string" },
        "ca-file": { type: "string" },
        "public-ip": { type: "string" },
        ports: { type: "string" },
      },
    });
    const [min, max] = need(v.ports, "ports").split("-").map(Number);
    if (!min || !max || min > max) throw new Error("--ports must look like 25566-25600");
    await db.insert(schema.nodes).values({
      id: need(v.id, "id"),
      name: need(v.name, "name"),
      agentUrl: need(v.url, "url"),
      agentTokenEnc: seal(cfg.appSecret, readFileSync(need(v["token-file"], "token-file"), "utf8").trim()),
      agentCaPem: readFileSync(need(v["ca-file"], "ca-file"), "utf8"),
      publicIp: need(v["public-ip"], "public-ip"),
      portMin: min,
      portMax: max,
    });
    console.log(`node ${v.id} added`);
  } else if (command === "register-server") {
    const { values: v } = parseArgs({
      args: rest,
      options: {
        id: { type: "string" },
        name: { type: "string" },
        node: { type: "string" },
        owner: { type: "string" },
        type: { type: "string" },
        version: { type: "string" },
        memory: { type: "string" },
        cpus: { type: "string" },
        port: { type: "string" },
        hostname: { type: "string" },
      },
    });
    const [owner] = await db.select().from(schema.users).where(eq(schema.users.email, need(v.owner, "owner").toLowerCase()));
    if (!owner) throw new Error("owner not found");
    await db.insert(schema.servers).values({
      id: serverIdSchema.parse(need(v.id, "id")),
      name: need(v.name, "name"),
      nodeId: need(v.node, "node"),
      ownerId: owner.id,
      type: serverTypeSchema.parse(need(v.type, "type")),
      version: need(v.version, "version"),
      memoryMb: Number(need(v.memory, "memory")),
      cpus: Number(need(v.cpus, "cpus")),
      port: Number(need(v.port, "port")),
      hostname: v.hostname ?? null,
      eulaAcceptedBy: owner.id,
      eulaAcceptedAt: new Date(),
    });
    console.log(`server ${v.id} registered`);
  } else if (command === "invite") {
    const { values } = parseArgs({ args: rest, options: { email: { type: "string" }, role: { type: "string" }, "give-server": { type: "string" } } });
    const email = need(values.email, "email").toLowerCase();
    const role = (values.role ?? "owner") as "admin" | "owner" | "subuser";
    if (!["admin", "owner", "subuser"].includes(role)) throw new Error("--role must be admin, owner or subuser");
    const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    if (exists) throw new Error("that email already has an account");
    const token = newSessionId();
    const give = values["give-server"] ? serverIdSchema.parse(values["give-server"]) : null;
    await db.insert(schema.invites).values({ tokenHash: sessionHash(token), kind: "invite", email, role, userId: null, giveServerId: give, createdBy: "cli", expiresAt: new Date(Date.now() + 7 * 86_400_000) });
    console.log(`invite for ${email} (${role}): /invite/${token}`);
  } else {
    console.log("commands: create-admin, add-node, register-server, invite");
    process.exitCode = 2;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
