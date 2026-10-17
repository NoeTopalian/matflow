/**
 * T7 (Sean note 5): the class allowance inside the single check-in engine.
 *
 * Owner decisions (17 Oct 2026):
 *  - enforced as soon as a plan has a limit; blank = Unlimited;
 *  - member app and kiosk refuse with the count and the date it frees up;
 *    the desk register and the card scanner ask, and an admission is reported
 *    as the "allowance_reached" override with the count;
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
  classLimitWeeks: number | null;
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
      classPackRedemption: { create: vi.fn() },
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
  return { classLimit: null, classLimitWeeks: null, maxClassesPerWeek: null, alreadyIn: false, visits: [], ...over };
}
/** Four counted visits inside the 4 weeks before Monday 19 Oct 18:00. */
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
  enforceRankGate: true, enforceRosterGate: true, enforceTimeWindow: false,
  requireCoverage: true, enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true,
  enforceKidsGate: true, enforceVenueGate: true, tierGate: "refuse", allowanceGate: "refuse", checkedInByUserId: null,
};
const KIOSK: PerformCheckinArgs = { ...SELF, method: "kiosk", requireCoverage: false };
const DESK: PerformCheckinArgs = {
  ...SELF, method: "admin", enforceRankGate: false, enforceRosterGate: false, requireCoverage: false,
  enforceCapacity: false, enforceWaiverGate: false, enforceHoldGate: false, enforceKidsGate: false,
  enforceVenueGate: false, tierGate: "ask", allowanceGate: "ask", checkedInByUserId: "u-1",
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
  h.cRow = cRow({ classLimit: 4, classLimitWeeks: 4, visits: FOUR_VISITS });
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
  h.packFindFirst.mockResolvedValue({ id: "pack-1" });
  h.packUpdateMany.mockImplementation(async () => { h.order.push("pack-decrement"); return { count: 1 }; });
});

describe("refusing doors (member app, parent, kiosk)", () => {
  it("the member app refuses the fifth class in 4 weeks, names the count and the free date, and writes nothing", async () => {
    const r = await performCheckin(SELF);
    expect(r).toEqual({
      kind: "allowance_reached", askable: false, used: 4, limit: 4, weeks: 4,
      nextFree: { date: "2026-11-02", time: "18:00" },
    });
    expect(h.recordCreate).not.toHaveBeenCalled();
    const refusal = checkinRefusal(r)!;
    expect(refusal.status).toBe(403);
    expect(refusal.body).toMatchObject({
      reason: "allowance_reached",
      error: "4 of 4 classes used in the last 4 weeks; next free on Monday 2 November from 18:00. Ask staff if you need to train before then.",
    });
    expect(refusal.body.askable).toBeUndefined();
  });

  it("the kiosk gives the same refusal", async () => {
    const r = await performCheckin(KIOSK);
    expect(r.kind).toBe("allowance_reached");
    expect(h.recordCreate).not.toHaveBeenCalled();
  });

  it("admits while the rolling total is within the allowance (several in one week)", async () => {
    h.cRow = cRow({ classLimit: 4, classLimitWeeks: 4, visits: FOUR_VISITS.slice(1) });
    const r = await performCheckin(SELF);
    expect(r.kind).toBe("success");
    if (r.kind === "success") expect(r.overrides).toBeUndefined();
  });

  it("an Unlimited plan is never refused", async () => {
    h.cRow = cRow({ visits: [...FOUR_VISITS, ...FOUR_VISITS] });
    expect((await performCheckin(SELF)).kind).toBe("success");
  });

  it("reads an existing maxClassesPerWeek as N per 1 week until the owner edits the plan", async () => {
    h.cRow = cRow({ maxClassesPerWeek: 2, visits: [{ d: DAY("2026-10-13"), s: "18:00" }, { d: DAY("2026-10-15"), s: "18:00" }] });
    const r = await performCheckin(SELF);
    expect(r).toMatchObject({ kind: "allowance_reached", used: 2, limit: 2, weeks: 1 });
  });

  it("a member already in this session is told so, not that the allowance is used", async () => {
    h.cRow = cRow({ classLimit: 4, classLimitWeeks: 4, visits: FOUR_VISITS, alreadyIn: true });
    expect(await performCheckin(SELF)).toEqual({ kind: "duplicate" });
    expect(h.recordCreate).not.toHaveBeenCalled();
  });
});

describe("asking doors (desk register, card scanner)", () => {
  it("the desk is asked: refused with askable: true until staff confirm", async () => {
    const r = await performCheckin(DESK);
    expect(r).toMatchObject({ kind: "allowance_reached", askable: true, used: 4, limit: 4 });
    expect(h.recordCreate).not.toHaveBeenCalled();
    expect(checkinRefusal(r)!.body).toMatchObject({ askable: true, allowance: { used: 4, limit: 4, weeks: 4 } });
  });

  it("confirmed, the desk admits and reports the override with the count for the audit row", async () => {
    const r = await performCheckin({ ...DESK, allowanceOverrideConfirmed: true });
    expect(r.kind).toBe("success");
    if (r.kind !== "success") return;
    expect(r.overrides).toEqual(["allowance_reached"]);
    expect(r.overAllowance).toEqual({ used: 4, limit: 4, weeks: 4, nextFree: { date: "2026-11-02", time: "18:00" } });
  });

  it("the card scanner asks the same way", async () => {
    expect((await performCheckin(CARD)).kind).toBe("allowance_reached");
    const ok = await performCheckin({ ...CARD, allowanceOverrideConfirmed: true });
    expect(ok.kind === "success" && ok.overrides).toEqual(["allowance_reached"]);
  });

  it("a confirmation is inert when nothing was asked: no override is recorded", async () => {
    h.cRow = cRow({ classLimit: 4, classLimitWeeks: 4, visits: [] });
    const r = await performCheckin({ ...DESK, allowanceOverrideConfirmed: true });
    expect(r.kind === "success" && r.overrides).toBeUndefined();
  });
});

describe("lock order and the single read", () => {
  it("Class FOR UPDATE, then the Member lock, then statement C, then the insert", async () => {
    h.cRow = cRow({ classLimit: 4, classLimitWeeks: 4, visits: [] });
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
    const r = await performCheckin(SELF);
    expect(r.kind).toBe("success");
    if (r.kind === "success") expect(r.coverage.kind).toBe("pack");
    expect(h.order).toEqual(["class-lock", "member-lock", "pack-decrement", "insert"]);
  });
});
