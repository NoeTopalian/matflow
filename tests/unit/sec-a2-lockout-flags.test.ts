// Lane A2 (security campaign iteration 2, 9 Oct 2026): the sign-in door's
// switches and refusals, driven through the REAL authorize() of auth.ts.
//
//  SF-35  one generic refusal for every throttle/lock; no account-specific code.
//  SF-59  the failure lockout fails CLOSED when its counters cannot be read;
//         LOGIN_THROTTLE_ENABLED cannot switch the throttle off on a Vercel
//         deployment or the production database (its production value is
//         unreadable, lane E2), and absent/malformed stays ON.
//  SF-37  the E2E password bypass and throttle skip depend on an explicit
//         environment flag (E2E_AUTH_BYPASS=true, refused on Vercel), never on
//         x-forwarded-for / x-real-ip (client-controlled).

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";

type Authorize = (credentials: Record<string, unknown>, request: Request) => Promise<Record<string, unknown> | null>;
const h = vi.hoisted(() => ({
  authorize: undefined as undefined | ((c: Record<string, unknown>, r: Request) => Promise<Record<string, unknown> | null>),
  checkRateLimit: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
}));

vi.mock("next-auth", () => ({
  default: (config: { providers: { authorize?: Authorize }[] }) => {
    for (const p of config.providers) if (p?.authorize) h.authorize = p.authorize;
    return { handlers: {}, auth: async () => null, signIn: async () => {}, signOut: async () => {} };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: async () => {} }));
vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));

const PASSWORD = "secA2-correct-horse-battery";
const HASH = bcrypt.hashSync(PASSWORD, 4);
const BYPASS = "secA2-e2e-bypass-token-not-a-password";
const TENANT = { id: "t-a2", slug: "a2-club", name: "A2", primaryColor: "#000", secondaryColor: "#111", textColor: "#fff", subscriptionStatus: "active", deletedAt: null };
const member = (extra: Record<string, unknown> = {}) => ({
  id: "m-a2", tenantId: "t-a2", email: "member@example.test", name: "A2 Member", passwordHash: HASH,
  sessionVersion: 0, failedLoginCount: 0, lockedUntil: null, totpEnabled: false, notifyOnNewLogin: false, ...extra,
});

const db = vi.hoisted(() => ({
  memberRow: null as unknown,
  countImpl: (async () => 0) as (args: unknown) => Promise<number>,
}));
const tx = {
  tenant: { findUnique: vi.fn(async () => TENANT) },
  user: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({ failedLoginCount: 1 })) },
  member: { findUnique: vi.fn(async () => db.memberRow), update: vi.fn(async () => ({ failedLoginCount: 1 })) },
  loginEvent: { findFirst: vi.fn(async () => null) },
  rateLimitHit: {
    count: vi.fn((a: unknown) => db.countImpl(a)),
    createMany: vi.fn(async () => ({ count: 2 })),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
  // Lane A4 (R6-N1): the failure slot is reserved before bcrypt (advisory lock + conditional insert, one
  // transaction). Here the reservation always succeeds unless a cell makes it throw.
  $executeRaw: vi.fn(async () => 1),
  $queryRaw: vi.fn(async () => [{ pairCount: 0, addrCount: 0, inserted: 2 }]),
  $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
};
vi.mock("@/lib/prisma", () => ({ prisma: tx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async (fn: (t: unknown) => unknown) => fn(tx),
  withTenantContext: async (_id: string, fn: (t: unknown) => unknown) => fn(tx),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/rate-limit")>();
  const { vi: v } = await import("vitest");
  h.checkRateLimit = v.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
  return { ...real, checkRateLimit: h.checkRateLimit };
});

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  h.authorize = undefined;
  await import("@/auth");
  return h.authorize!;
}
async function signIn(
  authorize: Authorize,
  password: string,
  headers: Record<string, string> = {},
): Promise<"admitted" | "refused" | string> {
  try {
    const r = await authorize(
      { email: "member@example.test", password, tenantSlug: "a2-club" },
      new Request("http://localhost/api/auth/callback/credentials", { method: "POST", headers }),
    );
    return r ? "admitted" : "refused";
  } catch (e) {
    return `code:${(e as { code?: string }).code}`;
  }
}

const SAFE = { DATABASE_URL: "postgresql://synthetic@ep-hidden-salad-test.invalid/db", VERCEL: "", VERCEL_ENV: "" };

beforeEach(() => {
  db.memberRow = member();
  db.countImpl = async () => 0;
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

describe("SF-35: one generic refusal", () => {
  it("a disown/operator row lock answers like a wrong password, not with an account-specific code", async () => {
    const authorize = await load({ ...SAFE });
    db.memberRow = member({ lockedUntil: new Date(Date.now() + 30 * 60 * 1000) });
    expect(await signIn(authorize, PASSWORD)).toBe("refused");
    expect(await signIn(authorize, "wrong-password-a2")).toBe("refused");
  });

  it("auth.ts no longer has an account-specific lockout code", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("auth.ts", "utf8")).not.toMatch(/code\s*=\s*"account_locked"/);
  });

  it("the throttle refusal carries the generic wording", async () => {
    const { SIGN_IN_THROTTLED_MESSAGE } = await import("@/lib/auth-lockout");
    const authorize = await load({ ...SAFE });
    db.countImpl = async () => 10; // both counters full
    try {
      await authorize({ email: "member@example.test", password: PASSWORD, tenantSlug: "a2-club" }, new Request("http://localhost/x", { method: "POST" }));
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("rate_limited");
      expect(String((e as Error).message)).toContain(SIGN_IN_THROTTLED_MESSAGE);
      expect(String((e as Error).message)).not.toMatch(/account/i);
    }
  });
});

describe("SF-59: fail closed", () => {
  it("positive control: counters readable, right password → admitted", async () => {
    const authorize = await load({ ...SAFE });
    expect(await signIn(authorize, PASSWORD)).toBe("admitted");
  });

  it("counters unreadable (database error) → the RIGHT password is refused", async () => {
    const authorize = await load({ ...SAFE });
    db.countImpl = async () => {
      throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    };
    expect(await signIn(authorize, PASSWORD)).toBe("refused");
  });

  it("a failure that cannot be recorded keeps the attempt refused", async () => {
    const authorize = await load({ ...SAFE });
    // The failure is now recorded by the reservation taken before bcrypt (lane A4, R6-N1).
    tx.$queryRaw.mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
    expect(await signIn(authorize, "wrong-password-a2")).toBe("refused");
  });
});

describe("LOGIN_THROTTLE_ENABLED: production cannot switch the throttle off", () => {
  it.each([
    ["absent", { LOGIN_THROTTLE_ENABLED: undefined }, true],
    ["malformed FALSE", { LOGIN_THROTTLE_ENABLED: "FALSE" }, true],
    ["'false' on a Vercel production deployment", { LOGIN_THROTTLE_ENABLED: "false", VERCEL: "1", VERCEL_ENV: "production" }, true],
    ["'false' on a Vercel preview", { LOGIN_THROTTLE_ENABLED: "false", VERCEL: "1", VERCEL_ENV: "preview" }, true],
    ["'false' on the production database", { LOGIN_THROTTLE_ENABLED: "false", DATABASE_URL: "postgresql://x@ep-bold-wave-abt39t7x-pooler.invalid/db" }, true],
    ["'false' on a laptop against a test database", { LOGIN_THROTTLE_ENABLED: "false" }, false],
  ] as const)("%s → throttle %s", async (_label, env, on) => {
    const authorize = await load({ ...SAFE, ...env });
    await signIn(authorize, PASSWORD, { "x-vercel-forwarded-for": "198.51.100.9" });
    const ipCalls = h.checkRateLimit.mock.calls.filter((c) => String(c[0]).startsWith("login:ip:"));
    expect(ipCalls.length > 0).toBe(on);
  });
});

describe("SF-37: the E2E harness is an explicit flag, never a header", () => {
  const LOCAL = { ...SAFE, TESTING_MODE: "true", E2E_BYPASS_TOKEN: BYPASS };

  it.each([
    ["x-forwarded-for: 127.0.0.1", { "x-forwarded-for": "127.0.0.1" }],
    ["x-real-ip: ::1", { "x-real-ip": "::1" }],
    ["no proxy headers at all", {}],
  ])("without E2E_AUTH_BYPASS, a request that looks local (%s) cannot use the bypass token", async (_l, headers) => {
    const authorize = await load({ ...LOCAL });
    expect(await signIn(authorize, BYPASS, headers)).toBe("refused");
  });

  it("without the flag, a local-looking header does not skip the throttle", async () => {
    const authorize = await load({ ...LOCAL });
    await signIn(authorize, PASSWORD, { "x-forwarded-for": "127.0.0.1" });
    expect(h.checkRateLimit.mock.calls.some((c) => String(c[0]).startsWith("login:ip:"))).toBe(true);
  });

  it("positive control: E2E_AUTH_BYPASS=true in a local TESTING_MODE process → bypass works, throttle skipped", async () => {
    const authorize = await load({ ...LOCAL, E2E_AUTH_BYPASS: "true" });
    expect(await signIn(authorize, BYPASS, { "x-vercel-forwarded-for": "198.51.100.10" })).toBe("admitted");
    expect(h.checkRateLimit.mock.calls.some((c) => String(c[0]).startsWith("login:ip:"))).toBe(false);
  });

  it.each([
    ["any Vercel deployment (preview)", { VERCEL: "1", VERCEL_ENV: "preview" }],
    ["Vercel production", { VERCEL: "1", VERCEL_ENV: "production" }],
    ["the production database", { DATABASE_URL: "postgresql://x@ep-bold-wave-abt39t7x-pooler.invalid/db" }],
    ["TESTING_MODE off", { TESTING_MODE: "" }],
  ])("the flag is refused on %s", async (_l, env) => {
    const authorize = await load({ ...LOCAL, E2E_AUTH_BYPASS: "true", ...env });
    expect(await signIn(authorize, BYPASS, { "x-forwarded-for": "127.0.0.1" })).toBe("refused");
  });
});

describe("sign-in reads the client network by the product's trust order", () => {
  it.each([
    [{ "x-vercel-forwarded-for": "198.51.100.1", "x-forwarded-for": "10.0.0.1" }],
    [{ "x-real-ip": "198.51.100.2", "x-forwarded-for": "10.0.0.1, 198.51.100.3" }],
    [{ "x-forwarded-for": "10.9.9.9, 198.51.100.4" }],
    [{}],
  ])("same answer as getClientIp for %j", async (headers) => {
    const { requestClientIp } = await import("@/lib/auth-lockout");
    const { getClientIp } = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
    const req = new Request("http://localhost/x", { headers });
    expect(requestClientIp(req.headers)).toBe(getClientIp(req));
  });
});
