// DELETE /api/admin/impersonate — the stop-impersonation door.
//
// Two contracts, both established by the round-2 assessment run:
//
//  1. It is fail-safe but not open. Until round 2 a caller holding neither the
//     impersonation cookie nor an operator credential got 200 { ok: true }
//     from the operator plane (lane L-B). Nothing was written for them — but a
//     door on this plane must not answer yes to someone it does not know.
//  2. Stopping must actually stop. auth.ts:744-764 overwrites the JWT's
//     identity IN PLACE while the impersonation cookie is present, so clearing
//     that cookie alone leaves the browser holding the target's identity
//     (measured: lg-2-impersonation.spec.ts:187). The session cookie goes too.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const {
  cookieStore,
  isAdminAuthedMock,
  readImpersonationCookieMock,
  clearImpersonationCookieMock,
  logAuditMock,
  endSupportSessionMock,
  getOperatorContextMock,
} = vi.hoisted(() => ({
  // `set` with maxAge 0 is how the route clears the session cookie since the
  // lane I review (D-I1: a bare delete drops Secure); `delete` is kept so the
  // test also proves no bare delete is sent.
  cookieStore: {
    delete: vi.fn<(name: string) => void>(),
    set: vi.fn<(name: string, value: string, opts?: Record<string, unknown>) => void>(),
  },
  isAdminAuthedMock: vi.fn<() => Promise<boolean>>(),
  readImpersonationCookieMock: vi.fn<() => Promise<unknown>>(),
  clearImpersonationCookieMock: vi.fn<() => Promise<void>>(async () => {}),
  logAuditMock: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => ({})),
  endSupportSessionMock: vi.fn<(args: Record<string, unknown>) => Promise<number>>(async () => 0),
  getOperatorContextMock: vi.fn(async () => ({ operatorId: "op-noe", operatorEmail: null, operatorName: null, authed: true, named: true })),
}));

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: isAdminAuthedMock }));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
// Since 6 Oct 2026 (lane B) the stop reads the cookie with its signature checked even if it has just
// expired, and ends the support session SERVER-SIDE (the nonce on the Operator row), so a copied cookie
// is dead everywhere, not only in this browser.
vi.mock("@/lib/impersonation", () => ({
  startSupportSession: vi.fn(),
  endSupportSession: endSupportSessionMock,
  clearImpersonationCookie: clearImpersonationCookieMock,
  readImpersonationCookie: vi.fn(async () => null),
  readImpersonationCookieForStop: readImpersonationCookieMock,
}));
vi.mock("@/lib/operator-auth", () => ({ OP_SESSION_COOKIE: "matflow_op_session", resolveOperatorFromCookie: vi.fn() }));
vi.mock("@/lib/operator-step-up", () => ({ requireStepUp: vi.fn(), stepUpTarget: (t: string, s?: string) => (s ? `${t}/${s}` : t) }));
vi.mock("@/lib/prisma-tenant", () => ({ withRlsBypass: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(), getClientIp: () => "test" }));
vi.mock("@/lib/operator-context", () => ({ getOperatorContext: getOperatorContextMock }));
vi.mock("@/lib/auth-cookie", () => ({
  SESSION_COOKIE_NAME: "authjs.session-token",
  SESSION_COOKIE_SECURE: false,
}));

const ACTIVE = {
  v: 2,
  opSv: 1,
  tsv: 3,
  n: "nonce-0123456789abcdef",
  adminUserId: "op-noe",
  targetUserId: "user-1",
  targetTenantId: "tenant-1",
  reason: "support call",
  exp: Math.floor(Date.now() / 1000) + 600,
};

function req() {
  return new Request("http://test/api/admin/impersonate", {
    method: "DELETE",
    headers: { Origin: "http://test" },
  });
}

async function callDelete() {
  const { DELETE } = await import("@/app/api/admin/impersonate/route");
  return DELETE(req());
}

describe("DELETE /api/admin/impersonate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearImpersonationCookieMock.mockResolvedValue(undefined);
    logAuditMock.mockResolvedValue({});
  });

  it("refuses a caller holding neither the impersonation cookie nor an operator credential", async () => {
    readImpersonationCookieMock.mockResolvedValue(null);
    isAdminAuthedMock.mockResolvedValue(false);

    const res = await callDelete();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(logAuditMock).not.toHaveBeenCalled();
    expect(clearImpersonationCookieMock).not.toHaveBeenCalled();
    expect(endSupportSessionMock).not.toHaveBeenCalled();
    expect(cookieStore.delete).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("lets the impersonation cookie alone end it — no operator credential needed", async () => {
    readImpersonationCookieMock.mockResolvedValue(ACTIVE);
    isAdminAuthedMock.mockResolvedValue(false);

    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redirectTo: "/admin/tenants" });
    expect(isAdminAuthedMock).toHaveBeenCalledTimes(0);
    expect(logAuditMock.mock.calls[0][0]).toMatchObject({
      tenantId: "tenant-1",
      userId: "user-1",
      action: "admin.impersonate.end",
      actAsUserId: "op-noe",
    });
    expect(endSupportSessionMock, "the nonce is cleared server-side").toHaveBeenCalledWith({ operatorId: "op-noe", nonce: "nonce-0123456789abcdef" });
  });

  it("lets an operator with no impersonation in flight stop idempotently, auditing nothing", async () => {
    readImpersonationCookieMock.mockResolvedValue(null);
    isAdminAuthedMock.mockResolvedValue(true);

    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(logAuditMock).not.toHaveBeenCalled();
    expect(clearImpersonationCookieMock).toHaveBeenCalledTimes(1);
    expect(endSupportSessionMock, "a named operator's support sessions elsewhere end too").toHaveBeenCalledWith({ operatorId: "op-noe" });
  });

  it("discards the session cookie too — the swapped JWT must not survive the stop", async () => {
    readImpersonationCookieMock.mockResolvedValue(ACTIVE);
    isAdminAuthedMock.mockResolvedValue(true);

    await callDelete();
    expect(clearImpersonationCookieMock).toHaveBeenCalledTimes(1);
    // Cleared with its own attributes and maxAge 0, never a bare delete (D-I1).
    expect(cookieStore.set).toHaveBeenCalledWith(
      "authjs.session-token",
      "",
      expect.objectContaining({ maxAge: 0, path: "/", httpOnly: true, sameSite: "lax" }),
    );
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/impersonate from a browser WITHOUT the support cookie (lane B)", () => {
  it("ends the named operator's support session elsewhere and writes a durable end row", async () => {
    vi.clearAllMocks();
    readImpersonationCookieMock.mockResolvedValue(null);
    isAdminAuthedMock.mockResolvedValue(true);
    endSupportSessionMock.mockResolvedValueOnce(1);
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(endSupportSessionMock).toHaveBeenCalledWith({ operatorId: "op-noe" });
    expect(logAuditMock.mock.calls[0][0]).toMatchObject({
      action: "admin.impersonate.end",
      durable: true,
      outcome: "ended",
      entityType: "Operator",
      entityId: "op-noe",
      actAsUserId: "op-noe",
    });
  });

  it("a failed audit write does not undo or block the stop", async () => {
    vi.clearAllMocks();
    readImpersonationCookieMock.mockResolvedValue(null);
    isAdminAuthedMock.mockResolvedValue(true);
    endSupportSessionMock.mockResolvedValueOnce(1);
    logAuditMock.mockRejectedValueOnce(new Error("audit down"));
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(clearImpersonationCookieMock).toHaveBeenCalledTimes(1);
  });
});
