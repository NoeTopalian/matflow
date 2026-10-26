/**
 * T2b (17 Oct 2026) — lib/reports.ts returns the counts behind every rate.
 *
 * Churn (D4, settled by Noe 26 Oct 2026: "how it normally is"): members who
 * left during the period ÷ active members just before it opened, always shown
 * as "x% (n of m)", with the people who joined in the same period beside it.
 * Both come from the status history (lib/membership-movement.ts), so the
 * fixtures below are events. No history before the period is a null rate
 * ("—"), never a rate against nothing. Q4 A-2: status shares are over current
 * members only; cancelled members are a separate count.
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

type Ev = { id: string; memberId: string; fromStatus: string | null; toStatus: string; reason: string; sourceAction: null; occurredAt: Date; createdAt: Date };
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
function ev(memberId: string, fromStatus: string | null, toStatus: string, at: Date): Ev {
  seq += 1;
  return { id: `e${String(seq).padStart(5, "0")}`, memberId, fromStatus, toStatus, reason: "staff_edit", sourceAction: null, occurredAt: at, createdAt: at };
}
/** An instant inside this club month that is never after now. */
function thisMonthAt(): Date {
  const start = zonedMonthStart(new Date(), "Europe/London").getTime();
  return new Date(Math.min(start + 60 * 60 * 1000, Date.now() - 1000));
}
/** An instant inside last club month. */
function lastMonthAt(): Date {
  return new Date(zonedMonthStart(new Date(), "Europe/London", -1).getTime() + 2 * 86_400_000);
}
/**
 * `stayers` members active since 2025 and still active; `leaversNow` active
 * since 2025 who cancel this month; `leaversLast` who cancelled last month;
 * `joinersNow` whose first ever start is this month.
 */
function history({ stayers = 0, leaversNow = 0, leaversLast = 0, joinersNow = 0 }): { events: Ev[]; live: Live[] } {
  const events: Ev[] = [];
  const live: Live[] = [];
  const add = (id: string, final: string, moves: [string | null, string, Date][]) => {
    for (const [from, to, at] of moves) events.push(ev(id, from, to, at));
    live.push({ id, status: final, joinedAt: moves[0][2], cancelledAt: final === "cancelled" ? moves[moves.length - 1][2] : null });
  };
  for (let i = 0; i < stayers; i++) add(`s${i}`, "active", [[null, "active", LONG_AGO]]);
  for (let i = 0; i < leaversNow; i++) add(`l${i}`, "cancelled", [[null, "active", LONG_AGO], ["active", "cancelled", thisMonthAt()]]);
  for (let i = 0; i < leaversLast; i++) add(`p${i}`, "cancelled", [[null, "active", LONG_AGO], ["active", "cancelled", lastMonthAt()]]);
  for (let i = 0; i < joinersNow; i++) add(`j${i}`, "active", [[null, "active", thisMonthAt()]]);
  return { events, live };
}

describe("getReportsData — churn the normal way, with its counts", () => {
  it("10 active at the start of the month, 1 leaves → 10% (1 of 10); joined and net for the same month beside it", async () => {
    setup({ ...BASE, history: history({ stayers: 9, leaversNow: 1, joinersNow: 2 }) });
    const data = await getReportsData("tenant-A");
    expect(data.churn).toEqual({ ratePct: 10, cancelled: 1, base: 10, joined: 2, net: 1 });
    // The compatibility field keeps the same number for its numeric readers.
    expect(data.churnRate).toBe(10);
  });

  it("the base is who was active when the period opened: this month's joiners are not in it", async () => {
    setup({ ...BASE, history: history({ stayers: 3, leaversNow: 1, joinersNow: 6 }) });
    const data = await getReportsData("tenant-A");
    expect(data.churn).toMatchObject({ ratePct: 25, cancelled: 1, base: 4, joined: 6, net: 5 });
  });

  it("keeps one decimal place (1 of 313 → 0.3)", async () => {
    setup({ ...BASE, history: history({ stayers: 312, leaversNow: 1 }) });
    const data = await getReportsData("tenant-A");
    expect(data.churn.ratePct).toBe(0.3);
    expect(data.churn.base).toBe(313);
  });

  it("no members at all is null — never a 0% that reads as perfect", async () => {
    setup({ ...BASE, history: history({}) });
    const data = await getReportsData("tenant-A");
    expect(data.churn).toEqual({ ratePct: null, cancelled: 0, base: 0, joined: 0, net: 0 });
    expect(data.churnRate).toBe(0);
  });

  it("no history from before the period: someone left, but there is no base to divide by → null", async () => {
    setup({ ...BASE, history: { events: [ev("x", null, "active", thisMonthAt()), ev("x", "active", "cancelled", new Date(thisMonthAt().getTime() + 1))], live: [{ id: "x", status: "cancelled", joinedAt: thisMonthAt(), cancelledAt: thisMonthAt() }] } });
    const data = await getReportsData("tenant-A");
    expect(data.churn.ratePct).toBeNull();
    expect(data.churn.base).toBe(0);
    expect(data.churn.cancelled).toBe(1);
  });

  it("last month: only last month's leavers, over who was active when last month opened", async () => {
    setup({ ...BASE, history: history({ stayers: 8, leaversLast: 2, leaversNow: 1 }) });
    const data = await getReportsData("tenant-A", { period: { period: "last-month" } });
    expect(data.range.key).toBe("last-month");
    expect(data.churn).toMatchObject({ ratePct: 18.2, cancelled: 2, base: 11 });
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
