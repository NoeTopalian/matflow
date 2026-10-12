// A support session started in a CLEAN operator browser (E2E flow 6, 6 Oct 2026).
//
// The swap to the target lives in auth.ts jwt(), and Auth.js only runs jwt()
// when the request carries a session-token cookie. Operator sign-in never mints
// one, so in a browser holding only `matflow_op_session` the start returned 200,
// set `matflow_impersonation`, and /dashboard bounced to /login.
//
// The fix: POST /api/admin/impersonate also sets a CARRIER session token
// ({ supportCarrier: true }, no identity) when the browser has no Auth.js
// session. This file pins what jwt() does with a carrier: it is only ever a
// vehicle for the swap, and never a session on its own.
//
// Same harness as tests/unit/impersonation-jwt-claims.test.ts: mock next-auth to
// capture the REAL callbacks out of the NextAuth({ … }) config in auth.ts.

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

describe("a carrier token is a vehicle for the support swap", () => {
  it("clean-browser start: the carrier swaps to the target", async () => {
    hasImpersonationCookie.mockResolvedValue(true);
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const t = await jwt(carrierToken());
    expect(t!.id).toBe("u-target");
    expect(t!.tenantId).toBe("t-victim");
    expect(t!.role).toBe("owner");
    expect(t!.impersonatedBy).toBe("op-noe");
    expect(checkSessionVersion).toHaveBeenLastCalledWith(expect.objectContaining({ userId: "u-target", tokenVersion: 2 }), expect.any(Function));
    // And the session the dashboard sees is the target, flagged as support.
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const s = (await sessionFor(t!)) as { user: Record<string, unknown> };
    expect(s.user.id).toBe("u-target");
    expect(s.user.impersonatedBy).toBe("op-noe");
  });

  it("a second request during support stays on the target", async () => {
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const first = await jwt(carrierToken());
    const second = await jwt(first!);
    expect(second!.id).toBe("u-target");
    expect(second!.impersonatedBy).toBe("op-noe");
  });

  it("stop (support no longer active) → signed out, never an identity-less session", async () => {
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const during = await jwt(carrierToken());
    resolveActiveImpersonation.mockResolvedValue(null);
    expect(await jwt(during!)).toBeNull();
  });

  it("expiry (cookie gone or past its time: the resolver says no) → null", async () => {
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const during = await jwt(carrierToken());
    const second = await jwt(during!);
    // The browser drops the 30-minute support cookie; the carrier JWT is still presented.
    hasImpersonationCookie.mockResolvedValue(false);
    resolveActiveImpersonation.mockResolvedValue(null);
    expect(await jwt(second!)).toBeNull();
  });

  it("any binding failure ends a carrier session: resolver error → null", async () => {
    resolveActiveImpersonation.mockRejectedValue(new Error("connection reset"));
    expect(await jwt(carrierToken())).toBeNull();
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const during = await jwt(carrierToken());
    resolveActiveImpersonation.mockRejectedValue(new Error("connection reset"));
    expect(await jwt(during!)).toBeNull();
  });

  it("revocation of the target ends it too (target version moved → null)", async () => {
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const during = await jwt(carrierToken());
    checkSessionVersion.mockResolvedValue("revoked");
    expect(await jwt(during!)).toBeNull();
  });
});

describe("a carrier is never a session on its own", () => {
  it("carrier alone, no impersonation cookie → null", async () => {
    expect(await jwt(carrierToken())).toBeNull();
  });

  it("carrier with a forged-looking identity but no support → still null", async () => {
    expect(await jwt({ ...carrierToken(), id: "u-target", tenantId: "t-victim", role: "owner" })).toBeNull();
  });

  it("the session action yields NO session (not an empty, truthy one)", async () => {
    expect(await sessionFor(carrierToken())).toBeNull();
  });

  it("requireApiRole refuses it 401 (the auth() a carrier alone produces)", async () => {
    authMock.mockResolvedValue(await sessionFor(carrierToken()));
    const { requireApiRole } = await import("@/lib/api-authz");
    const gate = await requireApiRole(["owner", "manager", "coach", "admin"]);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(401);
  });

  it("requireSession sends it to /login", async () => {
    authMock.mockResolvedValue(await sessionFor(carrierToken()));
    const { requireSession } = await import("@/lib/authz");
    await expect(requireSession()).rejects.toThrow("REDIRECT:/login");
  });
});

describe("a browser with a club session keeps today's behaviour", () => {
  const CLUB = {
    id: "u-operator",
    tenantId: "t-operator",
    tenantSlug: "matflow-hq",
    tenantName: "MatFlow HQ",
    primaryColor: "#0a0",
    secondaryColor: "#0b0",
    textColor: "#fff",
    role: "owner",
    sessionVersion: 7,
    memberId: null,
    totpPending: false,
    requireTotpSetup: false,
    totpEnabled: true,
  };
  it("stashes the operator's own claims and restores them on stop", async () => {
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const during = await jwt({ ...CLUB });
    expect(during!.id).toBe("u-target");
    resolveActiveImpersonation.mockResolvedValue(null);
    const after = await jwt(during!);
    expect(after!.id).toBe("u-operator");
    expect(after!.impersonatedBy).toBeUndefined();
    expect(after!.supportCarrier).toBeUndefined();
  });
});
