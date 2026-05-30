import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * 2FA-optional spec (2026-05-07) — Risk R9.
 *
 * The staff reset route POST /api/members/[id]/totp-reset must ONLY touch
 * Member rows. A gym owner/manager must never be able to clear a *User's*
 * (staff/owner) TOTP through it — that path stays operator-only at
 * POST /api/admin/customers/[id]/totp-reset.
 *
 * Mechanism: the route resolves the id against tx.member.findFirst scoped to
 * the caller's tenant. A User id resolves to no Member → 404, and the route
 * never calls tx.user.update. This test proves the staff route cannot be
 * repurposed to disable a staff/owner second factor.
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

const { logAuditMock, requireStaffMock, memberFindFirst, memberUpdate, userUpdate } = vi.hoisted(() => ({
  logAuditMock: vi.fn(async () => {}),
  requireStaffMock: vi.fn(async () => ({ tenantId: "tenant-A", userId: "u-owner" })),
  memberFindFirst: vi.fn(),
  memberUpdate: vi.fn().mockResolvedValue({}),
  userUpdate: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/authz", () => ({ requireStaff: requireStaffMock }));

// The fake tx exposes BOTH member and user. The route should only ever reach
// member.* — we assert user.update is never invoked.
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({
      member: { findFirst: memberFindFirst, update: memberUpdate },
      user: { findFirst: vi.fn(), update: userUpdate },
    })),
}));

function postReq(id: string) {
  return new Request(`http://localhost/api/members/${id}/totp-reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost", host: "localhost" },
    body: JSON.stringify({ reason: "Attempting to reset a target" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireStaffMock.mockResolvedValue({ tenantId: "tenant-A", userId: "u-owner" });
  memberUpdate.mockResolvedValue({});
});

describe("staff totp-reset cannot clear a User's TOTP", () => {
  it("returns 404 and never calls user.update when given a User id", async () => {
    // A User id ("u-owner") matches no Member row in this tenant.
    memberFindFirst.mockResolvedValueOnce(null);

    const { POST } = await import("@/app/api/members/[id]/totp-reset/route");
    const res = await POST(postReq("u-owner") as never, { params: Promise.resolve({ id: "u-owner" }) });

    expect(res.status).toBe(404);
    expect(userUpdate).not.toHaveBeenCalled();
    expect(memberUpdate).not.toHaveBeenCalled();
    // No spurious audit row for a non-existent member.
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("only resolves the id against member.findFirst (never user lookups)", async () => {
    memberFindFirst.mockResolvedValueOnce(null);

    const { POST } = await import("@/app/api/members/[id]/totp-reset/route");
    await POST(postReq("u-some-staff") as never, { params: Promise.resolve({ id: "u-some-staff" }) });

    expect(memberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "u-some-staff", tenantId: "tenant-A" }) }),
    );
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
