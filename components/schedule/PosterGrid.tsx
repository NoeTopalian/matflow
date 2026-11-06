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

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
  scrollToken = 0,
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
  /**
   * The box is positioned ONCE for each value of this (the week on show), on
   * mount and when it changes — never again on an ordinary re-render. The
   * target moves as the clock does (the live class ends, the next begins); a
   * box that followed it would jump away from where the reader had scrolled
   * the moment they opened a class or saved one.
   */
  scrollToken?: string | number;
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
    // What sits above the box inside the page (a filter line, a banner) can change height without resizing the box.
    const above = el.parentElement?.parentElement ?? null;
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
    if (above && above !== main) observer.observe(above);
    return () => observer.disconnect();
  }, [onOverflowChange]);

  const targetKey = scrollTarget?.key ?? null;
  const targetDay = scrollTarget?.day ?? null;
  // A target folded behind "+N more" has no cell of its own: the box opens on that button instead.
  const foldedInto = targetKey === null ? null : (grid.items.find((i) => i.type === "more" && i.keys.includes(targetKey)) ?? null);
  const targetMore = foldedInto && foldedInto.type === "more" ? foldedInto.id : null;
  const positioned = useRef<{ token: string | number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (positioned.current && positioned.current.token === scrollToken) return;
    positioned.current = { token: scrollToken };
    const within = (node: Element) => {
      const a = node.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return { top: a.top - b.top + el.scrollTop, left: a.left - b.left + el.scrollLeft, right: a.right - b.left + el.scrollLeft };
    };
    const cell =
      targetKey === null
        ? null
        : (Array.from(el.querySelectorAll("[data-cell-key]")).find((n) => n.getAttribute("data-cell-key") === targetKey) ??
          Array.from(el.querySelectorAll("[data-cell-more]")).find((n) => n.getAttribute("data-cell-more") === targetMore) ??
          null);
    const head = targetDay === null ? null : el.querySelector(`[data-day-head="${DAY_SLUG[targetDay]}"]`);
    el.scrollTop = cell ? Math.max(0, within(cell).top - band - 4) : 0;
    const across = cell ?? head;
    if (!across) {
      el.scrollLeft = 0;
      return;
    }
    const { left, right } = within(across);
    if (left - GUTTER_PX < el.scrollLeft || right > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, left - GUTTER_PX - DAY_GAP_PX);
  }, [scrollToken, targetKey, targetMore, targetDay, band]);

  return (
    <div
      ref={box}
      className="pg-box"
      tabIndex={0}
      role="region"
      aria-label={label}
      data-testid="week-scroller"
      // 6 px beyond the pinned band and gutter: a focused chip's ring (3 px out) is never half under them.
      style={{ scrollPaddingTop: band + 6, scrollPaddingLeft: GUTTER_PX + 4 }}
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
                  <div key={column.matId ?? "none"} className="pg-mat" title={name} data-mat-head={column.matId ?? ""} style={vars({ "--c": column.col, "--s": column.span })}>
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

/**
 * One day of the poster grid, for a phone: the staff phone's day and the
 * members' day. The same row lines and columns as the week (so a 20-minute
 * class never sits over the class after it, and two at the same time start on
 * one line), without the day card, the day header or a scroll box of its own:
 * the surface it sits in scrolls. Columns share the width — no minimum lane,
 * no sideways scroll.
 *
 * Mat headers wrap to as many lines as the name needs (nothing is cut where
 * there is no hover). `pinMats` keeps them at the top of the surface's
 * scroller; their background is the surface's own (`--pg-pin-bg`).
 *
 * "+N more": when `openMore` is that item's id, `renderMorePanel` is drawn
 * over the grid at the cluster's first line, across every column, straight
 * after its button in the DOM (so Tab goes from the button into the panel and
 * on to the next class). It takes no part in the row sizes; if it would hang
 * past the end of the grid, the grid grows by that much while it is open.
 */
export function PosterDay({
  grid,
  label,
  matName,
  pinMats = false,
  renderSession,
  renderMore,
  renderMorePanel,
  openMore = null,
  breakLabel,
  testId = "day-poster",
  tone = "staff",
}: {
  /** "member": the members' app paints the pinned mat names on its own shell colour, in its own ink (globals.css). */
  tone?: "staff" | "member";
  /** Built with one day in `days`. */
  grid: TimetableGrid;
  /** Accessible name of the day's group: "Monday 2 November, 12 sessions". */
  label: string;
  matName?: (matId: string | null) => string;
  pinMats?: boolean;
  renderSession: (item: GridPlacement) => ReactNode;
  renderMore: (item: GridMore) => ReactNode;
  renderMorePanel?: (item: GridMore) => ReactNode;
  /** The id of the "+N more" whose panel is open, else null. */
  openMore?: string | null;
  breakLabel: (fromMin: number, toMin: number) => string;
  testId?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [reserve, setReserve] = useState(0);
  const day = grid.days[0];

  useLayoutEffect(() => {
    const grown = () => {
      const g = root.current;
      const p = panel.current;
      if (!g || !p) {
        setReserve(0);
        return;
      }
      // The grid's own end is its bottom less what was reserved last time.
      setReserve((prev) => {
        const need = Math.max(0, Math.ceil(p.getBoundingClientRect().bottom - (g.getBoundingClientRect().bottom - prev)));
        return need === prev ? prev : need;
      });
    };
    grown();
    if (!panel.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(grown);
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, [openMore]);

  if (!day) return null;
  const hasMats = day.columns.length > 0;
  const rows = ["0px", hasMats ? "auto" : "0px", ...grid.rows.map((r) => (r.kind === "used" ? `minmax(${r.floorPx}px, auto)` : r.kind === "break" ? "26px" : "10px"))];

  return (
    <div
      ref={root}
      className="pg-grid"
      role="group"
      aria-label={label}
      data-one-day="true"
      data-tone={tone}
      data-pin-mats={pinMats || undefined}
      data-mats={hasMats || undefined}
      data-day={DAY_SLUG[day.day]}
      data-testid={testId}
      style={{
        gridTemplateColumns: `${GUTTER_PX}px repeat(${day.tracks}, minmax(0, 1fr))`,
        gridTemplateRows: rows.join(" "),
        paddingBottom: reserve > 0 ? reserve : undefined,
        // The day's first track is the grid's second column: cells place themselves with --d + --c, as in the week.
        ...vars({ "--d": 1, "--dt": day.tracks }),
      }}
    >
      {grid.rows.map((row, i) =>
        row.kind === "break" ? (
          <div key={`break-${row.fromMin}`} className="pg-break" aria-hidden="true" style={{ gridRow: grid.firstTimeLine + i, gridColumn: "2 / -1" }}>
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
      {/* The band runs the full width: without this cell the time labels would scroll past the pinned names in the gutter. */}
      {hasMats ? <div className="pg-mat" aria-hidden="true" style={vars({ "--c": 0, "--s": 1 })} /> : null}
      {day.columns.map((column) => {
        const name = matName ? matName(column.matId) : "";
        return (
          <div key={column.matId ?? "none"} className="pg-mat" data-mat-head={column.matId ?? ""} style={vars({ "--c": column.col, "--s": column.span })}>
            <span className="pg-mat-pill">
              <span>{name}</span>
            </span>
          </div>
        );
      })}
      {grid.items.map((item) => (
        <Fragment key={item.type === "session" ? item.key : item.id}>
          <div
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
          {item.type === "more" && openMore === item.id && renderMorePanel ? (
            <div ref={panel} className="pg-panel" data-panel-for={item.id} style={{ gridRow: `${item.clusterRowStart} / ${item.clusterRowStart + 1}` }}>
              {renderMorePanel(item)}
            </div>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}
