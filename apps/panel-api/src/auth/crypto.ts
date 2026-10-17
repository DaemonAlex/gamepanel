import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

// Passwords: argon2id with the library's defaults.
export const hashPassword = (password: string) => hash(password);
export const verifyPassword = (stored: string, password: string) => verify(stored, password).catch(() => false);

// Session ids are random; only their SHA-256 is stored.
export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}
export function sessionHash(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

// Small secrets at rest (node agent tokens): AES-256-GCM with a key from APP_SECRET.
function key(appSecret: string): Buffer {
  return createHash("sha256").update(`gamepanel:${appSecret}`).digest();
}

export function seal(appSecret: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(appSecret), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function open(appSecret: string, sealed: string): string {
  const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !body) throw new Error("bad sealed value");
  const d = createDecipheriv("aes-256-gcm", key(appSecret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString("utf8");
}
