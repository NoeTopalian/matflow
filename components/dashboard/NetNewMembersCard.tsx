"use client";

/**
 * Net New Members — one card, three ways of seeing the same six months:
 *   Bars           joined (green) and cancelled (red) per month, as before;
 *   Net line       one line for the net change on a symmetric axis with a
 *                  centre zero line, shaded green above and red below, so the
 *                  line visibly rises or dips with the month;
 *   Running total  the cumulative net from the first month shown, from the
 *                  same zero line — bigger or smaller than at the start.
 * The choice is a per-viewer convenience remembered in localStorage; it never
 * touches the URL because it changes nothing about the data. Colours come
 * from the tokens (UI-RULES §2): the two hues are fill/stroke only, and the
 * text on the tooltip uses the -ink tier.
 */
import { useMemo, useSyncExternalStore } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyChart, SectionTitle, formatNumber, type TooltipPayload } from "./reports-primitives";
import {
  NET_NEW_VIEWS,
  buildNetNewSeries,
  isNetNewEmpty,
  isNetNewView,
  symmetricDomain,
  type NetNewRow,
  type NetNewView,
} from "@/lib/net-new-series";

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
    const raw = window.localStorage.getItem(NET_NEW_VIEW_STORAGE_KEY);
    if (isNetNewView(raw)) v = raw;
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
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
  mode: NetNewView;
}) {
  if (!active || !payload?.length) return null;
  const p = (payload[0]?.payload ?? {}) as Record<string, unknown>;
  const joined = Number(p.joined ?? 0);
  const cancelled = Number(p.cancelled ?? 0);
  const net = Number(p.net ?? 0);
  const running = Number(p.runningNet ?? 0);
  const signed = (n: number) => `${n > 0 ? "+" : ""}${formatNumber(n)}`;
  return (
    <div className="rounded-xl border border-bd-default bg-sf-0 px-3 py-2 text-sm shadow-xl space-y-1">
      <p className="text-xs mb-1 font-semibold text-tx-3">{label}</p>
      <div className="space-y-0.5">
        <p className="text-[var(--hue-success-ink)]">Joined: {formatNumber(joined)}</p>
        <p className="text-[var(--hue-danger-ink)]">Cancelled: {formatNumber(cancelled)}</p>
        <p className={`font-semibold ${net >= 0 ? "text-[var(--hue-success-ink)]" : "text-[var(--hue-danger-ink)]"}`}>
          Net: {signed(net)}
        </p>
        {mode === "running" && (
          <p className={`font-semibold ${running >= 0 ? "text-[var(--hue-success-ink)]" : "text-[var(--hue-danger-ink)]"}`}>
            Since start: {signed(running)}
          </p>
        )}
      </div>
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

export default function NetNewMembersCard({ rows }: { rows: NetNewRow[] }) {
  const view = useSyncExternalStore(subscribe, readStoredView, () => "bars" as NetNewView);

  const points = useMemo(() => buildNetNewSeries(rows), [rows]);
  const empty = isNetNewEmpty(rows);
  const current = NET_NEW_VIEWS.find((v) => v.value === view) ?? NET_NEW_VIEWS[0];

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

  return (
    <Card data-testid="net-new-card">
      <SectionTitle title="Net New Members" subtitle={current.subtitle} icon={TrendingUp} actions={control} fixedSubtitleHeight />
      {empty ? (
        <EmptyChart label="No membership movement data yet" />
      ) : (
        <div role="img" aria-label={`Net new members, ${current.label.toLowerCase()} view`} data-testid="net-new-chart" data-view={view}>
          <ResponsiveContainer width="100%" height={260}>
            {view === "bars" ? (
              <BarChart data={points} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--bd-default)" />
                <XAxis dataKey="month" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<NetNewTooltip mode="bars" />} cursor={{ fill: "var(--sf-2)" }} />
                <Bar dataKey="joined" stackId="a" fill={SUCCESS} radius={[0, 0, 0, 0]} maxBarSize={34} name="Joined" />
                <Bar dataKey="cancelled" stackId="b" fill={DANGER} radius={[6, 6, 0, 0]} maxBarSize={34} name="Cancelled" />
              </BarChart>
            ) : view === "net" ? (
              <ComposedChart data={points} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--bd-default)" />
                <XAxis dataKey="month" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis domain={symmetricDomain(points, "net")} tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<NetNewTooltip mode="net" />} cursor={{ stroke: "var(--bd-default)" }} />
                <Area dataKey="netAbove" baseValue={0} type="monotone" fill={SUCCESS} fillOpacity={0.18} stroke="none" isAnimationActive={false} name="Gained" />
                <Area dataKey="netBelow" baseValue={0} type="monotone" fill={DANGER} fillOpacity={0.18} stroke="none" isAnimationActive={false} name="Lost" />
                <ReferenceLine y={0} stroke="var(--tx-3)" strokeDasharray="4 4" />
                <Line dataKey="net" type="monotone" stroke="var(--tx-1)" strokeWidth={2} dot={<SignedDot />} activeDot={{ r: 5 }} name="Net" />
              </ComposedChart>
            ) : (
              <ComposedChart data={points} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--bd-default)" />
                <XAxis dataKey="month" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                <YAxis domain={symmetricDomain(points, "runningNet")} tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<NetNewTooltip mode="running" />} cursor={{ stroke: "var(--bd-default)" }} />
                <Area
                  dataKey="runningNet"
                  baseValue={0}
                  type="monotone"
                  fill={(points[points.length - 1]?.runningNet ?? 0) >= 0 ? SUCCESS : DANGER}
                  fillOpacity={0.18}
                  stroke="none"
                  isAnimationActive={false}
                  name="Running total"
                />
                <ReferenceLine y={0} stroke="var(--tx-3)" strokeDasharray="4 4" />
                <Line dataKey="runningNet" type="monotone" stroke="var(--tx-1)" strokeWidth={2} dot={{ r: 3, fill: "var(--tx-1)" }} activeDot={{ r: 5 }} name="Running total" />
              </ComposedChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}
