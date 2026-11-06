"use client";

/**
 * A day on a time axis, for the staff timetable's Day view: sessions placed
 * by start and end, overlapping ones side by side in lanes (up to three; a
 * wider clash folds into one group the reader expands), the same `packLanes`
 * and `hourWindow` the member day view uses — so both surfaces agree on what
 * clashes and which hours a club runs. Light-shell tokens; the member view
 * keeps its own dark blocks (the maths is shared, the renderer is per
 * surface — plan decision 1 as revised 4 Nov).
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { hex } from "@/lib/color";
import { minToTime, packLanes, sessionStateLabel, spanMinutes, type SessionState } from "@/lib/schedule-state";

export type DayGridItem = {
  key: string;
  name: string;
  startTime: string;
  endTime: string;
  /** Colour of the class — the tenant colour or the class's own. */
  color: string;
  /** Shown after the time: the mat, else the coach. */
  meta?: string | null;
  /** Today's temporal state (lib/schedule-state); `null` on any other day. */
  state?: SessionState | null;
  /** Looks like the same session entered twice (lib/schedule-state#duplicateSessionKeys). */
  duplicate?: boolean;
};

/**
 * Shortest block, so a 15-minute session is still readable. Below the 44 px
 * touch floor on purpose (UI-RULES §0.4, recorded in the plan): on a time
 * axis a block's height is its duration, and a block never grows past the
 * next session in its lane. The expanded group rows are 44 px.
 */
export const MIN_BLOCK_PX = 28;

export function DayGrid({
  items,
  startHour,
  endHour,
  hourHeight = 56,
  isToday = false,
  now = new Date(),
  action,
  onActivate,
  emptyText = "No sessions",
  openCluster = null,
  onOpenClusterHandled,
}: {
  items: DayGridItem[];
  startHour: number;
  endHour: number;
  /** Pixels per hour: 56 on the staff desktop view, so a 30-minute class is 28 px. */
  hourHeight?: number;
  isToday?: boolean;
  now?: Date;
  /** Verb for each block's accessible name ("Edit"). Without `onActivate` the blocks are disabled and carry no verb. */
  action?: string;
  onActivate?: (key: string) => void;
  emptyText?: string;
  /**
   * A session key. The folded group that holds that session opens and focus
   * moves to its first block — where the week's "+N more" lands, so the
   * classes it folded are on screen, not behind a second button.
   */
  openCluster?: string | null;
  /**
   * Called once `openCluster` has been acted on, so the caller can drop the
   * request. Without that, coming back to this day (the grid mounts afresh)
   * would open the group again and take focus from whatever was pressed.
   */
  onOpenClusterHandled?: () => void;
}) {
  const spans = items.map((i) => spanMinutes(i.startTime, i.endTime));
  const packed = packLanes(spans, { maxLanes: 3 });
  // Open groups, keyed by the group's start minute so a re-render with other
  // sessions (another day, an edit) never opens the wrong one.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const root = useRef<HTMLDivElement>(null);
  const [focusAfter, setFocusAfter] = useState<{ open: boolean; startMin: number } | null>(null);
  const toggle = (startMin: number) => {
    const willOpen = !expanded.has(startMin);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(startMin);
      else next.delete(startMin);
      return next;
    });
    setFocusAfter({ open: willOpen, startMin });
  };
  // The group a caller asked for, by one of its sessions; null when that
  // session is not in a folded group (or not on this day).
  const requestedIndex = openCluster === null ? -1 : items.findIndex((it) => it.key === openCluster);
  const requestedCluster = requestedIndex === -1 ? undefined : packed.clusters[packed.placements[requestedIndex].cluster];
  const requested = requestedCluster?.dense ? requestedCluster.startMin : null;
  useEffect(() => {
    if (openCluster === null) return;
    if (requested !== null) {
      setExpanded((prev) => new Set(prev).add(requested));
      setFocusAfter({ open: true, startMin: requested });
    }
    onOpenClusterHandled?.();
  }, [requested, openCluster, onOpenClusterHandled]);
  // Keep keyboard focus with the group as it opens (first row) or closes (the group button).
  useEffect(() => {
    if (!focusAfter || !root.current) return;
    const sel = focusAfter.open
      ? `[data-day-grid-cluster-open="${focusAfter.startMin}"] [data-day-grid-block]`
      : `[data-day-grid-cluster="${focusAfter.startMin}"]`;
    root.current.querySelector<HTMLElement>(sel)?.focus();
    setFocusAfter(null);
  }, [focusAfter]);

  const totalHeight = (endHour - startHour) * hourHeight;
  const topOf = (min: number) => Math.max(0, ((min - startHour * 60) / 60) * hourHeight);
  // Height from the span, at least MIN_BLOCK_PX — but a cap (the next session
  // in the lane, the grid's end) beats the minimum, so a block never paints
  // over what follows it or runs off the axis.
  const heightOf = (startMin: number, endMin: number, capAt = Infinity) => {
    const top = topOf(startMin);
    const trimmedAbove = top - ((startMin - startHour * 60) / 60) * hourHeight; // part of the span before the first hour
    const raw = ((endMin - startMin) / 60) * hourHeight - trimmedAbove;
    return Math.max(1, Math.min(Math.max(raw, MIN_BLOCK_PX), capAt, totalHeight - top));
  };
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowTop = topOf(nowMin);
  const enabled = !!onActivate;

  const nameOf = (it: DayGridItem) => {
    const state = it.state ?? null;
    const suffix = state !== null && state !== "upcoming" ? ` (${sessionStateLabel(state).toLowerCase()})` : "";
    return `${enabled && action ? `${action} ` : ""}${it.name}, ${it.startTime} to ${it.endTime}${suffix}${it.duplicate ? " (possible duplicate)" : ""}`;
  };

  const block = (i: number, layout: CSSProperties) => {
    const it = items[i];
    const state = it.state ?? null;
    const showState = state !== null && state !== "upcoming";
    const dim = state === "ended" || state === "cancelled";
    const h = typeof layout.height === "number" ? layout.height : 44;
    const short = h < 40;
    return (
      <Button
        key={it.key}
        variant="ghost"
        disabled={!enabled}
        onClick={() => onActivate?.(it.key)}
        aria-label={nameOf(it)}
        data-session-state={state ?? undefined}
        data-day-grid-block={it.key}
        className="h-auto min-h-0 flex-col items-start justify-start gap-0 rounded-lg px-2 py-1 text-left overflow-hidden hover:bg-transparent enabled:hover:brightness-110 disabled:opacity-100 disabled:cursor-default"
        style={{
          ...layout,
          // Ended and cancelled sessions dim their fill, never their ink (UI-RULES §8).
          background: hex(it.color, dim ? 0.06 : 0.12),
          border: `1px solid ${hex(it.color, dim ? 0.12 : 0.2)}`,
          borderLeft: it.duplicate ? "3px solid var(--hue-warning)" : state === "live" ? `3px solid ${it.color}` : undefined,
          color: "var(--tx-1)",
        }}
      >
        <span className="flex items-center gap-1.5 w-full min-w-0">
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: it.color, opacity: dim ? 0.5 : undefined }} />
          <span className={["font-semibold truncate min-w-0 flex-1", short ? "text-[11px]" : "text-xs", state === "cancelled" ? "line-through" : ""].join(" ")}>
            {it.name}
            {/* A short block has one line: the mat still shows, because it is what tells two of the same class apart. */}
            {short && it.meta ? <span className="font-normal" style={{ color: "var(--tx-2)" }}> · {it.meta}</span> : null}
          </span>
          {it.duplicate && (
            <span
              className="inline-flex items-center rounded-full px-1.5 font-bold uppercase tracking-wide leading-4 text-[9px] shrink-0"
              style={{ background: "color-mix(in srgb, var(--hue-warning) 18%, transparent)", border: "1px solid color-mix(in srgb, var(--hue-warning) 55%, transparent)" }}
            >
              Duplicate?
            </span>
          )}
          {showState && (
            <span
              className="inline-flex items-center gap-1 rounded-full px-1.5 font-bold uppercase tracking-wide leading-4 text-[9px] shrink-0"
              style={{
                background: state === "live" ? "color-mix(in srgb, var(--hue-success) 14%, transparent)" : state === "next" ? "color-mix(in srgb, var(--hue-info) 14%, transparent)" : "var(--sf-2)",
                border: `1px solid ${state === "live" ? "color-mix(in srgb, var(--hue-success) 45%, transparent)" : state === "next" ? "color-mix(in srgb, var(--hue-info) 45%, transparent)" : "var(--bd-default)"}`,
                color: state === "live" ? "var(--hue-success-ink)" : state === "next" ? "var(--hue-info-ink)" : "var(--tx-3)",
              }}
            >
              {sessionStateLabel(state)}
            </span>
          )}
        </span>
        {!short && (
          <span className="block w-full pl-3 text-[10px] tabular-nums truncate" style={{ color: "var(--tx-2)" }}>
            {it.startTime}–{it.endTime}
            {it.meta ? ` · ${it.meta}` : ""}
          </span>
        )}
      </Button>
    );
  };

  // The next thing drawn below a block in its horizontal range caps its height,
  // so the 28 px minimum never paints over the session (or group) beneath it —
  // a 10-minute drill followed by a class 15 minutes later included.
  const span = (j: number): [number, number] => {
    const p = packed.placements[j];
    return packed.clusters[p.cluster]?.dense ? [0, 1] : [p.lane / p.lanes, (p.lane + 1) / p.lanes];
  };
  const startOf = (j: number) => {
    const c = packed.clusters[packed.placements[j].cluster];
    return c?.dense ? c.startMin : spans[j].startMin;
  };
  const nextBelow = (i: number) => {
    const [l, r] = span(i);
    let cap = Infinity;
    for (let j = 0; j < items.length; j++) {
      if (j === i || startOf(j) <= spans[i].startMin) continue;
      const [l2, r2] = span(j);
      if (l2 < r && l < r2) cap = Math.min(cap, topOf(startOf(j)) - topOf(spans[i].startMin));
    }
    return cap;
  };

  return (
    <div ref={root} className="relative ml-12 mr-1" style={{ height: totalHeight }} data-testid="day-grid">
      {Array.from({ length: endHour - startHour + 1 }, (_, i) => {
        const hour = startHour + i;
        return (
          <div key={hour} className="absolute left-0 right-0 flex items-start" style={{ top: i * hourHeight }}>
            <span
              className="absolute text-[10px] font-medium leading-none tabular-nums"
              style={{ left: -44, top: -6, width: 36, textAlign: "right", color: "var(--tx-3)" }}
            >
              {String(hour % 24).padStart(2, "0")}:00
            </span>
            <div className="w-full" style={{ height: 1, background: "var(--bd-default)" }} />
          </div>
        );
      })}

      {isToday && nowTop > 0 && nowTop < totalHeight && (
        <div className="absolute left-0 right-0 flex items-center z-10 pointer-events-none" style={{ top: nowTop }} data-testid="day-grid-now">
          <div className="w-2 h-2 rounded-full -ml-1 shrink-0" style={{ background: "var(--hue-danger)" }} />
          <div className="flex-1" style={{ height: 2, background: "var(--hue-danger)" }} />
        </div>
      )}

      {items.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-sm" style={{ color: "var(--tx-3)" }}>{emptyText}</p>
        </div>
      )}

      {/* One pass in time order, so the DOM and Tab order follow the clock: a
          clash wider than three lanes is one group block (or its rows once
          opened); everything else is a block in its lane. */}
      <div className="absolute left-1 right-0 top-0 bottom-0">
        {packed.clusters.map((cluster) => {
          if (!cluster.dense) {
            return cluster.members.map((i) => {
              const placement = packed.placements[i];
              const width = 100 / placement.lanes;
              return block(i, {
                position: "absolute",
                top: topOf(spans[i].startMin),
                height: heightOf(spans[i].startMin, spans[i].endMin, nextBelow(i)),
                left: `${placement.lane * width}%`,
                width: `calc(${width}% - ${placement.lane === placement.lanes - 1 ? 0 : 4}px)`,
              });
            });
          }
          const top = topOf(cluster.startMin);
          const range = `${minToTime(cluster.startMin)}–${minToTime(cluster.endMin)}`;
          if (!expanded.has(cluster.startMin)) {
            return (
              <Button
                key={`cluster-${cluster.startMin}`}
                variant="ghost"
                onClick={() => toggle(cluster.startMin)}
                aria-expanded={false}
                data-testid="day-grid-cluster"
                data-day-grid-cluster={cluster.startMin}
                className="absolute left-0 right-0 h-auto min-h-0 flex-col items-start justify-start gap-0 rounded-lg px-2 py-1 text-left overflow-hidden hover:bg-transparent"
                style={{ top, height: Math.max(heightOf(cluster.startMin, cluster.endMin), 44), background: "var(--sf-2)", border: "1px dashed var(--bd-active)", color: "var(--tx-1)" }}
              >
                <span className="block w-full font-semibold leading-tight truncate text-xs">{cluster.members.length} classes at once</span>
                <span className="block w-full leading-tight truncate mt-0.5 text-[10px] tabular-nums" style={{ color: "var(--tx-2)" }}>
                  {range} · show them
                </span>
              </Button>
            );
          }
          return (
            <div
              key={`cluster-${cluster.startMin}`}
              className="absolute left-0 right-0 z-20 rounded-lg p-1 flex flex-col gap-1"
              style={{ top, background: "var(--sf-1)", border: "1px solid var(--bd-active)", boxShadow: "var(--shadow-md, 0 4px 12px rgba(0,0,0,0.08))" }}
              data-testid="day-grid-cluster-open"
              data-day-grid-cluster-open={cluster.startMin}
            >
              {cluster.members.map((i) => block(i, { position: "relative", height: 44 }))}
              <Button variant="ghost" size="compact" onClick={() => toggle(cluster.startMin)} aria-expanded={true} className="w-full text-[11px] font-semibold" style={{ color: "var(--tx-2)" }}>
                Collapse
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
