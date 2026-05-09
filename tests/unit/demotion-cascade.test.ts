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
  member: { findFirst: vi.fn() },
  rankSystem: { findFirst: vi.fn() },
  memberRank: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  class: { findMany: vi.fn() },
  classSubscription: { deleteMany: vi.fn() },
};

describe("POST /api/members/[id]/rank/demote", () => {
  it("creates downward MemberRank and cancels ClassSubscription for now-ineligible classes", async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ id: "m1", tenantId: "t1", email: "m@test", name: "M" });
    mockPrisma.rankSystem.findFirst.mockResolvedValue({ id: "r-white", tenantId: "t1", discipline: "BJJ", order: 1, name: "White" });
    mockPrisma.memberRank.findFirst.mockResolvedValue({ id: "mr-old", rankSystemId: "r-blue" });
    mockPrisma.memberRank.update.mockResolvedValue({ id: "mr1", memberId: "m1", rankSystemId: "r-white", rankSystem: { name: "White" } });
    mockPrisma.class.findMany.mockResolvedValue([{ id: "c1" }, { id: "c2" }]);
    mockPrisma.classSubscription.deleteMany.mockResolvedValue({ count: 2 });

    const { POST } = await import("@/app/api/members/[id]/rank/demote/route");
    const req = new Request("http://test", {
      method: "POST",
      body: JSON.stringify({ toRankId: "r-white", reason: "rule change" }),
    });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancelledSubscriptions).toBe(2);
    expect(mockPrisma.classSubscription.deleteMany).toHaveBeenCalled();
  });
});
