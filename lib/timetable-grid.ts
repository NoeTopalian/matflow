/**
 * The poster grid: one layout for the staff week, the staff phone day and the
 * members' day. Pure data — no React, no pixels, no copy.
 *
 * Rows are the REAL times. Every distinct start and end minute of the sessions
 * on show is a row line; a session spans from its start line to its end line,
 * so two sessions that start together start on the same line on every day.
 * One exception, `levelDay`: classes on at once that start under half an hour
 * apart are drawn level, from one line. Each still says its own times.
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
  /**
   * A sliver of ten minutes or less that every session crossing it shares with
   * a longer row: it is exactly `floorPx` tall and takes no part in fitting
   * text. Left to size itself it soaks up the height two classes that overlap
   * by those few minutes each need, and one of them is drawn a third taller
   * than a class of the same length beside it (Noe, 6 Nov 2026).
   */
  fixed?: boolean;
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

/** `startMin` and `endMin` are where the session is DRAWN; `realStartMin` and `realEndMin` are when it runs. */
type Placed = GridSession & { startMin: number; endMin: number; realStartMin: number; realEndMin: number };

/** Minutes on the day's own axis: an overnight end stops at 24:00, and a time that cannot be read still gets a place. */
function onAxis(session: GridSession): Placed {
  if (!TIME.test(session.startTime) || !TIME.test(session.endTime)) return { ...session, startMin: 0, endMin: 10, realStartMin: 0, realEndMin: 10 };
  const span = spanMinutes(session.startTime, session.endTime);
  const startMin = Math.min(Math.max(span.startMin, 0), DAY_END - 1);
  const endMin = Math.max(Math.min(span.endMin, DAY_END), startMin + 1);
  return { ...session, startMin, endMin, realStartMin: startMin, realEndMin: endMin };
}

/** Classes on at once that start (or end) less than this many minutes apart are drawn level. */
export const LEVEL_WITHIN_MIN = 30;

/**
 * Levelling (Noe, 21 Nov 2026): an 11:00 class on one mat and an 11:20 class
 * on the next are on at the same time, and drawn to the minute the second sat
 * a few pixels lower than the first, which read as a mistake. A class that
 * overlaps an earlier one and starts under `LEVEL_WITHIN_MIN` after it is
 * drawn from that class's start line; the classes levelled together also end
 * on one line when their ends are under `LEVEL_WITHIN_MIN` apart.
 *
 * Never at the price of a false clash: a class is only stretched over time in
 * which every other class of the day that is on also really overlaps it. So
 * two classes drawn side by side are always two classes really on at once.
 *
 * Takes one day's sessions in `inOrder`; returns them with the drawn times set.
 */
function levelDay(sessions: Placed[]): Placed[] {
  const out = sessions.map((s) => ({ ...s }));
  const really = (a: Placed, b: Placed) => a.realStartMin < b.realEndMin && b.realStartMin < a.realEndMin;
  // True when every other session drawn inside [from, to) really overlaps `s`.
  const free = (i: number, from: number, to: number) =>
    out.every((k, j) => j === i || !(k.startMin < to && k.endMin > from) || really(k, out[i]));
  const anchorOf = new Array<number>(out.length).fill(-1);
  for (let a = 0; a < out.length; a++) {
    if (anchorOf[a] !== -1) continue;
    anchorOf[a] = a;
    for (let j = a + 1; j < out.length; j++) {
      if (anchorOf[j] !== -1) continue;
      const later = out[j].realStartMin - out[a].realStartMin;
      if (later >= LEVEL_WITHIN_MIN || !really(out[a], out[j])) continue;
      if (later > 0 && !free(j, out[a].realStartMin, out[j].realStartMin)) continue;
      anchorOf[j] = a;
      out[j].startMin = out[a].realStartMin;
    }
  }
  for (let a = 0; a < out.length; a++) {
    if (anchorOf[a] !== a) continue;
    const members = out.map((_, i) => i).filter((i) => anchorOf[i] === a);
    const end = Math.max(...members.map((i) => out[i].realEndMin));
    for (const i of members) {
      const short = end - out[i].realEndMin;
      if (short > 0 && short < LEVEL_WITHIN_MIN && free(i, out[i].realEndMin, end)) out[i].endMin = end;
    }
  }
  return out;
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

const overlap = (a: Placed, b: Placed) => a.startMin < b.endMin && b.startMin < a.endMin;

/**
 * Lanes for one run of sessions (a day by time, or one mat column), folding
 * where more than `maxLanes` are on at once.
 *
 * Folding is per crowded MOMENT, not per overlap cluster: one long class makes
 * a whole day a single cluster, and a pair at 07:00 must not vanish because
 * five classes clash at 18:00. A session folds when it is in a lane beyond the
 * last, or in the last lane while one beyond it is running; every stretch of
 * such sessions becomes its own "+N more" in the last lane. Whatever stays in
 * the last lane cannot overlap a "+N more": it shares a lane with the folded
 * last-lane sessions and, by the rule, overlaps none beyond.
 */
function lanesFor(sessions: Placed[], maxLanes: number): { placed: Lane[]; folds: Fold[]; widest: number } {
  const packed = packLanes(sessions, { maxLanes });
  const placed: Lane[] = [];
  const folds: Fold[] = [];
  let widest = sessions.length ? 1 : 0;
  const last = maxLanes - 1;
  for (const cluster of packed.clusters) {
    const members = [...cluster.members].sort((a, b) => a - b);
    if (!cluster.dense) {
      widest = Math.max(widest, cluster.lanes);
      for (const i of members) placed.push({ session: sessions[i], lane: packed.placements[i].lane, lanes: cluster.lanes });
      continue;
    }
    widest = Math.max(widest, maxLanes);
    const beyond = members.filter((i) => packed.placements[i].lane > last);
    const folded = members.filter(
      (i) => packed.placements[i].lane > last || (packed.placements[i].lane === last && beyond.some((j) => overlap(sessions[i], sessions[j]))),
    );
    for (const i of members) {
      if (!folded.includes(i)) placed.push({ session: sessions[i], lane: packed.placements[i].lane, lanes: maxLanes });
    }
    // `members` is in start order, so a run ends where the next folded session starts at or after everything before it.
    let run: number[] = [];
    let runEnd = -1;
    const close = () => {
      if (run.length === 0) return;
      const startMin = sessions[run[0]].startMin;
      const around = members.filter((i) => sessions[i].startMin < runEnd && sessions[i].endMin > startMin);
      folds.push({
        lane: last,
        lanes: maxLanes,
        startMin,
        endMin: runEnd,
        keys: run.map((i) => sessions[i].key),
        clusterKeys: around.map((i) => sessions[i].key),
        clusterStartMin: Math.min(...around.map((i) => sessions[i].startMin)),
      });
      run = [];
    };
    for (const i of folded) {
      if (run.length > 0 && sessions[i].startMin >= runEnd) close();
      run.push(i);
      runEnd = run.length === 1 ? sessions[i].endMin : Math.max(runEnd, sessions[i].endMin);
    }
    close();
  }
  return { placed, folds, widest };
}

type DayLayout = {
  day: GridDay;
  /** `matId`: the column the session sits in by mat (null = "No mat"); by time, its own mat. */
  sessions: { session: Placed; col: number; span: number; lane: number; lanes: number; matId: string | null }[];
  folds: (Fold & { col: number; span: number })[];
};

function dayByTime(day: number, sessions: Placed[], maxLanes: number, fellBack: boolean): DayLayout {
  const { placed, folds } = lanesFor(sessions, maxLanes);
  const counts = [...placed.map((p) => p.lanes), ...folds.map((f) => f.lanes)];
  const tracks = counts.reduce(lcm, 1);
  const lanes = counts.length ? Math.max(...counts) : 1;
  return {
    day: { day, tracks, lanes, layout: "time", fellBack, columns: [], count: sessions.length },
    sessions: placed.map((p) => ({ ...p, matId: p.session.matId, span: tracks / p.lanes, col: 1 + p.lane * (tracks / p.lanes) })),
    folds: folds.map((f) => ({ ...f, span: tracks / f.lanes, col: 1 + f.lane * (tracks / f.lanes) })),
  };
}

/**
 * The mat columns of one day, in the club's order: every mat for a club with
 * one or two (as its poster has it), only the mats in use that day for a club
 * with three or more, and "no mat" (`null`) last when a session needs it. A
 * `matId` the club no longer has counts as no mat. The week, the phone day and
 * the staff Day view all take their columns from here.
 */
export function matColumns(dayMatIds: (string | null)[], mats: GridMat[]): (string | null)[] {
  const known = new Set(mats.map((m) => m.id));
  const used = new Set(dayMatIds.map((id) => (id !== null && known.has(id) ? id : null)));
  const shown: (string | null)[] = (mats.length <= 2 ? mats : mats.filter((m) => used.has(m.id))).map((m) => m.id);
  if (used.has(null)) shown.push(null);
  return shown;
}

function dayByMat(day: number, sessions: Placed[], mats: GridMat[], maxLanes: number): DayLayout {
  const known = new Set(mats.map((m) => m.id));
  const matOf = (s: Placed) => (s.matId !== null && known.has(s.matId) ? s.matId : null);
  const shown = matColumns(sessions.map((s) => s.matId), mats);

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
    for (const p of placed) layout.sessions.push({ ...p, matId, ...place(p.lane, p.lanes) });
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
  // Only the days on show shape the rows: a session on a day nobody asked for adds no line and no gutter label.
  const onShow = input.filter((s) => opts.days.includes(s.day)).map(onAxis);
  const all = opts.days.flatMap((day) => levelDay(onShow.filter((s) => s.day === day).sort(inOrder)));
  const realOf = new Map(all.map((s) => [s.key, s] as const));

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
  // Slivers: a used row of ten minutes or less is fixed at its scale height when every session crossing it also
  // crosses a longer row, which then carries that session's text. A session that lives wholly in slivers (a
  // ten-minute class) keeps them free to grow to its text.
  const long = (r: GridRow) => r.kind === "used" && r.toMin - r.fromMin > 10;
  for (const row of rows) {
    if (row.kind !== "used" || long(row)) continue;
    const crossing = all.filter((s) => s.startMin <= row.fromMin && s.endMin >= row.toMin);
    if (crossing.every((s) => rows.some((r) => long(r) && s.startMin <= r.fromMin && s.endMin >= r.toMin))) {
      row.fixed = true;
      row.floorPx = Math.max(2, Math.round((row.toMin - row.fromMin) * 0.6));
    }
  }

  // Gutter labels: every drawn start at least 15 minutes after the last labelled one; each runs to the next label.
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
          matId: p.matId,
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
          // What the button says: when the folded sessions really run, not where they are drawn.
          startMin: Math.min(...f.keys.map((key) => realOf.get(key)?.realStartMin ?? f.startMin)),
          endMin: Math.max(...f.keys.map((key) => realOf.get(key)?.realEndMin ?? f.endMin)),
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
