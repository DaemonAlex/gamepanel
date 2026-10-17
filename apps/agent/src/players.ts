import type { PlayerAction, PlayerRef, PlayersView } from "@gamepanel/shared";
import { playerActionSchema } from "@gamepanel/shared";
import type { ServerFiles } from "./files.js";

// Player actions become exactly one vanilla command. The "minecraft:" prefix
// skips plugins (Essentials and the like) that replace these commands.
// The name is checked against the Minecraft name rules first, so it cannot
// carry anything else into the command.
export function commandFor(input: PlayerAction): string {
  const a = playerActionSchema.parse(input);
  const text = (a.text ?? "").trim();
  switch (a.action) {
    case "kick":
      return `minecraft:kick ${a.name}${text ? ` ${text}` : ""}`;
    case "ban":
      return `minecraft:ban ${a.name}${text ? ` ${text}` : ""}`;
    case "pardon":
      return `minecraft:pardon ${a.name}`;
    case "op":
      return `minecraft:op ${a.name}`;
    case "deop":
      return `minecraft:deop ${a.name}`;
    case "whitelist-add":
      return `minecraft:whitelist add ${a.name}`;
    case "whitelist-remove":
      return `minecraft:whitelist remove ${a.name}`;
    case "tell":
      if (!text) throw new Error("a message is needed");
      return `minecraft:tell ${a.name} ${text}`;
  }
}

async function readJson<T>(files: ServerFiles, name: string): Promise<T[]> {
  try {
    const v = JSON.parse(await files.readText(name)) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

const ref = (x: { name?: string; uuid?: string }): PlayerRef => ({ name: String(x.name ?? ""), uuid: x.uuid ?? null });

// Whitelist, operators, bans and every player seen, from the server's own files.
export async function readPlayerFiles(files: ServerFiles): Promise<Omit<PlayersView, "running" | "online" | "max" | "whitelistOn">> {
  const [whitelist, ops, banned, bannedIps, cache] = await Promise.all([
    readJson<{ name?: string; uuid?: string }>(files, "whitelist.json"),
    readJson<{ name?: string; uuid?: string; level?: number }>(files, "ops.json"),
    readJson<{ name?: string; uuid?: string; reason?: string; source?: string }>(files, "banned-players.json"),
    readJson<{ ip?: string; reason?: string }>(files, "banned-ips.json"),
    readJson<{ name?: string; uuid?: string; expiresOn?: string }>(files, "usercache.json"),
  ]);
  // usercache entries expire a month after last login, so later expiry = seen more recently.
  const lastSeen = (e?: string) => {
    if (!e) return null;
    const d = new Date(e.replace(" ", "T").replace(/ ([+-]\d{4})$/, "$1"));
    return isNaN(d.getTime()) ? null : new Date(d.getTime() - 30 * 86_400_000).toISOString();
  };
  const byName = (a: PlayerRef, b: PlayerRef) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return {
    whitelist: whitelist.map(ref).sort(byName),
    ops: ops.map((o) => ({ ...ref(o), level: o.level ?? 4 })).sort(byName),
    banned: banned.map((b) => ({ ...ref(b), reason: b.reason ?? "", source: b.source ?? "" })).sort(byName),
    bannedIps: bannedIps.map((b) => ({ ip: String(b.ip ?? ""), reason: b.reason ?? "" })),
    known: cache
      .map((c) => ({ ...ref(c), lastSeen: lastSeen(c.expiresOn) }))
      .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "")),
  };
}
