import { createHash, timingSafeEqual } from "node:crypto";

// Compare the request's bearer token with ours in constant time. Hashing both
// first gives equal-length buffers, so the length of a wrong guess leaks nothing.
export function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = createHash("sha256").update(header.slice(7)).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(given, expected);
}
