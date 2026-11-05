/**
 * The poster grid: one layout for the staff week, the staff phone day and the
 * members' day. Pure data — no React, no pixels, no copy.
 *
 * Rows are the REAL times. Every distinct start and end minute of the sessions
 * on show is a row line; a session spans from its start line to its end line,
 * so two sessions that start together start on the same line on every day.
 * The component sizes each track to its content (`minmax(floorPx, auto)`), so
 * a session is never shorter than its text, and a stretch nobody teaches in
 * collapses to a thin gap or a "No classes" break row.
 *
 * Columns are lanes inside a day:
 *  - by time: `packLanes` (lib/schedule-state) — a session alone takes the
 *    day's full width, sessions that overlap share it;
 *  - by mat: one column per mat, in the club's order, "no mat" last; sessions
 *    that share a mat split that mat's column.
 * More than `maxLanes` at once folds into the first lanes plus one "more"
 * item, so nothing is drawn as a sliver and nothing is hidden.
 */

import { packLanes, spanMinutes } from "@/lib/schedule-state";

export type GridLayout = "time" | "mat";

export interface GridSession {
  key: string;
  /** JS day of week, 0 = Sunday. */
  day: number;
  startTime: string;
  endTime: string;
  matId: string | null;
  /** Tie-break for equal starts and lengths: the mat's place in the club's order, else the typed place. Compared number-aware. */
  tie: string;
}

export interface GridMat {
  id: string;
}

export interface GridOptions {
  /** Days in display order. The week passes `[1, 2, 3, 4, 5, 6, 0]`; a one-day grid passes `[d]`. */
  days: number[];
  layout: GridLayout;
  /** The club's mats in its own order. Ignored by time. */
  mats: GridMat[];
  /** Lanes side by side before folding, by time and inside one mat column. Default 3. */
  maxLanes?: number;
  /** Phones and the members' day pass 3: a by-mat day needing more tracks is laid out by time. */
  maxTracks?: number;
}

export interface GridPlacement {
  key: string;
  day: number;
  /** 1-based track inside the day. */
  col: number;
  span: number;
  /** Lines of the shared row template. */
  rowStart: number;
  rowEnd: number;
  lane: number;
  lanes: number;
  matId: string | null;
}

export interface GridMore {
  id: string;
  day: number;
  col: number;
  span: number;
  rowStart: number;
  rowEnd: number;
  startMin: number;
  endMin: number;
  /** The folded sessions, in time then tie order. */
  keys: string[];
  /** Every session of the cluster, the ones on show included. */
  clusterKeys: string[];
  clusterRowStart: number;
}

export interface GridDay {
  day: number;
  /** Tracks this day spans; a session alone spans them all. */
  tracks: number;
  /** Lanes that drive the day's width: its busiest moment by time, the sum of its mat columns by mat. */
  lanes: number;
  layout: GridLayout;
  /** A by-mat day that needed more tracks than `maxTracks` and was laid out by time. */
  fellBack: boolean;
  /** Mat columns, `matId: null` = no mat. Empty by time. */
  columns: { matId: string | null; col: number; span: number }[];
  count: number;
}

export interface GridRow {
  fromMin: number;
  toMin: number;
  /** used = some session covers it; break = an empty hour or more; gap = a shorter empty stretch. */
  kind: "used" | "gap" | "break";
  floorPx: number;
}

export type GridItem = ({ type: "session" } & GridPlacement) | ({ type: "more" } & GridMore);

export interface TimetableGrid {
  days: GridDay[];
  /** Day, start, column, lane order — the DOM and Tab order. */
  items: GridItem[];
  rows: GridRow[];
  ticks: { minute: number; rowStart: number; rowEnd: number }[];
  /** Line of the first time. Row 1 is the day header, row 2 the mat header. */
  firstTimeLine: number;
}

const FIRST_TIME_LINE = 3;
const DAY_END = 24 * 60;
const TIME = /^\d{1,2}:\d{2}$/;
const numeric = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

type Placed = GridSession & { startMin: number; endMin: number };

/** Minutes on the day's own axis: an overnight end stops at 24:00, and a time that cannot be read still gets a place. */
function onAxis(session: GridSession): Placed {
  if (!TIME.test(session.startTime) || !TIME.test(session.endTime)) return { ...session, startMin: 0, endMin: 10 };
  const span = spanMinutes(session.startTime, session.endTime);
  const startMin = Math.min(Math.max(span.startMin, 0), DAY_END - 10);
  const endMin = Math.min(span.endMin, DAY_END);
  return { ...session, startMin, endMin: endMin > startMin ? endMin : startMin + 10 };
}

const inOrder = (a: Placed, b: Placed) =>
  a.startMin - b.startMin ||
  b.endMin - b.startMin - (a.endMin - a.startMin) ||
  numeric.compare(a.tie, b.tie) ||
  (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;

type Lane = { session: Placed; lane: number; lanes: number };
type Fold = { lane: number; lanes: number; startMin: number; endMin: number; keys: string[]; clusterKeys: string[]; clusterStartMin: number };

/** Lanes for one run of sessions (a day by time, or one mat column), folding any clash wider than `maxLanes`. */
function lanesFor(sessions: Placed[], maxLanes: number): { placed: Lane[]; folds: Fold[]; widest: number } {
  const packed = packLanes(sessions, { maxLanes });
  const placed: Lane[] = [];
  const folds: Fold[] = [];
  let widest = sessions.length ? 1 : 0;
  for (const cluster of packed.clusters) {
    const members = [...cluster.members].sort((a, b) => a - b);
    if (!cluster.dense) {
      widest = Math.max(widest, cluster.lanes);
      for (const i of members) placed.push({ session: sessions[i], lane: packed.placements[i].lane, lanes: cluster.lanes });
      continue;
    }
    widest = Math.max(widest, maxLanes);
    const folded = members.filter((i) => packed.placements[i].lane >= maxLanes - 1);
    for (const i of members) {
      if (packed.placements[i].lane < maxLanes - 1) placed.push({ session: sessions[i], lane: packed.placements[i].lane, lanes: maxLanes });
    }
    folds.push({
      lane: maxLanes - 1,
      lanes: maxLanes,
      startMin: Math.min(...folded.map((i) => sessions[i].startMin)),
      endMin: Math.max(...folded.map((i) => sessions[i].endMin)),
      keys: folded.map((i) => sessions[i].key),
      clusterKeys: members.map((i) => sessions[i].key),
      clusterStartMin: cluster.startMin,
    });
  }
  return { placed, folds, widest };
}

type DayLayout = {
  day: GridDay;
  sessions: { session: Placed; col: number; span: number; lane: number; lanes: number }[];
  folds: (Fold & { col: number; span: number })[];
};

function dayByTime(day: number, sessions: Placed[], maxLanes: number, fellBack: boolean): DayLayout {
  const { placed, folds } = lanesFor(sessions, maxLanes);
  const counts = [...placed.map((p) => p.lanes), ...folds.map((f) => f.lanes)];
  const tracks = counts.reduce(lcm, 1);
  const lanes = counts.length ? Math.max(...counts) : 1;
  return {
    day: { day, tracks, lanes, layout: "time", fellBack, columns: [], count: sessions.length },
    sessions: placed.map((p) => ({ ...p, span: tracks / p.lanes, col: 1 + p.lane * (tracks / p.lanes) })),
    folds: folds.map((f) => ({ ...f, span: tracks / f.lanes, col: 1 + f.lane * (tracks / f.lanes) })),
  };
}

function dayByMat(day: number, sessions: Placed[], mats: GridMat[], maxLanes: number): DayLayout {
  const known = new Set(mats.map((m) => m.id));
  const matOf = (s: Placed) => (s.matId !== null && known.has(s.matId) ? s.matId : null);
  // One or two mats: every mat, every day, as the club's poster has it. Three or more: the mats in use that day.
  const shown: (string | null)[] = (mats.length <= 2 ? mats : mats.filter((m) => sessions.some((s) => matOf(s) === m.id))).map((m) => m.id);
  if (sessions.some((s) => matOf(s) === null)) shown.push(null);

  const layout: DayLayout = {
    day: { day, tracks: 0, lanes: 0, layout: "mat", fellBack: false, columns: [], count: sessions.length },
    sessions: [],
    folds: [],
  };
  let offset = 0;
  for (const matId of shown) {
    const { placed, folds, widest } = lanesFor(sessions.filter((s) => matOf(s) === matId), maxLanes);
    const width = Math.max(1, widest);
    // A column's tracks are its lanes. A narrower clash shares the column evenly when it divides; otherwise one lane each.
    const place = (lane: number, lanes: number) => {
      const span = width % lanes === 0 ? width / lanes : 1;
      return { col: 1 + offset + lane * span, span };
    };
    for (const p of placed) layout.sessions.push({ ...p, ...place(p.lane, p.lanes) });
    for (const f of folds) layout.folds.push({ ...f, ...place(f.lane, f.lanes) });
    layout.day.columns.push({ matId, col: 1 + offset, span: width });
    offset += width;
  }
  layout.day.tracks = Math.max(1, offset);
  layout.day.lanes = Math.max(1, offset);
  return layout;
}

export function buildTimetableGrid(input: GridSession[], opts: GridOptions): TimetableGrid {
  const maxLanes = opts.maxLanes ?? 3;
  const all = input.map(onAxis);

  // Rows: the distinct start and end minutes of everything on show.
  const lines = [...new Set(all.flatMap((s) => [s.startMin, s.endMin]))].sort((a, b) => a - b);
  const lineOf = (minute: number) => FIRST_TIME_LINE + lines.indexOf(minute);
  const rows: GridRow[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const fromMin = lines[i];
    const toMin = lines[i + 1];
    const minutes = toMin - fromMin;
    const used = all.some((s) => s.startMin <= fromMin && s.endMin >= toMin);
    rows.push({ fromMin, toMin, kind: used ? "used" : minutes >= 60 ? "break" : "gap", floorPx: used && minutes > 10 ? Math.round(minutes * 0.6) : 0 });
  }

  // Gutter labels: every start at least 15 minutes after the last labelled one; each runs to the next label.
  const starts = [...new Set(all.map((s) => s.startMin))].sort((a, b) => a - b);
  const labelled: number[] = [];
  for (const m of starts) if (labelled.length === 0 || m - labelled[labelled.length - 1] >= 15) labelled.push(m);
  const lastLine = FIRST_TIME_LINE + Math.max(0, lines.length - 1);
  const ticks = labelled.map((minute, i) => ({ minute, rowStart: lineOf(minute), rowEnd: i + 1 < labelled.length ? lineOf(labelled[i + 1]) : lastLine }));

  const days: GridDay[] = [];
  const items: GridItem[] = [];
  for (const day of opts.days) {
    const sessions = all.filter((s) => s.day === day).sort(inOrder);
    if (sessions.length === 0) {
      days.push({ day, tracks: 1, lanes: 1, layout: opts.layout, fellBack: false, columns: [], count: 0 });
      continue;
    }
    let layout = opts.layout === "mat" ? dayByMat(day, sessions, opts.mats, maxLanes) : dayByTime(day, sessions, maxLanes, false);
    if (opts.layout === "mat" && opts.maxTracks !== undefined && layout.day.tracks > opts.maxTracks) {
      layout = dayByTime(day, sessions, maxLanes, true);
    }
    days.push(layout.day);
    const dayItems: { startMin: number; item: GridItem }[] = [
      ...layout.sessions.map((p) => ({
        startMin: p.session.startMin,
        item: {
          type: "session" as const,
          key: p.session.key,
          day,
          col: p.col,
          span: p.span,
          rowStart: lineOf(p.session.startMin),
          rowEnd: lineOf(p.session.endMin),
          lane: p.lane,
          lanes: p.lanes,
          matId: p.session.matId,
        },
      })),
      ...layout.folds.map((f) => ({
        startMin: f.startMin,
        item: {
          type: "more" as const,
          id: `more-${day}-${f.startMin}-${f.col}`,
          day,
          col: f.col,
          span: f.span,
          rowStart: lineOf(f.startMin),
          rowEnd: lineOf(f.endMin),
          startMin: f.startMin,
          endMin: f.endMin,
          keys: f.keys,
          clusterKeys: f.clusterKeys,
          clusterRowStart: lineOf(f.clusterStartMin),
        },
      })),
    ];
    dayItems.sort((x, y) => x.startMin - y.startMin || x.item.col - y.item.col);
    for (const { item } of dayItems) items.push(item);
  }

  return { days, items, rows, ticks, firstTimeLine: FIRST_TIME_LINE };
}
