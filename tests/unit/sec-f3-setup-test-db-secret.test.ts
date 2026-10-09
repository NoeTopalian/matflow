/**
 * Lane F3 (iteration 2, SF-102 from review R4): under the guarded runners neither NEXTAUTH_SECRET nor AUTH_SECRET is
 * set, so every keyed digest a DB suite computes (import provenance, login-email digests, card tokens …) was an HMAC
 * with an EMPTY key and said nothing about key secrecy. tests/setup-test-db.ts now gives a database test process a
 * synthetic 64-hex AUTH_SECRET when both are unset, says so in one line, and never overrides a configured secret.
 * The setup module is re-imported with a controlled environment; nothing connects.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const TEST_URL = "postgresql://u:p@ep-hidden-salad-abom7cg4-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";
const KEYS = ["TEST_DATABASE_URL", "DATABASE_URL", "PGOPTIONS", "PGHOST", "PGHOSTADDR", "AUTH_SECRET", "NEXTAUTH_SECRET"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

async function loadSetup(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
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
    else process.env[k] = saved[k];
  }
});

describe("tests/setup-test-db.ts signing secret (SF-102)", () => {
  it("a database run with neither secret set gets a synthetic, non-empty 64-hex AUTH_SECRET and one line saying so", async () => {
    const lines = await loadSetup({ TEST_DATABASE_URL: TEST_URL });
    expect(process.env.AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(process.env.NEXTAUTH_SECRET).toBeUndefined();
    expect(lines.filter((l) => /synthetic/i.test(l))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(process.env.AUTH_SECRET!);
  });

  it("each process gets its own value (nothing committed to the repository is ever the key)", async () => {
    await loadSetup({ TEST_DATABASE_URL: TEST_URL });
    const first = process.env.AUTH_SECRET;
    await loadSetup({ TEST_DATABASE_URL: TEST_URL });
    expect(process.env.AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(process.env.AUTH_SECRET).not.toBe(first);
  });

  it.each([
    ["AUTH_SECRET", { AUTH_SECRET: "configured-auth-secret-value-0001" }],
    ["NEXTAUTH_SECRET", { NEXTAUTH_SECRET: "configured-nextauth-secret-value-01" }],
  ])("a configured %s is left exactly as it is, and nothing is printed", async (_k, env) => {
    const lines = await loadSetup({ TEST_DATABASE_URL: TEST_URL, ...env });
    expect(process.env.AUTH_SECRET).toBe((env as Record<string, string>).AUTH_SECRET);
    expect(process.env.NEXTAUTH_SECRET).toBe((env as Record<string, string>).NEXTAUTH_SECRET);
    expect(lines.filter((l) => /synthetic/i.test(l))).toEqual([]);
  });

  it("a run without a test database (the plain unit suite) is untouched — unit cells about a missing secret keep their meaning", async () => {
    const lines = await loadSetup({});
    expect(process.env.AUTH_SECRET).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("an empty-string secret counts as unset (an empty key is exactly what SF-102 is about)", async () => {
    await loadSetup({ TEST_DATABASE_URL: TEST_URL, AUTH_SECRET: "", NEXTAUTH_SECRET: "" });
    expect(process.env.AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    // lib/auth-secret.ts reads NEXTAUTH_SECRET ?? AUTH_SECRET: an empty NEXTAUTH_SECRET would still win and stay empty.
    expect(process.env.NEXTAUTH_SECRET).toBeUndefined();
  });
});
