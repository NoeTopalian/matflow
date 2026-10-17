/**
 * Net-new members: the derived series behind the three views of the Reports
 * card (bars, net line, members). Pure — no React, no I/O — so the arithmetic
 * that decides what the chart draws is unit-tested on its own and the chart
 * only ever draws what this returns.
 *
 * T8c (17 Oct 2026): built from `ReportsData.membership` (movement and
 * headcount replayed from status history, lib/membership-movement.ts). The
 * old "Running total", a cumulative net that started from zero whatever the
 * size of the club, is replaced by "Members": active members at each month
 * end on a zero-based axis, whose last point is the "Active members" tile.
 */
import type { MembershipBasis, MonthHeadcount, MonthMovement } from "./membership-movement";

export type NetNewPoint = {
  /** "YYYY-MM". */
  key: string;
  /** "Oct 26" — the x-axis value. */
  month: string;
  /** new + rejoined: everyone who started in the month. */
  joined: number;
  new: number;
  rejoined: number;
  /** cancelled + completed course. */
  lost: number;
  lostCancelled: number;
  lostCompleted: number;
  net: number;
  /** Active members at month end (now, for the current month); null when the month has no data. */
  headcount: number | null;
  /** The part of `net` above zero (0 when the month lost members) — the green shading. */
  netAbove: number;
  /** The part of `net` below zero (0 when the month gained) — the red shading. */
  netBelow: number;
  /** Movement basis for the month. */
  basis: MembershipBasis;
  headcountBasis: MembershipBasis;
  isCurrentMonth: boolean;
};

export type NetNewView = "bars" | "net" | "members";

export const NET_NEW_VIEWS: { value: NetNewView; label: string; subtitle: string }[] = [
  { value: "bars", label: "Bars", subtitle: "Joined vs lost per month" },
  { value: "net", label: "Net line", subtitle: "Net change per month, against zero" },
  { value: "members", label: "Members", subtitle: "Active members at month end, from zero" },
];

export function isNetNewView(v: unknown): v is NetNewView {
  return v === "bars" || v === "net" || v === "members";
}

/**
 * A remembered view from storage. "running" was the old third view: a viewer
 * who chose it gets the Members view that replaced it.
 */
export function readNetNewView(raw: unknown): NetNewView | null {
  if (raw === "running") return "members";
  return isNetNewView(raw) ? raw : null;
}

/**
 * One point per month, starting at the first month with data: months that
 * ended before the club's earliest event (basis "none") are left out rather
 * than drawn as zero, so the chart never shows a month nobody can account for.
 */
export function buildNetNewSeries(membership: {
  movementsByMonth: readonly MonthMovement[];
  headcountByMonth: readonly MonthHeadcount[];
}): NetNewPoint[] {
  const heads = new Map(membership.headcountByMonth.map((h) => [h.month, h]));
  const firstData = membership.movementsByMonth.findIndex((m) => m.basis !== "none");
  const months = firstData < 0 ? [] : membership.movementsByMonth.slice(firstData);
  return months.map((m) => {
    const h = heads.get(m.month);
    return {
      key: m.month,
      month: m.label,
      joined: m.new + m.rejoined,
      new: m.new,
      rejoined: m.rejoined,
      lost: m.lost,
      lostCancelled: m.lostCancelled,
      lostCompleted: m.lostCompleted,
      net: m.net,
      headcount: h ? h.headcount : null,
      netAbove: Math.max(m.net, 0),
      netBelow: Math.min(m.net, 0),
      basis: m.basis,
      headcountBasis: h?.basis ?? m.basis,
      isCurrentMonth: m.isCurrentMonth,
    };
  });
}

/**
 * A symmetric axis so zero is always the centre line: the largest absolute
 * value on either side, never below 1 so a flat window still draws a line
 * rather than collapsing the axis to a point.
 */
export function symmetricDomain(points: NetNewPoint[], key: "net"): [number, number] {
  const m = points.reduce((acc, p) => Math.max(acc, Math.abs(p[key])), 0);
  const bound = Math.max(1, Math.ceil(m));
  return [-bound, bound];
}

/**
 * The Members axis: always from 0 (Sean's note 4 — a 3-to-12 axis made a
 * small change look like the club quadrupling), up to a round number above
 * the largest month so the top point never sits on the frame. Never below 1.
 */
export function headcountDomain(points: NetNewPoint[]): [0, number] {
  const max = points.reduce((acc, p) => Math.max(acc, p.headcount ?? 0), 0);
  if (max <= 0) return [0, 1];
  const step = max <= 10 ? 2 : max <= 50 ? 10 : max <= 200 ? 25 : max <= 1000 ? 100 : 500;
  return [0, Math.ceil((max + 1) / step) * step];
}

/**
 * The run of wholly estimated months at the start of the window (the months
 * before the first recorded event), for the shaded "estimated" band; null when
 * the first month is not estimated. A partly estimated month is marked in its
 * tooltip instead, so the band never covers a recorded month.
 *
 * `next` is the month after the run (null when the run reaches the end). On a
 * point scale (the Net line and Members views have no bars) a band from
 * `from` to `to` has zero width for one month and stops at the centre of the
 * last estimated month, so those views draw it to `next`: the estimate covers
 * the change into the first recorded month-end.
 */
export function estimatedRange(
  points: NetNewPoint[],
  which: "basis" | "headcountBasis" = "basis",
): { from: string; to: string; next: string | null } | null {
  let end = -1;
  while (end + 1 < points.length && points[end + 1][which] === "estimated") end += 1;
  if (end < 0) return null;
  return { from: points[0].month, to: points[end].month, next: points[end + 1]?.month ?? null };
}

/**
 * Tooltip and CSV words for a month's basis; null when it is recorded.
 * `caption` says what the estimate came from (estimatedCaption in
 * lib/membership-movement.ts); never TeamUp for a club whose estimate is not.
 */
export function basisNote(basis: MembershipBasis, caption = "Estimated"): string | null {
  if (basis === "estimated") return caption;
  if (basis === "mixed") return "Partly estimated";
  if (basis === "none") return "No data";
  return null;
}

/** Nothing to draw: no months, or no movement and no members in any month. */
export function isNetNewEmpty(points: NetNewPoint[]): boolean {
  return points.length === 0 || points.every((p) => p.joined === 0 && p.lost === 0 && !p.headcount);
}
