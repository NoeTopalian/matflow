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

import { getReportsDataCached, createEmptyReportsData } from "@/lib/reports";

beforeEach(() => { calls.length = 0; unstableCacheMock.mockClear(); });

describe("getReportsDataCached", () => {
  it("keys on tenant and on every filter, so no two clubs or windows share an entry", async () => {
    await getReportsDataCached("tenant-A", { weeksBack: 8, classId: "cls_1", ageGroup: "kids", attendanceRateMode: "fill-rate" });
    await getReportsDataCached("tenant-B", { weeksBack: 8, classId: "cls_1", ageGroup: "kids", attendanceRateMode: "fill-rate" });
    await getReportsDataCached("tenant-A", { weeksBack: 12 });
    expect(calls[0].key).toEqual(["reports", "tenant-A", "8", "cls_1", "kids", "fill-rate"]);
    expect(calls[1].key).toEqual(["reports", "tenant-B", "8", "cls_1", "kids", "fill-rate"]);
    expect(calls[2].key).toEqual(["reports", "tenant-A", "12", "-", "-", "checkins-per-member"]);
    expect(new Set(calls.map((c) => c.key.join("|"))).size).toBe(3);
  });

  it("normalises the key the same way the data layer normalises its inputs (clamped weeks, unknown mode → default)", async () => {
    await getReportsDataCached("tenant-A", { weeksBack: 99, attendanceRateMode: "nonsense", classId: "  " });
    expect(calls[0].key).toEqual(["reports", "tenant-A", "24", "-", "-", "checkins-per-member"]);
  });

  it("revalidates every 60 seconds under the per-tenant reports tag", async () => {
    await getReportsDataCached("tenant-A");
    expect(calls[0].opts).toEqual({ revalidate: 60, tags: ["reports-tenant-A"] });
  });

  it("an empty report still says when it was generated", () => {
    const empty = createEmptyReportsData();
    expect(typeof empty.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(empty.generatedAt))).toBe(false);
  });
});
