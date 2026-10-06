// Impersonation is a loan, and revocation has to reach it.
//
// Two defects lane L-G found by driving the operator plane, both in the JWT
// callback's impersonation branch and both caused by the swap having been
// written as an in-place overwrite:
//
//   lg-2:187  expect(user.impersonatedBy).toBeUndefined()
//             received "__matflow_super_admin__"
//             …after a 200 from DELETE /api/admin/impersonate, after the
//             admin.impersonate.end audit row, and with the cookie really gone.
//             Nothing remembered the operator's own claims, so the stop had
//             nothing to restore and the borrowed identity simply stayed.
//
//   lg-2:222  expect(afterUser.tenantId).not.toBe(victim.id)
//             …after UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1
//             on the impersonated user. `token.sessionVersion` was re-read from
//             the database on every pass, immediately before the revocation
//             check compared token against database, so the two could never
//             differ and the session could not be evicted — the opposite of
//             what the block's own comment promised.
//
// Like the bypass file beside it, this reaches the REAL callback: `auth.ts`
// builds it inline inside `NextAuth({ … })`, so mocking `next-auth` to capture
// the config object is the only way to get at it.

import { vi, describe, it, expect, beforeEach } from "vitest";

type Jwt = (args: { token: Record<string, unknown>; user?: unknown }) => Promise<unknown>;

const captured: { jwt?: Jwt } = {};

vi.mock("next-auth", () => ({
  default: (config: { callbacks?: { jwt?: Jwt } }) => {
    if (config.callbacks?.jwt) captured.jwt = config.callbacks.jwt;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));

const { resolveActiveImpersonation, hasImpersonationCookie, userFindUnique, tenantFindUnique, checkSessionVersion } =
  vi.hoisted(() => ({
    resolveActiveImpersonation: vi.fn(),
    hasImpersonationCookie: vi.fn(),
    userFindUnique: vi.fn(),
    tenantFindUnique: vi.fn(),
    checkSessionVersion: vi.fn(),
  }));

const tx = {
  user: { findUnique: userFindUnique, findFirst: vi.fn() },
  member: { findUnique: vi.fn(), findFirst: vi.fn() },
  tenant: { findUnique: tenantFindUnique },
};

vi.mock("@/lib/prisma", () => ({ prisma: tx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  withTenantContext: async <T,>(_id: string, fn: (t: unknown) => Promise<T>) => fn(tx),
}));
// Since 6 Oct 2026 (lane B) auth.ts asks lib/impersonation for the support session IN FORCE for the
// request (cookie + operator session + nonce + target version + club admission, all checked there and
// tested in tests/unit/support-session-binding.test.ts). This file tests what the callback does with it.
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

const OPERATOR = {
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

const TARGET_ROW = {
  id: "u-target",
  role: "owner",
  sessionVersion: 2,
  tenantId: "t-victim",
  tenant: {
    name: "Victim BJJ",
    slug: "victim-bjj",
    primaryColor: "#f00",
    secondaryColor: "#900",
    textColor: "#000",
  },
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

/** The support session in force: the signed claim plus the target row it resolved. */
const ACTIVE = { payload: COOKIE, target: TARGET_ROW };

async function jwt(token: Record<string, unknown>) {
  if (!captured.jwt) await import("@/auth");
  return (await captured.jwt!({ token })) as Record<string, unknown> | null;
}

function operatorToken() {
  return { ...OPERATOR } as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  userFindUnique.mockResolvedValue(TARGET_ROW);
  checkSessionVersion.mockResolvedValue("ok");
  hasImpersonationCookie.mockResolvedValue(false);
});

describe("an impersonation can be stopped", () => {
  it("swaps to the target while the cookie is present", async () => {
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);

    const t = await jwt(operatorToken());

    expect(t!.id).toBe("u-target");
    expect(t!.tenantId).toBe("t-victim");
    expect(t!.tenantSlug).toBe("victim-bjj");
    expect(t!.impersonatedBy).toBe("op-noe");
  });

  it("keeps the operator's own claims so there is something to give back", async () => {
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);

    const t = await jwt(operatorToken());

    expect(t!.impersonatorClaims, "the swap must not be destructive").toMatchObject({
      id: "u-operator",
      tenantId: "t-operator",
      sessionVersion: 7,
    });
  });

  it("RESTORES the operator on the first request after the cookie is gone", async () => {
    // Start it…
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const during = await jwt(operatorToken());
    expect(during!.id).toBe("u-target");

    // …then stop it. This is `DELETE /api/admin/impersonate` having cleared the
    // cookie; the token itself is whatever the browser still holds.
    resolveActiveImpersonation.mockResolvedValue(null);
    const after = await jwt(during!);

    expect(after!.id, "the operator gets their own id back").toBe("u-operator");
    expect(after!.tenantId).toBe("t-operator");
    expect(after!.tenantSlug).toBe("matflow-hq");
    expect(after!.role).toBe("owner");
    expect(after!.sessionVersion, "and their own version, not the target's").toBe(7);
    expect(after!.impersonatedBy, "lg-2:187 — the claim cannot outlive the cookie").toBeUndefined();
    expect(after!.impersonationReason).toBeUndefined();
    expect(after!.impersonatorClaims, "and the stash is spent").toBeUndefined();
  });

  it("does not re-stash on the second request, which would file the TARGET as the operator", async () => {
    // The subtle one. If the stash were written every pass, the second request
    // would record the target's claims as the operator's and the restore would
    // hand back the borrowed identity — a no-op wearing a fix's clothes.
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const first = await jwt(operatorToken());
    const second = await jwt(first!);

    expect(second!.impersonatorClaims).toMatchObject({ id: "u-operator", tenantId: "t-operator" });

    resolveActiveImpersonation.mockResolvedValue(null);
    const after = await jwt(second!);
    expect(after!.id).toBe("u-operator");
  });
});

describe("a sessionVersion bump evicts an impersonated session", () => {
  it("mints the target's version once, then leaves the token's copy alone", async () => {
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const first = await jwt(operatorToken());
    expect(first!.sessionVersion, "minted from the target at the start").toBe(2);

    // The target is disowned mid-session: the row moves, the token does not.
    // (The real resolver refuses a moved version outright; this pins the callback
    // in case it is ever handed one.)
    resolveActiveImpersonation.mockResolvedValue({ payload: COOKIE, target: { ...TARGET_ROW, sessionVersion: 3 } });
    const second = await jwt(first!);

    expect(
      second!.sessionVersion,
      "lg-2:222 — refreshing this is what made revocation inert",
    ).toBe(2);
  });

  it("hands the revocation check a version that CAN disagree with the database", async () => {
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const first = await jwt(operatorToken());

    resolveActiveImpersonation.mockResolvedValue({ payload: COOKIE, target: { ...TARGET_ROW, sessionVersion: 3 } });
    checkSessionVersion.mockResolvedValue("revoked");
    const second = await jwt(first!);

    expect(second, "a revoked verdict kills the session").toBeNull();
    // And the check was asked about the TARGET, with the TOKEN's stale version.
    expect(checkSessionVersion).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: "u-target", tokenVersion: 2 }),
    );
  });
});

describe("support sessions fail closed (lane B, 6 Oct 2026)", () => {
  // Was: "a resolver error (database blip) mid-support restores the operator
  // instead of keeping the borrowed identity" — which pinned review finding D1
  // (6 Oct 2026, fail-open). Restoring the operator on a throw let the proxy
  // wave a POST through as the operator while the route handler's own auth()
  // re-ran jwt() with the same JWT cookie and could resolve support — and run
  // as the TARGET owner. A throw while support may be live now ends the session
  // for the request instead.
  it("D1: a resolver error mid-support (stash present) ENDS the session for the request", async () => {
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const during = await jwt(operatorToken());
    expect(during!.impersonatedBy).toBe("op-noe");

    resolveActiveImpersonation.mockRejectedValue(new Error("connection reset"));
    const after = await jwt(during!);
    expect(after, "neither the operator nor the target — no session").toBeNull();
  });

  it("D1: a resolver error with a support cookie present (no stash yet) ends the session for the request", async () => {
    // The first request of a support session: the JWT still holds only the
    // operator's claims, so restoring is a no-op and the old code let it through.
    hasImpersonationCookie.mockResolvedValue(true);
    resolveActiveImpersonation.mockRejectedValue(new Error("connection reset"));
    const after = await jwt(operatorToken());
    expect(after).toBeNull();
  });

  it("D1: a resolver error with no support cookie and no stash leaves an ordinary session alone", async () => {
    hasImpersonationCookie.mockResolvedValue(false);
    resolveActiveImpersonation.mockRejectedValue(new Error("connection reset"));
    const after = await jwt(operatorToken());
    expect(after!.id).toBe("u-operator");
    expect(after!.impersonatedBy).toBeUndefined();
  });

  it("D1: an unreadable cookie store counts as no cookie (the stash still fails closed)", async () => {
    hasImpersonationCookie.mockRejectedValue(new Error("cookies() outside a request"));
    resolveActiveImpersonation.mockRejectedValue(new Error("connection reset"));
    const plain = await jwt(operatorToken());
    expect(plain!.id).toBe("u-operator");

    hasImpersonationCookie.mockRejectedValue(new Error("cookies() outside a request"));
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const during = await jwt(operatorToken());
    resolveActiveImpersonation.mockRejectedValue(new Error("connection reset"));
    expect(await jwt(during!)).toBeNull();
  });

  it("D6: a token that says impersonatedBy but has no stash is ended, not kept", async () => {
    // A pre-19-Sep support token (in-place swap, nothing stashed): there is no
    // operator identity to give back, so keeping it keeps the borrowed one.
    resolveActiveImpersonation.mockResolvedValue(null);
    const legacy = {
      ...operatorToken(),
      id: "u-target",
      tenantId: "t-victim",
      impersonatedBy: "__matflow_super_admin__",
    };
    expect(await jwt(legacy)).toBeNull();
  });

  it("N3: a legacy impersonatedBy token meeting a live support cookie is ended, never stashed as the operator", async () => {
    // Mirror of D6 in the swap branch: stashing these claims would make the
    // stop "restore" the old TARGET identity.
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const legacy = {
      ...operatorToken(),
      id: "u-target",
      tenantId: "t-victim",
      impersonatedBy: "__matflow_super_admin__",
    };
    expect(await jwt(legacy)).toBeNull();
  });

  it("the token carries the target version from the SIGNED claim, never a fresh database read", async () => {
    resolveActiveImpersonation.mockResolvedValue({ payload: { ...COOKIE, tsv: 5 }, target: { ...TARGET_ROW, sessionVersion: 9 } });
    const t = await jwt(operatorToken());
    expect(t!.sessionVersion).toBe(5);
  });

  it("re-swapping after a restore does not re-mint the version from the database", async () => {
    resolveActiveImpersonation.mockResolvedValue(ACTIVE);
    const first = await jwt(operatorToken());
    resolveActiveImpersonation.mockResolvedValue(null);
    const restored = await jwt(first!);
    resolveActiveImpersonation.mockResolvedValue({ payload: COOKIE, target: { ...TARGET_ROW, sessionVersion: 3 } });
    const again = await jwt(restored!);
    expect(again!.sessionVersion).toBe(2);
  });
});
