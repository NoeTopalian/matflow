/**
 * Coverage for a member who pays at the desk (club-life finding F-L5-1).
 *
 * The self path (`requireCoverage: true`) used to accept only a Stripe
 * subscription or a pack, so a paid cash member was told to buy a pack on
 * the portal while the kiosk admitted them. A desk membership now counts:
 * a tier assigned, paid or comped, and not overdue by the derived rule. The
 * schema default `paymentStatus = "paid"` on its own — no tier — is still
 * not coverage, so a freshly created member with nothing assigned cannot
 * train for free.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const recordCreateMock = vi.fn();
const memberFindUniqueMock = vi.fn();
const packFindFirstMock = vi.fn();

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      member: { findUnique: memberFindUniqueMock },
      memberRank: { findFirst: vi.fn().mockResolvedValue(null) },
      classRoster: { count: vi.fn().mockResolvedValue(0), findUnique: vi.fn().mockResolvedValue(null) },
      classInstance: {
        findFirst: vi.fn().mockResolvedValue({
          id: "ci-1", classId: "c-1", isCancelled: false,
          date: new Date("2026-09-25T00:00:00.000Z"), startTime: "10:00", endTime: "11:00",
          class: { id: "c-1", tenantId: "t-1", maxCapacity: null, requiredRankId: null, maxRankId: null, requiredRank: null, maxRank: null,
            tenant: { checkinWindowBeforeMin: 30, checkinWindowAfterMin: 30, timezone: "Europe/London" } },
        }),
      },
      attendanceRecord: { create: recordCreateMock, count: vi.fn().mockResolvedValue(0) },
      memberClassPack: { findFirst: packFindFirstMock, updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn().mockResolvedValue(null) },
      classPackRedemption: { create: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([{ maxCapacity: null }]),
    }),
  ),
}));

import { performCheckin } from "@/lib/checkin";

const SELF = {
  tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", method: "self" as const,
  enforceRankGate: false, enforceRosterGate: false, enforceTimeWindow: false,
  requireCoverage: true, enforceCapacity: false, enforceWaiverGate: true, enforceHoldGate: true,
  checkedInByUserId: null,
};
const future = new Date(Date.now() + 10 * 86_400_000);
const past = new Date(Date.now() - 2 * 86_400_000);
const base = { waiverAccepted: true, holdUntil: null, stripeSubscriptionId: null as string | null };

beforeEach(() => {
  vi.clearAllMocks();
  recordCreateMock.mockResolvedValue({ id: "ar-1", tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", checkInMethod: "self" });
  packFindFirstMock.mockResolvedValue(null);
});

describe("self check-in coverage for desk-paying members", () => {
  it("a paid member on a tier with a future due date is covered (manual)", async () => {
    memberFindUniqueMock.mockResolvedValue({ ...base, paymentStatus: "paid", membershipTierId: "tier-1", nextDueAt: future });
    const r = await performCheckin(SELF);
    expect(r.kind).toBe("success");
    if (r.kind === "success") expect(r.coverage.kind).toBe("manual");
    expect(recordCreateMock).toHaveBeenCalledTimes(1);
  });

  it("a comped member (free) on a tier is covered", async () => {
    memberFindUniqueMock.mockResolvedValue({ ...base, paymentStatus: "free", membershipTierId: "tier-1", nextDueAt: null });
    expect((await performCheckin(SELF)).kind).toBe("success");
  });

  it("a paid member on a tier with no due date tracked is covered", async () => {
    memberFindUniqueMock.mockResolvedValue({ ...base, paymentStatus: "paid", membershipTierId: "tier-1", nextDueAt: null });
    expect((await performCheckin(SELF)).kind).toBe("success");
  });

  it("the schema default paid with NO tier is not coverage — nobody trains on a blank row", async () => {
    memberFindUniqueMock.mockResolvedValue({ ...base, paymentStatus: "paid", membershipTierId: null, nextDueAt: null });
    const r = await performCheckin(SELF);
    expect(r.kind).toBe("no_coverage");
    expect(recordCreateMock).not.toHaveBeenCalled();
  });

  it("overdue by the derived rule (due date passed, no Stripe) is not coverage", async () => {
    memberFindUniqueMock.mockResolvedValue({ ...base, paymentStatus: "paid", membershipTierId: "tier-1", nextDueAt: past });
    expect((await performCheckin(SELF)).kind).toBe("no_coverage");
  });

  it("overdue by status is not coverage even with a tier", async () => {
    memberFindUniqueMock.mockResolvedValue({ ...base, paymentStatus: "overdue", membershipTierId: "tier-1", nextDueAt: future });
    expect((await performCheckin(SELF)).kind).toBe("no_coverage");
  });

  it("a Stripe subscription that is paid still reads as subscription coverage", async () => {
    memberFindUniqueMock.mockResolvedValue({ ...base, stripeSubscriptionId: "sub_1", paymentStatus: "paid", membershipTierId: "tier-1", nextDueAt: null });
    const r = await performCheckin(SELF);
    expect(r.kind).toBe("success");
    if (r.kind === "success") expect(r.coverage.kind).toBe("subscription");
  });

  // The pack path is pinned by tests/unit/checkin-atomic-pack.test.ts; it is
  // unchanged by this rule and not repeated here.
});
