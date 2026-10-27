/**
 * G4 (owner, 27 Oct 2026): a coach's one-off in the check-in engine.
 *
 * "If they want to do another class, they'd have to discuss with a coach, for
 * example, and maybe that coach will include them on a one-off session."
 *
 * The binding rules (plan "Check-in rules, end to end", rule 6):
 *  - admits past the squad list, the plan restriction and the class allowance
 *    for that session only, and nothing else;
 *  - is not counted and spends no class-pack credit;
 *  - does not bypass the hold, waiver and kids-class questions;
 *  - is a staff register action only (method "admin").
 * The real-database proof (the row, RLS, the cascade, the count) is in
 * tests/integration/class-one-off-db.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  recordCreate: vi.fn(),
  recordFindFirst: vi.fn(),
  oneOffCreate: vi.fn(),
  memberFindUnique: vi.fn(),
  instanceFindFirst: vi.fn(),
  packFindFirst: vi.fn(),
  packUpdateMany: vi.fn(),
  redemptionCreate: vi.fn(),
  rosterCount: vi.fn(),
  rosterFindUnique: vi.fn(),
  tierFindMany: vi.fn(),
  memberFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  order: [] as string[],
  capacity: null as number | null,
  cancelled: false,
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      member: { findUnique: h.memberFindUnique, findFirst: h.memberFindFirst },
      memberRank: { findFirst: vi.fn().mockResolvedValue(null) },
      classRoster: { count: h.rosterCount, findUnique: h.rosterFindUnique },
      classMembershipTier: { findMany: h.tierFindMany },
      classInstance: { findFirst: h.instanceFindFirst },
      attendanceRecord: { create: h.recordCreate, findFirst: h.recordFindFirst, count: vi.fn().mockResolvedValue(3) },
      classOneOff: { create: h.oneOffCreate },
      memberClassPack: { findFirst: h.packFindFirst, updateMany: h.packUpdateMany, findUnique: vi.fn().mockResolvedValue({ creditsRemaining: 4 }) },
      classPackRedemption: { create: h.redemptionCreate },
      $queryRaw: h.queryRaw,
    }),
  ),
}));

import { performCheckin, type PerformCheckinArgs } from "@/lib/checkin";

const INSTANCE = {
  id: "ci-1", classId: "c-1", isCancelled: false, sourceImportJobId: null,
  date: new Date("2026-10-19T00:00:00.000Z"), startTime: "18:00", endTime: "19:00",
  class: {
    id: "c-1", name: "Competition", tenantId: "t-1", maxCapacity: null, isKids: false, isActive: true, deletedAt: null,
    sourceImportJobId: null,
    requiredRankId: null, maxRankId: null, requiredRank: null, maxRank: null, locationId: null, locationRef: null,
    tenant: { checkinWindowBeforeMin: 30, checkinWindowAfterMin: 30, timezone: "Europe/London" },
  },
};

/** The register's staff mark (app/api/checkin/route.ts, method "admin"). */
const DESK: PerformCheckinArgs = {
  tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", method: "admin",
  enforceRankGate: false, enforceTimeWindow: false, requireCoverage: false, enforceCapacity: false,
  enforceWaiverGate: false, enforceHoldGate: false, enforceKidsGate: false, enforceVenueGate: false,
  enforceClassStateGate: false, allowanceGate: "refuse", checkedInByUserId: "u-coach",
};
const ONE_OFF: PerformCheckinArgs = { ...DESK, oneOff: { reason: "Trial for the comp squad", grantedById: "u-coach" } };

function sqlOf(strings: unknown): string {
  return Array.isArray(strings) ? (strings as string[]).join("?") : String(strings);
}

/** 4 classes every 4 weeks, all four used in the session's period: an ordinary mark is refused. */
const AT_LIMIT_ROW = {
  classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-09-28", maxClassesPerWeek: null,
  billingCycle: "monthly", stripeSubscriptionId: "sub_1", nextDueAt: null, billingPeriodStart: null, billingPeriodEnd: null,
  alreadyIn: false,
};
const DAY = (iso: string) => new Date(`${iso}T00:00:00.000Z`).getTime();
const FOUR_VISITS = ["2026-10-05", "2026-10-07", "2026-10-12", "2026-10-14"].map((d) => ({ d: DAY(d), s: "18:00" }));

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.capacity = null;
  h.cancelled = false;
  h.instanceFindFirst.mockResolvedValue(INSTANCE);
  h.memberFindUnique.mockResolvedValue({
    paymentStatus: "paid", stripeSubscriptionId: "sub_1", waiverAccepted: true, holdUntil: null, membershipTierId: "tier-1",
    nextDueAt: null, accountType: "adult", billedBy: null, membershipTier: { locationId: null, locationRef: null },
  });
  // A squad class the member is NOT on, whose memberships do not include their plan.
  h.rosterCount.mockResolvedValue(5);
  h.rosterFindUnique.mockResolvedValue(null);
  h.tierFindMany.mockResolvedValue([{ tierId: "tier-comp" }]);
  h.memberFindFirst.mockResolvedValue({ membershipTierId: "tier-1", membershipTier: { name: "Monthly" } });
  h.recordFindFirst.mockResolvedValue(null);
  h.queryRaw.mockImplementation(async (strings: unknown) => {
    const text = sqlOf(strings);
    if (text.includes('FROM "Class"')) {
      h.order.push("class-lock");
      return [{ maxCapacity: h.capacity, instanceCancelled: h.cancelled }];
    }
    if (text.includes('FROM "Member" WHERE') && text.includes("UPDATE")) {
      h.order.push("member-lock");
      return [{ id: "m-1", cardVersion: 0, membershipTierId: "tier-1", paymentStatus: "paid", stripeSubscriptionId: "sub_1", nextDueAtMs: null, holdUntilMs: null, waiverAccepted: true, accountType: "adult" }];
    }
    if (text.includes("json_agg")) { h.order.push("allowance-visits"); return [{ visits: FOUR_VISITS }]; }
    if (text.includes('"AttendanceRecord"')) { h.order.push("allowance-read"); return [AT_LIMIT_ROW]; }
    h.order.push("other");
    return [];
  });
  h.recordCreate.mockImplementation(async ({ data }: { data: { checkInMethod: string } }) => {
    h.order.push("insert");
    return { id: "ar-1", tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", checkInMethod: data.checkInMethod };
  });
  h.oneOffCreate.mockImplementation(async ({ data }: { data: { reason: string } }) => {
    h.order.push("one-off");
    return { id: "oo-1", reason: data.reason };
  });
  // A usable class pack: an ordinary mark past the allowance would spend it.
  h.packFindFirst.mockResolvedValue({ id: "pack-1" });
  h.packUpdateMany.mockResolvedValue({ count: 1 });
});

describe("a coach's one-off skips exactly the squad list, the plan restriction and the allowance", () => {
  it("the same member is refused by an ordinary register mark (the squad list first)", async () => {
    const r = await performCheckin(DESK);
    expect(r.kind).toBe("roster_not_listed");
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("a one-off admits them: attendance row and ClassOneOff row in the same transaction, Class then Member lock first", async () => {
    const r = await performCheckin(ONE_OFF);
    expect(r).toMatchObject({ kind: "success", record: { id: "ar-1" }, oneOff: { id: "oo-1", reason: "Trial for the comp squad" } });
    expect(h.order).toEqual(["class-lock", "member-lock", "insert", "one-off"]);
    expect(h.oneOffCreate).toHaveBeenCalledWith({
      data: {
        tenantId: "t-1", classInstanceId: "ci-1", memberId: "m-1", attendanceRecordId: "ar-1",
        grantedById: "u-coach", reason: "Trial for the comp squad",
      },
      select: { id: true, reason: true },
    });
    // Neither eligibility list is read, and the allowance is never judged.
    expect(h.rosterCount).not.toHaveBeenCalled();
    expect(h.tierFindMany).not.toHaveBeenCalled();
    expect(h.order).not.toContain("allowance-read");
    expect(h.order).not.toContain("allowance-visits");
  });

  it("spends no class-pack credit, even with a usable pack and the allowance used up", async () => {
    h.rosterCount.mockResolvedValue(0);
    h.tierFindMany.mockResolvedValue([]);
    // Without the one-off this member is refused for the allowance (and the pack would pay).
    const ordinary = await performCheckin(DESK);
    expect(ordinary).toMatchObject({ kind: "success", coverage: { kind: "pack" } });
    vi.clearAllMocks();
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    const r = await performCheckin(ONE_OFF);
    expect(r).toMatchObject({ kind: "success", oneOff: { id: "oo-1" } });
    expect(r.kind === "success" && r.coverage.kind).not.toBe("pack");
    expect(h.packFindFirst).not.toHaveBeenCalled();
    expect(h.packUpdateMany).not.toHaveBeenCalled();
    expect(h.redemptionCreate).not.toHaveBeenCalled();
  });

  it("a member already in the session answers duplicate and writes nothing", async () => {
    h.recordFindFirst.mockResolvedValue({ id: "ar-0" });
    const r = await performCheckin(ONE_OFF);
    expect(r).toEqual({ kind: "duplicate" });
    expect(h.recordCreate).not.toHaveBeenCalled();
    expect(h.oneOffCreate).not.toHaveBeenCalled();
    expect(h.recordFindFirst).toHaveBeenCalledWith({ where: { tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1" }, select: { id: true } });
  });
});

describe("a coach's one-off keeps every other gate", () => {
  it("a membership on hold is still asked about (the route sets the hold gate when unconfirmed)", async () => {
    h.memberFindUnique.mockResolvedValue({
      paymentStatus: "paused", stripeSubscriptionId: null, waiverAccepted: true, holdUntil: null, membershipTierId: "tier-1",
      nextDueAt: null, accountType: "adult", billedBy: null, membershipTier: { locationId: null, locationRef: null },
    });
    const r = await performCheckin({ ...ONE_OFF, enforceHoldGate: true });
    expect(r.kind).toBe("on_hold");
    expect(h.recordCreate).not.toHaveBeenCalled();
    expect(h.oneOffCreate).not.toHaveBeenCalled();
  });

  it("an unsigned waiver is still asked about", async () => {
    h.memberFindUnique.mockResolvedValue({
      paymentStatus: "paid", stripeSubscriptionId: "sub_1", waiverAccepted: false, holdUntil: null, membershipTierId: "tier-1",
      nextDueAt: null, accountType: "adult", billedBy: null, membershipTier: { locationId: null, locationRef: null },
    });
    const r = await performCheckin({ ...ONE_OFF, enforceWaiverGate: true });
    expect(r.kind).toBe("waiver_unsigned");
    expect(h.oneOffCreate).not.toHaveBeenCalled();
  });

  it("an adult in a kids class is still asked about", async () => {
    h.instanceFindFirst.mockResolvedValue({ ...INSTANCE, class: { ...INSTANCE.class, isKids: true } });
    const r = await performCheckin({ ...ONE_OFF, enforceKidsGate: true });
    expect(r.kind).toBe("kids_class");
    expect(h.oneOffCreate).not.toHaveBeenCalled();
  });

  it("a cancelled session is refused", async () => {
    h.cancelled = true;
    const r = await performCheckin(ONE_OFF);
    expect(r.kind).toBe("class_cancelled");
    expect(h.oneOffCreate).not.toHaveBeenCalled();
  });

  it("a full class is admitted as the register admits, and says so", async () => {
    h.capacity = 3; // attendanceRecord.count answers 3 taken
    const r = await performCheckin(ONE_OFF);
    expect(r).toMatchObject({ kind: "success", overCapacity: { taken: 3, maxCapacity: 3 }, oneOff: { id: "oo-1" } });
  });

  it("the member must be in this club (the Member lock finds no row: nothing written)", async () => {
    h.queryRaw.mockImplementation(async (strings: unknown) => {
      const text = sqlOf(strings);
      if (text.includes('FROM "Class"')) return [{ maxCapacity: null, instanceCancelled: false }];
      return [];
    });
    const r = await performCheckin(ONE_OFF);
    expect(r.kind).toBe("member_not_found");
    expect(h.recordCreate).not.toHaveBeenCalled();
  });
});

describe("a one-off is a staff register action with a reason", () => {
  it.each(["self", "kiosk", "qr", "auto"] as const)("method %s with a one-off answers error and writes nothing", async (method) => {
    const r = await performCheckin({ ...ONE_OFF, method });
    expect(r.kind).toBe("error");
    expect(h.instanceFindFirst).not.toHaveBeenCalled();
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it.each(["", "  ", "ab", "x".repeat(201)])("a reason of %j answers error", async (reason) => {
    const r = await performCheckin({ ...ONE_OFF, oneOff: { reason, grantedById: "u-coach" } });
    expect(r.kind).toBe("error");
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("the reason is stored trimmed", async () => {
    await performCheckin({ ...ONE_OFF, oneOff: { reason: "  Guest of Sean  ", grantedById: "u-coach" } });
    expect(h.oneOffCreate.mock.calls[0][0].data.reason).toBe("Guest of Sean");
  });
});
