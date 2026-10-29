/**
 * lib/reports.ts — Track G (2026-09-22) customisable attendance-rate
 * DEFINITION.
 *
 * getReportsData() gained `attendanceRateMode`, an enum the owner switches
 * between instead of one fixed implicit metric:
 *   - "checkins-per-member": total check-ins ÷ active members, this window
 *   - "attendance-percentage": distinct attendees ÷ active members, this window
 *   - "fill-rate": check-ins ÷ total class capacity, for classes with
 *     capacity set, this window
 *
 * All three are derived from the SAME windowed attendance data the rest of
 * getReportsData() already fetches (attendanceRecord rows + the top-classes
 * groupBy) — no new query, no divergent window from the rest of the page or
 * from the leaderboard's shared period math. Red-on-revert: pins the exact
 * numbers computed from a fixed fixture, and asserts divide-by-zero safety
 * (null, never NaN) for each mode.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

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
    // The coverage start (lib/attendance-coverage, 28 Oct 2026): records since 2020, so every period here is covered
    // and its counts read as they always did. A plain function, so a mock reset never clears it.
    attendanceRecord: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn(), findFirst: async () => ({ checkInTime: new Date("2020-01-01T12:00:00.000Z") }) },
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

const CLASS_OPTIONS = [{ id: "c1", name: "Fundamentals" }];

// Fixture: 3 distinct members generate 5 check-ins across 2 class instances.
// m1 attends twice (i1), m2 once (i1), m3 twice (i2). Class "Fundamentals"
// (i1) has maxCapacity 10; class "Open Mat" (i2) has no capacity set.
const WEEKLY_RECORDS = [
  { checkInTime: new Date(), memberId: "m1", member: { status: "active" } },
  { checkInTime: new Date(), memberId: "m1", member: { status: "active" } },
  { checkInTime: new Date(), memberId: "m2", member: { status: "active" } },
  { checkInTime: new Date(), memberId: "m3", member: { status: "active" } },
  { checkInTime: new Date(), memberId: "m3", member: { status: "active" } },
];

// groupBy(by: classInstanceId) shape: i1 gets 3 check-ins, i2 gets 2.
const TOP_RAW = [
  { classInstanceId: "i1", _count: 3 },
  { classInstanceId: "i2", _count: 2 },
];

const CLASS_INSTANCES = [
  { id: "i1", class: { name: "Fundamentals", maxCapacity: 10 } },
  { id: "i2", class: { name: "Open Mat", maxCapacity: null } },
];


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

let ROWS: AttendRow[] = WEEKLY_RECORDS;

function setupDefaultMocks() {
  ROWS = WEEKLY_RECORDS;
  vi.mocked(prisma.class.findMany).mockResolvedValue(CLASS_OPTIONS as never);
  vi.mocked(prisma.class.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.classInstance.findMany).mockResolvedValue(CLASS_INSTANCES as never);
  vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue(WEEKLY_RECORDS as never);
  vi.mocked(prisma.attendanceRecord.groupBy).mockImplementation(((args: unknown) => {
    const by = (args as { by: string[] }).by;
    if (by[0] === "classInstanceId") return Promise.resolve(TOP_RAW as never);
    if (by[0] === "memberId") return Promise.resolve(attendeeGroups(ROWS, (args as { where: Parameters<typeof attendeeGroups>[1] }).where) as never);
    return Promise.resolve([] as never); // checkInMethod groupBy — unused here
  }) as never);
  vi.mocked(prisma.attendanceRecord.count).mockResolvedValue(5 as never); // totalCheckIns
  vi.mocked(prisma.member.groupBy).mockResolvedValue([{ status: "active", _count: 4 }] as never);
  vi.mocked(prisma.member.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.member.count).mockImplementation(((args: unknown) => {
    const where = (args as { where?: Record<string, unknown> })?.where ?? {};
    if (where.status === "active") return Promise.resolve(4 as never); // active members
    return Promise.resolve(0 as never);
  }) as never);
  vi.mocked(prisma.payment.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.payment.findMany).mockResolvedValue([] as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDefaultMocks();
});

describe("getReportsData — attendanceRateMode", () => {
  it("checkins-per-member: total check-ins ÷ active members (5 ÷ 4 = 1.3)", async () => {
    const data = await getReportsData("tenant-A", { attendanceRateMode: "checkins-per-member" });
    expect(data.attendanceRate.mode).toBe("checkins-per-member");
    expect(data.attendanceRate.value).toBe(1.3);
    expect(data.attendanceRate.label).toBe("Check-ins per active member");
  });

  it("attendance-percentage: distinct attendees ÷ active members (3 ÷ 4 = 75%)", async () => {
    const data = await getReportsData("tenant-A", { attendanceRateMode: "attendance-percentage" });
    expect(data.attendanceRate.mode).toBe("attendance-percentage");
    expect(data.attendanceRate.value).toBe(75);
    expect(data.attendanceRate.label).toBe("Members who attended");
  });

  it("attendance-percentage never exceeds 100%: an ex-member's in-window check-in is excluded from the numerator", async () => {
    // 3 active attendees (m1,m2,m3) + 1 CANCELLED attendee (m4) over 3 active
    // members. The cancelled member's check-in must NOT count toward "members who
    // attended", or the rate reads 4 ÷ 3 = 133% — a "% of members" above 100%,
    // the honesty bug the hostile-owner E2E found. Red-on-revert: without the
    // active-only numerator this asserts 100 but computes 133.
    ROWS = [
      { memberId: "m1", member: { status: "active" } },
      { memberId: "m2", member: { status: "active" } },
      { memberId: "m3", member: { status: "active" } },
      { memberId: "m4", member: { status: "cancelled" } },
    ];
    vi.mocked(prisma.member.groupBy).mockResolvedValue([{ status: "active", _count: 3 }] as never);

    const data = await getReportsData("tenant-A", { attendanceRateMode: "attendance-percentage" });
    expect(data.attendanceRate.value).toBe(100);
    expect(data.attendanceRate.value).toBeLessThanOrEqual(100);
  });

  it("attendance-percentage: a guardian account's check-in is not in the numerator, as it is not in the denominator", async () => {
    // Denominator = ACTIVE_MEMBER (3), which leaves guardians out. A guardian
    // whose status is "active" used to be added to the numerator, so the
    // printed "(n of m)" held a person who is not in m: (4 of 3).
    ROWS = [
      { memberId: "m1", member: { status: "active", accountType: "adult" } },
      { memberId: "m2", member: { status: "active", accountType: "kids" } },
      { memberId: "g1", member: { status: "active", accountType: "parent" } },
    ];
    vi.mocked(prisma.member.groupBy).mockResolvedValue([{ status: "active", _count: 3 }] as never);

    const data = await getReportsData("tenant-A", { attendanceRateMode: "attendance-percentage" });
    expect(data.attendanceRate.numerator).toBe(2);
    expect(data.attendanceRate.denominator).toBe(3);
    // The exclusion is the query's: distinct attendees are counted in the database over ACTIVE_MEMBER.
    const call = vi.mocked(prisma.attendanceRecord.groupBy).mock.calls.find((c) => (c[0] as { by: string[] }).by[0] === "memberId");
    expect((call?.[0] as { where: { member: unknown } }).where.member).toEqual({ accountType: { not: "parent" }, status: "active" });
  });

  it("fill-rate: only capacity-bearing classes count on both sides (3 ÷ 10 = 30%, i2 excluded — no capacity)", async () => {
    const data = await getReportsData("tenant-A", { attendanceRateMode: "fill-rate" });
    expect(data.attendanceRate.mode).toBe("fill-rate");
    expect(data.attendanceRate.value).toBe(30);
    expect(data.attendanceRate.label).toBe("Class fill rate");
  });

  it("an unrecognised mode degrades to the default (checkins-per-member) rather than throwing", async () => {
    const data = await getReportsData("tenant-A", { attendanceRateMode: "not-a-real-mode" });
    expect(data.attendanceRate.mode).toBe("checkins-per-member");
  });

  it("returns all three selectable modes with label + formula for the UI picker", async () => {
    const data = await getReportsData("tenant-A", {});
    expect(data.attendanceRateModes.map((m) => m.mode)).toEqual([
      "checkins-per-member",
      "attendance-percentage",
      "fill-rate",
    ]);
    for (const m of data.attendanceRateModes) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.formula.length).toBeGreaterThan(0);
    }
  });

  describe("divide-by-zero safety — null, never NaN, when a tenant has zero active members", () => {
    beforeEach(() => {
      // activeMembers is read from the status groupBy, not member.count —
      // an empty groupBy means statusCount.get("active") falls through to 0.
      vi.mocked(prisma.member.groupBy).mockResolvedValue([] as never);
    });

    it("checkins-per-member is null with zero active members", async () => {
      const data = await getReportsData("tenant-A", { attendanceRateMode: "checkins-per-member" });
      expect(data.attendanceRate.value).toBeNull();
    });

    it("attendance-percentage is null with zero active members", async () => {
      const data = await getReportsData("tenant-A", { attendanceRateMode: "attendance-percentage" });
      expect(data.attendanceRate.value).toBeNull();
    });
  });

  it("fill-rate is null when no class in the window has capacity set", async () => {
    vi.mocked(prisma.classInstance.findMany).mockResolvedValue([
      { id: "i1", class: { name: "Fundamentals", maxCapacity: null } },
      { id: "i2", class: { name: "Open Mat", maxCapacity: null } },
    ] as never);
    const data = await getReportsData("tenant-A", { attendanceRateMode: "fill-rate" });
    expect(data.attendanceRate.value).toBeNull();
  });

  it("under an age filter the rate denominator is the ACTIVE MEMBERS OF THAT AGE GROUP, not the whole club", async () => {
    // Lane 6 (2026-09-23): "?ageGroup=kids" divided kids' check-ins by ALL
    // active members, so the readout's promised formula was not the one
    // computed. The scoped count is a separate member.count carrying the
    // accountType filter — mock it to 2 while the club-wide groupBy still says 4.
    vi.mocked(prisma.member.count).mockImplementation(((args: unknown) => {
      const where = (args as { where?: Record<string, unknown> })?.where ?? {};
      if (where.status === "active" && where.accountType) return Promise.resolve(2 as never); // active kids
      if (where.status === "active") return Promise.resolve(4 as never);
      return Promise.resolve(0 as never);
    }) as never);
    const data = await getReportsData("tenant-A", { attendanceRateMode: "checkins-per-member", ageGroup: "kids" });
    // 5 check-ins ÷ 2 active kids = 2.5 (red-on-revert: the old code gives 5 ÷ 4 = 1.3)
    expect(data.attendanceRate.value).toBe(2.5);
    // The club-wide summary tile is NOT scoped by the age filter.
    expect(data.summary.activeMembers).toBe(4);
  });

  it("6-month survival and payment recovery are null (not a fake 100%) when their denominators are zero", async () => {
    // The default fixture has no members joined 6+ months ago (retentionBase 0)
    // and no failed payments (recovery 0/0). Both are UNDEFINED, not perfect —
    // they must be null → "—", never 100%. Red-on-revert: the old `: 100`
    // defaults make these 100 and this fails. (Found by the two-club E2E on a
    // fresh club showing a misleading 100%.)
    const data = await getReportsData("tenant-A", {});
    expect(data.retentionRate).toBeNull();
    expect(data.paymentHealth.recoveryRate).toBeNull();
  });
});

// Integration review (26 Oct 2026): "Active classes" and the class filter read
// the timetable's classes the way #41 defines them (lib/class-live): not
// paused, archived or attendance-history imports. They used `isActive` alone
// (the count) or without the import marker (the filter).
describe("getReportsData — class reads use the live-class predicate", () => {
  const LIVE = { tenantId: "tenant-A", isActive: true, deletedAt: null, sourceImportJobId: null };

  it("the Active classes count and the class filter both read live classes only", async () => {
    await getReportsData("tenant-A", {});
    expect(vi.mocked(prisma.class.count)).toHaveBeenCalledWith({ where: LIVE });
    expect(vi.mocked(prisma.class.findMany)).toHaveBeenCalledWith(expect.objectContaining({ where: LIVE }));
  });

  it("the AI report and Analysis page count classes the same way", () => {
    for (const f of ["lib/ai-causal-report.ts", "app/dashboard/analysis/page.tsx"]) {
      const src = readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src, f).toMatch(/tx\.class\.count\(\{ where: liveClassWhere\(tenantId\) \}\)/);
      expect(src, f).not.toMatch(/class\.count\(\{ where: \{ tenantId, isActive: true \} \}\)/);
    }
  });

  it("the Settings class counts (page and GET /api/settings) count live classes too", () => {
    for (const f of ["app/dashboard/settings/page.tsx", "app/api/settings/route.ts"]) {
      const src = readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src, f).toMatch(/classes: \{ where: liveClassWhere\(/);
      expect(src, f).not.toMatch(/classes: \{ where: \{ isActive: true \} \}/);
    }
  });
});

// Review finding 1 (26 Oct 2026): the chart used to read check-in ROWS, capped
// at 10,000 with no order, so a 12-month period at a busy club dropped rows at
// random. Every bar is now a count in the database over its own window.
describe("getReportsData — attendance is counted in the database, never read as rows", () => {
  it("a 12-month period: no attendance rows read, one count per month, 12 monthly bars", async () => {
    const data = await getReportsData("tenant-A", { period: { period: "12m" } });
    expect(vi.mocked(prisma.attendanceRecord.findMany)).not.toHaveBeenCalled();
    expect(data.attendanceBucket).toBe("month");
    expect(data.weeklyAttendance).toHaveLength(12);
    const windows = vi.mocked(prisma.attendanceRecord.count).mock.calls
      .map((c) => (c[0] as { where: { checkInTime?: { gte?: Date; lt?: Date } } }).where.checkInTime)
      .filter((w) => w?.gte && w?.lt);
    for (const m of data.range.months) {
      expect(windows.some((w) => w!.gte!.toISOString() === m.monthStart && w!.lt!.toISOString() === m.nextMonthStart)).toBe(true);
    }
  });

  it("the default (this month) still charts at least 8 weeks, the weeks before the period marked as context", async () => {
    const data = await getReportsData("tenant-A");
    expect(data.attendanceBucket).toBe("week");
    expect(data.weeklyAttendance.length).toBeGreaterThanOrEqual(8);
    expect(data.weeklyAttendance.at(-1)?.inPeriod).toBe(true);
    expect(data.weeklyAttendance.some((w) => w.inPeriod === false)).toBe(true);
  });

  it("a past month's weekly bars add up to its check-ins: an edge week counts only its days inside the period", async () => {
    // One check-in per hour of each counted window, so a bar that reached past
    // the period's edge would add hours the headline does not have.
    vi.mocked(prisma.attendanceRecord.count).mockImplementation((async (args: { where?: { checkInTime?: { gte?: Date; lt?: Date } } }) => {
      const w = args?.where?.checkInTime;
      return w?.gte && w?.lt ? Math.round((w.lt.getTime() - w.gte.getTime()) / 3_600_000) : 0;
    }) as never);
    const data = await getReportsData("tenant-A", { period: { period: "last-month" } });
    expect(data.attendanceBucket).toBe("week");
    const inPeriod = data.weeklyAttendance.filter((w) => w.inPeriod !== false);
    expect(inPeriod.reduce((n, w) => n + w.count, 0)).toBe(data.summary.totalCheckIns);
    expect(data.summary.totalCheckIns).toBeGreaterThan(0);
  });
});
