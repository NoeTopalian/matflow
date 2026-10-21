/**
 * Class eligibility inside the single check-in engine: the membership list
 * (T6a) and the squad list / roster (T6d).
 *
 * Owner decisions (20 Oct 2026, superseding the 17 Oct ask and "roster
 * decides"):
 *  - no tiers and no roster on the class = open to everyone, as before;
 *  - tiers on the class admit only members on those tiers; a member with no
 *    tier is not covered;
 *  - a roster admits only members on it;
 *  - both set = both must hold;
 *  - NO door overrides either: self, parent, kiosk, the desk register (admin,
 *    auto) and the card scanner (qr) all refuse, and there is no flag to
 *    switch the check off;
 *  - a deactivated tier still attached still admits (acceptance 11).
 * Both gates run after the Class row lock, before any write or pack credit.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  recordCreate: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  instanceFindFirst: vi.fn(),
  tierFindMany: vi.fn(),
  rosterCount: vi.fn(),
  rosterFindUnique: vi.fn(),
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
      classRoster: { count: h.rosterCount, findUnique: h.rosterFindUnique },
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
/** A squad class: `onIt` says whether this member is on the roster. */
function setRoster(onIt: boolean) {
  h.rosterCount.mockImplementation(async () => { h.order.push("roster"); return 3; });
  h.rosterFindUnique.mockResolvedValue(onIt ? { id: "r-1" } : null);
}

const SELF: PerformCheckinArgs = {
  tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", method: "self",
  enforceRankGate: true, enforceTimeWindow: false,
  requireCoverage: true, enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true,
  enforceKidsGate: true, enforceVenueGate: true, checkedInByUserId: null,
};
const KIOSK: PerformCheckinArgs = { ...SELF, method: "kiosk", requireCoverage: false };
const DESK: PerformCheckinArgs = {
  ...SELF, method: "admin", enforceRankGate: false, requireCoverage: false,
  enforceCapacity: false, enforceWaiverGate: false, enforceHoldGate: false, enforceKidsGate: false,
  enforceVenueGate: false, checkedInByUserId: "u-1",
};
const AUTO: PerformCheckinArgs = { ...DESK, method: "auto" };
const CARD: PerformCheckinArgs = { ...DESK, method: "qr" };
const EVERY_DOOR = { SELF, KIOSK, DESK, AUTO, CARD };

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.instanceFindFirst.mockResolvedValue(INSTANCE);
  h.rosterCount.mockImplementation(async () => { h.order.push("roster"); return 0; });
  h.rosterFindUnique.mockResolvedValue(null);
  h.tierFindMany.mockImplementation(async () => { h.order.push("tiers"); return [{ tierId: "t-adv" }]; });
  h.queryRaw.mockImplementation(async () => { h.order.push("lock"); return [{ maxCapacity: null }]; });
  h.recordCreate.mockImplementation(async ({ data }: { data: { checkInMethod: string } }) => ({
    id: "ar-1", tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", checkInMethod: data.checkInMethod,
  }));
  h.packFindFirst.mockResolvedValue({ id: "pack-1" });
  h.packUpdateMany.mockResolvedValue({ count: 1 });
  setMember("t-beg");
});

describe("tier gate — every door refuses", () => {
  it("acceptance 2: a Beginners member at an Advanced-only class is refused with the class and plan, and nothing is written", async () => {
    const r = await performCheckin(SELF);
    expect(r).toEqual({ kind: "tier_not_included", className: "Advanced", tierName: "Beginners Unlimited" });
    expect(h.recordCreate).not.toHaveBeenCalled();
    const refusal = checkinRefusal(r)!;
    expect(refusal.status).toBe(403);
    expect(refusal.body).toEqual({
      error: "Advanced isn't included in your Beginners Unlimited membership. Ask staff about a membership that includes it.",
      reason: "tier_not_included",
    });
  });

  it.each(Object.entries(EVERY_DOOR))("%s refuses with the same answer and writes nothing", async (_door, args) => {
    const r = await performCheckin(args);
    expect(r).toEqual({ kind: "tier_not_included", className: "Advanced", tierName: "Beginners Unlimited" });
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("a member on an included tier is admitted at every door", async () => {
    setMember("t-adv");
    for (const args of Object.values(EVERY_DOOR)) {
      expect((await performCheckin(args)).kind).toBe("success");
    }
  });

  it("acceptance 6 (owner option: refuse): a member with no tier is not covered", async () => {
    setMember(null);
    const r = await performCheckin(DESK);
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
    await performCheckin(DESK);
    expect(h.order.indexOf("lock")).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf("lock")).toBeLessThan(h.order.indexOf("tiers"));
  });
});

describe("no staff override", () => {
  // An old register tab or scanner may still send the confirmation. The
  // engine has no such argument any more: whatever arrives is ignored.
  const withStaleConfirmation = (args: PerformCheckinArgs) =>
    ({ ...args, tierOverrideConfirmed: true, tierGate: "ask", enforceRosterGate: false } as unknown as PerformCheckinArgs);

  it.each(Object.entries(EVERY_DOOR))("%s: a tier confirmation flag is ignored and no override is reported", async (_door, args) => {
    const r = await performCheckin(withStaleConfirmation(args));
    expect(r.kind).toBe("tier_not_included");
    expect(r).not.toHaveProperty("overrides");
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("a successful mark never carries an overrides field", async () => {
    setMember("t-adv");
    const r = await performCheckin(withStaleConfirmation(DESK));
    expect(r.kind).toBe("success");
    expect(r).not.toHaveProperty("overrides");
  });

  it.each(Object.entries(EVERY_DOOR))("%s: enforceRosterGate: false no longer skips the roster", async (_door, args) => {
    setRoster(false);
    setMember("t-adv");
    expect((await performCheckin(withStaleConfirmation(args))).kind).toBe("roster_not_listed");
  });
});

describe("roster gate — under the Class lock, at every door", () => {
  it.each(Object.entries(EVERY_DOOR))("%s refuses a member who is not on the roster, after the lock, writing nothing", async (_door, args) => {
    setRoster(false);
    setMember("t-adv");
    const r = await performCheckin(args);
    expect(r).toEqual({ kind: "roster_not_listed" });
    expect(h.recordCreate).not.toHaveBeenCalled();
    expect(h.order.indexOf("lock")).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf("lock")).toBeLessThan(h.order.indexOf("roster"));
    expect(checkinRefusal(r)!.body).toEqual({ error: "You're not on the roster for this class.", reason: "roster_not_listed" });
  });

  it("reads the roster with the tenant filter (convention: RLS is the backstop, not the defence)", async () => {
    setRoster(true);
    setMember("t-adv");
    await performCheckin(DESK);
    expect(h.rosterCount).toHaveBeenCalledWith({ where: { tenantId: "t-1", classId: "c-adv" } });
    expect(h.rosterFindUnique).toHaveBeenCalledWith({
      where: { classId_memberId: { classId: "c-adv", memberId: "m-1" }, tenantId: "t-1" },
      select: { id: true },
    });
  });

  it("refuses before a pack credit is spent", async () => {
    setRoster(false);
    h.memberFindUnique.mockResolvedValue({ ...memberRow("t-adv"), stripeSubscriptionId: null, paymentStatus: "overdue" });
    expect((await performCheckin(SELF)).kind).toBe("roster_not_listed");
    expect(h.packUpdateMany).not.toHaveBeenCalled();
  });
});

describe("both gates combine", () => {
  it.each(Object.entries(EVERY_DOOR))("%s: a rostered member on a tier the class excludes is refused on the tier", async (_door, args) => {
    setRoster(true);
    setMember("t-beg");
    expect(await performCheckin(args)).toEqual({ kind: "tier_not_included", className: "Advanced", tierName: "Beginners Unlimited" });
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("a member on an included tier but not on the roster is refused on the roster", async () => {
    setRoster(false);
    setMember("t-adv");
    expect((await performCheckin(KIOSK)).kind).toBe("roster_not_listed");
  });

  it("a member failing both reads the roster sentence", async () => {
    setRoster(false);
    setMember("t-beg");
    expect((await performCheckin(SELF)).kind).toBe("roster_not_listed");
  });

  it("a rostered member on an included tier is admitted at every door", async () => {
    setRoster(true);
    setMember("t-adv");
    for (const args of Object.values(EVERY_DOOR)) {
      expect((await performCheckin(args)).kind).toBe("success");
    }
  });

  it("a rostered class with no tiers ticked admits any rostered member, with or without a plan", async () => {
    setRoster(true);
    h.tierFindMany.mockResolvedValue([]);
    setMember(null);
    expect((await performCheckin(DESK)).kind).toBe("success");
  });
});

describe("composition and compatibility", () => {
  it("acceptance 1: a class with neither restriction admits everyone at every door, as before", async () => {
    h.tierFindMany.mockResolvedValue([]);
    setMember(null);
    for (const args of Object.values(EVERY_DOOR)) {
      const r = await performCheckin(args);
      expect(r.kind).toBe("success");
      expect(r).not.toHaveProperty("overrides");
    }
    expect(h.rosterFindUnique).not.toHaveBeenCalled();
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
