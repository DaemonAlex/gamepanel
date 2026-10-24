import { createHash } from "node:crypto";
import type { ServerId } from "@gamepanel/shared";

// Pure helpers for the database feature: names, cell formatting and the SQL for
// editing one row. Kept free of connections so they can be tested on their own.

export class DbError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

// "pw" + "coreprotect" -> "pw_coreprotect". Server ids only use [a-z0-9-].
export function dbNameFor(id: ServerId, label: string): string {
  const name = `${id.replace(/-/g, "_")}_${label}`;
  if (name.length > 64) throw new DbError("database name is too long");
  return name;
}

// The second login on every database, allowed to read only.
export const readOnlyUser = (user: string) => `${user}_r`.slice(0, 80);

// The private link between one server and the database service. Bridge names
// are limited to 15 characters, so they use a hash of the id.
export const linkNetwork = (id: ServerId) => `gp-db-${id}`;
export const linkBridge = (id: ServerId) => `gpdb${createHash("sha1").update(id).digest("hex").slice(0, 10)}`;

export function quoteId(name: string): string {
  if (!name || name.includes("\0")) throw new DbError("bad name");
  return `\`${name.replace(/`/g, "``")}\``;
}

const BINARY_TYPES = new Set(["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob", "bit", "geometry"]);
export const isBinaryType = (dataType: string) => BINARY_TYPES.has(dataType.toLowerCase());

const HEX_SHOWN = 64;

// One cell as text. Binary data shows as hex, cut after 64 bytes.
export function formatCell(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) {
    const hex = v.subarray(0, HEX_SHOWN).toString("hex");
    return `0x${hex}${v.length > HEX_SHOWN ? `... (${v.length} bytes)` : ""}`;
  }
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

type Cells = Record<string, string | null>;

// The WHERE part that picks exactly one row by its full primary key.
function whereKey(primaryKey: string[], key: Cells): { sql: string; params: (string | null)[] } {
  if (!primaryKey.length) throw new DbError("this table has no primary key, so rows can't be edited here; use a query");
  const given = Object.keys(key).sort();
  if (given.length !== primaryKey.length || [...primaryKey].sort().some((c, i) => c !== given[i])) {
    throw new DbError("the row must be named by its whole primary key");
  }
  // <=> also matches NULL safely.
  return { sql: primaryKey.map((c) => `${quoteId(c)} <=> ?`).join(" AND "), params: primaryKey.map((c) => key[c] ?? null) };
}

export function buildUpdate(table: string, primaryKey: string[], binary: Set<string>, key: Cells, set: Cells): { sql: string; params: (string | null)[] } {
  const cols = Object.keys(set);
  if (!cols.length) throw new DbError("nothing to change");
  const bad = cols.find((c) => binary.has(c));
  if (bad) throw new DbError(`${bad} holds binary data and can't be edited here`);
  const where = whereKey(primaryKey, key);
  return {
    sql: `UPDATE ${quoteId(table)} SET ${cols.map((c) => `${quoteId(c)} = ?`).join(", ")} WHERE ${where.sql} LIMIT 1`,
    params: [...cols.map((c) => set[c] ?? null), ...where.params],
  };
}

// Checked before a snapshot is taken, so a missing row costs nothing.
export function buildExists(table: string, primaryKey: string[], key: Cells): { sql: string; params: (string | null)[] } {
  const where = whereKey(primaryKey, key);
  return { sql: `SELECT 1 FROM ${quoteId(table)} WHERE ${where.sql} LIMIT 1`, params: where.params };
}

export function buildDelete(table: string, primaryKey: string[], key: Cells): { sql: string; params: (string | null)[] } {
  const where = whereKey(primaryKey, key);
  return { sql: `DELETE FROM ${quoteId(table)} WHERE ${where.sql} LIMIT 1`, params: where.params };
}

// File-safe stamp for snapshot names.
export const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, "-");
