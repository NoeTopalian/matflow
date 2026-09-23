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

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    class: { findMany: vi.fn(), count: vi.fn() },
    classInstance: { findMany: vi.fn() },
    attendanceRecord: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    member: { groupBy: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    payment: { count: vi.fn(), findMany: vi.fn() },
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

function setupDefaultMocks() {
  vi.mocked(prisma.class.findMany).mockResolvedValue(CLASS_OPTIONS as never);
  vi.mocked(prisma.class.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.classInstance.findMany).mockResolvedValue(CLASS_INSTANCES as never);
  vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue(WEEKLY_RECORDS as never);
  vi.mocked(prisma.attendanceRecord.groupBy).mockImplementation(((args: unknown) => {
    const by = (args as { by: string[] }).by;
    if (by[0] === "classInstanceId") return Promise.resolve(TOP_RAW as never);
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
    vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([
      { checkInTime: new Date(), memberId: "m1", member: { status: "active" } },
      { checkInTime: new Date(), memberId: "m2", member: { status: "active" } },
      { checkInTime: new Date(), memberId: "m3", member: { status: "active" } },
      { checkInTime: new Date(), memberId: "m4", member: { status: "cancelled" } },
    ] as never);
    vi.mocked(prisma.member.groupBy).mockResolvedValue([{ status: "active", _count: 3 }] as never);

    const data = await getReportsData("tenant-A", { attendanceRateMode: "attendance-percentage" });
    expect(data.attendanceRate.value).toBe(100);
    expect(data.attendanceRate.value).toBeLessThanOrEqual(100);
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
