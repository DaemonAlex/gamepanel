import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, codeAt, newSecret, verifyCode } from "./totp.js";

// RFC 6238 test secret "12345678901234567890" (ASCII), SHA-1.
const RFC = base32Encode(Buffer.from("12345678901234567890"));

describe("totp", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("matches the RFC 6238 vector at %i s", (t, code) => {
    expect(codeAt(RFC, Math.floor(t / 30))).toBe(code);
  });

  it("round-trips base32", () => {
    const b = Buffer.from([0, 1, 2, 250, 255]);
    expect(base32Decode(base32Encode(b))).toEqual(b);
  });

  it("accepts the current code and one step either side, nothing else", () => {
    const s = newSecret();
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyCode(s, codeAt(s, step), now)).toBe(true);
    expect(verifyCode(s, codeAt(s, step - 1), now)).toBe(true);
    expect(verifyCode(s, codeAt(s, step + 3), now)).toBe(false);
    expect(verifyCode(s, "12345", now)).toBe(false);
  });
});
