/**
 * T7 (Sean note 5): the class allowance inside the single check-in engine.
 *
 * Owner decisions (17 and 20 Oct 2026):
 *  - enforced as soon as a plan has a limit; blank = Unlimited;
 *  - the allowance resets on an explicit basis (each week, each calendar
 *    month, every N weeks from a start date), never a rolling window: a
 *    session is judged against the period IT falls in;
 *  - member app and kiosk refuse with the count and the date it resets; the
 *    desk register and the card scanner ask, and an admission is reported as
 *    the "allowance_reached" override with the count;
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

import { performCheckin, type PerformCheckinArgs } from "@/lib/checkin";
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
  enforceVenueGate: false, allowanceGate: "ask", checkedInByUserId: "u-1",
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
    const r = await performCheckin(SELF);
    expect(r).toEqual({ kind: "allowance_reached", askable: false, ...FACTS });
    expect(h.recordCreate).not.toHaveBeenCalled();
    const refusal = checkinRefusal(r)!;
    expect(refusal.status).toBe(403);
    expect(refusal.body).toMatchObject({
      reason: "allowance_reached",
      error: "4 of 4 classes used this 4-week period; it resets on Monday 26 October. Ask staff if you need to train before then.",
    });
    expect(refusal.body.askable).toBeUndefined();
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
    if (r.kind === "success") expect(r.overrides).toBeUndefined();
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
    expect(checkinRefusal(r)!.body.error).toBe(
      "8 of 8 classes used this month; it resets on Sunday 1 November. Ask staff if you need to train before then.",
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

describe("asking doors (desk register, card scanner)", () => {
  it("the desk is asked: refused with askable: true until staff confirm", async () => {
    const r = await performCheckin(DESK);
    expect(r).toMatchObject({ kind: "allowance_reached", askable: true, used: 4, limit: 4 });
    expect(h.recordCreate).not.toHaveBeenCalled();
    expect(checkinRefusal(r)!.body).toMatchObject({ askable: true, allowance: FACTS });
  });

  it("confirmed, the desk admits and reports the override with the count for the audit row", async () => {
    const r = await performCheckin({ ...DESK, allowanceOverrideConfirmed: true });
    expect(r.kind).toBe("success");
    if (r.kind !== "success") return;
    expect(r.overrides).toEqual(["allowance_reached"]);
    expect(r.overAllowance).toEqual(FACTS);
  });

  it("the card scanner asks the same way", async () => {
    expect((await performCheckin(CARD)).kind).toBe("allowance_reached");
    const ok = await performCheckin({ ...CARD, allowanceOverrideConfirmed: true });
    expect(ok.kind === "success" && ok.overrides).toEqual(["allowance_reached"]);
  });

  it("a confirmation is inert when nothing was asked: no override is recorded", async () => {
    h.cRow = cRow({ ...FOUR_IN_FOUR, visits: [] });
    const r = await performCheckin({ ...DESK, allowanceOverrideConfirmed: true });
    expect(r.kind === "success" && r.overrides).toBeUndefined();
  });
});

describe("lock order and the single read", () => {
  it("Class FOR UPDATE, then the Member lock, then statement C, then the insert", async () => {
    h.cRow = cRow({ ...FOUR_IN_FOUR, visits: [] });
    await performCheckin(SELF);
    expect(h.order).toEqual(["class-lock", "member-lock", "statement-c", "insert"]);
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
    const c = h.sql.find((s) => s.includes('"AttendanceRecord"'))!;
    expect(c).toContain(`"checkInMethod" <> 'import'`);
    expect(c).toContain(`"importJobId" IS NULL`);
    expect(c).toContain(`"isCancelled" = false`);
    expect(c).toContain(`"ClassPackRedemption"`);
    expect(c).toContain(`"classLimit"`);
    expect(c).toContain(`"maxClassesPerWeek"`);
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
    expect(r.overrides).toBeUndefined();
    // Counted, found used up, then the pack pays in the SAME transaction.
    expect(h.order).toEqual(["class-lock", "member-lock", "statement-c", "pack-decrement", "insert"]);
    expect(h.redemptionCreate).toHaveBeenCalledWith({ data: { memberPackId: "pack-1", attendanceRecordId: "ar-1" } });
  });

  it("the kiosk does the same for a covered member", async () => {
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    const r = await performCheckin(KIOSK);
    expect(r.kind === "success" && r.coverage.kind).toBe("pack");
  });

  it("a staff door never spends a pack: it asks", async () => {
    h.packFindFirst.mockResolvedValue({ id: "pack-1" });
    const r = await performCheckin(DESK);
    expect(r).toMatchObject({ kind: "allowance_reached", askable: true });
    expect(h.packUpdateMany).not.toHaveBeenCalled();
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
        expect(h.order).toEqual(["class-lock", "member-lock", "statement-c", "pack-decrement", "insert"]);
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
        expect(h.order).toEqual(["class-lock", "member-lock", "statement-c", "insert"]);
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
