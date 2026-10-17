// T6b acceptance 1: a paused class's sessions are not admissible at self or
// kiosk check-in, even by instance id (the class is hidden from both, but a
// session minted before the pause still exists). Staff doors are unchanged:
// the desk and card scanner still admit (T4c owns their per-door modes).

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  cls: { isActive: false as boolean, deletedAt: null as Date | null },
  recordCreate: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      member: {
        findUnique: vi.fn(async () => ({
          accountType: "adult", paymentStatus: "paid", stripeSubscriptionId: null, waiverAccepted: true, holdUntil: null,
          membershipTierId: null, nextDueAt: null, membershipTier: null, status: "active",
        })),
        findFirst: vi.fn(async () => null),
      },
      memberRank: { findFirst: vi.fn().mockResolvedValue(null) },
      classRoster: { count: vi.fn().mockResolvedValue(0), findUnique: vi.fn().mockResolvedValue(null) },
      classMembershipTier: { findMany: vi.fn().mockResolvedValue([]) },
      classInstance: {
        findFirst: vi.fn(async () => ({
          id: "ci-1", classId: "c-1", isCancelled: false, sourceImportJobId: null,
          date: new Date("2026-10-17T00:00:00.000Z"), startTime: "18:00", endTime: "19:00",
          class: {
            id: "c-1", tenantId: "t-1", name: "Fundamentals", isKids: false, maxCapacity: null, locationId: null,
            isActive: h.cls.isActive, deletedAt: h.cls.deletedAt, sourceImportJobId: null,
            requiredRankId: null, maxRankId: null, requiredRank: null, maxRank: null, locationRef: null,
            tenant: { checkinWindowBeforeMin: 30, checkinWindowAfterMin: 30, timezone: "Europe/London" },
          },
        })),
      },
      attendanceRecord: { create: h.recordCreate, count: vi.fn().mockResolvedValue(0) },
      memberClassPack: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn(), findUnique: vi.fn() },
      classPackRedemption: { create: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([{ maxCapacity: null }]),
    }),
  ),
}));

import { performCheckin } from "@/lib/checkin";

const SELF = {
  tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", method: "self" as const,
  enforceRankGate: true, enforceRosterGate: true, enforceTimeWindow: false,
  requireCoverage: false, enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true,
  enforceVenueGate: true, enforceKidsGate: true, enforceClassStateGate: true, checkedInByUserId: null,
};
const KIOSK = { ...SELF, method: "kiosk" as const };
const ADMIN = {
  ...SELF, method: "admin" as const, enforceRankGate: false, enforceRosterGate: false,
  enforceCapacity: false, enforceWaiverGate: false, enforceHoldGate: false, enforceVenueGate: false,
  enforceKidsGate: false, enforceClassStateGate: false, checkedInByUserId: "u-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.cls.isActive = false;
  h.cls.deletedAt = null;
  h.recordCreate.mockResolvedValue({ id: "ar-1", tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", checkInMethod: "self" });
});

describe("T6b — paused / archived class at the member-decided doors", () => {
  it("self check-in to a PAUSED class's session is refused class_paused, and nothing is written", async () => {
    const r = await performCheckin(SELF);
    expect(r).toEqual({ kind: "class_paused", className: "Fundamentals", state: "paused" });
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("kiosk check-in by instance id to a PAUSED class is refused too", async () => {
    const r = await performCheckin(KIOSK);
    expect(r.kind).toBe("class_paused");
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("an ARCHIVED class is refused with state archived", async () => {
    h.cls.deletedAt = new Date("2026-10-01T00:00:00Z");
    const r = await performCheckin(SELF);
    expect(r).toEqual({ kind: "class_paused", className: "Fundamentals", state: "archived" });
  });

  it("a live class is not touched by the gate", async () => {
    h.cls.isActive = true;
    const r = await performCheckin(SELF);
    expect(r.kind).not.toBe("class_paused");
  });

  it("the desk (gate off) still admits into a paused class, as before T6b", async () => {
    const r = await performCheckin(ADMIN);
    expect(r.kind).not.toBe("class_paused");
  });
});
