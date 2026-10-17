// T6a: booking (POST /api/member/class-subscriptions/[classId]) applies the
// same membership gate as the member app's check-in, after the same Class
// row lock. Acceptance 5: a class the plan does not include cannot be booked.
import { vi, describe, it, expect, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  queryRaw: vi.fn(),
  tierFindMany: vi.fn(),
  rosterCount: vi.fn(),
  memberFindFirst: vi.fn(),
  subCreate: vi.fn(),
  subCount: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      $queryRaw: h.queryRaw,
      classMembershipTier: { findMany: h.tierFindMany },
      classRoster: { count: h.rosterCount },
      member: { findFirst: h.memberFindFirst },
      classSubscription: { create: h.subCreate, count: h.subCount, deleteMany: vi.fn() },
    }),
}));

import { POST } from "@/app/api/member/class-subscriptions/[classId]/route";

const book = async () => (await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "c-adv" }) }))!;

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.auth.mockResolvedValue({ user: { tenantId: "t1", memberId: "m-1" } });
  h.queryRaw.mockImplementation(async () => { h.order.push("lock"); return [{ id: "c-adv", name: "Advanced", maxCapacity: null, isActive: true, deletedAt: null, sourceImportJobId: null }]; });
  h.tierFindMany.mockImplementation(async () => { h.order.push("tiers"); return [{ tierId: "t-adv" }]; });
  h.rosterCount.mockResolvedValue(0);
  h.memberFindFirst.mockResolvedValue({ membershipTierId: "t-beg", membershipTier: { name: "Beginners Unlimited" } });
  h.subCreate.mockResolvedValue({});
});

describe("booking — tier gate", () => {
  it("refuses a class the member's plan does not include, naming both, and books nothing", async () => {
    const res = await book();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.reason).toBe("tier_not_included");
    expect(body.error).toBe("Advanced isn't included in your Beginners Unlimited membership. Ask staff about a membership that includes it.");
    expect(h.subCreate).not.toHaveBeenCalled();
    expect(h.order).toEqual(["lock", "tiers"]);
  });

  it("books a member on an included plan", async () => {
    h.memberFindFirst.mockResolvedValue({ membershipTierId: "t-adv", membershipTier: { name: "Advanced Unlimited" } });
    expect((await book()).status).toBe(201);
    expect(h.subCreate).toHaveBeenCalled();
  });

  it("a member with no plan is not covered", async () => {
    h.memberFindFirst.mockResolvedValue({ membershipTierId: null, membershipTier: null });
    expect((await book()).status).toBe(403);
  });

  it("no tiers on the class = open, as before", async () => {
    h.tierFindMany.mockResolvedValue([]);
    h.memberFindFirst.mockResolvedValue({ membershipTierId: null, membershipTier: null });
    expect((await book()).status).toBe(201);
  });

  it("a rostered class is governed by its roster", async () => {
    h.rosterCount.mockResolvedValue(4);
    expect((await book()).status).toBe(201);
  });
});
