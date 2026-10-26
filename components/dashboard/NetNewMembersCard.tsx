"use client";

/**
 * Net New Members — one card, three ways of seeing the same twelve club
 * months (T8c, Q6: agent default adopted 17 Oct 2026; not an owner decision;
 * the movement definition is confirmed by owner instruction of 23 Oct 2026):
 *   Bars      joined (new + rejoined, green) and lost (cancelled or completed
 *             course, red) per month;
 *   Net line  net change per month on a symmetric axis with a centre zero
 *             line, shaded green above and red below;
 *   Members   active members at each month end on an axis that starts at 0
 *             and is labelled, so the size of the club is real (Sean's note
 *             4); the last point is today and equals the "Active members"
 *             tile. It replaces the old "Running total", which started from
 *             zero whatever the size of the club.
 * Above the chart: the window and its tally (new, rejoined, lost, net), not
 * just a signed number, and the definition in words. Months before the first
 * recorded event are shaded and captioned with what they were estimated from
 * (the TeamUp history, or join and cancellation dates); they are never drawn
 * as recorded. Months before the club's earliest event are left out, never
 * drawn as zero. An empty club sees the empty state alone.
 *
 * The view is a per-viewer convenience remembered in localStorage; it never
 * touches the URL because it changes nothing about the data. Colours come
 * from the tokens (UI-RULES §2): the hues are fill/stroke only, and text on
 * the tooltip uses the -ink tier.
 */
import { useMemo, useSyncExternalStore } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyChart, SectionTitle, formatNumber, formatSigned, type TooltipPayload } from "./reports-primitives";
import {
  NET_NEW_VIEWS,
  basisNote,
  buildNetNewSeries,
  estimatedRange,
  headcountDomain,
  isNetNewEmpty,
  partlyEstimatedMonths,
  readNetNewView,
  symmetricDomain,
  type NetNewPoint,
  type NetNewView,
} from "@/lib/net-new-series";
import { MEMBERSHIP_COPY, estimatedCaption } from "@/lib/membership-movement";
import type { MembershipReport } from "@/lib/membership-report";
import { formatDate } from "@/lib/date";

export const NET_NEW_VIEW_STORAGE_KEY = "reports.netNewView";

const SUCCESS = "var(--hue-success)";
const DANGER = "var(--hue-danger)";
const AXIS_TICK = { fill: "var(--tx-3)", fontSize: 11 } as const;

// The remembered view is an external store (localStorage) read through
// useSyncExternalStore: the server snapshot is always "bars" so the first
// client paint matches the HTML, and the stored choice replaces it without a
// setState inside an effect. Storage that throws (a private window) simply
// means the choice does not persist.
let cachedView: NetNewView | null = null;
const listeners = new Set<() => void>();
function readStoredView(): NetNewView {
  if (cachedView) return cachedView;
  let v: NetNewView = "bars";
  try {
    v = readNetNewView(window.localStorage.getItem(NET_NEW_VIEW_STORAGE_KEY)) ?? "bars";
  } catch {
    v = "bars";
  }
  cachedView = v;
  return v;
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
function storeView(view: NetNewView) {
  cachedView = view;
  try {
    window.localStorage.setItem(NET_NEW_VIEW_STORAGE_KEY, view);
  } catch {
    // A private window or blocked storage: the choice simply does not persist.
  }
  for (const cb of listeners) cb();
}
/** Test seam: forget the cached choice so a fresh mount reads storage again. */
export function resetNetNewViewCache() { cachedView = null; }

function NetNewTooltip({
  active,
  payload,
  label,
  mode,
  caption,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
  mode: NetNewView;
  caption: string;
}) {
  if (!active || !payload?.length) return null;
  const p = (payload[0]?.payload ?? {}) as Partial<NetNewPoint>;
  const net = Number(p.net ?? 0);
  const basis = mode === "members" ? p.headcountBasis : p.basis;
  const note = basis ? basisNote(basis, caption) : null;
  return (
    <div className="rounded-xl border border-bd-default bg-sf-0 px-3 py-2 text-sm shadow-xl space-y-1">
      <p className="text-xs mb-1 font-semibold text-tx-3">{label}</p>
      {mode === "members" ? (
        <p className="font-semibold text-tx-1">
          {p.isCurrentMonth ? "Active members today" : MEMBERSHIP_COPY.headcount}: {formatNumber(Number(p.headcount ?? 0))}
        </p>
      ) : (
        <div className="space-y-0.5">
          <p className="text-[var(--hue-success-ink)]">
            Joined: {formatNumber(Number(p.joined ?? 0))} ({formatNumber(Number(p.new ?? 0))} new, {formatNumber(Number(p.rejoined ?? 0))} rejoined)
          </p>
          <p className="text-[var(--hue-danger-ink)]">
            Left: {formatNumber(Number(p.lost ?? 0))} ({formatNumber(Number(p.lostCancelled ?? 0))} cancelled, {formatNumber(Number(p.lostCompleted ?? 0))} completed course)
          </p>
          <p className={`font-semibold ${net >= 0 ? "text-[var(--hue-success-ink)]" : "text-[var(--hue-danger-ink)]"}`}>
            Net: {formatSigned(net)}
          </p>
        </div>
      )}
      {note && <p className="text-xs text-tx-3">{note}</p>}
    </div>
  );
}

/** A dot coloured by the sign of the month it marks (fill/stroke hues, never text). */
function SignedDot(props: { cx?: number; cy?: number; payload?: { net?: number } }) {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined) return null;
  const up = (payload?.net ?? 0) >= 0;
  return <circle cx={cx} cy={cy} r={4} fill={up ? SUCCESS : DANGER} stroke="var(--sf-0)" strokeWidth={1.5} />;
}

/**
 * The shaded band behind wholly estimated months (a fill; its label uses the
 * text token). The bar view has a band scale, so x2 = the last estimated month
 * covers it whole. The line views have a point scale, where that would give a
 * zero-width band for one month, so they run it to the next month's point.
 */
/**
 * Each partly estimated month marked on its own, behind the data: a lighter,
 * dashed-edged band over the month on the bar view; a dashed vertical line at
 * the month's point on the line views (a point scale has no width to shade).
 * Unlabelled on the chart (twelve labels would collide); the note under the
 * chart names the months, and the tooltip says "Partly estimated".
 */
function partlyEstimatedMarks(months: string[], pointScale: boolean) {
  return months.map((month) =>
    pointScale ? (
      <ReferenceLine key={`mixed-${month}`} x={month} stroke="var(--tx-3)" strokeDasharray="2 3" />
    ) : (
      <ReferenceArea
        key={`mixed-${month}`}
        x1={month}
        x2={month}
        fill="var(--sf-2)"
        fillOpacity={0.45}
        stroke="var(--tx-3)"
        strokeDasharray="2 3"
        strokeOpacity={0.6}
      />
    ),
  );
}

function estimatedBand(range: { from: string; to: string; next: string | null } | null, pointScale: boolean) {
  if (!range) return null;
  return (
    <ReferenceArea
      x1={range.from}
      x2={pointScale ? range.next ?? range.to : range.to}
      fill="var(--sf-2)"
      fillOpacity={0.8}
      stroke="none"
      label={{ value: "Estimated", position: "insideTopLeft", fill: "var(--tx-3)", fontSize: 11 }}
    />
  );
}

export default function NetNewMembersCard({ membership }: { membership: MembershipReport }) {
  const view = useSyncExternalStore(subscribe, readStoredView, () => "bars" as NetNewView);

  const points = useMemo(() => buildNetNewSeries(membership), [membership]);
  const empty = isNetNewEmpty(points);
  const current = NET_NEW_VIEWS.find((v) => v.value === view) ?? NET_NEW_VIEWS[0];
  const band = estimatedBand(estimatedRange(points, view === "members" ? "headcountBasis" : "basis"), view !== "bars");
  const anyEstimated = points.some((p) => p.basis !== "recorded" || p.headcountBasis !== "recorded");
  const mixedMonths = partlyEstimatedMonths(points, view === "members" ? "headcountBasis" : "basis");
  const marks = partlyEstimatedMarks(mixedMonths, view !== "bars");
  const caption = estimatedCaption(membership);
  const t = membership.totals;
  const today = points[points.length - 1];
  // The card's last month is today's only when the page's period ends this
  // month (lib/report-period); a past period ends at that month's end.
  const lastMonth = membership.headcountByMonth[membership.headcountByMonth.length - 1];
  const endsToday = lastMonth?.isCurrentMonth ?? true;

  function choose(next: NetNewView) {
    storeView(next);
  }

  const control = (
    <div
      className="inline-flex h-9 items-center rounded-[var(--r-md)] border border-bd-default p-0.5"
      role="group"
      aria-label="Net new members view"
    >
      {NET_NEW_VIEWS.map((opt) => (
        <Button
          key={opt.value}
          type="button"
          size="compact"
          className="rounded-[calc(var(--r-md)-2px)]"
          variant={view === opt.value ? "primary" : "ghost"}
          aria-pressed={view === opt.value}
          onClick={() => choose(opt.value)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );

  const others: string[] = [];
  if (t.imported > 0) others.push(`+${formatNumber(t.imported)} ${MEMBERSHIP_COPY.imported}`);
  if (t.otherIn > 0 || t.otherOut > 0) others.push(`+${formatNumber(t.otherIn)} / −${formatNumber(t.otherOut)} ${MEMBERSHIP_COPY.other}`);

  return (
    <Card data-testid="net-new-card">
      <SectionTitle title="Net New Members" subtitle={current.subtitle} icon={TrendingUp} actions={control} fixedSubtitleHeight />
      {!empty && (
        <div className="mb-3 space-y-1">
          <p className="text-sm text-tx-1" data-testid="net-new-tally">
            <span className="text-tx-3">
              {membership.window.from} – {membership.window.to}:{" "}
            </span>
            <span className="font-semibold tabular-nums">{formatNumber(t.new)}</span> new ·{" "}
            <span className="font-semibold tabular-nums">{formatNumber(t.rejoined)}</span> rejoined ·{" "}
            <span className="font-semibold tabular-nums">{formatNumber(t.lost)}</span> left{" "}
            <span className="text-tx-3">
              ({formatNumber(t.lostCancelled)} cancelled, {formatNumber(t.lostCompleted)} completed course)
            </span>{" "}
            · net <span className="font-semibold tabular-nums">{formatSigned(t.net)}</span>
            {/* D11: tasters added on their own, never in joined or net. */}
            {" "}· <span className="font-semibold tabular-nums">{formatNumber(t.tasterAdded ?? 0)}</span> tasters added
            {today && today.headcount !== null && (
              <>
                {" "}· <span className="font-semibold tabular-nums">{formatNumber(today.headcount)}</span>{" "}
                {endsToday ? "active members today" : `active members at the end of ${lastMonth?.label ?? today.month}`}
              </>
            )}
          </p>
          {others.length > 0 && (
            <p className="text-xs text-tx-3" data-testid="net-new-other-moves">
              Also: {others.join(" · ")}.
            </p>
          )}
          <p className="text-xs text-tx-3" data-testid="net-new-definition">
            {MEMBERSHIP_COPY.definition} Calendar months in the club&apos;s timezone.
          </p>
        </div>
      )}
      {empty ? (
        <EmptyChart label="No membership movement data yet" />
      ) : (
        <div role="img" aria-label={`Net new members, ${current.label.toLowerCase()} view`} data-testid="net-new-chart" data-view={view}>
          <ResponsiveContainer width="100%" height={260}>
            {view === "bars" ? (
              <BarChart data={points} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--bd-default)" />
                {band}
                {marks}
                <XAxis dataKey="month" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<NetNewTooltip mode="bars" caption={caption} />} cursor={{ fill: "var(--sf-2)" }} />
                <Bar dataKey="joined" stackId="a" fill={SUCCESS} radius={[0, 0, 0, 0]} maxBarSize={34} name="Joined" />
                <Bar dataKey="lost" stackId="b" fill={DANGER} radius={[6, 6, 0, 0]} maxBarSize={34} name="Left" />
              </BarChart>
            ) : view === "net" ? (
              <ComposedChart data={points} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--bd-default)" />
                {band}
                {marks}
                <XAxis dataKey="month" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis domain={symmetricDomain(points, "net")} tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<NetNewTooltip mode="net" caption={caption} />} cursor={{ stroke: "var(--bd-default)" }} />
                <Area dataKey="netAbove" baseValue={0} type="monotone" fill={SUCCESS} fillOpacity={0.18} stroke="none" isAnimationActive={false} name="Gained" />
                <Area dataKey="netBelow" baseValue={0} type="monotone" fill={DANGER} fillOpacity={0.18} stroke="none" isAnimationActive={false} name="Left" />
                <ReferenceLine y={0} stroke="var(--tx-3)" strokeDasharray="4 4" />
                <Line dataKey="net" type="monotone" stroke="var(--tx-1)" strokeWidth={2} dot={<SignedDot />} activeDot={{ r: 5 }} name="Net" />
              </ComposedChart>
            ) : (
              <ComposedChart data={points} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--bd-default)" />
                {band}
                {marks}
                <XAxis dataKey="month" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis
                  domain={headcountDomain(points)}
                  tick={AXIS_TICK}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                  width={48}
                  label={{ value: MEMBERSHIP_COPY.headcountAxis, angle: -90, position: "insideLeft", fill: "var(--tx-3)", fontSize: 11 }}
                />
                <Tooltip content={<NetNewTooltip mode="members" caption={caption} />} cursor={{ stroke: "var(--bd-default)" }} />
                <Area dataKey="headcount" baseValue={0} type="monotone" fill="var(--hue-info)" fillOpacity={0.14} stroke="none" isAnimationActive={false} name="Active members" />
                <Line dataKey="headcount" type="monotone" stroke="var(--tx-1)" strokeWidth={2} dot={{ r: 3, fill: "var(--tx-1)" }} activeDot={{ r: 5 }} name="Active members" />
              </ComposedChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
      {!empty && (
        <div className="mt-2 space-y-0.5 text-xs text-tx-3" data-testid="net-new-notes">
          {anyEstimated && (
            <p data-testid="net-new-estimated">
              {membership.boundary
                ? `${caption}: months before ${formatDate(membership.boundary)} are reconstructed, not recorded at the time.`
                : `${caption}: nothing in this window was recorded at the time.`}
            </p>
          )}
          {mixedMonths.length > 0 && (
            <p data-testid="net-new-partly-estimated">
              Partly estimated (dashed): {mixedMonths.join(", ")} — some {view === "members" ? "of the month-end count is" : "of the moves are"} reconstructed, not recorded at the time.
            </p>
          )}
          {membership.undatedHistory > 0 && (
            <p>
              {formatNumber(membership.undatedHistory)} imported {membership.undatedHistory === 1 ? "member has" : "members have"} TeamUp history without dates, so {membership.undatedHistory === 1 ? "is" : "are"} counted from the import day.
            </p>
          )}
          {membership.reconciled > 0 && endsToday && (
            <p>
              {formatNumber(membership.reconciled)} {membership.reconciled === 1 ? "member's" : "members'"} recorded history did not match their current status; counted as other changes this month.
            </p>
          )}
          <p>{MEMBERSHIP_COPY.deletion}</p>
        </div>
      )}
    </Card>
  );
}
