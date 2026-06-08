import { describe, it, expect, vi } from "vitest";

// Lane 1 iter-1 CSRF-sweep follow-up: short-circuit the guard so test
// Requests (which carry no browser-set Origin header) don't 403.
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));


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
  classRoster: { delete: vi.fn() },
  classSubscription: { deleteMany: vi.fn() },
};

describe("DELETE /api/classes/[id]/roster/[memberId]", () => {
  it("removes the roster row AND cascade-cancels ClassSubscription for the same class+member", async () => {
    mockPrisma.classRoster.delete.mockResolvedValue({ id: "r1", classId: "c1", memberId: "m1" });
    mockPrisma.classSubscription.deleteMany.mockResolvedValue({ count: 1 });

    const { DELETE } = await import("@/app/api/classes/[id]/roster/[memberId]/route");
    const res = await DELETE(
      new Request("http://test", { method: "DELETE" }),
      { params: Promise.resolve({ id: "c1", memberId: "m1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.classSubscription.deleteMany).toHaveBeenCalledWith({
      where: { classId: "c1", memberId: "m1" },
    });
  });
});
