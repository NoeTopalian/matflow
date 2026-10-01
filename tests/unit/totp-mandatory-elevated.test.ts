// Mandatory authenticator for ELEVATED staff roles (1 Oct 2026).
//
// Noe: "owner accounts and admin accounts should have more security than
// normal accounts". The gate that used to hold only a not-yet-enrolled OWNER at
// /login/totp/setup (pages) and 403 (API) now holds owner, manager and admin —
// the roles that see every member's personal data and move money/settings.
// A coach (registers and check-ins only) keeps optional 2FA; the challenge
// still applies once a coach enrols (see totp-challenge-follows-enrolment).
//
// This reaches the REAL `authorize` by the same capture trick as the sibling
// file: `auth.ts` builds the callback inline inside `NextAuth({ … })`, so
// mocking `next-auth` and the credentials provider is what makes it reachable.
// `isTestingMode()` is mocked FALSE: with it true the whole expression collapses
// and this file would pass against any policy at all.
//
// Red on revert: narrow `ELEVATED_ROLES` (lib/mfa-policy.ts) back to ["owner"],
// or restore `isOwner &&` in auth.ts, and the manager/admin cases fail.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";

type Authorize = (
  credentials: Record<string, unknown>,
  request: Request,
) => Promise<Record<string, unknown> | null>;

const captured: { authorize?: Authorize } = {};

vi.mock("next-auth", () => ({
  default: (config: { providers: { authorize?: Authorize }[] }) => {
    for (const p of config.providers) if (p?.authorize) captured.authorize = p.authorize;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({
  default: (cfg: { authorize?: Authorize }) => cfg,
}));
vi.mock("next-auth/providers/google", () => ({ default: (cfg: unknown) => cfg }));

const { tenantFindUnique, userFindUnique, memberFindUnique } = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
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
vi.mock("@/lib/session-revocation", () => ({ checkSessionVersion: vi.fn() }));
vi.mock("@/lib/impersonation", () => ({ readImpersonationCookie: vi.fn() }));
vi.mock("@/lib/pending-tenant-cookie", () => ({
  readPendingTenantSlug: vi.fn(),
  clearPendingTenantSlug: vi.fn(),
}));

const SLUG = "totalbjj";
const PASSWORD = "Ashgrove!2026aA";
const HASH = bcrypt.hashSync(PASSWORD, 4);
const TENANT = {
  id: "t1",
  slug: SLUG,
  name: "Total BJJ",
  subscriptionStatus: "active",
  deletedAt: null,
  primaryColor: "#000",
  secondaryColor: "#111",
  textColor: "#fff",
};

function staff(role: string, totpEnabled: boolean) {
  return {
    id: `u-${role}`,
    email: `${role}@totalbjj.com`,
    name: role,
    role,
    sessionVersion: 1,
    tenantId: "t1",
    passwordHash: HASH,
    failedLoginCount: 0,
    lockedUntil: null,
    totpEnabled,
    notifyOnNewLogin: false,
  };
}

async function signIn(email: string) {
  if (!captured.authorize) await import("@/auth");
  return captured.authorize!(
    { email, password: PASSWORD, tenantSlug: SLUG },
    new Request("http://localhost/api/auth/callback/credentials"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TESTING_MODE", "");
  tenantFindUnique.mockResolvedValue(TENANT);
  userFindUnique.mockResolvedValue(null);
  memberFindUnique.mockResolvedValue(null);
});

afterEach(() => vi.unstubAllEnvs());

describe("mandatory authenticator — elevated roles at the password door", () => {
  for (const role of ["owner", "manager", "admin"] as const) {
    it(`holds a not-yet-enrolled ${role} at enrolment (requireTotpSetup = true)`, async () => {
      userFindUnique.mockResolvedValue(staff(role, false));
      const result = await signIn(`${role}@totalbjj.com`);
      expect(result, "the sign-in itself still succeeds").not.toBeNull();
      expect(result!.requireTotpSetup, `${role} must enrol before the dashboard`).toBe(true);
      expect(result!.totpPending, "nothing to challenge yet").toBe(false);
    });

    it(`an enrolled ${role} is challenged, not held at setup`, async () => {
      userFindUnique.mockResolvedValue(staff(role, true));
      const result = await signIn(`${role}@totalbjj.com`);
      expect(result!.requireTotpSetup).toBe(false);
      expect(result!.totpPending).toBe(true);
    });
  }

  it("a coach is never held at enrolment — 2FA stays optional for registers-only staff", async () => {
    userFindUnique.mockResolvedValue(staff("coach", false));
    const result = await signIn("coach@totalbjj.com");
    expect(result!.requireTotpSetup).toBe(false);
    expect(result!.totpPending).toBe(false);
  });
});
