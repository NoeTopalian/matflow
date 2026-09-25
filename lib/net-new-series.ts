/**
 * Net-new members: the derived series behind the three views of the Reports
 * card (bars, net line, running total). Pure — no React, no I/O — so the
 * arithmetic that decides whether the line dips or rises is unit-tested on
 * its own and the chart only ever draws what this returns.
 */

export type NetNewRow = { month: string; joined: number; cancelled: number; net: number };

export type NetNewPoint = NetNewRow & {
  /** Cumulative net from the first month shown: where the club stands versus the start of the window. */
  runningNet: number;
  /** The part of `net` above zero (0 when the month lost members) — the green shading. */
  netAbove: number;
  /** The part of `net` below zero (0 when the month gained) — the red shading. */
  netBelow: number;
};

export type NetNewView = "bars" | "net" | "running";

export const NET_NEW_VIEWS: { value: NetNewView; label: string; subtitle: string }[] = [
  { value: "bars", label: "Bars", subtitle: "Joined vs cancelled per month, last 6 months" },
  { value: "net", label: "Net line", subtitle: "Net change per month, against zero" },
  { value: "running", label: "Running total", subtitle: "Running total of net change, from zero" },
];

export function isNetNewView(v: unknown): v is NetNewView {
  return v === "bars" || v === "net" || v === "running";
}

export function buildNetNewSeries(rows: NetNewRow[]): NetNewPoint[] {
  let running = 0;
  return rows.map((r) => {
    const net = Number.isFinite(r.net) ? r.net : r.joined - r.cancelled;
    running += net;
    return { ...r, net, runningNet: running, netAbove: Math.max(net, 0), netBelow: Math.min(net, 0) };
  });
}

/**
 * A symmetric axis so zero is always the centre line: the largest absolute
 * value on either side, never below 1 so a flat window still draws a line
 * rather than collapsing the axis to a point.
 */
export function symmetricDomain(points: NetNewPoint[], key: "net" | "runningNet"): [number, number] {
  const m = points.reduce((acc, p) => Math.max(acc, Math.abs(p[key])), 0);
  const bound = Math.max(1, Math.ceil(m));
  return [-bound, bound];
}

/** Nothing to draw: no months, or every month is zero both ways. */
export function isNetNewEmpty(rows: NetNewRow[]): boolean {
  return rows.length === 0 || rows.every((r) => r.joined === 0 && r.cancelled === 0);
}
