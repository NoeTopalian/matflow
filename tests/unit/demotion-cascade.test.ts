import { describe, it, expect, vi, beforeEach } from "vitest";

// D2 (booking preservation, approved by Noe on 21 Oct 2026): a demotion no
// longer cancels the member's bookings. The booked classes whose rank gate it
// NEWLY turns them away from — judged as the door judges, on the highest rank
// order of any discipline — are recorded durably in the same transaction, one
// row per class; the bookings stay.

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

const logAudit = vi.hoisted(() => vi.fn(async (entry: Record<string, unknown>) => (void entry, {})));
vi.mock("@/lib/audit-log", () => ({ logAudit }));

const mockPrisma = {
  member: { findFirst: vi.fn() },
  rankSystem: { findFirst: vi.fn() },
  memberRank: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  class: { findMany: vi.fn() },
  classSubscription: { deleteMany: vi.fn(), findMany: vi.fn() },
};

const entries = () => logAudit.mock.calls.map((c) => c[0] as { action: string; entityId: string; tx?: unknown; metadata: Record<string, unknown> });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/members/[id]/rank/demote", () => {
  it("writes the lower MemberRank and KEEPS every booking; newly refused classes are recorded durably", async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ id: "m1", tenantId: "t1", email: "m@test", name: "M" });
    mockPrisma.rankSystem.findFirst.mockResolvedValue({ id: "r-white", tenantId: "t1", discipline: "BJJ", order: 1, name: "White" });
    mockPrisma.memberRank.findFirst.mockResolvedValue({ id: "mr-old", rankSystemId: "r-blue", stripes: 2, rankSystem: { order: 2 } });
    mockPrisma.memberRank.update.mockResolvedValue({ id: "mr1", memberId: "m1", rankSystemId: "r-white", rankSystem: { name: "White" } });
    // Before: blue (order 2). After: white (order 1).
    mockPrisma.memberRank.findMany
      .mockResolvedValueOnce([{ rankSystem: { order: 2 } }])
      .mockResolvedValueOnce([{ rankSystem: { order: 1 } }]);
    mockPrisma.classSubscription.findMany.mockResolvedValue([
      { classId: "c-blue", class: { requiredRank: { order: 2 }, maxRank: null } }, // newly refused
      { classId: "c-purple", class: { requiredRank: { order: 3 }, maxRank: null } }, // refused before too
      { classId: "c-open", class: { requiredRank: null, maxRank: null } }, // open
    ]);

    const { POST } = await import("@/app/api/members/[id]/rank/demote/route");
    const req = new Request("http://test", {
      method: "POST",
      body: JSON.stringify({ toRankId: "r-white", reason: "rule change" }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancelledSubscriptions).toBe(0);
    expect(body.bookingsKeptIneligibleClassIds).toEqual(["c-blue"]);
    expect(mockPrisma.classSubscription.deleteMany).not.toHaveBeenCalled();
    // The booked classes are read inside the club only.
    expect(mockPrisma.classSubscription.findMany.mock.calls[0][0].where).toEqual({ memberId: "m1", member: { tenantId: "t1" }, class: { tenantId: "t1" } });

    const kept = entries().filter((e) => e.action === "class.bookings.kept_ineligible");
    expect(kept).toEqual([
      expect.objectContaining({
        tx: mockPrisma,
        entityId: "c-blue",
        metadata: expect.objectContaining({ trigger: "rank", cause: "member.rank.demote", memberIds: ["m1"], toRankId: "r-white" }),
      }),
    ]);
    const demote = entries().find((e) => e.action === "member.rank.demote")!;
    expect(demote.metadata).toMatchObject({ bookingsKeptIneligibleClassIds: ["c-blue"] });
    expect(demote.metadata).not.toHaveProperty("cancelledSubscriptions");
  });

  it("a demotion that leaves a higher rank in another discipline turns no booking away (the door reads the highest rank)", async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ id: "m1", tenantId: "t1", email: null, name: "M" });
    mockPrisma.rankSystem.findFirst.mockResolvedValue({ id: "r-white", tenantId: "t1", discipline: "BJJ", order: 1, name: "White" });
    mockPrisma.memberRank.findFirst.mockResolvedValue({ id: "mr-old", rankSystemId: "r-blue", stripes: 0, rankSystem: { order: 2 } });
    mockPrisma.memberRank.update.mockResolvedValue({ id: "mr1", memberId: "m1", rankSystemId: "r-white", rankSystem: { name: "White" } });
    mockPrisma.memberRank.findMany
      .mockResolvedValueOnce([{ rankSystem: { order: 2 } }, { rankSystem: { order: 4 } }])
      .mockResolvedValueOnce([{ rankSystem: { order: 1 } }, { rankSystem: { order: 4 } }]);
    mockPrisma.classSubscription.findMany.mockResolvedValue([{ classId: "c-blue", class: { requiredRank: { order: 2 }, maxRank: null } }]);

    const { POST } = await import("@/app/api/members/[id]/rank/demote/route");
    const res = await POST(new Request("http://test", { method: "POST", body: JSON.stringify({ toRankId: "r-white" }) }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    expect((await res.json()).bookingsKeptIneligibleClassIds).toEqual([]);
    expect(entries().filter((e) => e.action === "class.bookings.kept_ineligible")).toEqual([]);
    expect(mockPrisma.classSubscription.deleteMany).not.toHaveBeenCalled();
  });
});
