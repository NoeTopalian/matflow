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

// The operator route rate-limits destructive admin actions (20/hour on
// `admin:tenant-action:<operatorId>:<ip>`), and lib/rate-limit.ts backs that
// bucket with a real RateLimitHit table. With @/lib/prisma unmocked here, the
// four operator cases wrote four rows to the shared test branch on every run —
// so the fifth run of this file inside an hour returned 429 instead of
// 200/400/404 and the suite could not pass twice. This file states above that
// it is mock-based with no live DB; the unmocked limiter was the one place that
// was not true. Rate limiting itself is covered by
// tests/unit/apply-rate-limit.test.ts, so nothing is lost by stubbing it.
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

const {
  logAuditMock,
  isAdminAuthedMock,
  getOperatorContextMock,
  requireStaffMock,
  requireApiStaffMock,
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
  requireApiStaffMock: vi.fn(async () => ({ ok: true, tenantId: "tenant-A", userId: "u-owner" })),
  rlsTenantFindUnique: vi.fn(),
  rlsMemberFindFirst: vi.fn(),
  rlsMemberUpdate: vi.fn().mockResolvedValue({}),
  tenantMemberFindFirst: vi.fn(),
  tenantMemberUpdate: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: isAdminAuthedMock }));
vi.mock("@/lib/operator-context", () => ({ getOperatorContext: getOperatorContextMock }));
// The staff route gates on requireApiStaff from @/lib/api-authz, not
// requireStaff from @/lib/authz: a route handler must answer an expired
// session with JSON 401/403, never the 307-to-/login that @/lib/authz's
// redirect() produces (see the header of lib/api-authz.ts). Mocking only
// @/lib/authz left the real module in play, which pulls @/auth → next-auth →
// `next/server`, and next-auth is externalised so Vite cannot resolve it —
// hence "Cannot find module .../next/server" rather than an assertion failure.
// @/lib/authz stays mocked as a backstop — it is the module api-authz would
// otherwise pull in for STAFF_ROLES, and it imports @/auth directly.
vi.mock("@/lib/api-authz", () => ({ requireApiStaff: requireApiStaffMock }));
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
  requireApiStaffMock.mockResolvedValue({ ok: true, tenantId: "tenant-A", userId: "u-owner" });
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
        // GDPR obs-1: the subject's address is HMAC'd, never stored in
        // cleartext — AuditLog rows outlive an Article 17 erasure by up to 12
        // months, so a cleartext address here would re-plant erased PII.
        metadata: expect.objectContaining({ reason: "Lost authenticator", wasEnrolled: true }),
      }),
    );
    const lastAuditCall = logAuditMock.mock.calls.at(-1) as unknown as [{ metadata: Record<string, unknown> }];
    const auditMeta = lastAuditCall[0].metadata;
    expect(auditMeta).not.toHaveProperty("memberEmail");
    expect(auditMeta.memberEmailHash).toMatch(/^[0-9a-f]{64}$/);
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
