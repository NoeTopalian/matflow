/**
 * The reports cache (lib/reports.ts getReportsDataCached).
 *
 * The 2026-09-24 pilot load run found the report the slowest path in the
 * product (p95 5 s under 25 sessions). The cached read must be keyed so that
 * one club can never be served another's numbers and one filter combination
 * never another's; it revalidates every 60 s and carries the reports tag so a
 * write path can bust it. `generatedAt` is on every result so the page can
 * disclose the age of the figures.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const { unstableCacheMock, calls } = vi.hoisted(() => {
  const calls: { key: string[]; opts: Record<string, unknown> }[] = [];
  return {
    calls,
    unstableCacheMock: vi.fn((_fn: () => unknown, key: string[], opts: Record<string, unknown>) => {
      calls.push({ key, opts });
      return () => Promise.resolve({ __cached: true });
    }),
  };
});
vi.mock("next/cache", () => ({ unstable_cache: unstableCacheMock }));
vi.mock("@/lib/prisma-tenant", () => ({ withTenantContext: vi.fn() }));

import { getReportsDataCached, createEmptyReportsData, REPORTS_CACHE_VERSION } from "@/lib/reports";

beforeEach(() => { calls.length = 0; unstableCacheMock.mockClear(); });

describe("getReportsDataCached", () => {
  it("keys on tenant and on every filter, so no two clubs or windows share an entry", async () => {
    await getReportsDataCached("tenant-A", { weeksBack: 8, classId: "cls_1", ageGroup: "kids", attendanceRateMode: "fill-rate" });
    await getReportsDataCached("tenant-B", { weeksBack: 8, classId: "cls_1", ageGroup: "kids", attendanceRateMode: "fill-rate" });
    await getReportsDataCached("tenant-A", { weeksBack: 12 });
    // An old weeks value keys as the preset it maps to (lib/report-period): 8 and 12 weeks are both "3m".
    expect(calls[0].key).toEqual(["reports", REPORTS_CACHE_VERSION, "tenant-A", "3m", "cls_1", "kids", "fill-rate"]);
    expect(calls[1].key).toEqual(["reports", REPORTS_CACHE_VERSION, "tenant-B", "3m", "cls_1", "kids", "fill-rate"]);
    expect(calls[2].key).toEqual(["reports", REPORTS_CACHE_VERSION, "tenant-A", "3m", "-", "-", "checkins-per-member"]);
    expect(new Set(calls.map((c) => c.key.join("|"))).size).toBe(3);
  });

  it("normalises the key the same way the data layer normalises its inputs (weeks → preset, unknown mode → default)", async () => {
    await getReportsDataCached("tenant-A", { weeksBack: 99, attendanceRateMode: "nonsense", classId: "  " });
    expect(calls[0].key).toEqual(["reports", REPORTS_CACHE_VERSION, "tenant-A", "6m", "-", "-", "checkins-per-member"]);
  });

  it("keys the statistics period: presets by name, a custom run by its months, anything else as the default", async () => {
    await getReportsDataCached("tenant-A", { period: { period: "12m" } });
    await getReportsDataCached("tenant-A", { period: { period: "custom", from: "2026-01", to: "2026-06" } });
    await getReportsDataCached("tenant-A", { period: { period: "custom", from: "2026-1", to: "2026-06" } });
    await getReportsDataCached("tenant-A", { period: { period: "nonsense" } });
    expect(calls.map((c) => c.key[3])).toEqual(["12m", "custom:2026-01:2026-06", "this-month", "this-month"]);
  });

  it("revalidates every 60 seconds under the per-tenant reports tag", async () => {
    await getReportsDataCached("tenant-A");
    expect(calls[0].opts).toEqual({ revalidate: 60, tags: ["reports-tenant-A"] });
  });

  it("carries a shape version token, bumped for the T2b counts, so an old-shape entry is never served to new code", async () => {
    // A 60-second entry written by the previous deployment lacks `churn`,
    // `retention`, `paymentHealth.recovery` and `currentMembersByStatus`;
    // the version in the key keeps the two shapes apart in both directions.
    // v4 (review L4): `period`, the club-zone month window.
    // v5 (review L2): payer and guardian counts in paymentHealth.
    // v6 (T8c merged in): `membership`, movement and headcount by month.
    // v7 (D9 merged in): paymentHealth.otherOwingCount beside `membership`.
    // v8 (24 Oct): otherOwingCount = confirmed debts only, failedToReconcileCount
    // beside it, and monthlySignups[].basis.
    // v9 (26 Oct): the statistics period (range, attendanceBucket,
    // paymentHealth.failedInPeriod, monthlySignups[].inPeriod) and churn over it.
    // v10 (27 Oct): churn is a count of cancellations — no ratePct, no base, no churnRate.
    // v11 (28 Oct): attendanceCoverage and weeklyAttendance[].coverage.
    // v12 (31 Oct): churn carries opening, base and ratePct again (its percentage with counts).
    expect(REPORTS_CACHE_VERSION).toBe("v12");
    await getReportsDataCached("tenant-A");
    expect(calls[0].key[1]).toBe(REPORTS_CACHE_VERSION);
  });

  it("an empty report carries the T2b count fields, with every undefined rate null", () => {
    const empty = createEmptyReportsData();
    expect(empty.churn).toEqual({ cancelled: 0, joined: 0, net: 0, opening: 0, base: 0, ratePct: null });
    expect(empty).not.toHaveProperty("churnRate");
    expect(empty.retention).toEqual({ ratePct: null, survived: 0, cohort: 0 });
    expect(empty.paymentHealth.recovery).toEqual({ ratePct: null, recovered: 0, failedMembers: 0 });
    expect(empty.currentMembersByStatus).toEqual([]);
    expect(empty.summary.currentMembers).toBe(0);
    expect(empty.attendanceRate).toMatchObject({ value: null, numerator: 0, denominator: 0 });
  });

  it("an empty report still says when it was generated", () => {
    const empty = createEmptyReportsData();
    expect(typeof empty.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(empty.generatedAt))).toBe(false);
  });
});
