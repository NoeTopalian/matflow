/**
 * Venue eligibility at check-in (ADR-001 D2 slice 2).
 *
 * A tier may be bound to one venue. On the member-decided paths (self,
 * kiosk) a member on a venue-bound tier is refused at a class held at
 * another venue; a class with no venue, or a tier with no venue, is open.
 * A staff mark never asks. The refusal carries both names so the tablet can
 * say "your membership covers Northside, this class is at Southside".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const recordCreateMock = vi.fn();
const memberFindUniqueMock = vi.fn();
const instanceFindFirstMock = vi.fn();

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      member: { findUnique: memberFindUniqueMock },
      memberRank: { findFirst: vi.fn().mockResolvedValue(null) },
      classRoster: { count: vi.fn().mockResolvedValue(0), findUnique: vi.fn().mockResolvedValue(null) },
      classInstance: { findFirst: instanceFindFirstMock },
      attendanceRecord: { create: recordCreateMock, count: vi.fn().mockResolvedValue(0) },
      memberClassPack: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 0 }), findUnique: vi.fn().mockResolvedValue(null) },
      classPackRedemption: { create: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([{ maxCapacity: null }]),
    }),
  ),
}));

import { performCheckin } from "@/lib/checkin";

function instance(locationId: string | null, locationName: string | null) {
  return {
    id: "ci-1", classId: "c-1", isCancelled: false,
    date: new Date("2026-09-25T00:00:00.000Z"), startTime: "10:00", endTime: "11:00",
    class: {
      id: "c-1", tenantId: "t-1", maxCapacity: null, requiredRankId: null, maxRankId: null, requiredRank: null, maxRank: null,
      locationId, locationRef: locationId ? { id: locationId, name: locationName } : null,
      tenant: { checkinWindowBeforeMin: 30, checkinWindowAfterMin: 30, timezone: "Europe/London" },
    },
  };
}
function member(tierLocationId: string | null, tierLocationName: string | null) {
  return {
    paymentStatus: "paid", stripeSubscriptionId: "sub_1", waiverAccepted: true, holdUntil: null,
    membershipTierId: "tier-1", nextDueAt: null,
    membershipTier: { locationId: tierLocationId, locationRef: tierLocationId ? { id: tierLocationId, name: tierLocationName } : null },
  };
}
const SELF = {
  tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", method: "self" as const,
  enforceRankGate: false, enforceRosterGate: false, enforceTimeWindow: false,
  requireCoverage: true, enforceCapacity: false, enforceWaiverGate: true, enforceHoldGate: true, enforceVenueGate: true,
  checkedInByUserId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  recordCreateMock.mockResolvedValue({ id: "ar-1", tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", checkInMethod: "self" });
});

describe("venue eligibility", () => {
  it("a Northside tier at a Southside class is refused, naming both venues, writing nothing", async () => {
    instanceFindFirstMock.mockResolvedValue(instance("loc-south", "Southside"));
    memberFindUniqueMock.mockResolvedValue(member("loc-north", "Northside"));
    const r = await performCheckin(SELF);
    expect(r).toEqual({ kind: "venue_not_covered", classVenue: "Southside", tierVenue: "Northside" });
    expect(recordCreateMock).not.toHaveBeenCalled();
  });

  it("the same tier at a Northside class is admitted", async () => {
    instanceFindFirstMock.mockResolvedValue(instance("loc-north", "Northside"));
    memberFindUniqueMock.mockResolvedValue(member("loc-north", "Northside"));
    expect((await performCheckin(SELF)).kind).toBe("success");
  });

  it("a class with no venue is open to a venue-bound tier; a tier with no venue is open to any class", async () => {
    instanceFindFirstMock.mockResolvedValue(instance(null, null));
    memberFindUniqueMock.mockResolvedValue(member("loc-north", "Northside"));
    expect((await performCheckin(SELF)).kind).toBe("success");
    instanceFindFirstMock.mockResolvedValue(instance("loc-south", "Southside"));
    memberFindUniqueMock.mockResolvedValue(member(null, null));
    expect((await performCheckin(SELF)).kind).toBe("success");
  });

  it("a staff mark does not ask, and a caller that does not opt in is unchanged", async () => {
    instanceFindFirstMock.mockResolvedValue(instance("loc-south", "Southside"));
    memberFindUniqueMock.mockResolvedValue(member("loc-north", "Northside"));
    expect((await performCheckin({ ...SELF, method: "admin", requireCoverage: false, enforceWaiverGate: false, enforceHoldGate: false, enforceVenueGate: false })).kind).toBe("success");
    expect((await performCheckin({ ...SELF, enforceVenueGate: undefined })).kind).toBe("success");
  });
});
