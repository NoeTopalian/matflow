/**
 * T7 (Sean note 5): the class allowance inside the single check-in engine.
 *
 * Owner decisions (17 and 20 Oct 2026):
 *  - enforced as soon as a plan has a limit; blank = Unlimited;
 *  - the allowance resets on an explicit basis (each week, each calendar
 *    month, every N weeks from a start date), never a rolling window: a
 *    session is judged against the period IT falls in;
 *  - every door refuses with the count and the date it resets — the member
 *    app, the kiosk, the desk register and the card scanner alike; there is
 *    no staff override (owner decision, 27 Oct 2026), and a usable class pack
 *    pays instead of a refusal at every door;
 *  - counted rows: not imports, not cancelled sessions, not class-pack
 *    redemptions; a check-in a pack pays for is not gated;
 *  - CONCURRENCY: inside the write transaction, Class FOR UPDATE, then the
 *    Member row (FOR NO KEY UPDATE), then ONE read (statement C), then the
 *    insert. The Member lock is taken whatever the plan and the door.
 * The real-database race is in tests/integration/checkin-allowance-race-db.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type CRow = {
  classLimit: number | null;
  classLimitBasis: string | null;
  classLimitWeeks: number | null;
  classLimitAnchor: string | null;
  maxClassesPerWeek: number | null;
  billingCycle: string | null;
  stripeSubscriptionId: string | null;
  nextDueAt: Date | null;
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
  alreadyIn: boolean;
  visits: Array<{ d: number; s: string }>;
};

const h = vi.hoisted(() => ({
  recordCreate: vi.fn(),
  memberFindUnique: vi.fn(),
  instanceFindFirst: vi.fn(),
  packFindFirst: vi.fn(),
  packUpdateMany: vi.fn(),
  redemptionCreate: vi.fn(),
  queryRaw: vi.fn(),
  order: [] as string[],
  sql: [] as string[],
  memberRows: [{ id: "m-1" }] as unknown[],
  cRow: null as unknown,
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      member: { findUnique: h.memberFindUnique, findFirst: vi.fn() },
      memberRank: { findFirst: vi.fn().mockResolvedValue(null) },
      classRoster: { count: vi.fn().mockResolvedValue(0), findUnique: vi.fn() },
      classMembershipTier: { findMany: vi.fn().mockResolvedValue([]) },
      classInstance: { findFirst: h.instanceFindFirst },
      attendanceRecord: { create: h.recordCreate, count: vi.fn().mockResolvedValue(0) },
      memberClassPack: { findFirst: h.packFindFirst, updateMany: h.packUpdateMany, findUnique: vi.fn().mockResolvedValue({ creditsRemaining: 4 }) },
      classPackRedemption: { create: h.redemptionCreate },
      $queryRaw: h.queryRaw,
    }),
  ),
}));

import { performCheckin, staffAllowanceGate, returnClaimedPack, type PerformCheckinArgs } from "@/lib/checkin";
import { checkinRefusal } from "@/lib/checkin-refusal";

const DAY = (iso: string) => new Date(`${iso}T00:00:00.000Z`).getTime();
const INSTANCE = {
  id: "ci-1", classId: "c-1", isCancelled: false,
  date: new Date("2026-10-19T00:00:00.000Z"), startTime: "18:00", endTime: "19:00",
  class: {
    id: "c-1", name: "Fundamentals", tenantId: "t-1", maxCapacity: null, isKids: false, isActive: true, deletedAt: null,
    requiredRankId: null, maxRankId: null, requiredRank: null, maxRank: null, locationId: null, locationRef: null,
    tenant: { checkinWindowBeforeMin: 30, checkinWindowAfterMin: 30, timezone: "Europe/London" },
  },
};

function cRow(over: Partial<CRow> = {}): CRow {
  return {
    classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null, maxClassesPerWeek: null,
    billingCycle: "monthly", stripeSubscriptionId: null, nextDueAt: null, billingPeriodStart: null, billingPeriodEnd: null,
    alreadyIn: false, visits: [], ...over,
  };
}
/** 4 classes every 4 weeks, periods counted from Monday 28 September: the session (Mon 19 Oct) is in 28 Sep – 26 Oct. */
const FOUR_IN_FOUR = { classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-09-28" };
const PERIOD = { start: "2026-09-28", end: "2026-10-26" };
const FACTS = { used: 4, limit: 4, basis: "weeks", weeks: 4, period: PERIOD, resetsOn: "2026-10-26" };
/** Four counted visits inside that period, before Monday 19 Oct 18:00. */
const FOUR_VISITS = [
  { d: DAY("2026-10-05"), s: "18:00" },
  { d: DAY("2026-10-12"), s: "07:00" },
  { d: DAY("2026-10-12"), s: "18:00" },
  { d: DAY("2026-10-14"), s: "18:00" },
];

function memberRow(subscribed = true) {
  return {
    paymentStatus: subscribed ? "paid" : "overdue", stripeSubscriptionId: subscribed ? "sub_1" : null,
    waiverAccepted: true, holdUntil: null, membershipTierId: "tier-1", nextDueAt: null, accountType: "adult", billedBy: null,
    membershipTier: { locationId: null, locationRef: null },
  };
}

const SELF: PerformCheckinArgs = {
  tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", method: "self",
  enforceRankGate: true, enforceTimeWindow: false,
  requireCoverage: true, enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true,
  enforceKidsGate: true, enforceVenueGate: true, allowanceGate: "refuse", checkedInByUserId: null,
};
const KIOSK: PerformCheckinArgs = { ...SELF, method: "kiosk", requireCoverage: false };
const DESK: PerformCheckinArgs = {
  ...SELF, method: "admin", enforceRankGate: false, requireCoverage: false,
  enforceCapacity: false, enforceWaiverGate: false, enforceHoldGate: false, enforceKidsGate: false,
  enforceVenueGate: false, allowanceGate: "refuse", checkedInByUserId: "u-1",
};
const CARD: PerformCheckinArgs = { ...DESK, method: "qr" };

function sqlOf(strings: unknown): string {
  return Array.isArray(strings) ? (strings as string[]).join("?") : String(strings);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.sql.length = 0;
  h.memberRows = [{ id: "m-1" }];
  h.cRow = cRow({ ...FOUR_IN_FOUR, visits: FOUR_VISITS });
  h.instanceFindFirst.mockResolvedValue(INSTANCE);
  h.memberFindUnique.mockResolvedValue(memberRow());
  h.queryRaw.mockImplementation(async (strings: unknown) => {
    const text = sqlOf(strings);
    h.sql.push(text);
    if (text.includes('FROM "Class"')) { h.order.push("class-lock"); return [{ maxCapacity: null }]; }
    if (text.includes('FROM "Member" WHERE') && text.includes("UPDATE")) { h.order.push("member-lock"); return h.memberRows; }
    if (text.includes('json_agg')) { h.order.push("statement-c2"); return h.cRow ? [h.cRow] : []; }
    if (text.includes('"AttendanceRecord"')) { h.order.push("statement-c"); return h.cRow ? [h.cRow] : []; }
    h.order.push("other");
    return [];
  });
  h.recordCreate.mockImplementation(async ({ data }: { data: { checkInMethod: string } }) => {
    h.order.push("insert");
    return { id: "ar-1", tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1", checkInMethod: data.checkInMethod };
  });
  // No usable pack unless a test gives the member one.
  h.packFindFirst.mockResolvedValue(null);
  h.packUpdateMany.mockImplementation(async () => { h.order.push("pack-decrement"); return { count: 1 }; });
});

describe("refusing doors (member app, parent, kiosk)", () => {
  it("the member app refuses the fifth class of the period, names the count and the reset date, and writes nothing", async () => {
    // "this 4-week period" is the wording while today is inside it; pin today
    // there (the period ends 26 Oct 2026, so the real clock fails it after).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T12:00:00.000Z"));
    const r = await performCheckin(SELF).finally(() => vi.useRealTimers());
    expect(r).toEqual({ kind: "allowance_reached", ...FACTS, current: true });
    expect(h.recordCreate).not.toHaveBeenCalled();
    const refusal = checkinRefusal(r)!;
    expect(refusal.status).toBe(403);
    expect(refusal.body).toMatchObject({
      reason: "allowance_reached",
      error: "You've used all 4 of your classes for this 4-week period; it resets on Monday 26 October. For further information, please speak to a coach.",
    });
    expect(refusal.body).not.toHaveProperty("askable");
  });

  it("the kiosk gives the same refusal", async () => {
    const r = await performCheckin(KIOSK);
    expect(r.kind).toBe("allowance_reached");
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("admits while the period's count is within the allowance (several in one week)", async () => {
    h.cRow = cRow({ ...FOUR_IN_FOUR, visits: FOUR_VISITS.slice(1) });
    const r = await performCheckin(SELF);
    expect(r.kind).toBe("success");
    expect(r).not.toHaveProperty("overrides");
  });

  it("judges the period the session falls in, not a window ending at the session (never a rolling window)", async () => {
    // Four visits in the previous period (22–25 Sep). A rolling 4 weeks before
    // Mon 19 Oct would count them; the period 28 Sep – 26 Oct holds none.
    h.cRow = cRow({
      ...FOUR_IN_FOUR,
      visits: ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"].map((d) => ({ d: DAY(d), s: "18:00" })),
    });
    expect((await performCheckin(SELF)).kind).toBe("success");
  });

  it("a visit recorded in a later period never counts against this session's period (an undo lands in its own period)", async () => {
    h.cRow = cRow({ ...FOUR_IN_FOUR, visits: [...FOUR_VISITS.slice(1), { d: DAY("2026-10-27"), s: "18:00" }] });
    expect((await performCheckin(SELF)).kind).toBe("success");
  });

  it("a calendar-month allowance resets on the 1st", async () => {
    h.cRow = cRow({
      classLimit: 8, classLimitBasis: "month",
      visits: [1, 2, 5, 6, 7, 8, 12, 14].map((day) => ({ d: DAY(`2026-10-${String(day).padStart(2, "0")}`), s: "18:00" })),
    });
    const r = await performCheckin(SELF);
    expect(r).toMatchObject({
      kind: "allowance_reached", used: 8, limit: 8, basis: "month",
      period: { start: "2026-10-01", end: "2026-11-01" }, resetsOn: "2026-11-01",
    });
    // The month is named when it is not the current one ("for October 2026").
    expect(checkinRefusal(r)!.body.error).toMatch(
      /^You've used all 8 of your classes for (this month|October 2026); it resets on Sunday 1 November\. For further information, please speak to a coach\.$/,
    );
  });

  it("an Unlimited plan is never refused", async () => {
    h.cRow = cRow({ visits: [...FOUR_VISITS, ...FOUR_VISITS] });
    expect((await performCheckin(SELF)).kind).toBe("success");
  });

  it("a limit with no basis is Unlimited (the reader rule never guesses a window)", async () => {
    h.cRow = cRow({ classLimit: 4, classLimitWeeks: 4, visits: [...FOUR_VISITS, ...FOUR_VISITS] });
    expect((await performCheckin(SELF)).kind).toBe("success");
  });

  it("reads an existing maxClassesPerWeek as N each calendar week (Monday to Sunday) until the owner edits the plan", async () => {
    // Mon 19 Oct 07:00 and Wed 21 Oct are in the session's week (19–25 Oct); Thu 15 Oct is in the week before.
    h.cRow = cRow({
      maxClassesPerWeek: 2,
      visits: [{ d: DAY("2026-10-15"), s: "18:00" }, { d: DAY("2026-10-19"), s: "07:00" }, { d: DAY("2026-10-21"), s: "18:00" }],
    });
    const r = await performCheckin(SELF);
    expect(r).toMatchObject({
      kind: "allowance_reached", used: 2, limit: 2, basis: "week",
      period: { start: "2026-10-19", end: "2026-10-26" }, resetsOn: "2026-10-26",
    });
    expect(r).not.toHaveProperty("weeks");
  });

  it("a member already in this session is told so, not that the allowance is used", async () => {
    h.cRow = cRow({ ...FOUR_IN_FOUR, visits: FOUR_VISITS, alreadyIn: true });
    expect(await performCheckin(SELF)).toEqual({ kind: "duplicate" });
    expect(h.recordCreate).not.toHaveBeenCalled();
  });
});

describe("staff doors (desk register, card scanner) refuse too (owner decision, 27 Oct 2026)", () => {
  it("the desk is refused at the limit, with the count, and writes nothing", async () => {
    const r = await performCheckin(DESK);
    expect(r).toMatchObject({ kind: "allowance_reached", used: 4, limit: 4 });
    expect(r).not.toHaveProperty("askable");
    expect(h.recordCreate).not.toHaveBeenCalled();
    expect(h.redemptionCreate).not.toHaveBeenCalled();
    expect(checkinRefusal(r)!.body).toMatchObject({ reason: "allowance_reached", allowance: FACTS });
    expect(checkinRefusal(r)!.body).not.toHaveProperty("askable");
  });

  it("on a staff door the refusal is the staff sentence, naming the member", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T12:00:00.000Z"));
    const r = await performCheckin(DESK).finally(() => vi.useRealTimers());
    expect(checkinRefusal(r, { staffMemberName: "Sam Taylor" })!.body.error).toBe(
      "Sam Taylor has used all 4 classes this 4-week period (resets on Monday 26 October) and has no class-pack credit, so they can't be checked in.",
    );
  });

  it("the card scanner is refused the same way and writes nothing", async () => {
    expect((await performCheckin(CARD)).kind).toBe("allowance_reached");
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("the engine has no override argument: success never carries overrides or overAllowance", async () => {
    h.cRow = cRow({ ...FOUR_IN_FOUR, visits: [] });
    const r = await performCheckin(DESK);
    expect(r.kind).toBe("success");
    expect(r).not.toHaveProperty("overrides");
    expect(r).not.toHaveProperty("overAllowance");
  });

  it("an Unlimited plan is never refused at a staff door, however many visits", async () => {
    h.cRow = cRow({ visits: [...FOUR_VISITS, ...FOUR_VISITS, ...FOUR_VISITS] });
    for (const door of [DESK, CARD]) expect((await performCheckin(door)).kind).toBe("success");
    expect(h.packUpdateMany).not.toHaveBeenCalled();
  });
});

describe("lock order and the single read", () => {
  it("Class FOR UPDATE, then the Member lock, then statement C, then the insert", async () => {
    h.cRow = cRow({ ...FOUR_IN_FOUR, visits: [] });
    await performCheckin(SELF);
    expect(h.order).toEqual(["class-lock", "member-lock", "statement-c", "statement-c2", "insert"]);
  });

  it("the Member lock is a row-write lock scoped to the member and the club", async () => {
    await performCheckin(SELF);
    const call = h.queryRaw.mock.calls.find((c) => sqlOf(c[0]).includes('FROM "Member" WHERE'))!;
    // FOR NO KEY UPDATE: serialises check-ins for the member without blocking
    // the KEY SHARE of foreign-key inserts (see memberLock in lib/checkin.ts).
    expect(sqlOf(call[0])).toMatch(/FOR NO KEY UPDATE/);
    expect(call.slice(1)).toEqual(["m-1", "t-1"]);
  });

  it("takes the Member lock even for an Unlimited plan and with the gate off (a conditional lock cannot serialise)", async () => {
    h.cRow = cRow();
    await performCheckin({ ...DESK, allowanceGate: undefined });
    expect(h.order).toEqual(["class-lock", "member-lock", "insert"]);
  });

  it("statement C carries the counted-row rules and no locking clause", async () => {
    await performCheckin(SELF);
    // C1: the plan and the member; C2: the counted visits of the judged period.
    const c1 = h.sql.find((s) => s.includes('"classLimit"'))!;
    expect(c1).toContain(`"maxClassesPerWeek"`);
    expect(c1).toContain(`"billingPeriodEnd"`);
    expect(c1).not.toMatch(/FOR (UPDATE|SHARE|NO KEY|KEY SHARE)/);
    const c = h.sql.find((s) => s.includes("json_agg"))!;
    expect(c).toContain(`"checkInMethod" <> 'import'`);
    expect(c).toContain(`"importJobId" IS NULL`);
    expect(c).toContain(`"isCancelled" = false`);
    expect(c).toContain(`"ClassPackRedemption"`);
    expect(c).not.toMatch(/FOR (UPDATE|SHARE|NO KEY|KEY SHARE)/);
  });

  it("a member deleted before the lock was granted gets member_not_found and nothing is written", async () => {
    h.memberRows = [];
    expect(await performCheckin(SELF)).toEqual({ kind: "member_not_found" });
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("a refusal never spends a pack credit", async () => {
    await performCheckin(KIOSK);
    expect(h.packUpdateMany).not.toHaveBeenCalled();
  });
});

describe("class packs", () => {
  it("a check-in a pack pays for takes the Member lock but is neither counted nor gated", async () => {
    h.memberFindUnique.mockResolvedValue(memberRow(false));
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    const r = await performCheckin(SELF);
    expect(r.kind).toBe("success");
    if (r.kind === "success") expect(r.coverage.kind).toBe("pack");
    expect(h.order).toEqual(["class-lock", "member-lock", "pack-decrement", "insert"]);
  });
});

/** A member on a desk plan: a tier, paid at the desk, no Stripe subscription. */
function deskRow() {
  return { ...memberRow(true), stripeSubscriptionId: null };
}

describe("class packs and the allowance decide together (review, 17 Oct 2026)", () => {
  it("a covered member whose allowance is used up checks in on a pack at the member app instead of being refused", async () => {
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    const r = await performCheckin(SELF);
    expect(r.kind).toBe("success");
    if (r.kind !== "success") return;
    expect(r.coverage).toEqual({ kind: "pack", creditsRemaining: 4 });
    expect(r).not.toHaveProperty("overrides");
    // Counted, found used up, then the pack pays in the SAME transaction.
    expect(h.order).toEqual(["class-lock", "member-lock", "statement-c", "statement-c2", "pack-decrement", "insert"]);
    expect(h.redemptionCreate).toHaveBeenCalledWith({ data: { memberPackId: "pack-1", attendanceRecordId: "ar-1" } });
  });

  it("the kiosk does the same for a covered member", async () => {
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    const r = await performCheckin(KIOSK);
    expect(r.kind === "success" && r.coverage.kind).toBe("pack");
  });

  it("the desk and the card scanner spend a usable pack once the allowance is used up, instead of refusing", async () => {
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    for (const door of [DESK, CARD]) {
      h.order.length = 0;
      h.redemptionCreate.mockClear();
      const r = await performCheckin(door);
      expect(r.kind === "success" && r.coverage).toEqual({ kind: "pack", creditsRemaining: 4 });
      expect(r).not.toHaveProperty("overrides");
      expect(h.order).toEqual(["class-lock", "member-lock", "statement-c", "statement-c2", "pack-decrement", "insert"]);
      expect(h.redemptionCreate).toHaveBeenCalledWith({ data: { memberPackId: "pack-1", attendanceRecordId: "ar-1" } });
    }
  });

  it("an old client's confirmation cannot be passed: the desk with no pack is refused", async () => {
    // PerformCheckinArgs has no confirmation field; an extra property is ignored.
    const r = await performCheckin({ ...DESK, allowanceOverrideConfirmed: true } as PerformCheckinArgs);
    expect(r.kind).toBe("allowance_reached");
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("within the allowance a covered member is counted and the pack is left alone", async () => {
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    h.cRow = cRow({ ...FOUR_IN_FOUR, visits: FOUR_VISITS.slice(1) });
    const r = await performCheckin(SELF);
    expect(r.kind === "success" && r.coverage.kind).toBe("subscription");
    expect(h.packUpdateMany).not.toHaveBeenCalled();
  });

  describe("door parity: the member app and the kiosk give the same answer", () => {
    it("overdue with a pack: both doors pay with the pack, neither counts nor gates", async () => {
      h.memberFindUnique.mockResolvedValue(memberRow(false));
      h.packFindFirst.mockResolvedValue({ id: "pack-1" });
      for (const door of [SELF, KIOSK]) {
        h.order.length = 0;
        const r = await performCheckin(door);
        expect(r.kind === "success" && r.coverage.kind).toBe("pack");
        expect(h.order).toEqual(["class-lock", "member-lock", "pack-decrement", "insert"]);
      }
    });

    it("desk plan with a pack, allowance used: both doors pay with the pack after counting", async () => {
      h.memberFindUnique.mockResolvedValue(deskRow());
      h.packFindFirst.mockResolvedValue({ id: "pack-1" });
      for (const door of [SELF, KIOSK]) {
        h.order.length = 0;
        const r = await performCheckin(door);
        expect(r.kind === "success" && r.coverage.kind).toBe("pack");
        expect(h.order).toEqual(["class-lock", "member-lock", "statement-c", "statement-c2", "pack-decrement", "insert"]);
      }
    });

    it("desk plan with a pack, within the allowance: both doors count the visit and leave the pack (the kiosk no longer drains it)", async () => {
      h.memberFindUnique.mockResolvedValue(deskRow());
      h.packFindFirst.mockResolvedValue({ id: "pack-1" });
      h.cRow = cRow({ ...FOUR_IN_FOUR, visits: FOUR_VISITS.slice(1) });
      for (const door of [SELF, KIOSK]) {
        h.order.length = 0;
        const r = await performCheckin(door);
        expect(r.kind).toBe("success");
        expect(h.order).toEqual(["class-lock", "member-lock", "statement-c", "statement-c2", "insert"]);
      }
      expect(h.packUpdateMany).not.toHaveBeenCalled();
    });

    it("desk plan, allowance used, no pack: both doors refuse with the same sentence", async () => {
      h.memberFindUnique.mockResolvedValue(deskRow());
      const [a, b] = [await performCheckin(SELF), await performCheckin(KIOSK)];
      expect(a).toEqual(b);
      expect(a.kind).toBe("allowance_reached");
    });
  });
});

describe("coverage is re-checked under the Member lock (R-ALLOW rule 2)", () => {
  /** The lock row as Postgres returns it for the member the pre-read saw. */
  function lockRow(over: Record<string, unknown> = {}) {
    return {
      id: "m-1", membershipTierId: "tier-1", paymentStatus: "paid", stripeSubscriptionId: "sub_1",
      nextDueAtMs: null, holdUntilMs: null, waiverAccepted: true, accountType: "adult", ...over,
    };
  }

  it("the lock re-reads the columns the gates used, dates as epoch milliseconds", async () => {
    h.memberRows = [lockRow()];
    h.cRow = cRow({ ...FOUR_IN_FOUR, visits: [] });
    expect((await performCheckin(SELF)).kind).toBe("success");
    const lock = h.sql.find((t) => t.includes('FROM "Member" WHERE'))!;
    for (const col of ['"membershipTierId"', '"paymentStatus"', '"stripeSubscriptionId"', '"waiverAccepted"', '"accountType"']) {
      expect(lock).toContain(col);
    }
    expect(lock).toMatch(/EXTRACT\(EPOCH FROM "nextDueAt"\)/);
    expect(lock).toMatch(/EXTRACT\(EPOCH FROM "holdUntil"\)/);
  });

  it("a plan removed between the pre-read and the lock restarts the check-in, which is then judged on the new row", async () => {
    // Pre-read 1: a covered subscriber. Lock 1: the subscription is gone and
    // the plan removed. The restart pre-reads the new row: not covered, no
    // pack, so the member app refuses - instead of admitting on the old plan.
    h.memberFindUnique
      .mockResolvedValueOnce(memberRow(true))
      .mockResolvedValue({ ...memberRow(false), membershipTierId: null });
    h.memberRows = [lockRow({ membershipTierId: null, paymentStatus: "overdue", stripeSubscriptionId: null })];
    const r = await performCheckin(SELF);
    expect(r).toMatchObject({ kind: "no_coverage" });
    expect(h.memberFindUnique).toHaveBeenCalledTimes(2);
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("a row that keeps moving answers error after the restarts, and writes nothing", async () => {
    h.memberRows = [lockRow({ paymentStatus: "overdue" })];
    const r = await performCheckin(SELF);
    expect(r.kind).toBe("error");
    expect(h.memberFindUnique).toHaveBeenCalledTimes(3);
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("an unchanged row with dates set does not restart", async () => {
    const due = new Date("2026-11-01T00:00:00.000Z");
    h.memberFindUnique.mockResolvedValue({ ...memberRow(true), nextDueAt: due });
    h.memberRows = [lockRow({ nextDueAtMs: due.getTime() })];
    h.cRow = cRow({ ...FOUR_IN_FOUR, visits: [] });
    expect((await performCheckin(SELF)).kind).toBe("success");
    expect(h.memberFindUnique).toHaveBeenCalledTimes(1);
  });
});

describe("per member's billing period (owner scope, 21 Oct 2026)", () => {
  const BILLING = { classLimit: 4, classLimitBasis: "billing" };

  it("a desk-billed member: the period ends on the next due date MatFlow tracks and runs one cycle back", async () => {
    // four_weekly, due 2 Nov: the period is 5 Oct – 2 Nov; the four visits and the session (19 Oct) are in it.
    h.cRow = cRow({ ...BILLING, billingCycle: "four_weekly", nextDueAt: new Date("2026-11-02T00:00:00.000Z"), visits: FOUR_VISITS });
    const r = await performCheckin(SELF);
    expect(r).toMatchObject({
      kind: "allowance_reached", used: 4, limit: 4, basis: "billing",
      period: { start: "2026-10-05", end: "2026-11-02" }, resetsOn: "2026-11-02",
    });
    expect(h.recordCreate).not.toHaveBeenCalled();
    expect(checkinRefusal(r)!.body.error).toMatch(/^You've used all 4 of your classes for (this|the) billing period/);
  });

  it("a Stripe-billed member: the paid period Stripe stated, stepped forward by the cycle for a later session", async () => {
    // Paid period 28 Sep – 26 Oct (four_weekly). A session on 2 Nov is in the NEXT period (26 Oct – 23 Nov): 0 used.
    h.instanceFindFirst.mockResolvedValue({ ...INSTANCE, date: new Date("2026-11-02T00:00:00.000Z") });
    h.cRow = cRow({
      ...BILLING, billingCycle: "four_weekly", stripeSubscriptionId: "sub_1",
      billingPeriodStart: new Date("2026-09-28T00:00:00.000Z"), billingPeriodEnd: new Date("2026-10-26T00:00:00.000Z"),
      visits: FOUR_VISITS,
    });
    expect((await performCheckin(SELF)).kind).toBe("success");
    // The same member, the same visits, a session inside the stated period: refused.
    h.instanceFindFirst.mockResolvedValue(INSTANCE);
    h.recordCreate.mockClear();
    const r = await performCheckin(SELF);
    expect(r).toMatchObject({ kind: "allowance_reached", period: { start: "2026-09-28", end: "2026-10-26" } });
  });

  it("a live Stripe member is judged on the stated period, never on a stale next due date", async () => {
    h.cRow = cRow({
      ...BILLING, billingCycle: "four_weekly", stripeSubscriptionId: "sub_1", nextDueAt: new Date("2026-10-06T00:00:00.000Z"),
      billingPeriodStart: new Date("2026-09-28T00:00:00.000Z"), billingPeriodEnd: new Date("2026-10-26T00:00:00.000Z"),
      visits: FOUR_VISITS,
    });
    expect(await performCheckin(SELF)).toMatchObject({ kind: "allowance_reached", period: { start: "2026-09-28", end: "2026-10-26" } });
  });

  it("no period recorded: the member app refuses with 'no renewal date', never a silent calendar fallback", async () => {
    h.cRow = cRow({ ...BILLING, billingCycle: "four_weekly", visits: [] });
    const r = await performCheckin(SELF);
    expect(r).toMatchObject({ kind: "allowance_reached", used: 0, limit: 4, basis: "billing", periodUnknown: true });
    expect(r).not.toHaveProperty("resetsOn");
    expect(h.recordCreate).not.toHaveBeenCalled();
    expect(checkinRefusal(r)!.body).toMatchObject({
      reason: "allowance_reached",
      error: "Your plan counts classes per billing period, but no renewal date is recorded for you. For further information, please speak to a coach.",
      allowance: { periodUnknown: true, limit: 4 },
    });
  });

  it("no period recorded: the desk is refused too, and a usable pack is NOT spent (M-4)", async () => {
    h.cRow = cRow({ ...BILLING, billingCycle: "four_weekly", visits: [] });
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    const r = await performCheckin(DESK);
    expect(r).toMatchObject({ kind: "allowance_reached", periodUnknown: true });
    expect(h.packUpdateMany).not.toHaveBeenCalled();
    expect(h.recordCreate).not.toHaveBeenCalled();
    expect(checkinRefusal(r, { staffMemberName: "Sam" })!.body.error).toBe(
      "No renewal date is recorded for Sam, so their 4 classes per billing period can't be counted and they can't be checked in.",
    );
  });

  it("an annual billing period counts visits from the whole year: the visits read is bounded by the period, not a fixed window (H-1)", async () => {
    h.cRow = cRow({
      classLimit: 10, classLimitBasis: "billing", billingCycle: "annual", nextDueAt: new Date("2027-01-10T00:00:00.000Z"),
      visits: Array.from({ length: 10 }, (_, i) => ({ d: DAY(`2026-0${1 + (i % 8)}-1${i}`), s: "18:00" })),
    });
    const r = await performCheckin(SELF);
    expect(r).toMatchObject({ kind: "allowance_reached", used: 10, limit: 10, period: { start: "2026-01-10", end: "2027-01-10" } });
    const c2 = h.queryRaw.mock.calls.map((c) => c[0]).find((strings) => sqlOf(strings).includes("json_agg"))!;
    const call = h.queryRaw.mock.calls.find((c) => c[0] === c2)!;
    const bounds = call.slice(1).filter((v): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v));
    expect(bounds).toEqual(["2026-01-09T00:00:00.000Z", "2027-01-11T00:00:00.000Z"]);
  });

  it("no period recorded: a usable class pack is NOT spent at the member app — the member is refused, nothing written (M-4)", async () => {
    h.cRow = cRow({ ...BILLING, billingCycle: "four_weekly", visits: [] });
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    const r = await performCheckin(SELF);
    expect(r).toMatchObject({ kind: "allowance_reached", periodUnknown: true });
    expect(h.packUpdateMany).not.toHaveBeenCalled();
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("a non-recurring tier (cycle none) with a due date has no period either", async () => {
    h.cRow = cRow({ ...BILLING, billingCycle: "none", nextDueAt: new Date("2026-11-02T00:00:00.000Z"), visits: [] });
    expect(await performCheckin(SELF)).toMatchObject({ kind: "allowance_reached", periodUnknown: true });
  });
});

describe("staffAllowanceGate: the coach tick refuses, with the pack fall-through (owner decision, 27 Oct 2026)", () => {
  const SESSION = { id: "ci-1", date: INSTANCE.date, startTime: INSTANCE.startTime };
  const packUpdate = vi.fn();
  function tx() {
    return {
      $queryRaw: h.queryRaw,
      memberClassPack: {
        findFirst: h.packFindFirst, updateMany: h.packUpdateMany, update: packUpdate,
        findUnique: vi.fn().mockResolvedValue({ creditsRemaining: 2 }),
      },
    } as unknown as Parameters<typeof staffAllowanceGate>[0];
  }
  const ARGS = { tenantId: "t-1", memberId: "m-1", timeZone: "Europe/London" };

  it("at the limit with no pack: refused with the facts, Member lock then statement C, nothing spent", async () => {
    const r = await staffAllowanceGate(tx(), ARGS, SESSION);
    expect(r).toMatchObject({ kind: "allowance_reached", ...FACTS });
    expect(h.order).toEqual(["member-lock", "statement-c", "statement-c2"]);
    expect(h.packUpdateMany).not.toHaveBeenCalled();
  });

  it("at the limit with a usable pack: one credit is spent after the count (Member, then pack) and handed to the caller", async () => {
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    const r = await staffAllowanceGate(tx(), ARGS, SESSION);
    expect(r).toEqual({ kind: "open", pack: { id: "pack-1", creditsRemaining: 2 } });
    expect(h.order).toEqual(["member-lock", "statement-c", "statement-c2", "pack-decrement"]);
  });

  it("within the allowance: open, no pack touched", async () => {
    h.cRow = cRow({ ...FOUR_IN_FOUR, visits: FOUR_VISITS.slice(1) });
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    expect(await staffAllowanceGate(tx(), ARGS, SESSION)).toEqual({ kind: "open", pack: null });
    expect(h.packUpdateMany).not.toHaveBeenCalled();
  });

  it("an Unlimited plan is never counted or refused", async () => {
    h.cRow = cRow({ visits: [...FOUR_VISITS, ...FOUR_VISITS] });
    expect(await staffAllowanceGate(tx(), ARGS, SESSION)).toEqual({ kind: "open", pack: null });
  });

  it("an unknown billing period is refused without spending a pack (M-4)", async () => {
    h.cRow = cRow({ classLimit: 4, classLimitBasis: "billing", billingCycle: "four_weekly", visits: [] });
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    expect(await staffAllowanceGate(tx(), ARGS, SESSION)).toMatchObject({ kind: "allowance_reached", periodUnknown: true });
    expect(h.packUpdateMany).not.toHaveBeenCalled();
  });

  it("a member already in this session is a duplicate, nothing spent", async () => {
    h.cRow = cRow({ ...FOUR_IN_FOUR, visits: FOUR_VISITS, alreadyIn: true });
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    expect(await staffAllowanceGate(tx(), ARGS, SESSION)).toEqual({ kind: "duplicate" });
    expect(h.packUpdateMany).not.toHaveBeenCalled();
  });

  it("a member deleted before the lock is member_not_found", async () => {
    h.memberRows = [];
    expect(await staffAllowanceGate(tx(), ARGS, SESSION)).toEqual({ kind: "member_not_found" });
  });

  it("returnClaimedPack gives the one credit back", async () => {
    await returnClaimedPack(tx(), { id: "pack-1", creditsRemaining: 2 });
    expect(packUpdate).toHaveBeenCalledWith({ where: { id: "pack-1" }, data: { creditsRemaining: { increment: 1 } } });
  });
});
