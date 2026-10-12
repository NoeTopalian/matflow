/**
 * Lane F3 (iteration 2, SF-102 from review R4): a database test run must never compute keyed digests with an EMPTY
 * key. tests/setup-test-db.ts supplies a synthetic AUTH_SECRET when the guarded runners set neither secret; this cell
 * pins that, in the real database-run configuration, the key every keyed digest uses is non-empty. It reads the key
 * exactly as the library does (lib/auth-secret.ts AUTH_SECRET_VALUE, and the NEXTAUTH_SECRET ?? AUTH_SECRET order of
 * lib/login-email.ts) and never prints it. Nothing is written to the database.
 */
import { describe, expect, it } from "vitest";

const HAS_DB = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!HAS_DB)("database test runs sign with a non-empty key (SF-102)", () => {
  it("lib/auth-secret's AUTH_SECRET_VALUE is non-empty and at least 32 characters", async () => {
    const { AUTH_SECRET_VALUE } = await import("@/lib/auth-secret");
    expect(AUTH_SECRET_VALUE.length).toBeGreaterThanOrEqual(32);
  });
  it("the read-at-use order (NEXTAUTH_SECRET ?? AUTH_SECRET) also yields a non-empty key", () => {
    const key = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "";
    expect(key.length).toBeGreaterThanOrEqual(32);
  });
});
