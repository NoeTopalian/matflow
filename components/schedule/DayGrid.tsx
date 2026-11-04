"use client";

/**
 * A day on a time axis, for the staff timetable's Day view: sessions placed
 * by start and end, overlapping ones side by side in lanes (up to three; a
 * wider clash folds into one group the reader expands), the same `packLanes`
 * and `hourWindow` the member day view uses — so both surfaces agree on what
 * clashes and which hours a club runs. Light-shell tokens; the member view
 * keeps its own dark blocks.
 */

import { useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { minToTime, packLanes, sessionStateLabel, spanMinutes, type SessionState } from "@/lib/schedule-state";

export type DayGridItem = {
  key: string;
  name: string;
  startTime: string;
  endTime: string;
  /** CSS colour of the class — the tenant colour or the class's own. */
  color: string;
  /** Shown after the time: the mat, else the coach. */
  meta?: string | null;
  /** Today's temporal state (lib/schedule-state); `null` on any other day. */
  state?: SessionState | null;
  /** Looks like the same session entered twice (lib/schedule-state#duplicateSessionKeys). */
  duplicate?: boolean;
};

export const MIN_BLOCK_PX = 28;
const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export function DayGrid({
  items,
  startHour,
  endHour,
  hourHeight = 36,
  isToday = false,
  now = new Date(),
  action = "Open",
  onActivate,
  emptyText = "No sessions",
}: {
  items: DayGridItem[];
  startHour: number;
  endHour: number;
  /** Pixels per hour: 36 on the staff desktop view. */
  hourHeight?: number;
  isToday?: boolean;
  now?: Date;
  /** Verb for each block's accessible name: "Edit" on the staff view. */
  action?: string;
  onActivate?: (key: string) => void;
  emptyText?: string;
}) {
  const spans = items.map((i) => spanMinutes(i.startTime, i.endTime));
  const packed = packLanes(spans, { maxLanes: 3 });
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const toggle = (index: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const topOf = (min: number) => ((min - startHour * 60) / 60) * hourHeight;
  const heightOf = (startMin: number, endMin: number) => Math.max(((endMin - startMin) / 60) * hourHeight, MIN_BLOCK_PX);
  const totalHeight = (endHour - startHour) * hourHeight;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowTop = topOf(nowMin);

  const nameOf = (it: DayGridItem) => {
    const state = it.state ?? null;
    const suffix = state !== null && state !== "upcoming" ? ` (${sessionStateLabel(state).toLowerCase()})` : "";
    return `${action} ${it.name}, ${it.startTime} to ${it.endTime}${suffix}${it.duplicate ? " (possible duplicate)" : ""}`;
  };

  const block = (i: number, layout: CSSProperties) => {
    const it = items[i];
    const state = it.state ?? null;
    const showState = state !== null && state !== "upcoming";
    const h = typeof layout.height === "number" ? layout.height : 44;
    const short = h < 40;
    return (
      <Button
        key={it.key}
        variant="ghost"
        onClick={() => onActivate?.(it.key)}
        aria-label={nameOf(it)}
        data-session-state={state ?? undefined}
        data-day-grid-block={it.key}
        className="h-auto min-h-0 flex-col items-start justify-start gap-0 rounded-lg px-2 py-1 text-left overflow-hidden hover:bg-transparent hover:brightness-110"
        style={{
          ...layout,
          background: tint(it.color, 12),
          border: `1px solid ${tint(it.color, 30)}`,
          borderLeft: it.duplicate ? "3px solid var(--hue-warning)" : state === "live" ? `3px solid ${it.color}` : undefined,
          opacity: state === "ended" || state === "cancelled" ? 0.55 : undefined,
          color: "var(--tx-1)",
        }}
      >
        <span className="flex items-center gap-1.5 w-full min-w-0">
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: it.color }} />
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

  return (
    <div className="relative ml-12 mr-1" style={{ height: totalHeight }} data-testid="day-grid">
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

      <div className="absolute left-1 right-0 top-0 bottom-0">
        {/* A clash wider than three lanes: one group block, or its sessions as rows once expanded. */}
        {packed.clusters.map((cluster, index) => {
          if (!cluster.dense) return null;
          const top = topOf(cluster.startMin);
          const span = heightOf(cluster.startMin, cluster.endMin);
          const range = `${minToTime(cluster.startMin)}–${minToTime(cluster.endMin)}`;
          if (!expanded.has(index)) {
            return (
              <Button
                key={`cluster-${index}`}
                variant="ghost"
                onClick={() => toggle(index)}
                aria-expanded={false}
                data-testid="day-grid-cluster"
                className="absolute left-0 right-0 h-auto min-h-0 flex-col items-start justify-start gap-0 rounded-lg px-2 py-1 text-left overflow-hidden hover:bg-transparent"
                style={{ top, height: Math.max(span, 44), background: "var(--sf-2)", border: "1px dashed var(--bd-active)", color: "var(--tx-1)" }}
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
              key={`cluster-${index}`}
              className="absolute left-0 right-0 z-20 rounded-lg p-1 flex flex-col gap-1"
              style={{ top, background: "var(--sf-1)", border: "1px solid var(--bd-active)", boxShadow: "var(--shadow-md, 0 4px 12px rgba(0,0,0,0.08))" }}
              data-testid="day-grid-cluster-open"
            >
              {cluster.members.map((i) => block(i, { position: "relative", height: 44 }))}
              <Button variant="ghost" size="compact" onClick={() => toggle(index)} aria-expanded={true} className="w-full text-[11px] font-semibold" style={{ color: "var(--tx-2)" }}>
                Collapse
              </Button>
            </div>
          );
        })}

        {items.map((_, i) => {
          const placement = packed.placements[i];
          if (packed.clusters[placement.cluster]?.dense) return null;
          const width = 100 / placement.lanes;
          return block(i, {
            position: "absolute",
            top: topOf(spans[i].startMin),
            height: heightOf(spans[i].startMin, spans[i].endMin),
            left: `${placement.lane * width}%`,
            width: `calc(${width}% - ${placement.lane === placement.lanes - 1 ? 0 : 4}px)`,
          });
        })}
      </div>
    </div>
  );
}
