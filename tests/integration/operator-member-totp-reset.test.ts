import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * 2FA-optional spec (2026-05-07) — the two Member TOTP unlock paths.
 *
 * Once a member is enrolled, no self-disable is possible. Exactly two routes
 * may clear it:
 *   - Operator: POST /api/admin/customers/[id]/member-totp-reset
 *               (audit: admin.member.totp_reset, requires gym-name confirmation)
 *   - Staff:    POST /api/members/[id]/totp-reset
 *               (audit: member.totp_reset, requireStaff, tenant-scoped)
 *
 * Both must: clear totpEnabled/totpSecret/totpRecoveryCodes, bump sessionVersion,
 * and write the correct audit code. This is mock-based (no live DB) so it runs
 * in CI without TEST_DATABASE_URL.
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

const {
  logAuditMock,
  isAdminAuthedMock,
  getOperatorContextMock,
  requireStaffMock,
  rlsTenantFindUnique,
  rlsMemberFindFirst,
  rlsMemberUpdate,
  tenantMemberFindFirst,
  tenantMemberUpdate,
} = vi.hoisted(() => ({
  logAuditMock: vi.fn(async () => {}),
  isAdminAuthedMock: vi.fn(async () => true),
  getOperatorContextMock: vi.fn(async () => ({ operatorId: "op-1" })),
  requireStaffMock: vi.fn(async () => ({ tenantId: "tenant-A", userId: "u-owner" })),
  rlsTenantFindUnique: vi.fn(),
  rlsMemberFindFirst: vi.fn(),
  rlsMemberUpdate: vi.fn().mockResolvedValue({}),
  tenantMemberFindFirst: vi.fn(),
  tenantMemberUpdate: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: isAdminAuthedMock }));
vi.mock("@/lib/operator-context", () => ({ getOperatorContext: getOperatorContextMock }));
vi.mock("@/lib/authz", () => ({ requireStaff: requireStaffMock }));

// withRlsBypass (operator route) and withTenantContext (staff route) both come
// from @/lib/prisma-tenant. Give each its own fake tx.
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: (fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({
      tenant: { findUnique: rlsTenantFindUnique },
      member: { findFirst: rlsMemberFindFirst, update: rlsMemberUpdate },
    })),
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({
      member: { findFirst: tenantMemberFindFirst, update: tenantMemberUpdate },
    })),
}));

function postReq(url: string, body: Record<string, unknown>) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost", host: "localhost" },
    body: JSON.stringify(body),
  });
}

const RESET_FIELDS = { totpEnabled: false, totpSecret: null };

beforeEach(() => {
  vi.clearAllMocks();
  isAdminAuthedMock.mockResolvedValue(true);
  getOperatorContextMock.mockResolvedValue({ operatorId: "op-1" });
  requireStaffMock.mockResolvedValue({ tenantId: "tenant-A", userId: "u-owner" });
  rlsMemberUpdate.mockResolvedValue({});
  tenantMemberUpdate.mockResolvedValue({});
});

// ── Operator path ────────────────────────────────────────────────────────────

describe("POST /api/admin/customers/[id]/member-totp-reset (operator)", () => {
  function body(over: Record<string, unknown> = {}) {
    return { memberId: "m-9", reason: "Member lost phone", confirmName: "Total BJJ", ...over };
  }

  it("clears TOTP, bumps sessionVersion, writes admin.member.totp_reset", async () => {
    rlsTenantFindUnique.mockResolvedValueOnce({ id: "tenant-A", name: "Total BJJ" });
    rlsMemberFindFirst.mockResolvedValueOnce({ id: "m-9", email: "x@gym.test", name: "X", totpEnabled: true });

    const { POST } = await import("@/app/api/admin/customers/[id]/member-totp-reset/route");
    const res = await POST(postReq("http://localhost/x", body()) as never, { params: Promise.resolve({ id: "tenant-A" }) });

    expect(res.status).toBe(200);
    expect(rlsMemberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ...RESET_FIELDS, sessionVersion: { increment: 1 } }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.member.totp_reset", entityType: "Member", entityId: "m-9", actAsUserId: "op-1" }),
    );
  });

  it("rejects 403 when the caller is not an authed operator", async () => {
    isAdminAuthedMock.mockResolvedValueOnce(false);
    const { POST } = await import("@/app/api/admin/customers/[id]/member-totp-reset/route");
    const res = await POST(postReq("http://localhost/x", body()) as never, { params: Promise.resolve({ id: "tenant-A" }) });
    expect(res.status).toBe(403);
    expect(rlsMemberUpdate).not.toHaveBeenCalled();
  });

  it("rejects 400 when the gym-name confirmation does not match", async () => {
    rlsTenantFindUnique.mockResolvedValueOnce({ id: "tenant-A", name: "Total BJJ" });
    const { POST } = await import("@/app/api/admin/customers/[id]/member-totp-reset/route");
    const res = await POST(postReq("http://localhost/x", body({ confirmName: "Wrong Gym" })) as never, { params: Promise.resolve({ id: "tenant-A" }) });
    expect(res.status).toBe(400);
    expect(rlsMemberUpdate).not.toHaveBeenCalled();
  });

  it("rejects 400 on a too-short reason", async () => {
    const { POST } = await import("@/app/api/admin/customers/[id]/member-totp-reset/route");
    const res = await POST(postReq("http://localhost/x", body({ reason: "no" })) as never, { params: Promise.resolve({ id: "tenant-A" }) });
    expect(res.status).toBe(400);
    expect(rlsMemberUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 when the member is not in the named tenant (forged memberId)", async () => {
    rlsTenantFindUnique.mockResolvedValueOnce({ id: "tenant-A", name: "Total BJJ" });
    rlsMemberFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/admin/customers/[id]/member-totp-reset/route");
    const res = await POST(postReq("http://localhost/x", body({ memberId: "m-other-tenant" })) as never, { params: Promise.resolve({ id: "tenant-A" }) });
    expect(res.status).toBe(404);
    expect(rlsMemberUpdate).not.toHaveBeenCalled();
  });
});

// ── Staff path ───────────────────────────────────────────────────────────────

describe("POST /api/members/[id]/totp-reset (staff)", () => {
  it("clears TOTP, bumps sessionVersion, writes member.totp_reset with metadata", async () => {
    tenantMemberFindFirst.mockResolvedValueOnce({ id: "m-9", email: "x@gym.test", name: "X", totpEnabled: true });

    const { POST } = await import("@/app/api/members/[id]/totp-reset/route");
    const res = await POST(
      postReq("http://localhost/api/members/m-9/totp-reset", { reason: "Lost authenticator" }) as never,
      { params: Promise.resolve({ id: "m-9" }) },
    );

    expect(res.status).toBe(200);
    expect(tenantMemberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "m-9" }, data: expect.objectContaining({ ...RESET_FIELDS, sessionVersion: { increment: 1 } }) }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.totp_reset",
        entityType: "Member",
        entityId: "m-9",
        metadata: expect.objectContaining({ reason: "Lost authenticator", memberEmail: "x@gym.test", wasEnrolled: true }),
      }),
    );
  });

  it("rejects 400 on a too-short reason", async () => {
    const { POST } = await import("@/app/api/members/[id]/totp-reset/route");
    const res = await POST(
      postReq("http://localhost/api/members/m-9/totp-reset", { reason: "x" }) as never,
      { params: Promise.resolve({ id: "m-9" }) },
    );
    expect(res.status).toBe(400);
    expect(tenantMemberUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 when the member is not in the caller's tenant (forged id)", async () => {
    tenantMemberFindFirst.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/members/[id]/totp-reset/route");
    const res = await POST(
      postReq("http://localhost/api/members/m-other/totp-reset", { reason: "Lost authenticator" }) as never,
      { params: Promise.resolve({ id: "m-other" }) },
    );
    expect(res.status).toBe(404);
    expect(tenantMemberUpdate).not.toHaveBeenCalled();
  });
});
