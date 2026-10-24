import { describe, it, expect, vi, beforeEach } from "vitest";

// D2 (booking preservation, approved by Noe on 21 Oct 2026): removing a member
// from a squad list no longer cancels their booking. The route takes the Class
// row lock first (the order every check-in and the class PATCH use), deletes
// the roster row, keeps the booking, and — while others remain on the list,
// so the class now turns the member away — records it durably in the same
// transaction.

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

const logAudit = vi.hoisted(() => vi.fn(async (_entry: Record<string, unknown>) => ({})));
vi.mock("@/lib/audit-log", () => ({ logAudit }));

const order: string[] = [];
const mockPrisma = {
  $queryRaw: vi.fn(async () => { order.push("class-lock"); return [{ id: "c1" }]; }),
  classRoster: {
    count: vi.fn(async () => 3),
    deleteMany: vi.fn(async () => { order.push("roster-delete"); return { count: 1 }; }),
  },
  classSubscription: { deleteMany: vi.fn(), findFirst: vi.fn() },
};

const call = async () => {
  const { DELETE } = await import("@/app/api/classes/[id]/roster/[memberId]/route");
  return DELETE(new Request("http://test", { method: "DELETE" }), { params: Promise.resolve({ id: "c1", memberId: "m1" }) });
};
const entries = () => logAudit.mock.calls.map((c) => c[0] as { action: string; tx?: unknown; metadata: Record<string, unknown> });

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
});

describe("DELETE /api/classes/[id]/roster/[memberId]", () => {
  it("takes the Class lock, removes the roster row and KEEPS the booking, recorded durably", async () => {
    mockPrisma.classSubscription.findFirst.mockResolvedValue({ id: "sub1" });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, bookingKept: true });
    expect(order).toEqual(["class-lock", "roster-delete"]);
    // Both predicates carry the caller's tenant. Previously neither did, so an
    // owner of gym A could remove a member from gym B's class.
    expect(mockPrisma.classRoster.deleteMany).toHaveBeenCalledWith({
      where: { classId: "c1", memberId: "m1", tenantId: "t1" },
    });
    expect(mockPrisma.classSubscription.findFirst).toHaveBeenCalledWith({
      where: { classId: "c1", memberId: "m1", member: { tenantId: "t1" } },
      select: { id: true },
    });
    expect(mockPrisma.classSubscription.deleteMany).not.toHaveBeenCalled();
    const kept = entries().filter((e) => e.action === "class.bookings.kept_ineligible");
    expect(kept).toEqual([
      expect.objectContaining({
        tx: mockPrisma,
        metadata: expect.objectContaining({ classId: "c1", trigger: "squad", cause: "class.roster.remove", memberIds: ["m1"], bookingsKept: true }),
      }),
    ]);
    const removal = entries().find((e) => e.action === "class.roster.remove")!;
    expect(removal.metadata).toEqual({ classId: "c1", memberId: "m1", bookingKept: true });
  });

  it("the last member off the list: the class has no squad list any more and admits them, so nothing is recorded", async () => {
    mockPrisma.classRoster.count.mockResolvedValueOnce(1);
    mockPrisma.classSubscription.findFirst.mockResolvedValue({ id: "sub1" });
    const res = await call();
    expect(res.status).toBe(200);
    expect(mockPrisma.classSubscription.deleteMany).not.toHaveBeenCalled();
    expect(entries().filter((e) => e.action === "class.bookings.kept_ineligible")).toEqual([]);
  });

  it("a member with no booking: the roster row goes, nothing is recorded as kept", async () => {
    mockPrisma.classSubscription.findFirst.mockResolvedValue(null);
    const res = await call();
    expect(await res.json()).toEqual({ ok: true, bookingKept: false });
    expect(entries().filter((e) => e.action === "class.bookings.kept_ineligible")).toEqual([]);
  });

  it("another club's class matches nothing under the lock: 404, nothing deleted", async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    const res = await call();
    expect(res.status).toBe(404);
    expect(mockPrisma.classRoster.deleteMany).not.toHaveBeenCalled();
  });
});
