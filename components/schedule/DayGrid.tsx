"use client";

/**
 * A day on a time axis, for the staff timetable's Day view: sessions placed
 * by start and end, overlapping ones side by side in lanes (up to three; a
 * wider clash folds into one group the reader expands), the same `packLanes`
 * and `hourWindow` the member day view uses — so both surfaces agree on what
 * clashes and which hours a club runs. Light-shell tokens.
 *
 * With `columns` (a club split by mat) the day is one column per mat on the
 * same clock scale, in its own scroll box: mat names pinned across the top,
 * the hours pinned down the left, and the lanes packed inside each mat's
 * column. Without `columns` it is the single run of lanes it always was.
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
  /** With `columns`: the id of the column this session sits in (`null` = the "No mat" column). */
  column?: string | null;
};

/** One mat column of the Day view, in the club's order; `id: null` is "No mat". */
export type DayGridColumn = { id: string | null; name: string };

/**
 * Shortest block, so a 15-minute session is still readable. Below the 44 px
 * touch floor on purpose (UI-RULES §0.4, recorded in the plan): on a time
 * axis a block's height is its duration, and a block never grows past the
 * next session in its lane. The expanded group rows are 44 px.
 */
export const MIN_BLOCK_PX = 28;
/** By mat: the narrowest a lane may be, the hours column and the pinned mat names. */
export const DAY_LANE_MIN_PX = 120;
export const DAY_GUTTER_PX = 48;
export const DAY_HEAD_PX = 34;

type Packed = ReturnType<typeof packLanes>;
/** A run of lanes: the whole day by time, one mat's column by mat. `members` are indexes into `items`. */
type Run = { id: string; column: DayGridColumn | null; members: number[]; packed: Packed; lanes: number };

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
  columns,
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
  /**
   * The day's mat columns, in the club's order. Each item names its column;
   * an item whose column is not listed is drawn in the last one. Omit (or
   * pass none) for a day by time.
   */
  columns?: DayGridColumn[];
}) {
  const spans = items.map((i) => spanMinutes(i.startTime, i.endTime));
  const byMat = !!columns && columns.length > 0;
  const columnIndex = (it: DayGridItem) => {
    if (!columns) return 0;
    const at = columns.findIndex((c) => c.id === (it.column ?? null));
    return at === -1 ? columns.length - 1 : at;
  };
  const runs: Run[] = (byMat ? columns : [null]).map((column, c) => {
    const members = items.map((_, i) => i).filter((i) => !byMat || columnIndex(items[i]) === c);
    const packed = packLanes(members.map((i) => spans[i]), { maxLanes: 3 });
    const lanes = Math.max(1, ...packed.clusters.map((cluster) => (cluster.dense ? 1 : cluster.lanes)));
    return { id: column === null ? "all" : (column.id ?? "none"), column, members, packed, lanes };
  });

  // Open groups, keyed by run and the group's start minute so a re-render with
  // other sessions (another day, an edit) never opens the wrong one.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [focusAfter, setFocusAfter] = useState<{ open: boolean; run: string; startMin: number } | null>(null);
  const groupKey = (run: string, startMin: number) => `${run}:${startMin}`;
  const toggle = (run: string, startMin: number) => {
    const key = groupKey(run, startMin);
    const willOpen = !expanded.has(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(key);
      else next.delete(key);
      return next;
    });
    setFocusAfter({ open: willOpen, run, startMin });
  };
  // The group a caller asked for, by one of its sessions; null when that
  // session is not in a folded group (or not on this day).
  const requestedIndex = openCluster === null ? -1 : items.findIndex((it) => it.key === openCluster);
  const requestedRun = requestedIndex === -1 ? undefined : runs.find((r) => r.members.includes(requestedIndex));
  const requestedCluster = requestedRun ? requestedRun.packed.clusters[requestedRun.packed.placements[requestedRun.members.indexOf(requestedIndex)].cluster] : undefined;
  const requested = requestedRun && requestedCluster?.dense ? groupKey(requestedRun.id, requestedCluster.startMin) : null;
  useEffect(() => {
    if (openCluster === null) return;
    if (requested !== null) {
      const at = requested.lastIndexOf(":");
      setExpanded((prev) => new Set(prev).add(requested));
      setFocusAfter({ open: true, run: requested.slice(0, at), startMin: Number(requested.slice(at + 1)) });
    }
    onOpenClusterHandled?.();
  }, [requested, openCluster, onOpenClusterHandled]);
  // Keep keyboard focus with the group as it opens (first row) or closes (the group button).
  useEffect(() => {
    if (!focusAfter || !root.current) return;
    const within = `[data-day-grid-column="${focusAfter.run}"] `;
    const sel = focusAfter.open
      ? `${within}[data-day-grid-cluster-open="${focusAfter.startMin}"] [data-day-grid-block]`
      : `${within}[data-day-grid-cluster="${focusAfter.startMin}"]`;
    root.current.querySelector<HTMLElement>(sel)?.focus();
    setFocusAfter(null);
  }, [focusAfter]);

  // By mat the day lives in its own scroll box, which ends at the bottom of
  // the window at page scroll 0 (so its sideways scrollbar is on screen), as
  // the week's does. One guarded observer; the layout never waits for it.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const main = el.closest("main");
    const measure = () => {
      if (!main) return;
      const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      const padBottom = parseFloat(getComputedStyle(main).paddingBottom) || 0;
      el.style.maxHeight = `${Math.max(320, Math.floor(main.clientHeight - top - padBottom))}px`;
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !main) return;
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    return () => observer.disconnect();
  }, [byMat]);

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

  const nameOf = (it: DayGridItem, column: DayGridColumn | null) => {
    const state = it.state ?? null;
    const suffix = state !== null && state !== "upcoming" ? ` (${sessionStateLabel(state).toLowerCase()})` : "";
    // By mat the column's name is part of the block's name: the pinned header is not read with it.
    const mat = column ? `, ${column.name}` : "";
    return `${enabled && action ? `${action} ` : ""}${it.name}, ${it.startTime} to ${it.endTime}${mat}${suffix}${it.duplicate ? " (possible duplicate)" : ""}`;
  };

  const block = (i: number, column: DayGridColumn | null, layout: CSSProperties) => {
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
        aria-label={nameOf(it, column)}
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

  // One run in time order, so the DOM and Tab order follow the clock: a clash
  // wider than three lanes is one group block (or its rows once opened);
  // everything else is a block in its lane.
  const lanesOf = (run: Run) => {
    const { packed, members } = run;
    const spanOf = (j: number) => spans[members[j]];
    // The next thing drawn below a block in its horizontal range caps its height,
    // so the 28 px minimum never paints over the session (or group) beneath it —
    // a 10-minute drill followed by a class 15 minutes later included.
    const range = (j: number): [number, number] => {
      const p = packed.placements[j];
      return packed.clusters[p.cluster]?.dense ? [0, 1] : [p.lane / p.lanes, (p.lane + 1) / p.lanes];
    };
    const startOf = (j: number) => {
      const c = packed.clusters[packed.placements[j].cluster];
      return c?.dense ? c.startMin : spanOf(j).startMin;
    };
    const nextBelow = (i: number) => {
      const [l, r] = range(i);
      let cap = Infinity;
      for (let j = 0; j < members.length; j++) {
        if (j === i || startOf(j) <= spanOf(i).startMin) continue;
        const [l2, r2] = range(j);
        if (l2 < r && l < r2) cap = Math.min(cap, topOf(startOf(j)) - topOf(spanOf(i).startMin));
      }
      return cap;
    };
    return packed.clusters.map((cluster) => {
      if (!cluster.dense) {
        return cluster.members.map((j) => {
          const placement = packed.placements[j];
          const width = 100 / placement.lanes;
          return block(members[j], run.column, {
            position: "absolute",
            top: topOf(spanOf(j).startMin),
            height: heightOf(spanOf(j).startMin, spanOf(j).endMin, nextBelow(j)),
            left: `${placement.lane * width}%`,
            width: `calc(${width}% - ${placement.lane === placement.lanes - 1 ? 0 : 4}px)`,
          });
        });
      }
      const top = topOf(cluster.startMin);
      const times = `${minToTime(cluster.startMin)}–${minToTime(cluster.endMin)}`;
      if (!expanded.has(groupKey(run.id, cluster.startMin))) {
        return (
          <Button
            key={`cluster-${cluster.startMin}`}
            variant="ghost"
            onClick={() => toggle(run.id, cluster.startMin)}
            aria-expanded={false}
            data-testid="day-grid-cluster"
            data-day-grid-cluster={cluster.startMin}
            className="absolute left-0 right-0 h-auto min-h-0 flex-col items-start justify-start gap-0 rounded-lg px-2 py-1 text-left overflow-hidden hover:bg-transparent"
            style={{ top, height: Math.max(heightOf(cluster.startMin, cluster.endMin), 44), background: "var(--sf-2)", border: "1px dashed var(--bd-active)", color: "var(--tx-1)" }}
          >
            <span className="block w-full font-semibold leading-tight truncate text-xs">{cluster.members.length} classes at once</span>
            <span className="block w-full leading-tight truncate mt-0.5 text-[10px] tabular-nums" style={{ color: "var(--tx-2)" }}>
              {times} · show them
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
          {cluster.members.map((j) => block(members[j], run.column, { position: "relative", height: 44 }))}
          <Button variant="ghost" size="compact" onClick={() => toggle(run.id, cluster.startMin)} aria-expanded={true} className="w-full text-[11px] font-semibold" style={{ color: "var(--tx-2)" }}>
            Collapse
          </Button>
        </div>
      );
    });
  };

  const hours = Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i);
  const nowLine = isToday && nowTop > 0 && nowTop < totalHeight;

  if (byMat) {
    const minWidth = DAY_GUTTER_PX + runs.reduce((sum, run) => sum + run.lanes * DAY_LANE_MIN_PX, 0);
    return (
      <div
        ref={box}
        className="pg-box"
        tabIndex={0}
        role="region"
        aria-label="Day timetable"
        data-testid="day-scroller"
        // 6 px beyond the pinned names and hours: a focused block's ring is never half under them.
        style={{ scrollPaddingTop: DAY_HEAD_PX + 6, scrollPaddingLeft: DAY_GUTTER_PX + 4 }}
      >
        <div
          ref={root}
          className="relative grid"
          data-testid="day-grid"
          data-mats="true"
          style={{
            gridTemplateColumns: `${DAY_GUTTER_PX}px ${runs.map((run) => `minmax(${run.lanes * DAY_LANE_MIN_PX}px, ${run.lanes}fr)`).join(" ")}`,
            gridTemplateRows: `${DAY_HEAD_PX}px ${totalHeight + 8}px`,
            minWidth,
          }}
        >
          {/* Pinned cells are opaque and sit above the blocks; the corner is pinned both ways. */}
          <div aria-hidden="true" className="sticky left-0 top-0 z-30 border-b border-bd-default bg-sf-1" style={{ gridColumn: 1, gridRow: 1 }} />
          {runs.map((run, c) => (
            <div
              key={run.id}
              className="sticky top-0 z-20 flex min-w-0 items-center justify-center border-b border-bd-default bg-sf-1 px-1"
              style={{ gridColumn: c + 2, gridRow: 1 }}
              title={run.column?.name}
              data-mat-head={run.column?.id ?? ""}
            >
              <span className="line-clamp-2 text-center text-[11px] font-semibold leading-[13px] text-tx-2 [overflow-wrap:anywhere]">{run.column?.name}</span>
            </div>
          ))}
          <div aria-hidden="true" className="sticky left-0 z-10 bg-sf-1" style={{ gridColumn: 1, gridRow: 2 }}>
            {hours.map((hour, i) => (
              <span
                key={hour}
                className="absolute right-2 text-[10px] font-medium leading-none tabular-nums text-tx-2"
                style={{ top: 8 + i * hourHeight - 5 }}
              >
                {String(hour % 24).padStart(2, "0")}:00
              </span>
            ))}
          </div>
          <div aria-hidden="true" className="relative mt-2" style={{ gridColumn: "2 / -1", gridRow: 2, height: totalHeight }}>
            {hours.map((hour, i) => (
              <div key={hour} className="absolute left-0 right-0" style={{ top: i * hourHeight, height: 1, background: "var(--bd-default)" }} />
            ))}
          </div>
          {runs.map((run, c) => (
            <div
              key={run.id}
              className="relative z-0 mt-2"
              style={{ gridColumn: c + 2, gridRow: 2, height: totalHeight }}
              data-day-grid-column={run.id}
            >
              <div className="absolute inset-x-0.5 inset-y-0">{lanesOf(run)}</div>
            </div>
          ))}
          {nowLine && (
            <div
              className="pointer-events-none relative z-[5] mt-2"
              style={{ gridColumn: "2 / -1", gridRow: 2, height: totalHeight }}
            >
              <div className="absolute left-0 right-0 flex items-center" style={{ top: nowTop }} data-testid="day-grid-now">
                <div className="w-2 h-2 rounded-full shrink-0" style={{ background: "var(--hue-danger)" }} />
                <div className="flex-1" style={{ height: 2, background: "var(--hue-danger)" }} />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={root} className="relative ml-12 mr-1" style={{ height: totalHeight }} data-testid="day-grid">
      {hours.map((hour, i) => (
        <div key={hour} className="absolute left-0 right-0 flex items-start" style={{ top: i * hourHeight }}>
          <span
            className="absolute text-[10px] font-medium leading-none tabular-nums"
            style={{ left: -44, top: -6, width: 36, textAlign: "right", color: "var(--tx-3)" }}
          >
            {String(hour % 24).padStart(2, "0")}:00
          </span>
          <div className="w-full" style={{ height: 1, background: "var(--bd-default)" }} />
        </div>
      ))}

      {nowLine && (
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

      <div className="absolute left-1 right-0 top-0 bottom-0" data-day-grid-column={runs[0].id}>
        {lanesOf(runs[0])}
      </div>
    </div>
  );
}
