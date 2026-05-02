import { vi, describe, it, expect, beforeEach } from "vitest";

// Assessment Fix #3 — DSAR scripted export endpoint.
// Verifies tenant scoping, member-not-found 404, missing-query 400,
// the export shape (all 9 collections present), and audit logging.

const {
  requireOwnerMock,
  memberFindFirstMock,
  attendanceFindManyMock,
  paymentFindManyMock,
  orderFindManyMock,
  waiverFindManyMock,
  subFindManyMock,
  packFindManyMock,
  rankFindManyMock,
  emailLogFindManyMock,
  auditLogFindManyMock,
  logAuditMock,
} = vi.hoisted(() => ({
  requireOwnerMock: vi.fn(),
  memberFindFirstMock: vi.fn(),
  attendanceFindManyMock: vi.fn().mockResolvedValue([]),
  paymentFindManyMock: vi.fn().mockResolvedValue([]),
  orderFindManyMock: vi.fn().mockResolvedValue([]),
  waiverFindManyMock: vi.fn().mockResolvedValue([]),
  subFindManyMock: vi.fn().mockResolvedValue([]),
  packFindManyMock: vi.fn().mockResolvedValue([]),
  rankFindManyMock: vi.fn().mockResolvedValue([]),
  emailLogFindManyMock: vi.fn().mockResolvedValue([]),
  auditLogFindManyMock: vi.fn().mockResolvedValue([]),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/authz", () => ({ requireOwner: requireOwnerMock }));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: message }),
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: memberFindFirstMock },
    attendanceRecord: { findMany: attendanceFindManyMock },
    payment: { findMany: paymentFindManyMock },
    order: { findMany: orderFindManyMock },
    signedWaiver: { findMany: waiverFindManyMock },
    classSubscription: { findMany: subFindManyMock },
    memberClassPack: { findMany: packFindManyMock },
    memberRank: { findMany: rankFindManyMock },
    emailLog: { findMany: emailLogFindManyMock },
    auditLog: { findMany: auditLogFindManyMock },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  requireOwnerMock.mockResolvedValue({
    tenantId: "tenant-A",
    userId: "user-owner-A",
    role: "owner",
  });
});

function makeReq(memberId?: string) {
  const url = memberId
    ? `http://localhost/api/admin/dsar/export?memberId=${memberId}`
    : "http://localhost/api/admin/dsar/export";
  return new Request(url);
}

describe("GET /api/admin/dsar/export — Assessment Fix #3", () => {
  it("returns 400 when memberId query param is missing", async () => {
    const { GET } = await import("@/app/api/admin/dsar/export/route");
    const res = await GET(makeReq());
    expect(res.status).toBe(400);
    expect(memberFindFirstMock).not.toHaveBeenCalled();
  });

  it("returns 404 for cross-tenant memberId (tenant scope enforced)", async () => {
    memberFindFirstMock.mockResolvedValueOnce(null);
    const { GET } = await import("@/app/api/admin/dsar/export/route");
    const res = await GET(makeReq("foreign-member"));
    expect(res.status).toBe(404);
    // Confirm the lookup was tenant-scoped — the load-bearing assertion.
    expect(memberFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "foreign-member", tenantId: "tenant-A" },
      }),
    );
  });

  it("returns a JSON download with Content-Disposition: attachment", async () => {
    memberFindFirstMock.mockResolvedValueOnce({
      id: "m1",
      email: "alice@example.com",
      name: "Alice",
      tenantId: "tenant-A",
      parent: null,
      children: [],
    } as never);
    const { GET } = await import("@/app/api/admin/dsar/export/route");
    const res = await GET(makeReq("m1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename="dsar-alice_example_com-/);
    expect(res.headers.get("Cache-Control")).toContain("private");
  });

  it("includes all 9 collections in the export package", async () => {
    memberFindFirstMock.mockResolvedValueOnce({
      id: "m1",
      email: "alice@example.com",
      name: "Alice",
      tenantId: "tenant-A",
      parent: null,
      children: [],
    } as never);
    const { GET } = await import("@/app/api/admin/dsar/export/route");
    const res = await GET(makeReq("m1"));
    const body = await res.text();
    const parsed = JSON.parse(body);

    // The 9 collections from the assessment doc + member + counts + meta.
    expect(parsed).toHaveProperty("member");
    expect(parsed).toHaveProperty("attendances");
    expect(parsed).toHaveProperty("payments");
    expect(parsed).toHaveProperty("orders");
    expect(parsed).toHaveProperty("signedWaivers");
    expect(parsed).toHaveProperty("classSubscriptions");
    expect(parsed).toHaveProperty("classPacks");
    expect(parsed).toHaveProperty("ranks");
    expect(parsed).toHaveProperty("emailLogs");
    expect(parsed).toHaveProperty("auditLogs");
    expect(parsed).toHaveProperty("counts");
    expect(parsed).toHaveProperty("_meta");
    expect(parsed._meta.version).toBe(1);
  });

  it("audit-logs member.dsar_export with counts + memberEmail in metadata", async () => {
    memberFindFirstMock.mockResolvedValueOnce({
      id: "m1",
      email: "alice@example.com",
      name: "Alice",
      tenantId: "tenant-A",
      parent: null,
      children: [],
    } as never);
    attendanceFindManyMock.mockResolvedValueOnce([{ id: "a1" }, { id: "a2" }]);
    paymentFindManyMock.mockResolvedValueOnce([{ id: "p1" }]);

    const { GET } = await import("@/app/api/admin/dsar/export/route");
    await GET(makeReq("m1"));

    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "member.dsar_export",
        entityType: "Member",
        entityId: "m1",
        metadata: expect.objectContaining({
          memberEmail: "alice@example.com",
          counts: expect.objectContaining({
            attendances: 2,
            payments: 1,
          }),
        }),
      }),
    );
  });

  it("queries each PII collection scoped to the member (and tenant where the model has a tenantId column)", async () => {
    memberFindFirstMock.mockResolvedValueOnce({
      id: "m1",
      email: "alice@example.com",
      name: "Alice",
      tenantId: "tenant-A",
      parent: null,
      children: [],
    } as never);

    const { GET } = await import("@/app/api/admin/dsar/export/route");
    await GET(makeReq("m1"));

    // Tenant-scoped collections (have tenantId column)
    expect(paymentFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ memberId: "m1", tenantId: "tenant-A" }) }),
    );
    expect(orderFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ memberId: "m1", tenantId: "tenant-A" }) }),
    );
    expect(waiverFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ memberId: "m1", tenantId: "tenant-A" }) }),
    );

    // EmailLog is queried by recipient (email) within the tenant
    expect(emailLogFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: "tenant-A", recipient: "alice@example.com" }),
      }),
    );

    // AuditLog is queried by entity ref + tenant
    expect(auditLogFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant-A",
          entityType: "Member",
          entityId: "m1",
        }),
      }),
    );
  });
});
