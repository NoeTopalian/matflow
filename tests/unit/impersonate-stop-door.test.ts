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
} = vi.hoisted(() => ({
  cookieStore: { delete: vi.fn<(name: string) => void>() },
  isAdminAuthedMock: vi.fn<() => Promise<boolean>>(),
  readImpersonationCookieMock: vi.fn<() => Promise<unknown>>(),
  clearImpersonationCookieMock: vi.fn<() => Promise<void>>(async () => {}),
  logAuditMock: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => ({})),
}));

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: isAdminAuthedMock }));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/impersonation", () => ({
  setImpersonationCookie: vi.fn(),
  clearImpersonationCookie: clearImpersonationCookieMock,
  readImpersonationCookie: readImpersonationCookieMock,
}));
vi.mock("@/lib/prisma-tenant", () => ({ withRlsBypass: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(), getClientIp: () => "test" }));
vi.mock("@/lib/operator-context", () => ({ getOperatorContext: vi.fn() }));
vi.mock("@/lib/auth-cookie", () => ({
  SESSION_COOKIE_NAME: "authjs.session-token",
  SESSION_COOKIE_SECURE: false,
}));

const ACTIVE = {
  adminUserId: "__matflow_super_admin__",
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
    expect(cookieStore.delete).not.toHaveBeenCalled();
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
      actAsUserId: "__matflow_super_admin__",
    });
  });

  it("lets an operator with no impersonation in flight stop idempotently, auditing nothing", async () => {
    readImpersonationCookieMock.mockResolvedValue(null);
    isAdminAuthedMock.mockResolvedValue(true);

    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(logAuditMock).not.toHaveBeenCalled();
    expect(clearImpersonationCookieMock).toHaveBeenCalledTimes(1);
  });

  it("discards the session cookie too — the swapped JWT must not survive the stop", async () => {
    readImpersonationCookieMock.mockResolvedValue(ACTIVE);
    isAdminAuthedMock.mockResolvedValue(true);

    await callDelete();
    expect(clearImpersonationCookieMock).toHaveBeenCalledTimes(1);
    expect(cookieStore.delete).toHaveBeenCalledWith("authjs.session-token");
  });
});
