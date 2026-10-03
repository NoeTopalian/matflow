// Owner activation order + the token claim behind it (3 Oct 2026).
//
// Handover of the real Total BJJ owner account runs: temporary password ->
// owner chooses a password -> owner enrols an authenticator -> club data.
// `mustChangePassword` used to be read from the database by
// app/dashboard/layout.tsx and nowhere else, so a temporary-password session
// could drive /api/* directly. auth.ts now mints it on the token, and proxy.ts
// + lib/api-authz.ts refuse on it (see proxy-activation-gates.test.ts and
// api-authz-password-gate.test.ts for the gates themselves).
//
// This file reaches the REAL authorize / jwt / session callbacks with the same
// capture trick as totp-mandatory-elevated.test.ts, and pins the invariant
// that makes minting-once safe: every write that SETS the flag also bumps
// sessionVersion, so no token can outlive the flag being turned on.
//
// Red on revert: drop `mustChangePassword` from authorize, the jwt callback or
// the session callback and the first block fails; remove the bump from
// force-password-reset or staff/[id] and the invariant block fails.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

type Authorize = (credentials: Record<string, unknown>, request: Request) => Promise<Record<string, unknown> | null>;
type Callbacks = {
  jwt: (a: { token: Record<string, unknown>; user?: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
  session: (a: { session: { user: Record<string, unknown> }; token: Record<string, unknown> }) => { user?: Record<string, unknown> };
};

const captured: { authorize?: Authorize; callbacks?: Callbacks } = {};

vi.mock("next-auth", () => ({
  default: (config: { providers: { authorize?: Authorize }[]; callbacks: Callbacks }) => {
    for (const p of config.providers) if (p?.authorize) captured.authorize = p.authorize;
    captured.callbacks = config.callbacks;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (cfg: { authorize?: Authorize }) => cfg }));
vi.mock("next-auth/providers/google", () => ({ default: (cfg: unknown) => cfg }));

const { tenantFindUnique, userFindUnique, memberFindUnique, checkSessionVersion } = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  checkSessionVersion: vi.fn(),
}));

const tx = {
  tenant: { findUnique: tenantFindUnique },
  user: { findUnique: userFindUnique, findFirst: vi.fn(), update: vi.fn() },
  member: { findUnique: memberFindUnique, update: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({ prisma: tx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  withTenantContext: async <T,>(_id: string, fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => false }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "unknown",
}));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/session-revocation", () => ({ checkSessionVersion: (...a: unknown[]) => checkSessionVersion(...a) }));
vi.mock("@/lib/impersonation", () => ({ readImpersonationCookie: vi.fn() }));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));
vi.mock("@/lib/pending-tenant-cookie", () => ({ readPendingTenantSlug: vi.fn(), clearPendingTenantSlug: vi.fn() }));

const PASSWORD = "TempPass2345";
const HASH = bcrypt.hashSync(PASSWORD, 4);
const TENANT = {
  id: "t1", slug: "totalbjj", name: "Total BJJ", subscriptionStatus: "active", deletedAt: null,
  primaryColor: "#000", secondaryColor: "#111", textColor: "#fff",
};
const owner = (mustChangePassword: boolean, totpEnabled = false) => ({
  id: "u-owner", email: "owner@example.test", name: "Owner", role: "owner", sessionVersion: 3, tenantId: "t1",
  passwordHash: HASH, failedLoginCount: 0, lockedUntil: null, totpEnabled, notifyOnNewLogin: false, mustChangePassword,
});

async function load() {
  if (!captured.authorize) await import("@/auth");
  return { authorize: captured.authorize!, callbacks: captured.callbacks! };
}
async function signIn() {
  const { authorize } = await load();
  return authorize(
    { email: "owner@example.test", password: PASSWORD, tenantSlug: "totalbjj" },
    new Request("http://localhost/api/auth/callback/credentials"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TESTING_MODE", "");
  tenantFindUnique.mockResolvedValue(TENANT);
  memberFindUnique.mockResolvedValue(null);
  checkSessionVersion.mockResolvedValue("ok");
});
afterEach(() => vi.unstubAllEnvs());

describe("the temporary-password claim travels authorize -> jwt -> session", () => {
  it("a flagged owner signs in carrying mustChangePassword AND requireTotpSetup", async () => {
    userFindUnique.mockResolvedValue(owner(true));
    const user = await signIn();
    expect(user?.mustChangePassword).toBe(true);
    expect(user?.requireTotpSetup).toBe(true);

    const { callbacks } = await load();
    const token = await callbacks.jwt({ token: {}, user: user! });
    expect(token?.mustChangePassword).toBe(true);
    const session = callbacks.session({ session: { user: {} }, token: token! });
    expect(session.user?.mustChangePassword).toBe(true);
  });

  it("an owner who has chosen a password carries false", async () => {
    userFindUnique.mockResolvedValue(owner(false, true));
    const user = await signIn();
    expect(user?.mustChangePassword).toBe(false);
    const { callbacks } = await load();
    const token = await callbacks.jwt({ token: {}, user: user! });
    expect(callbacks.session({ session: { user: {} }, token: token! }).user?.mustChangePassword).toBe(false);
  });

  it("a legacy token minted before the claim existed is stamped from the row once", async () => {
    const { callbacks } = await load();
    userFindUnique.mockResolvedValue({ mustChangePassword: true });
    const legacy = { id: "u-owner", tenantId: "t1", role: "owner", sessionVersion: 3, memberId: null };
    const token = await callbacks.jwt({ token: { ...legacy } });
    expect(token?.mustChangePassword).toBe(true);

    // Already stamped: no further read on the next pass.
    userFindUnique.mockClear();
    await callbacks.jwt({ token: token! });
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("a revoked version still signs the token out before anything else", async () => {
    const { callbacks } = await load();
    checkSessionVersion.mockResolvedValue("revoked");
    const token = await callbacks.jwt({
      token: { id: "u-owner", tenantId: "t1", sessionVersion: 2, mustChangePassword: true },
    });
    expect(token).toBeNull();
  });
});

// Invariant: setting the flag always bumps sessionVersion.

const ROOT = resolve(__dirname, "../..");
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("every write that sets mustChangePassword also evicts existing sessions", () => {
  const SETS_FLAG = /mustChangePassword\s*(:|=)\s*true/;
  const BUMPS = /sessionVersion\s*(:|=)\s*\{\s*increment:\s*1\s*\}/;
  // Creating a brand-new staff row: there are no sessions to evict.
  const NEW_ROW_ONLY = new Set(["app/api/staff/route.ts"]);

  const writers = routeFiles(join(ROOT, "app"))
    .map((p) => ({ rel: relative(ROOT, p).replace(/\\/g, "/"), src: readFileSync(p, "utf8") }))
    // Line-wise, ignoring `select: { mustChangePassword: true }` READS.
    .filter((f) => f.src.split(/\r?\n/).some((l) => SETS_FLAG.test(l) && !/select/.test(l)) && !NEW_ROW_ONLY.has(f.rel));

  it("finds the known writers (the scan is not vacuous)", () => {
    const names = writers.map((w) => w.rel);
    expect(names).toContain("app/api/admin/customers/[id]/force-password-reset/route.ts");
    expect(names).toContain("app/api/staff/[id]/route.ts");
  });

  it.each(writers.map((w) => [w.rel, w.src] as const))("%s bumps sessionVersion", (_rel, src) => {
    expect(src).toMatch(BUMPS);
  });

  it("set-password (which CLEARS the flag) bumps it too, so other temp-password devices go", () => {
    const src = readFileSync(join(ROOT, "app/api/auth/set-password/route.ts"), "utf8");
    expect(src).toMatch(/mustChangePassword:\s*false/);
    expect(src).toMatch(BUMPS);
  });

  it("the authenticator page sends a temp-password account to /set-password first", () => {
    const src = readFileSync(join(ROOT, "app/login/totp/setup/page.tsx"), "utf8");
    expect(src).toMatch(/mustChangePassword\)\s*redirect\("\/set-password"\)/);
  });
});
