/**
 * lib/reports.ts — Track A (2026-09-21) class/age-group filters.
 *
 * getReportsData() gained two optional filters, `classId` and `ageGroup`,
 * that scope the ATTENDANCE-derived queries only (weekly attendance,
 * check-in methods, top classes, check-ins summary) — never the membership
 * lifecycle ones (growth, churn, retention, payment health). This is a
 * red-on-revert test for both halves of that contract:
 *
 *   1. A resolvable classId/ageGroup actually reaches the attendance where
 *      clauses as a Prisma relation filter (classInstance.classId /
 *      member.accountType).
 *   2. An unresolvable classId (deleted class, foreign id, typo) is dropped
 *      to "no filter" rather than applied as a filter matching nothing —
 *      which would otherwise make a tenant's real attendance silently read
 *      as zero (UI-RULES §7).
 *   3. Membership-lifecycle queries (member.count / member.groupBy) never
 *      pick up the attendance-scope filter fragment.
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

const CLASS_OPTIONS = [
  { id: "c1", name: "Fundamentals" },
  { id: "c2", name: "Kids Class" },
];

function setupDefaultMocks() {
  vi.mocked(prisma.class.findMany).mockResolvedValue(CLASS_OPTIONS as never);
  vi.mocked(prisma.class.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.classInstance.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.attendanceRecord.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.attendanceRecord.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.attendanceRecord.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.member.groupBy).mockResolvedValue([] as never);
  vi.mocked(prisma.member.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.member.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.payment.count).mockResolvedValue(0 as never);
  vi.mocked(prisma.payment.findMany).mockResolvedValue([] as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDefaultMocks();
});

describe("getReportsData — class/age-group filter scope", () => {
  it("echoes back every active class as classOptions, unfiltered by the current selection", async () => {
    const data = await getReportsData("tenant-A", { classId: "c1" });
    expect(data.classOptions).toEqual(CLASS_OPTIONS);
  });

  it("applies a resolvable classId to the attendance-derived queries as a real relation filter", async () => {
    await getReportsData("tenant-A", { classId: "c1" });

    const methodCountsCall = vi.mocked(prisma.attendanceRecord.groupBy).mock.calls
      .find(([args]) => (args as { by: string[] }).by[0] === "checkInMethod");
    expect(methodCountsCall).toBeDefined();
    const where = (methodCountsCall![0] as { where: Record<string, unknown> }).where;
    expect(where.classInstance).toEqual({ classId: "c1" });
  });

  it("resolves the classId against the real class list and echoes className back", async () => {
    const data = await getReportsData("tenant-A", { classId: "c1" });
    expect(data.filters.classId).toBe("c1");
    expect(data.filters.className).toBe("Fundamentals");
  });

  it("drops an unresolvable classId to no filter — never a filter matching nothing", async () => {
    const data = await getReportsData("tenant-A", { classId: "does-not-exist" });

    expect(data.filters.classId).toBeNull();
    expect(data.filters.className).toBeNull();

    // The attendance queries must NOT have been scoped to the bogus id — a
    // phantom filter here would make a tenant's real attendance silently
    // read as zero rather than "no filter applied".
    for (const [args] of vi.mocked(prisma.attendanceRecord.groupBy).mock.calls) {
      expect((args as { where: Record<string, unknown> }).where.classInstance).toBeUndefined();
    }
    for (const [args] of vi.mocked(prisma.attendanceRecord.count).mock.calls) {
      expect((args as { where: Record<string, unknown> }).where.classInstance).toBeUndefined();
    }
  });

  it("applies ageGroup=kids as an accountType-in relation filter on the attendance queries", async () => {
    await getReportsData("tenant-A", { ageGroup: "kids" });

    const countCalls = vi.mocked(prisma.attendanceRecord.count).mock.calls;
    expect(countCalls.length).toBeGreaterThan(0);
    for (const [args] of countCalls) {
      const where = (args as { where: Record<string, unknown> }).where;
      expect(where.member).toEqual({ accountType: { in: ["kids", "junior"] } });
    }
    const data = await getReportsData("tenant-A", { ageGroup: "kids" });
    expect(data.filters.ageGroup).toBe("kids");
  });

  it("applies ageGroup=adult as the adult/parent accountType bucket", async () => {
    await getReportsData("tenant-A", { ageGroup: "adult" });

    const [firstCall] = vi.mocked(prisma.attendanceRecord.count).mock.calls;
    const where = (firstCall[0] as { where: Record<string, unknown> }).where;
    expect(where.member).toEqual({ accountType: { in: ["adult", "parent"] } });
  });

  it("never applies the class/age filter to membership-lifecycle queries (growth, churn, retention)", async () => {
    await getReportsData("tenant-A", { classId: "c1", ageGroup: "kids" });

    for (const [args] of vi.mocked(prisma.member.count).mock.calls) {
      const where = args as Record<string, unknown>;
      expect(where.classInstance).toBeUndefined();
      expect(("accountType" in where)).toBe(false);
    }
    for (const [args] of vi.mocked(prisma.member.groupBy).mock.calls) {
      const where = (args as { where: Record<string, unknown> }).where;
      expect(where.classInstance).toBeUndefined();
    }
  });

  it("with no filters requested, no attendanceScope leaks onto any query", async () => {
    await getReportsData("tenant-A", {});

    for (const [args] of vi.mocked(prisma.attendanceRecord.count).mock.calls) {
      const where = (args as { where: Record<string, unknown> }).where;
      expect(where.classInstance).toBeUndefined();
      expect(where.member).toBeUndefined();
    }
    const data = await getReportsData("tenant-A", {});
    expect(data.filters).toEqual({ classId: null, className: null, ageGroup: null });
  });
});
