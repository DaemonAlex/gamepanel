import { z } from "zod";

// The server.properties fields the Settings tab edits. Anything not listed
// here is shown read-only; the managed keys are never written by the form.

type Field =
  | { key: string; label: string; group: Group; type: "text"; max: number; help?: string }
  | { key: string; label: string; group: Group; type: "number"; min: number; max: number; help?: string }
  | { key: string; label: string; group: Group; type: "bool"; help?: string }
  | { key: string; label: string; group: Group; type: "enum"; options: readonly string[]; help?: string };

export type Group = "General" | "Gameplay" | "World" | "Players" | "Advanced";
export const propertyGroups: readonly Group[] = ["General", "Gameplay", "World", "Players", "Advanced"];

export const propertyFields: readonly Field[] = [
  { key: "motd", label: "Message of the day", group: "General", type: "text", max: 200, help: "Shown in the server list. Colour codes like §6 work." },
  { key: "max-players", label: "Max players", group: "General", type: "number", min: 1, max: 500 },
  { key: "white-list", label: "Whitelist", group: "General", type: "bool", help: "Only listed players (and operators) can join." },
  { key: "enforce-whitelist", label: "Kick players not on the whitelist", group: "General", type: "bool" },
  { key: "gamemode", label: "Game mode", group: "Gameplay", type: "enum", options: ["survival", "creative", "adventure", "spectator"] },
  { key: "force-gamemode", label: "Force game mode on join", group: "Gameplay", type: "bool" },
  { key: "difficulty", label: "Difficulty", group: "Gameplay", type: "enum", options: ["peaceful", "easy", "normal", "hard"] },
  { key: "hardcore", label: "Hardcore", group: "Gameplay", type: "bool", help: "One life. Death means spectator mode." },
  { key: "pvp", label: "PvP", group: "Gameplay", type: "bool" },
  { key: "allow-flight", label: "Allow flight", group: "Gameplay", type: "bool", help: "Stops kicks for flying with mods or plugins." },
  { key: "spawn-monsters", label: "Monsters", group: "World", type: "bool" },
  { key: "spawn-animals", label: "Animals", group: "World", type: "bool" },
  { key: "spawn-npcs", label: "Villagers", group: "World", type: "bool" },
  { key: "allow-nether", label: "Nether", group: "World", type: "bool" },
  { key: "spawn-protection", label: "Spawn protection radius", group: "World", type: "number", min: 0, max: 1000, help: "Blocks around spawn only operators can change." },
  { key: "view-distance", label: "View distance", group: "World", type: "number", min: 3, max: 32, help: "Chunks sent to players. Higher costs RAM and CPU." },
  { key: "simulation-distance", label: "Simulation distance", group: "World", type: "number", min: 3, max: 32, help: "Chunks that tick. The biggest lag lever." },
  { key: "max-world-size", label: "World border radius", group: "World", type: "number", min: 1, max: 29999984 },
  { key: "online-mode", label: "Real accounts only (online mode)", group: "Players", type: "bool", help: "Off lets anyone join with any name. Keep on." },
  { key: "player-idle-timeout", label: "Kick idle players after (minutes, 0 = never)", group: "Players", type: "number", min: 0, max: 1440 },
  { key: "op-permission-level", label: "Operator permission level", group: "Players", type: "number", min: 1, max: 4 },
  { key: "hide-online-players", label: "Hide player names in the server list", group: "Players", type: "bool" },
  { key: "enable-command-block", label: "Command blocks", group: "Advanced", type: "bool" },
  { key: "resource-pack", label: "Resource pack URL", group: "Advanced", type: "text", max: 500 },
  { key: "require-resource-pack", label: "Require the resource pack", group: "Advanced", type: "bool" },
  { key: "enable-status", label: "Show in server list pings", group: "Advanced", type: "bool" },
  { key: "sync-chunk-writes", label: "Safe chunk saving", group: "Advanced", type: "bool", help: "Off is faster but riskier on crashes." },
];

// Set by the panel or the image. Changing them by hand breaks the connection or the console.
export const managedProperties = ["server-port", "query.port", "enable-query", "enable-rcon", "rcon.port", "rcon.password", "broadcast-rcon-to-ops"] as const;

const fieldByKey = new Map(propertyFields.map((f) => [f.key, f]));

// Check one change. Returns the value as it goes into the file, or an error message.
export function checkProperty(key: string, value: string): { ok: true; value: string } | { ok: false; error: string } {
  const f = fieldByKey.get(key);
  if (!f) return { ok: false, error: `${key} cannot be changed here` };
  if (/[\r\n]/.test(value)) return { ok: false, error: `${f.label}: one line only` };
  switch (f.type) {
    case "text":
      return value.length <= f.max ? { ok: true, value } : { ok: false, error: `${f.label}: at most ${f.max} characters` };
    case "number": {
      const n = Number(value);
      return Number.isInteger(n) && n >= f.min && n <= f.max ? { ok: true, value: String(n) } : { ok: false, error: `${f.label}: a whole number from ${f.min} to ${f.max}` };
    }
    case "bool":
      return value === "true" || value === "false" ? { ok: true, value } : { ok: false, error: `${f.label}: true or false` };
    case "enum":
      return f.options.includes(value) ? { ok: true, value } : { ok: false, error: `${f.label}: one of ${f.options.join(", ")}` };
  }
}

export const propertyChangesSchema = z.object({ changes: z.record(z.string(), z.string()) });

export interface PropertiesView {
  values: Record<string, string>;
}
