import { describe, it, expect } from "vitest";
import { emailDigest } from "@/lib/login-email";
import * as script from "../../scripts/readiness/owner-login-change-check.mjs";

/**
 * Browser rehearsal AH-G2 (9 Oct 2026): the readiness checker compared the
 * audit rows' address digests with a plain SHA-256 while the routes write a
 * keyed HMAC, so `audit.owner_row_before_after` failed on every correct
 * change. The checker must produce byte-for-byte what the routes write.
 */
describe("owner-login-change-check: audit digest parity with the routes", () => {
  const KEY = "parity-test-key-0123456789";

  it("the checker's digest equals lib/login-email emailDigest under the same key", () => {
    for (const addr of ["Owner@Club.Example", "  pat.personal@club.example ", "x@y.z"]) {
      expect(script.routeEmailDigest(addr, KEY)).toBe(emailDigest(addr, KEY));
    }
  });

  it("a different key, or no key, never matches — and no key is a refusal, not a silent mismatch", () => {
    expect(script.routeEmailDigest("x@y.z", KEY)).not.toBe(emailDigest("x@y.z", KEY + "1"));
    expect(() => script.routeEmailDigest("x@y.z", "")).toThrow(/NEXTAUTH_SECRET|AUTH_SECRET/);
    expect(() => script.routeEmailDigest("x@y.z", undefined as unknown as string)).toThrow(/NEXTAUTH_SECRET|AUTH_SECRET/);
  });
});
