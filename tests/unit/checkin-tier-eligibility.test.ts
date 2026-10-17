/**
 * T6a: class eligibility by membership tier, inside the single check-in engine.
 *
 * Owner decisions (17 Oct 2026):
 *  - no tiers on the class = open, exactly as before (acceptance 1);
 *  - tiers on the class admit members on those tiers; a member with no tier
 *    is not covered (acceptance 2, 6);
 *  - the member app and kiosk refuse ("refuse"); the desk register and card
 *    scanner ask ("ask") and admit only once staff confirm, reporting the
 *    override so the route can record it (acceptance 3, 4);
 *  - a class with a roster is governed by its roster, not its tiers;
 *  - a deactivated tier still attached still admits (acceptance 11).
 * The gate runs after the Class row lock, before any write or pack credit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  recordCreate: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  instanceFindFirst: vi.fn(),
  tierFindMany: vi.fn(),
  rosterCount: vi.fn(),
  packFindFirst: vi.fn(),
  packUpdateMany: vi.fn(),
  queryRaw: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      member: { findUnique: h.memberFindUnique, findFirst: h.memberFindFirst },
      memberRank: { findFirst: vi.fn().mockResolvedValue(null) },
      classRoster: { count: h.rosterCount, findUnique: vi.fn().mockResolvedValue({ id: "r-1" }) },
      classMembershipTier: { findMany: h.tierFindMany },
      classInstance: { findFirst: h.instanceFindFirst },
      attendanceRecord: { create: h.recordCreate, count: vi.fn().mockResolvedValue(0) },
      memberClassPack: { findFirst: h.packFindFirst, updateMany: h.packUpdateMany, findUnique: vi.fn().mockResolvedValue({ creditsRemaining: 4 }) },
      classPackRedemption: { create: vi.fn() },
      $queryRaw: h.queryRaw,
    }),
  ),
}));

import { performCheckin, type PerformCheckinArgs } from "@/lib/checkin";
import { checkinRefusal } from "@/lib/checkin-refusal";

const INSTANCE = {
  id: "ci-1", classId: "c-adv", isCancelled: false,
  date: new Date("2026-10-17T00:00:00.000Z"), startTime: "19:00", endTime: "20:00",
  class: {
    id: "c-adv", name: "Advanced", tenantId: "t-1", maxCapacity: null, isKids: false,
    requiredRankId: null, maxRankId: null, requiredRank: null, maxRank: null,
    locationId: null, locationRef: null,
    tenant: { checkinWindowBeforeMin: 30, checkinWindowAfterMin: 30, timezone: "Europe/London" },
  },
};

function memberRow(tierId: string | null) {
  return {
    paymentStatus: "paid", stripeSubscriptionId: "sub_1", waiverAccepted: true, holdUntil: null,
    membershipTierId: tierId, nextDueAt: null, accountType: "adult", billedBy: null,
    membershipTier: tierId ? { locationId: null, locationRef: null } : null,
  };
}
const TIER_NAMES: Record<string, string> = { "t-beg": "Beginners Unlimited", "t-adv": "Advanced Unlimited", "t-old": "Legacy Unlimited" };
function setMember(tierId: string | null) {
  h.memberFindUnique.mockResolvedValue(memberRow(tierId));
  h.memberFindFirst.mockResolvedValue({ membershipTierId: tierId, membershipTier: tierId ? { name: TIER_NAMES[tierId] } : null });
}

const SELF: PerformCheckinArgs = {
  tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", method: "self",
  enforceRankGate: true, enforceRosterGate: true, enforceTimeWindow: false,
  requireCoverage: true, enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true,
  enforceKidsGate: true, enforceVenueGate: true, tierGate: "refuse", checkedInByUserId: null,
};
const KIOSK: PerformCheckinArgs = { ...SELF, method: "kiosk", requireCoverage: false };
const DESK: PerformCheckinArgs = {
  ...SELF, method: "admin", enforceRankGate: false, enforceRosterGate: false, requireCoverage: false,
  enforceCapacity: false, enforceWaiverGate: false, enforceHoldGate: false, enforceKidsGate: false,
  enforceVenueGate: false, tierGate: "ask", checkedInByUserId: "u-1",
};
const CARD: PerformCheckinArgs = { ...DESK, method: "qr" };

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.instanceFindFirst.mockResolvedValue(INSTANCE);
  h.rosterCount.mockResolvedValue(0);
  h.tierFindMany.mockImplementation(async () => { h.order.push("tiers"); return [{ tierId: "t-adv" }]; });
  h.queryRaw.mockImplementation(async () => { h.order.push("lock"); return [{ maxCapacity: null }]; });
  h.recordCreate.mockImplementation(async ({ data }: { data: { checkInMethod: string } }) => ({
    id: "ar-1", tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", checkInMethod: data.checkInMethod,
  }));
  h.packFindFirst.mockResolvedValue({ id: "pack-1" });
  h.packUpdateMany.mockResolvedValue({ count: 1 });
  setMember("t-beg");
});

describe("tier gate — refusing doors (member app, parent, kiosk)", () => {
  it("acceptance 2: a Beginners member at an Advanced-only class is refused with the class and plan, and nothing is written", async () => {
    const r = await performCheckin(SELF);
    expect(r).toEqual({ kind: "tier_not_included", className: "Advanced", tierName: "Beginners Unlimited", askable: false });
    expect(h.recordCreate).not.toHaveBeenCalled();
    const refusal = checkinRefusal(r)!;
    expect(refusal.status).toBe(403);
    expect(refusal.body.reason).toBe("tier_not_included");
    expect(refusal.body.error).toContain("Advanced");
    expect(refusal.body.error).toContain("Beginners Unlimited");
    expect(refusal.body.askable).toBeUndefined();
  });

  it("the kiosk gives the same refusal", async () => {
    const r = await performCheckin(KIOSK);
    expect(r.kind).toBe("tier_not_included");
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("a member on an included tier is admitted", async () => {
    setMember("t-adv");
    expect((await performCheckin(SELF)).kind).toBe("success");
    expect((await performCheckin(KIOSK)).kind).toBe("success");
  });

  it("acceptance 6 (owner option: refuse): a member with no tier is not covered", async () => {
    setMember(null);
    const r = await performCheckin(KIOSK);
    expect(r).toMatchObject({ kind: "tier_not_included", tierName: null });
    expect(checkinRefusal(r)!.body.error).toMatch(/don't have a membership plan set/);
  });

  it("refuses before a pack credit is spent", async () => {
    // Not subscribed: the self path would redeem a pack.
    h.memberFindUnique.mockResolvedValue({ ...memberRow("t-beg"), stripeSubscriptionId: null, paymentStatus: "overdue" });
    const r = await performCheckin(SELF);
    expect(r.kind).toBe("tier_not_included");
    expect(h.packUpdateMany).not.toHaveBeenCalled();
  });

  it("is read after the Class row lock (the write-phase re-check)", async () => {
    await performCheckin(SELF);
    expect(h.order.indexOf("lock")).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf("lock")).toBeLessThan(h.order.indexOf("tiers"));
  });
});

describe("tier gate — asking doors (register, card scanner)", () => {
  it("acceptance 3: the desk is asked (askable refusal) until staff confirm", async () => {
    const r = await performCheckin(DESK);
    expect(r).toEqual({ kind: "tier_not_included", className: "Advanced", tierName: "Beginners Unlimited", askable: true });
    expect(checkinRefusal(r)!.body.askable).toBe(true);
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("acceptance 3: on confirm the member is admitted and the override is reported", async () => {
    const r = await performCheckin({ ...DESK, tierOverrideConfirmed: true });
    expect(r.kind).toBe("success");
    if (r.kind === "success") expect(r.overrides).toEqual(["tier_not_included"]);
  });

  it("acceptance 4: the card scanner asks the same way and records the override on confirm", async () => {
    expect((await performCheckin(CARD)).kind).toBe("tier_not_included");
    const r = await performCheckin({ ...CARD, tierOverrideConfirmed: true });
    expect(r.kind).toBe("success");
    if (r.kind === "success") {
      expect(r.overrides).toEqual(["tier_not_included"]);
      expect(r.record.checkInMethod).toBe("qr");
    }
  });

  it("a confirmation on an included member records no override", async () => {
    setMember("t-adv");
    const r = await performCheckin({ ...DESK, tierOverrideConfirmed: true });
    expect(r.kind).toBe("success");
    if (r.kind === "success") expect(r.overrides).toBeUndefined();
  });

  it("a refusing door ignores a confirmation flag", async () => {
    expect((await performCheckin({ ...SELF, tierOverrideConfirmed: true })).kind).toBe("tier_not_included");
  });
});

describe("tier gate — composition and compatibility", () => {
  it("acceptance 1: a class with no tiers behaves exactly as before at every door", async () => {
    h.tierFindMany.mockResolvedValue([]);
    setMember(null);
    for (const args of [SELF, KIOSK, DESK, CARD]) {
      const r = await performCheckin(args);
      expect(r.kind).toBe("success");
      if (r.kind === "success") expect(r.overrides).toBeUndefined();
    }
  });

  it("a caller that does not opt in is unchanged (gate off)", async () => {
    const r = await performCheckin({ ...SELF, tierGate: undefined });
    expect(r.kind).toBe("success");
    expect(h.tierFindMany).not.toHaveBeenCalled();
  });

  it("a rostered class is governed by its roster: a rostered member on another tier is admitted", async () => {
    h.rosterCount.mockResolvedValue(3);
    const r = await performCheckin(SELF);
    expect(r.kind).toBe("success");
  });

  it("acceptance 11: a deactivated tier still attached still admits its members", async () => {
    h.tierFindMany.mockResolvedValue([{ tierId: "t-old" }]);
    setMember("t-old");
    expect((await performCheckin(SELF)).kind).toBe("success");
  });

  it("earlier gates still win: an unsigned waiver is refused as a waiver, not a tier", async () => {
    h.memberFindUnique.mockResolvedValue({ ...memberRow("t-beg"), waiverAccepted: false });
    expect((await performCheckin(SELF)).kind).toBe("waiver_unsigned");
  });
});
