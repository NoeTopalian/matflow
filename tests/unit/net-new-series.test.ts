// The arithmetic behind the Net New Members views (lib/net-new-series.ts):
// the running total, the symmetric zero-centred axis, the above/below split
// that shades the net line, and the empty rule. Pure, so it is pinned here.
import { describe, it, expect } from "vitest";
import { buildNetNewSeries, symmetricDomain, isNetNewEmpty, isNetNewView, NET_NEW_VIEWS } from "@/lib/net-new-series";

const rows = [
  { month: "Apr", joined: 5, cancelled: 2, net: 3 },
  { month: "May", joined: 1, cancelled: 4, net: -3 },
  { month: "Jun", joined: 0, cancelled: 0, net: 0 },
  { month: "Jul", joined: 6, cancelled: 1, net: 5 },
];

describe("buildNetNewSeries", () => {
  it("carries the running total forward month by month, dipping when a month loses members", () => {
    const s = buildNetNewSeries(rows);
    expect(s.map((p) => p.runningNet)).toEqual([3, 0, 0, 5]);
  });

  it("splits net into the part above zero and the part below, so shading never crosses the centre line", () => {
    const s = buildNetNewSeries(rows);
    expect(s.map((p) => p.netAbove)).toEqual([3, 0, 0, 5]);
    expect(s.map((p) => p.netBelow)).toEqual([0, -3, 0, 0]);
    for (const p of s) expect(p.netAbove + p.netBelow).toBe(p.net);
  });

  it("recomputes net from joined and cancelled when the row's net is not a number", () => {
    const s = buildNetNewSeries([{ month: "Aug", joined: 4, cancelled: 1, net: Number.NaN }]);
    expect(s[0].net).toBe(3);
    expect(s[0].runningNet).toBe(3);
  });

  it("keeps month, joined and cancelled untouched", () => {
    const s = buildNetNewSeries(rows);
    expect(s.map(({ month, joined, cancelled }) => ({ month, joined, cancelled }))).toEqual(rows.map(({ month, joined, cancelled }) => ({ month, joined, cancelled })));
  });

  it("returns nothing for nothing", () => {
    expect(buildNetNewSeries([])).toEqual([]);
  });
});

describe("symmetricDomain", () => {
  it("is centred on zero at the largest absolute value on either side", () => {
    const s = buildNetNewSeries(rows);
    expect(symmetricDomain(s, "net")).toEqual([-5, 5]);
    expect(symmetricDomain(s, "runningNet")).toEqual([-5, 5]);
  });

  it("never collapses to a point: a flat window still spans -1 to 1", () => {
    const flat = buildNetNewSeries([{ month: "Sep", joined: 0, cancelled: 0, net: 0 }]);
    expect(symmetricDomain(flat, "net")).toEqual([-1, 1]);
    expect(symmetricDomain([], "runningNet")).toEqual([-1, 1]);
  });

  it("uses the negative side when losses dominate", () => {
    const s = buildNetNewSeries([{ month: "Oct", joined: 0, cancelled: 7, net: -7 }]);
    expect(symmetricDomain(s, "net")).toEqual([-7, 7]);
  });
});

describe("isNetNewEmpty / views", () => {
  it("is empty for no months and for months with no movement either way", () => {
    expect(isNetNewEmpty([])).toBe(true);
    expect(isNetNewEmpty([{ month: "Sep", joined: 0, cancelled: 0, net: 0 }])).toBe(true);
    expect(isNetNewEmpty([{ month: "Sep", joined: 0, cancelled: 1, net: -1 }])).toBe(false);
  });

  it("names exactly three views and rejects anything else from storage", () => {
    expect(NET_NEW_VIEWS.map((v) => v.value)).toEqual(["bars", "net", "running"]);
    expect(isNetNewView("net")).toBe(true);
    expect(isNetNewView("pie")).toBe(false);
    expect(isNetNewView(null)).toBe(false);
  });
});
