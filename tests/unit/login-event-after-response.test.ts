// Review of lane I (6 Oct 2026): auth.ts wrote the sign-in record with
// `void recordLoginEvent(...)` — fire-and-forget. On serverless the function
// can be frozen as soon as the response is sent, so the row (now the
// activation evidence the readiness verdict reads) could be lost. It is now
// handed to Next's after() (node_modules/next/dist/docs/01-app/03-api-reference/
// 04-functions/after.md: runs after the response, within the route's max
// duration, usable from Route Handlers and Server Functions — where Auth.js
// runs authorize and signIn). Outside a request scope after() throws; then the
// write is awaited instead (recordLoginEvent never throws).
//
// Harness copied from tests/unit/owner-activation-order.test.ts.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");

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
  // A recorded future expiry, so the legacy deadline (review D2) cannot age this fixture out.
  tempPasswordExpiresAt: new Date(Date.now() + 3_600_000),
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


const ah = vi.hoisted(() => ({ after: vi.fn(), scheduled: [] as Array<() => unknown> }));
vi.mock("next/server", async (orig) => ({ ...(await orig<Record<string, unknown>>()), after: ah.after }));

import { recordLoginEvent } from "@/lib/login-event";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TESTING_MODE", "");
  tenantFindUnique.mockResolvedValue(TENANT);
  memberFindUnique.mockResolvedValue(null);
  checkSessionVersion.mockResolvedValue("ok");
  userFindUnique.mockResolvedValue(owner(false, true));
  ah.scheduled = [];
  ah.after.mockImplementation((cb: () => unknown) => { ah.scheduled.push(cb); });
});
afterEach(() => vi.unstubAllEnvs());

describe("the sign-in record survives the response", () => {
  it("authorize hands the write to after(), and the scheduled task writes the record", async () => {
    const user = await signIn();
    expect(user?.id).toBe("u-owner");
    expect(ah.after).toHaveBeenCalledTimes(1);
    expect(recordLoginEvent).not.toHaveBeenCalled();
    await ah.scheduled[0]();
    expect(recordLoginEvent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordLoginEvent).mock.calls[0][0]).toMatchObject({ subject: { kind: "user", id: "u-owner", role: "owner" } });
  });

  it("outside a request scope (after() throws) the write is awaited instead, not dropped", async () => {
    ah.after.mockImplementation(() => { throw new Error("after was called outside a request scope"); });
    const user = await signIn();
    expect(user?.id).toBe("u-owner");
    expect(recordLoginEvent).toHaveBeenCalledTimes(1);
  });

  it("no call site is fire-and-forget any more", () => {
    const src = readFileSync(join(ROOT, "auth.ts"), "utf8");
    expect(src).not.toMatch(/void\s+recordLoginEvent\(/);
    expect(src).toMatch(/after\(/);
  });
});
