// E2E re-run (6 Oct 2026, lane J item 9): in a clean operator browser, support
// for a manager / activated owner swapped correctly, but every /dashboard page
// 500'd — userTone(session.user.name) read `.length` of undefined. The swap in
// auth.ts jwt() set id / club / role / colours but never name or email, so a
// carrier (no identity) reached the dashboard with no name; and before the
// carrier existed, the PREVIOUS user's name and email leaked into the support
// view (the wrong person in the avatar). The swap now sets the target's name
// and email, stashes the operator's own and gives them back on the stop.
//
// Harness copied from tests/unit/support-carrier-jwt.test.ts.

import { vi, describe, it, expect, beforeEach } from "vitest";

type Jwt = (args: { token: Record<string, unknown>; user?: unknown }) => Promise<unknown>;
type SessionCb = (args: { session: Record<string, unknown>; token: Record<string, unknown> }) => unknown;

const captured: { jwt?: Jwt; session?: SessionCb } = {};

const { authMock, redirectMock, resolveActiveImpersonation, hasImpersonationCookie, userFindUnique, checkSessionVersion } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    redirectMock: vi.fn((to: string) => {
      throw new Error(`REDIRECT:${to}`);
    }),
    resolveActiveImpersonation: vi.fn(),
    hasImpersonationCookie: vi.fn(),
    userFindUnique: vi.fn(),
    checkSessionVersion: vi.fn(),
  }));

vi.mock("next-auth", () => ({
  default: (config: { callbacks?: { jwt?: Jwt; session?: SessionCb } }) => {
    if (config.callbacks?.jwt) captured.jwt = config.callbacks.jwt;
    if (config.callbacks?.session) captured.session = config.callbacks.session;
    return { handlers: {}, auth: authMock, signIn: vi.fn(), signOut: vi.fn() };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const tx = {
  user: { findUnique: userFindUnique, findFirst: vi.fn() },
  member: { findUnique: vi.fn(), findFirst: vi.fn() },
  tenant: { findUnique: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({ prisma: tx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  withTenantContext: async <T,>(_id: string, fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/impersonation", () => ({ resolveActiveImpersonation, hasImpersonationCookie }));
vi.mock("@/lib/session-revocation", () => ({ checkSessionVersion }));
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => false }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "unknown",
}));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/pending-tenant-cookie", () => ({
  readPendingTenantSlug: vi.fn(),
  clearPendingTenantSlug: vi.fn(),
}));
vi.mock("@/lib/brand-refresh", () => ({ shouldRefreshBrand: () => false }));

const TARGET_ROW = {
  id: "u-target",
  name: "Target Owner",
  email: "target@example.test",
  role: "owner",
  sessionVersion: 2,
  tenantId: "t-victim",
  tenant: { name: "Victim BJJ", slug: "victim-bjj", primaryColor: "#f00", secondaryColor: "#900", textColor: "#000" },
};
const COOKIE = {
  v: 2 as const,
  adminUserId: "op-noe",
  opSv: 1,
  targetUserId: "u-target",
  targetTenantId: "t-victim",
  tsv: 2,
  reason: "support ticket 41",
  n: "nonce-0123456789abcdef",
  exp: Math.floor(Date.now() / 1000) + 600,
};
const ACTIVE = { payload: COOKIE, target: TARGET_ROW };

/** What Auth.js decodes from the carrier cookie: the claim plus its standard JWT fields. */
function carrierToken(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { supportCarrier: true, iat: now, exp: now + 1800, jti: "jti-carrier" };
}

async function jwt(token: Record<string, unknown>) {
  if (!captured.jwt) await import("@/auth");
  return (await captured.jwt!({ token })) as Record<string, unknown> | null;
}

/** @auth/core's session action: jwt() → null clears the cookie (no session); otherwise session(). */
async function sessionFor(token: Record<string, unknown>) {
  const t = await jwt(token);
  if (t === null) return null;
  return captured.session!({
    session: { user: { name: t.name, email: t.email }, expires: new Date(Date.now() + 3600_000).toISOString() },
    token: t,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  userFindUnique.mockResolvedValue(TARGET_ROW);
  checkSessionVersion.mockResolvedValue("ok");
  hasImpersonationCookie.mockResolvedValue(false);
  resolveActiveImpersonation.mockResolvedValue(null);
});

const OPERATOR_CLUB_TOKEN = () => ({
  id: "u-op-club", tenantId: "t-hq", tenantSlug: "hq", tenantName: "HQ", role: "owner", sessionVersion: 1,
  name: "Noe Operator", email: "noe@example.test", primaryColor: "#111", secondaryColor: "#222", textColor: "#fff",
  memberId: null, totpPending: false, requireTotpSetup: false, totpEnabled: true, mustChangePassword: false,
});

describe("the support swap carries the target's name and email", () => {
  it("swap over a club session: the target's name/email, not the operator's", async () => {
    hasImpersonationCookie.mockResolvedValue(true);
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const t = await jwt(OPERATOR_CLUB_TOKEN());
    expect(t!.id).toBe("u-target");
    expect(t!.name).toBe("Target Owner");
    expect(t!.email).toBe("target@example.test");
  });

  it("stop: the operator's own name/email are restored", async () => {
    hasImpersonationCookie.mockResolvedValue(true);
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const swapped = await jwt(OPERATOR_CLUB_TOKEN());
    hasImpersonationCookie.mockResolvedValue(false);
    resolveActiveImpersonation.mockResolvedValue(null);
    userFindUnique.mockResolvedValue({ sessionVersion: 1 });
    const back = await jwt({ ...swapped! });
    expect(back!.id).toBe("u-op-club");
    expect(back!.name).toBe("Noe Operator");
    expect(back!.email).toBe("noe@example.test");
  });

  it("carrier swap (clean browser): the session the dashboard sees has the target's name", async () => {
    hasImpersonationCookie.mockResolvedValue(true);
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const t = await jwt(carrierToken());
    expect(t!.name).toBe("Target Owner");
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const s = (await sessionFor(t!)) as { user: Record<string, unknown> };
    expect(s.user.name).toBe("Target Owner");
    expect(s.user.email).toBe("target@example.test");
  });

  it("a target with no name on record clears the operator's name instead of leaking it", async () => {
    hasImpersonationCookie.mockResolvedValue(true);
    resolveActiveImpersonation.mockResolvedValue({ ...ACTIVE, target: { ...TARGET_ROW, name: null } });
    const t = await jwt(OPERATOR_CLUB_TOKEN());
    expect(t!.name).not.toBe("Noe Operator");
    expect(t!.email).toBe("target@example.test");
  });
});
