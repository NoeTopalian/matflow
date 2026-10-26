// The statistics pages' period (Noe, 26 Oct 2026): one range per page, whole
// club months, presets plus a custom run of months; invalid input is the
// default, never a throw or a phantom filter.
import { describe, it, expect } from "vitest";
import {
  resolveReportPeriod,
  reportPeriodParams,
  inReportRange,
  monthsLabel,
  rangeAsMonthWindow,
  MAX_CUSTOM_MONTHS,
  MIN_CHART_MONTHS,
} from "@/lib/report-period";

const LONDON = "Europe/London";
// 26 Oct 2026, 10:00 UK time (GMT after the 25 Oct changeover).
const NOW = new Date("2026-10-26T10:00:00.000Z");

describe("resolveReportPeriod — presets", () => {
  it("defaults to this month, counted to now", () => {
    const r = resolveReportPeriod({}, NOW, LONDON);
    expect(r).toMatchObject({ key: "this-month", fromMonth: "2026-10", toMonth: "2026-10", isCurrent: true, label: "October 2026" });
    // 1 Oct is BST: club midnight is 23:00Z on 30 Sep.
    expect(r.start).toBe("2026-09-30T23:00:00.000Z");
    expect(r.end).toBe("2026-11-01T00:00:00.000Z");
    expect(r.at).toBe(NOW.toISOString());
    expect(r.months.map((m) => m.monthKey)).toEqual(["2026-10"]);
  });

  it("last month is the whole of September, ending at its last instant", () => {
    const r = resolveReportPeriod({ period: "last-month" }, NOW, LONDON);
    expect(r).toMatchObject({ key: "last-month", fromMonth: "2026-09", toMonth: "2026-09", isCurrent: false, label: "September 2026" });
    expect(r.at).toBe(new Date(new Date("2026-09-30T23:00:00.000Z").getTime() - 1).toISOString());
  });

  it.each([
    ["3m", "2026-08", "Aug – Oct 2026", 3],
    ["6m", "2026-05", "May – Oct 2026", 6],
    ["12m", "2025-11", "Nov 2025 – Oct 2026", 12],
  ])("%s ends with this month and starts %s", (period, from, label, n) => {
    const r = resolveReportPeriod({ period }, NOW, LONDON);
    expect(r).toMatchObject({ key: period, fromMonth: from, toMonth: "2026-10", isCurrent: true, label });
    expect(r.months).toHaveLength(n);
  });

  it("previous is the same number of months straight before", () => {
    expect(resolveReportPeriod({}, NOW, LONDON).previous.label).toBe("September 2026");
    const r = resolveReportPeriod({ period: "3m" }, NOW, LONDON);
    expect(r.previous.label).toBe("May – Jul 2026");
    expect(r.previous.end).toBe(r.start);
  });
});

describe("resolveReportPeriod — custom months", () => {
  it("accepts a run of whole months ending no later than this month", () => {
    const r = resolveReportPeriod({ period: "custom", from: "2026-01", to: "2026-06" }, NOW, LONDON);
    expect(r).toMatchObject({ key: "custom", fromMonth: "2026-01", toMonth: "2026-06", isCurrent: false, label: "Jan – Jun 2026" });
    expect(r.months).toHaveLength(6);
  });

  it(`accepts exactly ${MAX_CUSTOM_MONTHS} months and refuses one more`, () => {
    expect(resolveReportPeriod({ period: "custom", from: "2024-11", to: "2026-10" }, NOW, LONDON).key).toBe("custom");
    expect(resolveReportPeriod({ period: "custom", from: "2024-10", to: "2026-10" }, NOW, LONDON).key).toBe("this-month");
  });

  it.each<[{ from: string | null; to: string }, string]>([
    [{ from: "2026-06", to: "2026-01" }, "from after to"],
    [{ from: "2026-10", to: "2026-11" }, "ends in the future"],
    [{ from: "2026-13", to: "2026-10" }, "not a month"],
    [{ from: "2026-1", to: "2026-10" }, "malformed"],
    [{ from: null, to: "2026-10" }, "missing from"],
  ])("falls back to this month when %j (%s)", (p) => {
    const r = resolveReportPeriod({ period: "custom", ...p }, NOW, LONDON);
    expect(r).toMatchObject({ key: "this-month", fromMonth: "2026-10", toMonth: "2026-10" });
  });

  it("an unknown period value is the default, not an error", () => {
    expect(resolveReportPeriod({ period: "forever" }, NOW, LONDON).key).toBe("this-month");
  });
});

describe("resolveReportPeriod — old ?weeks= links", () => {
  it.each([
    ["4", "this-month"],
    ["8", "3m"],
    ["12", "3m"],
    ["16", "6m"],
    ["24", "6m"],
    ["abc", "this-month"],
  ])("weeks=%s maps to %s", (weeks, key) => {
    expect(resolveReportPeriod({ weeks }, NOW, LONDON).key).toBe(key);
  });

  it("an explicit period wins over weeks", () => {
    expect(resolveReportPeriod({ period: "12m", weeks: "4" }, NOW, LONDON).key).toBe("12m");
  });
});

describe("chartMonths", () => {
  it(`shows at least ${MIN_CHART_MONTHS} months, ending with the period`, () => {
    const r = resolveReportPeriod({ period: "last-month" }, NOW, LONDON);
    expect(r.chartMonths.map((m) => m.monthKey)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(r.chartMonths.filter((m) => inReportRange(r, m.monthKey)).map((m) => m.monthKey)).toEqual(["2026-09"]);
  });

  it("a period of 6 or more months is charted as it is", () => {
    expect(resolveReportPeriod({ period: "12m" }, NOW, LONDON).chartMonths).toHaveLength(12);
  });
});

describe("club time zone", () => {
  it("a club already in November (Auckland) reports November when London is still in October", () => {
    const late = new Date("2026-10-31T12:00:00.000Z"); // 1 Nov 01:00 in Auckland
    expect(resolveReportPeriod({}, late, "Pacific/Auckland").fromMonth).toBe("2026-11");
    expect(resolveReportPeriod({}, late, LONDON).fromMonth).toBe("2026-10");
  });

  it("an unusable zone falls back to the default zone instead of throwing", () => {
    expect(() => resolveReportPeriod({}, NOW, "Not/AZone")).not.toThrow();
  });

  it("crosses a year boundary", () => {
    const jan = new Date("2027-01-10T12:00:00.000Z");
    const r = resolveReportPeriod({ period: "3m" }, jan, LONDON);
    expect(r).toMatchObject({ fromMonth: "2026-11", toMonth: "2027-01", label: "Nov 2026 – Jan 2027" });
  });
});

describe("helpers", () => {
  it("reportPeriodParams round-trips through the resolver", () => {
    for (const p of [{ period: "3m" }, { period: "custom", from: "2025-12", to: "2026-03" }]) {
      const r = resolveReportPeriod(p, NOW, LONDON);
      expect(resolveReportPeriod(reportPeriodParams(r), NOW, LONDON)).toEqual(r);
    }
  });

  it("monthsLabel names one month in full", () => {
    expect(monthsLabel("2026-02", "2026-02", LONDON)).toBe("February 2026");
  });
});

describe("rangeAsMonthWindow (the Members drill-through for a period)", () => {
  it("a run of months is one window from the first month's start to the end of the last, never 'this month'", () => {
    const w = rangeAsMonthWindow(resolveReportPeriod({ period: "3m" }, NOW, LONDON));
    expect(w).toMatchObject({ monthStart: "2026-07-31T23:00:00.000Z", nextMonthStart: "2026-11-01T00:00:00.000Z", label: "Aug – Oct 2026", isCurrent: false });
  });
  it("one month is that month; the current month on its own is 'this month'", () => {
    expect(rangeAsMonthWindow(resolveReportPeriod({}, NOW, LONDON))).toMatchObject({ monthKey: "2026-10", label: "October 2026", isCurrent: true });
    expect(rangeAsMonthWindow(resolveReportPeriod({ period: "last-month" }, NOW, LONDON))).toMatchObject({ monthKey: "2026-09", isCurrent: false });
  });
});
