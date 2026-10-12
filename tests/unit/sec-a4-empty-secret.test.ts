// R6-N6 (security campaign iteration 2, lane A4, 10 Oct 2026) — an EMPTY secret string must count as unset.
//
// lib/auth-secret.ts read `NEXTAUTH_SECRET ?? AUTH_SECRET`: `??` only falls through on undefined, so
// NEXTAUTH_SECRET="" with AUTH_SECRET set signed every HMAC in the product with a zero-length key outside production
// (R6 measured key length 0 in a TEST run) and refused to start in production although AUTH_SECRET was set. tests/setup-test-db.ts likewise synthesised a key only when BOTH were empty.
// Now a blank value (empty or whitespace only) is treated as unset in both places. The secret ITSELF is never
// trimmed or altered: a real secret with a trailing newline keeps every derived key (sessions, lib/encryption's
// TOTP secrets, card and kiosk sub-keys) exactly as it was.
import { afterEach, describe, expect, it, vi } from "vitest";

const KEYS = ["NEXTAUTH_SECRET", "AUTH_SECRET", "NODE_ENV", "NEXT_PHASE", "TEST_DATABASE_URL", "DATABASE_URL", "PGOPTIONS", "PGHOST", "PGHOSTADDR"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const TEST_URL = "postgresql://u:p@ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";
const A = "secA4-auth-secret-" + "a".repeat(40);
const N = "secA4-nextauth-secret-" + "n".repeat(40);

function setEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}
async function secret(env: Partial<Record<(typeof KEYS)[number], string>>): Promise<string> {
  setEnv(env);
  vi.resetModules();
  return (await import("@/lib/auth-secret")).AUTH_SECRET_VALUE;
}
async function loadSetup(env: Partial<Record<(typeof KEYS)[number], string>>) {
  setEnv(env);
  vi.resetModules();
  const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await import("../setup-test-db");
    return log.mock.calls.map((c) => String(c[0]));
  } finally {
    log.mockRestore();
  }
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else (process.env as Record<string, string | undefined>)[k] = saved[k];
  }
});

describe("lib/auth-secret: a blank secret is unset", () => {
  it("R6-N6: NEXTAUTH_SECRET='' with AUTH_SECRET set signs with AUTH_SECRET, not a zero-length key", async () => {
    const v = await secret({ NEXTAUTH_SECRET: "", AUTH_SECRET: A });
    expect(v.length).toBeGreaterThan(0);
    expect(v).toBe(A);
  });
  it("whitespace-only NEXTAUTH_SECRET falls through to AUTH_SECRET too", async () => {
    expect(await secret({ NEXTAUTH_SECRET: "  \n", AUTH_SECRET: A })).toBe(A);
  });
  it("positive control: NEXTAUTH_SECRET still wins when it is set", async () => {
    expect(await secret({ NEXTAUTH_SECRET: N, AUTH_SECRET: A })).toBe(N);
    expect(await secret({ AUTH_SECRET: A })).toBe(A);
  });
  it("a configured secret is used VERBATIM (never trimmed): a trailing newline keeps every derived key", async () => {
    expect(await secret({ NEXTAUTH_SECRET: N + "\n" })).toBe(N + "\n");
    expect(await secret({ AUTH_SECRET: " " + A })).toBe(" " + A);
  });
  it.each([
    ["both unset", {}],
    ["both empty", { NEXTAUTH_SECRET: "", AUTH_SECRET: "" }],
    ["NEXTAUTH_SECRET empty, AUTH_SECRET whitespace", { NEXTAUTH_SECRET: "", AUTH_SECRET: "   " }],
    ["NEXTAUTH_SECRET whitespace, AUTH_SECRET unset", { NEXTAUTH_SECRET: " \t " }],
  ])("production with %s throws at import (as before, and now for blank values too)", async (_n, env) => {
    await expect(secret({ ...env, NODE_ENV: "production" })).rejects.toThrow(/must be set in production/);
  });
  it("production build phase is still allowed to import without a secret (unchanged)", async () => {
    expect(await secret({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build", NEXTAUTH_SECRET: "" })).toBe("");
  });
  it("non-production with nothing usable: empty, as before (callers that must not sign refuse on their own)", async () => {
    expect(await secret({ NEXTAUTH_SECRET: "", AUTH_SECRET: "" })).toBe("");
  });
});

describe("tests/setup-test-db.ts: a blank NEXTAUTH_SECRET is dropped when AUTH_SECRET is set", () => {
  it("R6-N6: TEST run with NEXTAUTH_SECRET='' and AUTH_SECRET set → NEXTAUTH_SECRET removed, AUTH_SECRET kept, nothing printed", async () => {
    const lines = await loadSetup({ TEST_DATABASE_URL: TEST_URL, NEXTAUTH_SECRET: "", AUTH_SECRET: A });
    expect(process.env.NEXTAUTH_SECRET).toBeUndefined();
    expect(process.env.AUTH_SECRET).toBe(A);
    expect(lines.filter((l) => /synthetic/i.test(l))).toEqual([]);
    vi.resetModules();
    expect((await import("@/lib/auth-secret")).AUTH_SECRET_VALUE).toBe(A);
  });
  it("whitespace-only secrets count as unset: a synthetic key is made and the blank NEXTAUTH_SECRET removed", async () => {
    const lines = await loadSetup({ TEST_DATABASE_URL: TEST_URL, NEXTAUTH_SECRET: " ", AUTH_SECRET: "  " });
    expect(process.env.AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(process.env.NEXTAUTH_SECRET).toBeUndefined();
    expect(lines.filter((l) => /synthetic/i.test(l))).toHaveLength(1);
  });
  it("positive control: a configured NEXTAUTH_SECRET is left alone", async () => {
    await loadSetup({ TEST_DATABASE_URL: TEST_URL, NEXTAUTH_SECRET: N });
    expect(process.env.NEXTAUTH_SECRET).toBe(N);
    expect(process.env.AUTH_SECRET).toBeUndefined();
  });
});
