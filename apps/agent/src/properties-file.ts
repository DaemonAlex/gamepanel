// Reading and editing server.properties without disturbing anything else in it.

// Java properties escapes: \uXXXX and backslash before a character.
export function decodeValue(raw: string): string {
  return raw.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_m, hex: string | undefined, ch: string | undefined) => {
    if (hex) return String.fromCharCode(parseInt(hex, 16));
    return ch === "n" ? "\n" : ch === "t" ? "\t" : (ch ?? "");
  });
}

// Write a value the way Java expects: backslash, '=' and ':' escaped, and
// anything outside printable ASCII as \uXXXX (so § in a MOTD survives).
export function encodeValue(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "=" || ch === ":") out += `\\${ch}`;
    else if (code < 0x20 || code > 0x7e) {
      for (const unit of ch.split("").map((c) => c.charCodeAt(0))) out += `\\u${unit.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return out;
}

export function readProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#!]/.test(line)) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = decodeValue(line.slice(i + 1).trim());
  }
  return out;
}

// Change only the given keys; comments, order and every other line stay as they were.
export function writeProperties(text: string, changes: Record<string, string>): string {
  const pending = new Map(Object.entries(changes));
  const lines = text.split(/\r?\n/);
  const out = lines.map((line) => {
    if (/^\s*[#!]/.test(line)) return line;
    const i = line.indexOf("=");
    if (i < 0) return line;
    const key = line.slice(0, i).trim();
    if (!pending.has(key)) return line;
    const v = pending.get(key)!;
    pending.delete(key);
    return `${key}=${encodeValue(v)}`;
  });
  // Keys that were not in the file yet go at the end.
  const tail = out.length && out[out.length - 1] === "" ? out.pop() : undefined;
  for (const [k, v] of pending) out.push(`${k}=${encodeValue(v)}`);
  if (tail !== undefined) out.push(tail);
  return out.join("\n");
}

// Keys never sent out of the agent.
const SECRET_KEYS = ["rcon.password", "management-server-secret"];
export function withoutSecrets(values: Record<string, string>): Record<string, string> {
  const out = { ...values };
  for (const k of SECRET_KEYS) delete out[k];
  return out;
}
