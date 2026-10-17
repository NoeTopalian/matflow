// The arithmetic behind the Net New Members views (lib/net-new-series.ts),
// built from ReportsData.membership since T8c: joined = new + rejoined, lost
// with its split, the symmetric zero-centred net axis, the zero-based Members
// axis that replaced the zero-start running total, the estimated band, the
// remembered-view upgrade and the empty rule. Pure, so it is pinned here.
import { describe, it, expect } from "vitest";
import {
  NET_NEW_VIEWS,
  basisNote,
  buildNetNewSeries,
  estimatedRange,
  headcountDomain,
  isNetNewEmpty,
  isNetNewView,
  readNetNewView,
  symmetricDomain,
} from "@/lib/net-new-series";
import type { MembershipBasis, MonthHeadcount, MonthMovement } from "@/lib/membership-movement";

function month(
  key: string,
  label: string,
  t: Partial<MonthMovement> & { headcount: number | null },
  basis: MembershipBasis = "recorded",
  headBasis: MembershipBasis = basis,
): { mv: MonthMovement; hc: MonthHeadcount } {
  const n = t.new ?? 0;
  const r = t.rejoined ?? 0;
  const lc = t.lostCancelled ?? 0;
  const lp = t.lostCompleted ?? 0;
  return {
    mv: { month: key, label, new: n, rejoined: r, lostCancelled: lc, lostCompleted: lp, lost: lc + lp, net: n + r - lc - lp, imported: 0, otherIn: 0, otherOut: 0, basis, isCurrentMonth: false },
    hc: { month: key, label, headcount: t.headcount, basis: headBasis, isCurrentMonth: false, at: `${key}-28T00:00:00.000Z` },
  };
}

function membership(months: ReturnType<typeof month>[]) {
  return { movementsByMonth: months.map((m) => m.mv), headcountByMonth: months.map((m) => m.hc) };
}

const fixture = membership([
  month("2026-04", "Apr 26", { new: 4, rejoined: 1, lostCancelled: 2, headcount: 40 }, "estimated"),
  month("2026-05", "May 26", { new: 1, lostCancelled: 3, lostCompleted: 1, headcount: 37 }, "estimated"),
  month("2026-06", "Jun 26", { headcount: 37 }, "mixed", "recorded"),
  month("2026-07", "Jul 26", { new: 6, lostCancelled: 1, headcount: 42 }),
]);

describe("buildNetNewSeries", () => {
  it("joins new and rejoined, keeps the lost split, and carries the headcount for each month", () => {
    const s = buildNetNewSeries(fixture);
    expect(s.map((p) => p.month)).toEqual(["Apr 26", "May 26", "Jun 26", "Jul 26"]);
    expect(s.map((p) => p.joined)).toEqual([5, 1, 0, 6]);
    expect(s.map((p) => p.lost)).toEqual([2, 4, 0, 1]);
    expect(s[1]).toMatchObject({ lostCancelled: 3, lostCompleted: 1 });
    expect(s.map((p) => p.net)).toEqual([3, -3, 0, 5]);
    expect(s.map((p) => p.headcount)).toEqual([40, 37, 37, 42]);
  });

  it("splits net into the part above zero and the part below, so shading never crosses the centre line", () => {
    const s = buildNetNewSeries(fixture);
    expect(s.map((p) => p.netAbove)).toEqual([3, 0, 0, 5]);
    expect(s.map((p) => p.netBelow)).toEqual([0, -3, 0, 0]);
    for (const p of s) expect(p.netAbove + p.netBelow).toBe(p.net);
  });

  it("returns nothing for nothing", () => {
    expect(buildNetNewSeries({ movementsByMonth: [], headcountByMonth: [] })).toEqual([]);
  });

  it("leaves out the leading months with no data (basis none): never drawn as zero", () => {
    const s = buildNetNewSeries(
      membership([
        month("2026-02", "Feb 26", { headcount: null }, "none"),
        month("2026-03", "Mar 26", { headcount: null }, "none"),
        month("2026-04", "Apr 26", { new: 2, headcount: 2 }, "estimated"),
        month("2026-05", "May 26", { headcount: 2 }),
      ]),
    );
    expect(s.map((p) => p.month)).toEqual(["Apr 26", "May 26"]);
    expect(buildNetNewSeries(membership([month("2026-02", "Feb 26", { headcount: null }, "none")]))).toEqual([]);
  });
});

describe("axes", () => {
  it("the net axis is centred on zero and never collapses to a point", () => {
    expect(symmetricDomain(buildNetNewSeries(fixture), "net")).toEqual([-5, 5]);
    expect(symmetricDomain([], "net")).toEqual([-1, 1]);
  });

  it("the Members axis always starts at 0 and rises above the largest month (note 4: never a 3-to-12 axis)", () => {
    expect(headcountDomain(buildNetNewSeries(fixture))).toEqual([0, 50]);
    const small = buildNetNewSeries(membership([month("2026-09", "Sep 26", { headcount: 3 }), month("2026-10", "Oct 26", { headcount: 12 })]));
    const [lo, hi] = headcountDomain(small);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(12);
    expect(headcountDomain([])).toEqual([0, 1]);
    expect(headcountDomain(buildNetNewSeries(membership([month("2026-10", "Oct 26", { headcount: 531 })]))) [1]).toBe(600);
  });
});

describe("estimated band and notes", () => {
  it("shades only the leading run of wholly estimated months", () => {
    const s = buildNetNewSeries(fixture);
    // `next` lets the point-scale views draw the band to the first recorded month.
    expect(estimatedRange(s)).toEqual({ from: "Apr 26", to: "May 26", next: "Jun 26" });
    expect(estimatedRange(s, "headcountBasis")).toEqual({ from: "Apr 26", to: "May 26", next: "Jun 26" });
    expect(estimatedRange(buildNetNewSeries(membership([month("2026-07", "Jul 26", { headcount: 1 })])))).toBeNull();
    const allEstimated = buildNetNewSeries(membership([month("2026-07", "Jul 26", { headcount: 1 }, "estimated")]));
    expect(estimatedRange(allEstimated)).toEqual({ from: "Jul 26", to: "Jul 26", next: null });
  });

  it("names the basis in words, and says nothing for a recorded month", () => {
    expect(basisNote("estimated", "Estimated from your TeamUp history")).toBe("Estimated from your TeamUp history");
    // Never TeamUp unless the caller says the estimate came from it.
    expect(basisNote("estimated")).toBe("Estimated");
    expect(basisNote("mixed")).toBe("Partly estimated");
    expect(basisNote("none")).toBe("No data");
    expect(basisNote("recorded")).toBeNull();
  });
});

describe("isNetNewEmpty / views", () => {
  it("is empty for no months, and for months with no movement and no members", () => {
    expect(isNetNewEmpty([])).toBe(true);
    expect(isNetNewEmpty(buildNetNewSeries(membership([month("2026-09", "Sep 26", { headcount: 0 })])))).toBe(true);
    expect(isNetNewEmpty(buildNetNewSeries(membership([month("2026-09", "Sep 26", { headcount: 5 })])))).toBe(false);
    expect(isNetNewEmpty(buildNetNewSeries(membership([month("2026-09", "Sep 26", { lostCancelled: 1, headcount: 0 })])))).toBe(false);
  });

  it("names exactly three views, Members in place of Running total, and upgrades a remembered 'running'", () => {
    expect(NET_NEW_VIEWS.map((v) => v.value)).toEqual(["bars", "net", "members"]);
    expect(NET_NEW_VIEWS.map((v) => v.label)).toEqual(["Bars", "Net line", "Members"]);
    expect(isNetNewView("members")).toBe(true);
    expect(isNetNewView("running")).toBe(false);
    expect(readNetNewView("running")).toBe("members");
    expect(readNetNewView("net")).toBe("net");
    expect(readNetNewView("pie")).toBeNull();
    expect(readNetNewView(null)).toBeNull();
  });
});
