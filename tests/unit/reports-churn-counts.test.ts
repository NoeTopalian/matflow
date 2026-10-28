/**
 * T2b (17 Oct 2026) — lib/reports.ts returns the counts behind every rate.
 *
 * Churn (owner decision, 27 Oct 2026): the total cancellations in the
 * selected period, joiners included, with the people who joined in the same
 * period beside it. A finished prepaid course is Left, not churn. No
 * percentage until its denominator is approved. Both come from the status
 * history (lib/membership-movement.ts), so the fixtures below are events.
 * Q4 A-2: status shares are over current members only; cancelled members are
 * a separate count.
 *
 * The mocked transaction routes each `member.count` by the shape of its
 * `where`, so the test pins which population each number comes from rather
 * than the order the queries run in.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    class: { findMany: vi.fn(), count: vi.fn() },
    // Review L4: getReportsData reads the club zone for its month windows.
    tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) },
    classInstance: { findMany: vi.fn() },
    attendanceRecord: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    member: { groupBy: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    payment: { count: vi.fn(), findMany: vi.fn() },
    // T8c: the membership series reads (lib/membership-report.ts); it reads
    // the club zone through the same `tenant` mock above.
    memberStatusEvent: { findMany: vi.fn(async () => []) },
    importedMembership: { findMany: vi.fn(async () => []) },
  },
}));

import { prisma } from "@/lib/prisma";
import { getReportsData } from "@/lib/reports";
import { zonedMonthStart } from "@/lib/club-month";

type Where = Record<string, unknown>;

type Ev = { id: string; memberId: string; fromStatus: string | null; toStatus: string; reason: string; sourceAction: string | null; occurredAt: Date; createdAt: Date };
type Live = { id: string; status: string; joinedAt: Date; cancelledAt: Date | null };

type Fixture = {
  active: number;
  cancelledThisMonth: number;
  joinedThisMonth: number;
  retentionCohort: number;
  retentionSurvived: number;
  failedMemberIds: string[];
  recovered: number;
  statusGroups: { status: string; _count: number }[];
  /** The status history the churn and joined figures replay (none: no movement). */
  history?: { events: Ev[]; live: Live[] };
};

const BASE: Fixture = {
  active: 9,
  cancelledThisMonth: 1,
  joinedThisMonth: 3,
  retentionCohort: 20,
  retentionSurvived: 15,
  failedMemberIds: ["a", "b", "c", "d"],
  recovered: 3,
  statusGroups: [
    { status: "active", _count: 9 },
    { status: "inactive", _count: 2 },
    { status: "taster", _count: 1 },
    { status: "cancelled", _count: 5 },
  ],
};


/**
 * The database's answer to the distinct-attendee groupBy (lib/reports.ts):
 * the rows its `where.member` filter keeps (status, and accountType "not" /
 * "in"), one per member. The filter, not the test, decides who counts.
 */
type AttendRow = { memberId: string; member?: { status?: string; accountType?: string } };
function attendeeGroups(rows: AttendRow[], where: { member?: { status?: string; accountType?: { not?: string; in?: string[] } } }) {
  const m = where.member ?? {};
  const typeOk = (t: string) => (!m.accountType ? true : m.accountType.not !== undefined ? t !== m.accountType.not : (m.accountType.in ?? []).includes(t));
  const kept = rows.filter((r) => (!m.status || r.member?.status === m.status) && typeOk(r.member?.accountType ?? "adult"));
  return [...new Set(kept.map((r) => r.memberId))].map((memberId) => ({ memberId }));
}

function setup(f: Fixture) {
  vi.mocked(prisma.class.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.class.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.classInstance.findMany).mockResolvedValue([
    { id: "i1", class: { name: "Fundamentals", maxCapacity: 10 } },
    { id: "i2", class: { name: "Open Mat", maxCapacity: null } },
  ] as never);
  vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
    { checkInTime: new Date(), memberId: "m1", member: { status: "active" } },
    { checkInTime: new Date(), memberId: "m1", member: { status: "active" } },
    { checkInTime: new Date(), memberId: "m2", member: { status: "active" } },
  ] as never);
  vi.mocked(prisma.attendanceRecord.groupBy).mockImplementation(((args: unknown) => {
    const by = (args as { by: string[] }).by;
    if (by[0] === "memberId") {
      // The three in-period check-ins: m1 twice and m2, both active.
      return Promise.resolve(attendeeGroups(
        [{ memberId: "m1", member: { status: "active" } }, { memberId: "m1", member: { status: "active" } }, { memberId: "m2", member: { status: "active" } }],
        (args as { where: Parameters<typeof attendeeGroups>[1] }).where,
      ) as never);
    }
    if (by[0] === "classInstanceId") {
      return Promise.resolve([
        { classInstanceId: "i1", _count: 2 },
        { classInstanceId: "i2", _count: 1 },
      ] as never);
    }
    return Promise.resolve([] as never);
  }) as never);
  vi.mocked(prisma.attendanceRecord.count).mockResolvedValue(3 as never);
  vi.mocked(prisma.member.groupBy).mockResolvedValue(f.statusGroups as never);
  // The membership replay reads every training member (its select carries joinedAt) and their events.
  vi.mocked(prisma.member.findMany).mockImplementation(((args: unknown) => {
    const select = (args as { select?: Where })?.select ?? {};
    return Promise.resolve((select.joinedAt ? f.history?.live ?? [] : []) as never);
  }) as never);
  vi.mocked(prisma.memberStatusEvent.findMany).mockResolvedValue((f.history?.events ?? []) as never);
  vi.mocked(prisma.member.count).mockImplementation(((args: unknown) => {
    const where = ((args as { where?: Where })?.where ?? {}) as Where;
    const joinedAt = where.joinedAt as Where | undefined;
    if (where.id) return Promise.resolve(f.recovered as never); // recovered: failed members now paid
    if (where.status === "cancelled" && where.cancelledAt) return Promise.resolve(f.cancelledThisMonth as never);
    if (joinedAt && "lt" in joinedAt && !("gte" in joinedAt)) {
      return Promise.resolve((where.status === "active" ? f.retentionSurvived : f.retentionCohort) as never);
    }
    // Review L4: both month windows are half-open [start, next start) in the
    // club's zone; this month is the one starting at the club's current month.
    if (joinedAt && "gte" in joinedAt && "lt" in joinedAt) {
      const thisMonth = (joinedAt.gte as Date).getTime() === zonedMonthStart(new Date(), "Europe/London").getTime();
      return Promise.resolve((thisMonth ? f.joinedThisMonth : 0) as never);
    }
    if (where.status === "active") return Promise.resolve(f.active as never);
    return Promise.resolve(0 as never);
  }) as never);
  vi.mocked(prisma.payment.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.payment.findMany).mockResolvedValue(f.failedMemberIds.map((memberId) => ({ memberId })) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

const LONG_AGO = new Date("2025-01-06T10:00:00.000Z");
let seq = 0;
function ev(memberId: string, fromStatus: string | null, toStatus: string, at: Date, source: { reason: string; sourceAction: string } | null = null): Ev {
  seq += 1;
  return { id: `e${String(seq).padStart(5, "0")}`, memberId, fromStatus, toStatus, reason: source?.reason ?? "staff_edit", sourceAction: source?.sourceAction ?? null, occurredAt: at, createdAt: at };
}
/** The k-th of a few distinct instants inside this club month, in order, never after now. */
function thisMonthAt(k = 0): Date {
  const start = zonedMonthStart(new Date(), "Europe/London").getTime();
  return new Date(Math.min(start + 60 * 60 * 1000 + k * 60_000, Date.now() - (10 - k) * 1000));
}
/** An instant inside last club month. */
function lastMonthAt(): Date {
  return new Date(zonedMonthStart(new Date(), "Europe/London", -1).getTime() + 2 * 86_400_000);
}
/** A TeamUp refresh ending a prepaid course: "Completed course", in Left and never a cancellation. */
const COURSE_END = { reason: "import", sourceAction: "import_refresh" };
/**
 * `stayers` members active since 2025 and still active; `leaversNow` active
 * since 2025 who cancel this month; `leaversLast` who cancelled last month;
 * `joinersNow` whose first ever start is this month; `joinersLeft` who start
 * AND cancel this month; `repeaters` active since 2025 who cancel, rejoin and
 * cancel again this month; `courses` active since 2025 whose prepaid course
 * ends this month.
 */
function history({ stayers = 0, leaversNow = 0, leaversLast = 0, joinersNow = 0, joinersLeft = 0, repeaters = 0, courses = 0 }): { events: Ev[]; live: Live[] } {
  const events: Ev[] = [];
  const live: Live[] = [];
  const add = (id: string, final: string, moves: [string | null, string, Date, ({ reason: string; sourceAction: string } | null)?][]) => {
    for (const [from, to, at, source] of moves) events.push(ev(id, from, to, at, source ?? null));
    live.push({ id, status: final, joinedAt: moves[0][2], cancelledAt: final === "cancelled" ? moves[moves.length - 1][2] : null });
  };
  for (let i = 0; i < stayers; i++) add(`s${i}`, "active", [[null, "active", LONG_AGO]]);
  for (let i = 0; i < leaversNow; i++) add(`l${i}`, "cancelled", [[null, "active", LONG_AGO], ["active", "cancelled", thisMonthAt()]]);
  for (let i = 0; i < leaversLast; i++) add(`p${i}`, "cancelled", [[null, "active", LONG_AGO], ["active", "cancelled", lastMonthAt()]]);
  for (let i = 0; i < joinersNow; i++) add(`j${i}`, "active", [[null, "active", thisMonthAt()]]);
  for (let i = 0; i < joinersLeft; i++) add(`jl${i}`, "cancelled", [[null, "active", thisMonthAt(0)], ["active", "cancelled", thisMonthAt(1)]]);
  for (let i = 0; i < repeaters; i++) {
    add(`r${i}`, "cancelled", [[null, "active", LONG_AGO], ["active", "cancelled", thisMonthAt(1)], ["cancelled", "active", thisMonthAt(2)], ["active", "cancelled", thisMonthAt(3)]]);
  }
  for (let i = 0; i < courses; i++) add(`c${i}`, "inactive", [[null, "active", LONG_AGO], ["active", "inactive", thisMonthAt(1), COURSE_END]]);
  return { events, live };
}

// Churn (owner decision, 27 Oct 2026, superseding the opening-cohort rate of
// 26 Oct): the total cancellations in the selected period, joiners included.
// No percentage: its denominator is not approved, so the report carries the
// count and no rate or base at all.
describe("getReportsData — churn is the total cancellations in the period", () => {
  it("one long-standing member cancels this month → 1 cancellation; joined and net for the same month beside it", async () => {
    setup({ ...BASE, history: history({ stayers: 9, leaversNow: 1, joinersNow: 2 }) });
    const data = await getReportsData("tenant-A");
    expect(data.churn).toEqual({ cancelled: 1, joined: 2, net: 1 });
  });

  it("carries no percentage and no denominator anywhere in the report data", async () => {
    setup({ ...BASE, history: history({ stayers: 9, leaversNow: 1 }) });
    const data = await getReportsData("tenant-A");
    expect(data.churn).not.toHaveProperty("ratePct");
    expect(data.churn).not.toHaveProperty("base");
    expect(data).not.toHaveProperty("churnRate");
  });

  it("a joiner who cancels inside the period is counted", async () => {
    setup({ ...BASE, history: history({ stayers: 3, joinersLeft: 1 }) });
    const data = await getReportsData("tenant-A");
    expect(data.churn).toEqual({ cancelled: 1, joined: 1, net: 0 });
    expect(data.periodMovement.totals).toMatchObject({ new: 1, lost: 1, lostCancelled: 1 });
  });

  it("a club with no history before the period: a joiner who cancels is still 1 cancellation", async () => {
    setup({ ...BASE, history: history({ joinersLeft: 1 }) });
    const data = await getReportsData("tenant-A");
    expect(data.churn.cancelled).toBe(1);
  });

  it("a finished prepaid course is counted in Left, not as churn", async () => {
    setup({ ...BASE, history: history({ stayers: 3, courses: 1 }) });
    const data = await getReportsData("tenant-A");
    expect(data.churn.cancelled).toBe(0);
    expect(data.periodMovement.totals).toMatchObject({ lost: 1, lostCompleted: 1, lostCancelled: 0 });
  });

  it("cancel, rejoin and cancel again inside the period is two cancellations (moves, as Left and Joined count them)", async () => {
    setup({ ...BASE, history: history({ stayers: 3, repeaters: 1 }) });
    const data = await getReportsData("tenant-A");
    expect(data.churn.cancelled).toBe(2);
    expect(data.periodMovement.totals).toMatchObject({ rejoined: 1, lostCancelled: 2, lost: 2 });
  });

  it("no members at all is 0 cancellations", async () => {
    setup({ ...BASE, history: history({}) });
    const data = await getReportsData("tenant-A");
    expect(data.churn).toEqual({ cancelled: 0, joined: 0, net: 0 });
  });

  it("last month: only last month's cancellations", async () => {
    setup({ ...BASE, history: history({ stayers: 8, leaversLast: 2, leaversNow: 1 }) });
    const data = await getReportsData("tenant-A", { period: { period: "last-month" } });
    expect(data.range.key).toBe("last-month");
    expect(data.churn.cancelled).toBe(2);
  });

  it("stays club-wide: the age-group and class filters do not narrow it", async () => {
    setup({ ...BASE, history: history({ stayers: 3, leaversNow: 2, joinersLeft: 1 }) });
    const all = await getReportsData("tenant-A");
    const kids = await getReportsData("tenant-A", { ageGroup: "kids" });
    const adults = await getReportsData("tenant-A", { ageGroup: "adult" });
    expect(all.churn.cancelled).toBe(3);
    expect([kids.churn, adults.churn]).toEqual([all.churn, all.churn]);
    expect(kids.filters.ageGroup).toBe("kids");
  });

  it("D11: joined and net are the movement figures, never the joinedAt or cancelledAt columns", async () => {
    // The fixture's joinedAt count says 1 and its cancelledAt count says 4;
    // with no status events nobody joined or left by the movement definition.
    setup({ ...BASE, cancelledThisMonth: 4, joinedThisMonth: 1 });
    const data = await getReportsData("tenant-A");
    expect(data.churn).toMatchObject({ joined: 0, net: 0, cancelled: 0 });
  });
});

describe("getReportsData — survival and recovery carry their counts", () => {
  it("6-month survival: 15 of 20 → 75%", async () => {
    setup(BASE);
    const data = await getReportsData("tenant-A");
    expect(data.retention).toEqual({ ratePct: 75, survived: 15, cohort: 20 });
    expect(data.retentionRate).toBe(75);
  });

  it("payment recovery: 3 of 4 failed members now paid → 75%", async () => {
    setup(BASE);
    const data = await getReportsData("tenant-A");
    expect(data.paymentHealth.recovery).toEqual({ ratePct: 75, recovered: 3, failedMembers: 4 });
    expect(data.paymentHealth.recoveryRate).toBe(75);
  });

  it("both are null on an empty base", async () => {
    setup({ ...BASE, retentionCohort: 0, retentionSurvived: 0, failedMemberIds: [], recovered: 0 });
    const data = await getReportsData("tenant-A");
    expect(data.retention).toEqual({ ratePct: null, survived: 0, cohort: 0 });
    expect(data.paymentHealth.recovery).toEqual({ ratePct: null, recovered: 0, failedMembers: 0 });
  });
});

describe("getReportsData — current members by status (Q4 A-2 split)", () => {
  it("shares are over current members, add to 100, and carry no cancelled row", async () => {
    setup(BASE);
    const data = await getReportsData("tenant-A");
    expect(data.summary.currentMembers).toBe(12);
    expect(data.summary.cancelledMembers).toBe(5);
    expect(data.currentMembersByStatus.map((r) => r.status)).toEqual(["active", "inactive", "taster"]);
    expect(data.currentMembersByStatus.map((r) => r.percentage)).toEqual([75, 17, 8]);
    expect(data.currentMembersByStatus.reduce((s, r) => s + r.percentage, 0)).toBe(100);
    // The deprecated all-time partition is unchanged for compatibility.
    expect(data.membersByStatus.find((r) => r.status === "cancelled")?.count).toBe(5);
  });
});

describe("getReportsData — the rate readout and fill carry their counts", () => {
  it("attendance-percentage: distinct active attendees of active members", async () => {
    setup(BASE);
    const data = await getReportsData("tenant-A", { attendanceRateMode: "attendance-percentage" });
    expect(data.attendanceRate).toMatchObject({ value: 22, numerator: 2, denominator: 9 });
  });

  it("checkins-per-member: check-ins and active members", async () => {
    setup(BASE);
    const data = await getReportsData("tenant-A", { attendanceRateMode: "checkins-per-member" });
    expect(data.attendanceRate).toMatchObject({ value: 0.3, numerator: 3, denominator: 9 });
  });

  it("fill-rate: check-ins against places, only for classes with capacity", async () => {
    setup(BASE);
    const data = await getReportsData("tenant-A", { attendanceRateMode: "fill-rate" });
    expect(data.attendanceRate).toMatchObject({ value: 20, numerator: 2, denominator: 10 });
    const fundamentals = data.topClasses.find((c) => c.name === "Fundamentals");
    expect(fundamentals).toMatchObject({ count: 2, fillRate: 20, capacityTotal: 10 });
    const openMat = data.topClasses.find((c) => c.name === "Open Mat");
    expect(openMat).toMatchObject({ fillRate: null, capacityTotal: 0 });
  });
});
