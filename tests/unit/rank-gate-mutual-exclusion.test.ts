import { describe, it, expect, vi, beforeEach } from "vitest";

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
  class: { findFirst: vi.fn(), updateMany: vi.fn() },
  classRoster: { deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn() },
  classSubscription: { findMany: vi.fn(), deleteMany: vi.fn() },
  rankSystem: { findFirst: vi.fn() },
  attendanceRecord: { count: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/classes/[id] mutual exclusion", () => {
  it("when requiredRankId set, server clears ClassRoster rows", async () => {
    mockPrisma.classSubscription.findMany.mockResolvedValue([]);
    mockPrisma.rankSystem.findFirst.mockResolvedValue({ id: "r-blue", order: 2, discipline: "BJJ" });
    mockPrisma.classRoster.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.class.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.class.findFirst.mockResolvedValue({ id: "c1", requiredRankId: "r-blue" });

    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const req = new Request("http://test/api/classes/c1", {
      method: "PATCH",
      body: JSON.stringify({ requiredRankId: "r-blue" }),
    });
    const res = await PATCH(req as any, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    expect(mockPrisma.classRoster.deleteMany).toHaveBeenCalledWith({ where: { classId: "c1" } });
  });

  it("?dryRun=1 returns affected member IDs without committing", async () => {
    mockPrisma.rankSystem.findFirst.mockResolvedValue({ id: "r-blue", order: 2, discipline: "BJJ" });
    mockPrisma.classSubscription.findMany.mockResolvedValue([
      { memberId: "m1", member: { memberRanks: [{ rankSystem: { discipline: "BJJ", order: 1 } }] } },
    ]);

    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const req = new Request("http://test/api/classes/c1?dryRun=1", {
      method: "PATCH",
      body: JSON.stringify({ requiredRankId: "r-blue" }),
    });
    const res = await PATCH(req as any, { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dryRun).toBe(true);
    expect(body.affectedMemberIds).toEqual(["m1"]);
    expect(mockPrisma.class.updateMany).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/classes/[id] preconditions", () => {
  it("returns 409 with counts when attendance or roster exists and ?force is not set", async () => {
    mockPrisma.attendanceRecord.count.mockResolvedValue(5);
    mockPrisma.classRoster.count.mockResolvedValue(2);

    const { DELETE } = await import("@/app/api/classes/[id]/route");
    const res = await DELETE(
      new Request("http://test/api/classes/c1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.attendanceCount).toBe(5);
    expect(body.rosterCount).toBe(2);
  });

  it("succeeds with ?force=true even when attendance/roster exist", async () => {
    mockPrisma.attendanceRecord.count.mockResolvedValue(5);
    mockPrisma.classRoster.count.mockResolvedValue(2);
    mockPrisma.class.updateMany.mockResolvedValue({ count: 1 });

    const { DELETE } = await import("@/app/api/classes/[id]/route");
    const res = await DELETE(
      new Request("http://test/api/classes/c1?force=true", { method: "DELETE" }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(res.status).toBe(200);
  });
});
