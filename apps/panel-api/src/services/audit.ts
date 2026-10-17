import { schema, type Db } from "../db/index.js";

// Every action that changes something is written here: who, what, when, which server.
export async function audit(
  db: Db,
  entry: { userId: string | null; action: string; serverId?: string | null; ip?: string | null; detail?: unknown },
): Promise<void> {
  await db.insert(schema.auditLog).values({
    userId: entry.userId,
    action: entry.action,
    serverId: entry.serverId ?? null,
    ip: entry.ip ?? null,
    detail: entry.detail ?? null,
  });
}
