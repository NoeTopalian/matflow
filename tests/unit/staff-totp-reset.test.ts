import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * POST /api/staff/[id]/totp-reset — the OWNER's recovery path for a manager,
 * admin or coach who lost their authenticator (1 Oct 2026). With TOTP now
 * mandatory for managers and admins (lib/mfa-policy.ts), a lost phone would
 * otherwise lock them out until MatFlow support intervened. The owner's own
 * reset stays operator-only (app/api/admin/customers/[id]/totp-reset).
 *
 * Invariants: owner-only; never touches the owner row (an owner id → 404);
 * tenant-scoped; clears secret + flag, bumps sessionVersion so live sessions
 * die; audited as `staff.totp_reset` with a reason.
 */

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));

const { logAuditMock, requireApiOwnerMock, userFindFirst, userUpdate } = vi.hoisted(() => ({
  logAuditMock: vi.fn(async () => {}),
  requireApiOwnerMock: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: requireApiOwnerMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({ user: { findFirst: userFindFirst, update: userUpdate } })),
}));

function postReq(id: string, reason = "Lost phone, confirmed in person") {
  return new Request(`http://localhost/api/staff/${id}/totp-reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost", host: "localhost" },
    body: JSON.stringify({ reason }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireApiOwnerMock.mockResolvedValue({ ok: true, tenantId: "tenant-A", userId: "u-owner", role: "owner" });
  userUpdate.mockResolvedValue({});
});

describe("staff totp-reset (owner → manager/admin/coach)", () => {
  it("clears the second factor, bumps sessionVersion and audits", async () => {
    userFindFirst.mockResolvedValueOnce({ id: "u-mgr", email: "mgr@club.com", name: "Mo", role: "manager", totpEnabled: true });
    const { POST } = await import("@/app/api/staff/[id]/totp-reset/route");
    const res = await POST(postReq("u-mgr") as never, { params: Promise.resolve({ id: "u-mgr" }) });
    expect(res.status).toBe(200);
    expect(userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "u-mgr", tenantId: "tenant-A", role: { not: "owner" } }) }),
    );
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u-mgr" },
        data: expect.objectContaining({ totpEnabled: false, totpSecret: null, sessionVersion: { increment: 1 } }),
      }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "staff.totp_reset", entityType: "User", entityId: "u-mgr", tenantId: "tenant-A", userId: "u-owner" }),
    );
  });

  it("an owner id resolves to no row (the query excludes owners) → 404, nothing written", async () => {
    userFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/staff/[id]/totp-reset/route");
    const res = await POST(postReq("u-owner") as never, { params: Promise.resolve({ id: "u-owner" }) });
    expect(res.status).toBe(404);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("a manager is refused (owner-only)", async () => {
    requireApiOwnerMock.mockResolvedValueOnce({ ok: false, response: { status: 403, json: async () => ({}), headers: new Headers() } });
    const { POST } = await import("@/app/api/staff/[id]/totp-reset/route");
    const res = await POST(postReq("u-coach") as never, { params: Promise.resolve({ id: "u-coach" }) });
    expect(res.status).toBe(403);
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("a reason is required", async () => {
    const { POST } = await import("@/app/api/staff/[id]/totp-reset/route");
    const res = await POST(postReq("u-mgr", "x") as never, { params: Promise.resolve({ id: "u-mgr" }) });
    expect(res.status).toBe(400);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
