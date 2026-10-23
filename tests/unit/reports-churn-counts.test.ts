/**
 * T2b (17 Oct 2026) — lib/reports.ts returns the counts behind every rate.
 *
 * Owner decision Q6: keep the churn formula (cancelled this month ÷ (active
 * now + cancelled this month)) but always show it as "x% (n of m)", with the
 * people who joined in the same month beside it. An empty base is null ("—"),
 * not the "0%" the old Math.max(…, 1) produced. Q4 A-2: status shares are over
 * current members only; cancelled members are a separate count.
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
    // T8c: the membership series reads (lib/membership-report.ts).
    tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) },
    memberStatusEvent: { findMany: vi.fn(async () => []) },
    importedMembership: { findMany: vi.fn(async () => []) },
  },
}));

import { prisma } from "@/lib/prisma";
import { getReportsData } from "@/lib/reports";
import { zonedMonthStart } from "@/lib/club-month";

type Where = Record<string, unknown>;

type Fixture = {
  active: number;
  cancelledThisMonth: number;
  joinedThisMonth: number;
  retentionCohort: number;
  retentionSurvived: number;
  failedMemberIds: string[];
  recovered: number;
  statusGroups: { status: string; _count: number }[];
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
  vi.mocked(prisma.member.findMany).mockResolvedValue([] as never);
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

describe("getReportsData — churn with its counts (T2b, Q6)", () => {
  it("9 active and 1 cancelled this month → 10% (1 of 10), with joined and net for the same month", async () => {
    setup(BASE);
    const data = await getReportsData("tenant-A");
    expect(data.churn).toEqual({ ratePct: 10, cancelled: 1, base: 10, joined: 3, net: 2 });
    // The compatibility field keeps the same number for its numeric readers.
    expect(data.churnRate).toBe(10);
  });

  it("keeps one decimal place (1 of 313 → 0.3)", async () => {
    setup({ ...BASE, active: 312, cancelledThisMonth: 1 });
    const data = await getReportsData("tenant-A");
    expect(data.churn.ratePct).toBe(0.3);
    expect(data.churn.base).toBe(313);
  });

  it("an empty base is null — never the 0% the old Math.max(…, 1) printed", async () => {
    setup({ ...BASE, active: 0, cancelledThisMonth: 0, joinedThisMonth: 0 });
    const data = await getReportsData("tenant-A");
    expect(data.churn).toEqual({ ratePct: null, cancelled: 0, base: 0, joined: 0, net: 0 });
    expect(data.churnRate).toBe(0);
  });

  it("net goes negative when more leave than join", async () => {
    setup({ ...BASE, cancelledThisMonth: 4, joinedThisMonth: 1 });
    const data = await getReportsData("tenant-A");
    expect(data.churn.net).toBe(-3);
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
