import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_t, fn) => fn(mockPrisma)),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "u1", role: "owner", tenantId: "t1" },
  })),
}));

vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn(async () => ({})),
}));

const mockPrisma = {
  class: { findFirst: vi.fn() },
  member: { findFirst: vi.fn() },
  classRoster: { create: vi.fn(), findUnique: vi.fn() },
};

describe("POST /api/classes/[id]/roster", () => {
  it("creates a ClassRoster row when class+member belong to same tenant", async () => {
    mockPrisma.class.findFirst.mockResolvedValue({ id: "c1", tenantId: "t1", requiredRankId: null, maxRankId: null });
    mockPrisma.member.findFirst.mockResolvedValue({ id: "m1", tenantId: "t1" });
    mockPrisma.classRoster.create.mockResolvedValue({ id: "r1", classId: "c1", memberId: "m1" });

    const { POST } = await import("@/app/api/classes/[id]/roster/route");
    const req = new Request("http://test/api/classes/c1/roster", {
      method: "POST",
      body: JSON.stringify({ memberId: "m1" }),
    });
    const res = await POST(req as any, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(201);
  });
});
