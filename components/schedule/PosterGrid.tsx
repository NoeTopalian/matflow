"use client";

/**
 * The poster grid: days across, times down, same-time sessions side by side.
 * It draws what lib/timetable-grid worked out and owns WHERE everything sits;
 * a renderer only fills a cell. Layout rules live in app/globals.css (`.pg-*`,
 * UI-RULES §4a.8): each day is one element on a subgrid, the day and mat
 * headers and the time gutter stay pinned inside the grid's own scroll box.
 *
 * Inline styles here are computed grid templates and placements — runtime
 * values, the one sanctioned use (UI-RULES §11).
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { minToTime } from "@/lib/schedule-state";
import type { GridDay, GridMore, GridPlacement, TimetableGrid } from "@/lib/timetable-grid";

export const GUTTER_PX = 36;
export const DAY_GAP_PX = 6;
export const EMPTY_DAY_PX = 40;
export const LANE_MIN_PX = 82;
export const LANE_MAX_PX = 220;
export const DAY_HEAD_PX = 44;
export const MAT_HEAD_PX = 34;

const DAY_SLUG = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const vars = (v: Record<string, string | number>) => v as CSSProperties;

export function PosterGrid({
  grid,
  label,
  today = null,
  matName,
  dayLabel,
  dayHeader,
  emptyDay,
  renderSession,
  renderMore,
  breakLabel,
  scrollTarget = null,
  onOverflowChange,
}: {
  grid: TimetableGrid;
  /** Accessible name of the scroll box ("Week timetable"). */
  label: string;
  /** JS day of week that is today in the week on show, else null. */
  today?: number | null;
  /** Header text of a mat column; called with null for the "No mat" column. */
  matName?: (matId: string | null) => string;
  /** Accessible name of a day's group: "Monday 2 November, 12 sessions, today". */
  dayLabel: (day: GridDay) => string;
  dayHeader: (day: GridDay) => ReactNode;
  emptyDay: (day: GridDay) => ReactNode;
  renderSession: (item: GridPlacement) => ReactNode;
  renderMore: (item: GridMore) => ReactNode;
  breakLabel: (fromMin: number, toMin: number) => string;
  /**
   * Where the box opens: the session to bring under the pinned headers, and
   * the day to bring into view sideways. Scroll positions are assigned — no
   * animation, and focus does not move.
   */
  scrollTarget?: { key: string | null; day: number | null } | null;
  /** Told whenever the grid becomes wider, or stops being wider, than its box. */
  onOverflowChange?: (wider: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const hasMats = grid.days.some((d) => d.columns.length > 0);
  const band = DAY_HEAD_PX + (hasMats ? MAT_HEAD_PX : 0);

  // Columns: the gutter, then per day a gap and its tracks. A day's width
  // follows its lanes; a track is that share of a lane.
  const columns: string[] = [`${GUTTER_PX}px`];
  const dayStart = new Map<number, number>();
  let line = 2;
  let minWidth = GUTTER_PX;
  for (const day of grid.days) {
    columns.push(`${DAY_GAP_PX}px`);
    line += 1;
    minWidth += DAY_GAP_PX;
    dayStart.set(day.day, line);
    if (day.count === 0) {
      columns.push(`${EMPTY_DAY_PX}px`);
      minWidth += EMPTY_DAY_PX;
    } else {
      const share = day.lanes / day.tracks;
      for (let t = 0; t < day.tracks; t++) columns.push(`minmax(${LANE_MIN_PX * share}px, ${LANE_MAX_PX * share}px)`);
      minWidth += LANE_MIN_PX * day.lanes;
    }
    line += day.tracks;
  }
  const rows = [
    `${DAY_HEAD_PX}px`,
    hasMats ? `${MAT_HEAD_PX}px` : "0px",
    ...grid.rows.map((r) => (r.kind === "used" ? `minmax(${r.floorPx}px, auto)` : r.kind === "break" ? "26px" : "10px")),
  ];
  const firstBusyDay = grid.days.find((d) => d.count > 0);
  const breakFrom = firstBusyDay ? (dayStart.get(firstBusyDay.day) ?? 2) : 2;

  // The box ends at the bottom of the window at page scroll 0, so its sideways
  // scrollbar is on screen; and the page hears when the week is wider than
  // the box. One guarded observer: the layout itself never waits for it.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const main = el.closest("main");
    const measure = () => {
      if (main) {
        const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
        const padBottom = parseFloat(getComputedStyle(main).paddingBottom) || 0;
        el.style.maxHeight = `${Math.max(320, Math.floor(main.clientHeight - top - padBottom))}px`;
      }
      onOverflowChange?.(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    if (main) observer.observe(main);
    return () => observer.disconnect();
  }, [onOverflowChange]);

  const targetKey = scrollTarget?.key ?? null;
  const targetDay = scrollTarget?.day ?? null;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const within = (node: Element) => {
      const a = node.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return { top: a.top - b.top + el.scrollTop, left: a.left - b.left + el.scrollLeft, right: a.right - b.left + el.scrollLeft };
    };
    const cell = targetKey === null ? null : Array.from(el.querySelectorAll("[data-cell-key]")).find((n) => n.getAttribute("data-cell-key") === targetKey);
    const head = targetDay === null ? null : el.querySelector(`[data-day-head="${DAY_SLUG[targetDay]}"]`);
    el.scrollTop = cell ? Math.max(0, within(cell).top - band - 4) : 0;
    const across = cell ?? head;
    if (!across) {
      el.scrollLeft = 0;
      return;
    }
    const { left, right } = within(across);
    if (left - GUTTER_PX < el.scrollLeft || right > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, left - GUTTER_PX - DAY_GAP_PX);
  }, [targetKey, targetDay, band]);

  return (
    <div
      ref={box}
      className="pg-box"
      tabIndex={0}
      role="region"
      aria-label={label}
      data-testid="week-scroller"
      style={{ scrollPaddingTop: band + 2, scrollPaddingLeft: GUTTER_PX }}
    >
      <div
        className="pg-grid"
        data-testid="week-grid"
        data-mats={hasMats || undefined}
        style={{ gridTemplateColumns: columns.join(" "), gridTemplateRows: rows.join(" "), minWidth }}
      >
        <div className="pg-gutter-bg" aria-hidden="true" />
        <div className="pg-corner" aria-hidden="true" />
        {grid.rows.map((row, i) =>
          row.kind === "break" ? (
            <div key={`break-${row.fromMin}`} className="pg-break" aria-hidden="true" style={{ gridRow: grid.firstTimeLine + i, gridColumn: `${breakFrom} / -1` }}>
              <span>{breakLabel(row.fromMin, row.toMin)}</span>
              <i />
            </div>
          ) : null,
        )}
        {grid.ticks.map((tick) => (
          <div key={`tick-${tick.minute}`} className="pg-tick" aria-hidden="true" style={{ gridRow: `${tick.rowStart} / ${tick.rowEnd}` }}>
            {minToTime(tick.minute)}
          </div>
        ))}
        {grid.days.map((day) => {
          const start = dayStart.get(day.day) ?? 2;
          const slug = DAY_SLUG[day.day];
          return (
            <section
              key={day.day}
              className="pg-day"
              role="group"
              aria-label={dayLabel(day)}
              data-day={slug}
              data-today={today === day.day || undefined}
              style={{ gridColumn: `${start} / span ${day.tracks}`, ...vars({ "--d": start - 1, "--dt": day.tracks }) }}
            >
              <div className="pg-head" data-day-head={slug}>
                {dayHeader(day)}
              </div>
              {day.columns.map((column) => {
                const name = matName ? matName(column.matId) : "";
                return (
                  <div key={column.matId ?? "none"} className="pg-mat" title={name} style={vars({ "--c": column.col, "--s": column.span })}>
                    <span className="pg-mat-pill">
                      <span>{name}</span>
                    </span>
                  </div>
                );
              })}
              {day.count === 0 ? <div className="pg-empty">{emptyDay(day)}</div> : null}
              {grid.items.map((item) =>
                item.day !== day.day ? null : (
                  <div
                    key={item.type === "session" ? item.key : item.id}
                    className="pg-cell"
                    data-cell-key={item.type === "session" ? item.key : undefined}
                    data-cell-more={item.type === "more" ? item.id : undefined}
                    data-row-start={item.rowStart}
                    data-row-end={item.rowEnd}
                    data-col={item.col}
                    data-lane={item.type === "session" ? item.lane : undefined}
                    data-mat={item.type === "session" ? (item.matId ?? "") : undefined}
                    style={vars({ "--c": item.col, "--s": item.span, "--r1": item.rowStart, "--r2": item.rowEnd })}
                  >
                    {item.type === "session" ? renderSession(item) : renderMore(item)}
                  </div>
                ),
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
