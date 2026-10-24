/**
 * T8c (17 Oct 2026): membership movement and headcount, replayed from status
 * history. Pure: no database, no clock, no React. `lib/membership-report.ts`
 * feeds it; Reports, the Net New Members card and the CSV only ever show what
 * this returns.
 *
 * THE MOVEMENT DEFINITION — the only one (Q6: agent default adopted 17 Oct
 * 2026; not an owner decision; confirmed by owner instruction of 23 Oct 2026:
 * one definition, joins and rejoins separate or labelled, imports never
 * manufacture joins. D11 sub-cases remain open). Every "joined", "left" and "net" MatFlow shows
 * — the Reports "Joined this month" and "New this month" tiles, the Net New
 * Members chart and its tally line, the "Joins" chart, the Reports CSV rows
 * and the Members drill-throughs (filter=new-this-month, rejoined-this-month,
 * lost-this-month, tasters-this-month, each with the club month in `month=`)
 * — counts these events, per calendar month in the club's timezone, for
 * training members (never guardians):
 * - New       first ever start (first entry to active).
 * - Rejoined  a start after a previous end (re-entry to active).
 * - Joined    new + rejoined (always labelled "Joined (new + rejoined)").
 * - Left      ("lost" in code) a cancellation, plus a completed prepaid
 *             course from its dated end (B-2: the member stays inactive,
 *             labelled "Completed course").
 * - Net       new + rejoined - left.
 * - Tasters added  a person whose first known state is a taster. Counted on
 *             its own line, never in Joined or Net: a taster is "new" when
 *             they first start.
 * - Imported  an import's opening balance (below). NEVER new: an import does
 *             not manufacture joins, and an import-day join date is not a
 *             join either (lib/membership-report.ts joinDateHistory).
 * - Headcount active training members at month end; the current month is
 *             "now", so the last point equals the live "Active members" tile.
 * Member.joinedAt and Member.cancelledAt are NOT the definition: they only
 * reconstruct history for members with no event log (membership-report).
 *
 * Two kinds of move cross the active line without being a join or a loss, and
 * are counted apart so the headcount always adds up (acceptance 1):
 * - imported  a member brought over by an import with no earlier dated
 *             history (the import is an opening balance, not a join);
 * - otherIn / otherOut  corrections: an import refresh rollback, a member
 *             set inactive or taster by hand and back again (a pause is not
 *             an end, so its reversal is not a rejoin), and the
 *             reconciliation below. A paused member who is then cancelled is
 *             lost at the cancellation, with a paired otherIn (memberMovements).
 * So headcount(end) - headcount(start) = net + imported + otherIn - otherOut.
 *
 * Replay order is (occurredAt, createdAt, id), the order lib/member-status.ts
 * writes and the latest-event invariant uses. Events that share one
 * occurredAt are settled together: only the state before and after that
 * instant counts, so a refresh and the rollback that undoes it at the same
 * occurredAt move nobody.
 *
 * Reconciliation: where a member's replayed state now differs from their
 * current status (a writer that bypassed the event log), a correction at
 * "now" brings the replay into line, so the current month equals the tile.
 * The count is returned so the screen can say so.
 */
import { clubMonthWindow } from "./club-month";

export interface MovementEvent {
  id: string;
  memberId: string;
  fromStatus?: string | null;
  toStatus: string;
  occurredAt: Date;
  createdAt: Date;
  reason?: string | null;
  sourceAction?: string | null;
  /** Reconstructed (TeamUp ledger, back-fill, join and cancel dates), not recorded when it happened. */
  estimated?: boolean;
  /** A move to inactive that ends a prepaid course ("Completed course", B-2). */
  completedCourse?: boolean;
  /** A correction rather than a real join or loss (the reconciliation at "now"). */
  correction?: boolean;
}

export type MovementKind = "new" | "rejoined" | "lostCancelled" | "lostCompleted" | "imported" | "otherIn" | "otherOut" | "tasterAdded";

export interface Movement {
  memberId: string;
  at: Date;
  kind: MovementKind;
  estimated: boolean;
}

/**
 * recorded: from events written at the time · estimated: reconstructed ·
 * mixed: some of each · none: the month ended before the club's earliest
 * event of any kind, so there is nothing to count (never drawn as a zero).
 */
export type MembershipBasis = "recorded" | "estimated" | "mixed" | "none";

export interface MovementTally {
  new: number;
  rejoined: number;
  /** lostCancelled + lostCompleted. */
  lost: number;
  lostCancelled: number;
  lostCompleted: number;
  /** new + rejoined - lost. */
  net: number;
  imported: number;
  otherIn: number;
  otherOut: number;
  /** People whose first known state is a taster (D11). Not in net, not in the headcount. */
  tasterAdded: number;
}

export interface MonthMovement extends MovementTally {
  /** "YYYY-MM" in the club's timezone. */
  month: string;
  /** "Oct 26". */
  label: string;
  basis: MembershipBasis;
  isCurrentMonth: boolean;
}

export interface MonthHeadcount {
  month: string;
  label: string;
  /** Active training members at month end (now, for the current month); null when the month has no data (basis "none"). */
  headcount: number | null;
  basis: MembershipBasis;
  isCurrentMonth: boolean;
  /** The instant counted (ISO): the last millisecond of the month, or now. */
  at: string;
}

export interface MembershipSeries {
  timeZone: string;
  /** First recorded (not back-filled) status event, ISO; months before it are estimated. Null when nothing is recorded. */
  boundary: string | null;
  /** The earliest event of any kind (recorded or reconstructed), ISO; months that end before it are basis "none". */
  firstDataAt: string | null;
  /** `from` is the first month with data and `months` counts from there (never padded with empty months). */
  window: { from: string; to: string; months: number };
  /** Active members just before the window opens, so the first month's change can be checked too. */
  openingHeadcount: number;
  headcountByMonth: MonthHeadcount[];
  movementsByMonth: MonthMovement[];
  totals: MovementTally;
  /** Members whose recorded history disagreed with their current status across the active line, corrected at now. */
  reconciled: number;
}

export const MEMBERSHIP_WINDOW_MONTHS = 12;

/** The words on screen and in the CSV, once. British English, sentence case. */
export const MEMBERSHIP_COPY = {
  definition:
    "New: first ever start. Rejoined: started again after leaving. Joined = new + rejoined. Left: cancelled, or finished a prepaid course. Net = new + rejoined − left. Tasters added are counted apart, and imports are never joins.",
  /** The Reports tile that counts Joined (D11). */
  joinedLabel: "Joined this month (new + rejoined)",
  headcount: "Active members at month end",
  headcountAxis: "Active members",
  deletion: "Members deleted from MatFlow are not in past months.",
  imported: "brought over by an import without dated history",
  other: "other changes (set inactive or taster by hand, or corrected)",
} as const;

/**
 * What an estimated month was reconstructed from, in words: the TeamUp ledger
 * (back-filled or planned in memory) and/or members' join and cancellation
 * dates. Never names TeamUp for a club whose estimate did not come from it.
 */
export function estimatedCaption(src: { historySource: "backfill" | "ledger" | "none"; fromJoinDates: number }): string {
  const parts: string[] = [];
  if (src.historySource !== "none") parts.push("your TeamUp history");
  if (src.fromJoinDates > 0) parts.push("join and cancellation dates");
  return parts.length > 0 ? `Estimated from ${parts.join(" and ")}` : "Estimated";
}

// ── Ordering and state ───────────────────────────────────────────────────────

export function compareEvents(a: MovementEvent, b: MovementEvent): number {
  return (
    a.occurredAt.getTime() - b.occurredAt.getTime() ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** One member's status at `at`: the toStatus of their latest event at or before it, or null. */
export function stateAt(events: readonly MovementEvent[], at: Date): string | null {
  let latest: MovementEvent | null = null;
  for (const e of events) {
    if (e.occurredAt.getTime() > at.getTime()) continue;
    if (!latest || compareEvents(e, latest) > 0) latest = e;
  }
  return latest ? latest.toStatus : null;
}

function groupByMember(events: readonly MovementEvent[]): Map<string, MovementEvent[]> {
  const out = new Map<string, MovementEvent[]>();
  for (const e of events) {
    const list = out.get(e.memberId);
    if (list) list.push(e);
    else out.set(e.memberId, [e]);
  }
  for (const list of out.values()) list.sort(compareEvents);
  return out;
}

/** Active members at each instant (inclusive), across every member in `events`. */
export function headcountSeries(events: readonly MovementEvent[], instants: readonly Date[]): number[] {
  const counts = instants.map(() => 0);
  for (const list of groupByMember(events).values()) {
    instants.forEach((at, i) => {
      if (stateAt(list, at) === "active") counts[i] += 1;
    });
  }
  return counts;
}

// ── Classification ───────────────────────────────────────────────────────────

/** The first event a TeamUp create import writes: an opening balance, not a join. */
export function isImportOpening(e: MovementEvent): boolean {
  return e.reason === "import" && !e.fromStatus && (e.sourceAction == null || e.sourceAction === "import_create");
}

function isCorrection(e: MovementEvent): boolean {
  return e.correction === true || e.sourceAction === "import_rollback";
}

// A TeamUp refresh moves a member to inactive only for a completed prepaid
// course (lib/importers/teamup.ts draftFor); the back-fill does the same for a
// course that ended (lib/status-backfill.ts endOf). A staff "inactive" is not one.
function endsCourse(e: MovementEvent): boolean {
  return (
    e.toStatus === "inactive" &&
    (e.completedCourse === true || e.sourceAction === "import_backfill" || e.sourceAction === "import_refresh")
  );
}

/**
 * Every crossing of the active line for ONE member, oldest first.
 *
 * "Rejoined" needs a previous END (Q6): a counted loss (cancelled, or a
 * completed course), or a first known state that is already cancelled or
 * inactive (a former member brought over by an import, or reconstructed from
 * dates). Leaving active any other way (set inactive or taster by hand, a
 * rollback) is "otherOut" and leaves the member PAUSED: coming back from a
 * pause is "otherIn", so a pause and its reversal (an Activity-log undo
 * included) net to zero. A paused member who is then cancelled, or whose
 * course then ends, is a loss at that date (Lost = cancellation); because the
 * pause already took them out of the headcount, the loss is paired with an
 * "otherIn" at the same instant so headcount(end) - headcount(start) still
 * equals net + imported + otherIn - otherOut.
 */
export function memberMovements(events: readonly MovementEvent[]): Movement[] {
  const sorted = [...events].sort(compareEvents);
  const out: Movement[] = [];
  let state: string | null = null;
  let ended = false;
  let paused = false;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].occurredAt.getTime() === sorted[i].occurredAt.getTime()) j += 1;
    const last = sorted[j];
    const push = (kind: MovementKind) =>
      out.push({ memberId: last.memberId, at: last.occurredAt, kind, estimated: last.estimated === true });
    const wasActive = state === "active";
    const isActive = last.toStatus === "active";
    const machine = isImportOpening(last) || isCorrection(last);
    const isEnd = last.toStatus === "cancelled" || endsCourse(last);
    if (isActive && !wasActive) {
      push(isImportOpening(last) ? "imported" : isCorrection(last) || paused ? "otherIn" : ended ? "rejoined" : "new");
      ended = false;
      paused = false;
    } else if (!isActive && wasActive) {
      if (machine || !isEnd) {
        push("otherOut");
        paused = true;
      } else {
        push(last.toStatus === "cancelled" ? "lostCancelled" : "lostCompleted");
        ended = true;
      }
    } else if (!isActive) {
      // D11: a person whose first known state is a taster is a taster added
      // — never an import's opening balance or a correction at "now".
      if (state === null && last.toStatus === "taster" && !machine) push("tasterAdded");
      const formerMember =
        last.toStatus === "cancelled" ||
        (last.toStatus === "inactive" && (isImportOpening(last) || last.estimated === true));
      if (state === null && formerMember) {
        // First known state is already a former member's: a later start is a rejoin.
        ended = true;
      } else if (paused && isEnd && !machine) {
        push("otherIn");
        push(last.toStatus === "cancelled" ? "lostCancelled" : "lostCompleted");
        paused = false;
        ended = true;
      }
    }
    state = last.toStatus;
    i = j + 1;
  }
  return out;
}

export function emptyTally(): MovementTally {
  return { new: 0, rejoined: 0, lost: 0, lostCancelled: 0, lostCompleted: 0, net: 0, imported: 0, otherIn: 0, otherOut: 0, tasterAdded: 0 };
}

/** Joined = new + rejoined (D11), the one figure every "joined" shows. */
export function joinedOf(t: Pick<MovementTally, "new" | "rejoined">): number {
  return t.new + t.rejoined;
}

function addMove(t: MovementTally, kind: MovementKind) {
  t[kind] += 1;
  t.lost = t.lostCancelled + t.lostCompleted;
  t.net = t.new + t.rejoined - t.lost;
}

/** Tally moves into windows: window i holds moves after window i-1's instant, up to and including its own. */
export function movements(moves: readonly Movement[], windows: readonly { start: Date; at: Date }[]): MovementTally[] {
  const out = windows.map(() => emptyTally());
  for (const m of moves) {
    const t = m.at.getTime();
    const i = windows.findIndex((w) => t >= w.start.getTime() && t <= w.at.getTime());
    if (i >= 0) addMove(out[i], m.kind);
  }
  return out;
}

/** The change in headcount a tally explains: net plus the moves that are neither joins nor losses. */
export function tallyChange(t: MovementTally): number {
  return t.net + t.imported + t.otherIn - t.otherOut;
}

// ── Club calendar ────────────────────────────────────────────────────────────

export interface MonthWindow {
  key: string;
  label: string;
  /** Midnight on the 1st, in the club's timezone. */
  start: Date;
  /** The instant counted: the last millisecond of the month, or now for the current month. */
  at: Date;
  isCurrent: boolean;
}

/**
 * The last `count` calendar months in the club's timezone, oldest first,
 * ending with the month that holds `now`. Each month is lib/club-month's
 * `clubMonthWindow` (the one club-zone month Reports' tiles, CSV and the
 * Members drill-through use), so a movement and a "Joined this month" tile
 * can never disagree about which month an instant falls in.
 */
export function clubMonthWindows(now: Date, timeZone: string, count: number): MonthWindow[] {
  const out: MonthWindow[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const w = clubMonthWindow(now, timeZone, -i);
    const [year, month] = w.monthKey.split("-").map(Number);
    const marker = new Date(Date.UTC(year, month - 1, 1));
    out.push({
      key: w.monthKey,
      label: marker.toLocaleString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }),
      start: new Date(w.monthStart),
      at: i === 0 ? now : new Date(new Date(w.nextMonthStart).getTime() - 1),
      isCurrent: i === 0,
    });
  }
  return out;
}

// ── The whole series ─────────────────────────────────────────────────────────

export interface BuildMembershipInput {
  /** Recorded, back-filled and reconstructed events, for training members. */
  events: readonly MovementEvent[];
  /** Every training member's current status. Only these members are counted. */
  live: ReadonlyArray<{ id: string; status: string }>;
  now: Date;
  timeZone: string;
  months?: number;
  boundary: Date | null;
}

/** Each live member's events, with the reconciliation at "now" added (see the header). */
function reconciledEvents(input: Pick<BuildMembershipInput, "events" | "live" | "now">): { byMember: Map<string, MovementEvent[]>; reconciled: number } {
  const { now } = input;
  const live = new Map(input.live.map((m) => [m.id, m.status]));
  const byMember = groupByMember(input.events.filter((e) => live.has(e.memberId)));
  let reconciled = 0;
  for (const [memberId, status] of live) {
    const list = byMember.get(memberId) ?? [];
    const replayed = stateAt(list, now);
    if (replayed === status) continue;
    if ((replayed === "active") !== (status === "active")) reconciled += 1;
    list.push({ id: `reconcile:${memberId}`, memberId, toStatus: status, occurredAt: now, createdAt: now, estimated: true, correction: true });
    list.sort(compareEvents);
    byMember.set(memberId, list);
  }
  return { byMember, reconciled };
}

/** The four Members drill-throughs (D11): one per figure on the Joined tile. */
export type MovementBucket = "new" | "rejoined" | "lost" | "tasterAdded";

export function movementBucket(kind: MovementKind): MovementBucket | null {
  if (kind === "new" || kind === "rejoined" || kind === "tasterAdded") return kind;
  if (kind === "lostCancelled" || kind === "lostCompleted") return "lost";
  return null;
}

/**
 * The members behind each figure for ONE window: the same replay, the same
 * events and the same window rule as buildMembership's tally (a move counts
 * when start <= at <= window.at), so a drill-through lists exactly the
 * members the tile counted. A member counted twice in one figure (rejoined
 * twice in a month) is listed once.
 */
export function moversInWindow(
  input: Pick<BuildMembershipInput, "events" | "live" | "now">,
  window: { start: Date; at: Date },
): Record<MovementBucket, string[]> {
  return moversAndBasisInWindow({ ...input, boundary: null }, window).movers;
}

/**
 * moversInWindow plus the window's basis, by the same rule buildMembership
 * gives each month (movementWindowBasis): the Members drill-through for a past
 * month says when the moves it lists are estimated, as the Reports chart does.
 */
export function moversAndBasisInWindow(
  input: Pick<BuildMembershipInput, "events" | "live" | "now" | "boundary">,
  window: { start: Date; at: Date },
): { movers: Record<MovementBucket, string[]>; basis: MembershipBasis } {
  const out: Record<MovementBucket, Set<string>> = { new: new Set(), rejoined: new Set(), lost: new Set(), tasterAdded: new Set() };
  let first: number | null = null;
  let estimatedMoves = 0;
  for (const list of reconciledEvents(input).byMember.values()) {
    const t0 = list[0]?.occurredAt.getTime();
    if (t0 !== undefined && (first === null || t0 < first)) first = t0;
    for (const m of memberMovements(list)) {
      const t = m.at.getTime();
      if (t < window.start.getTime() || t > window.at.getTime()) continue;
      if (m.estimated) estimatedMoves += 1;
      const bucket = movementBucket(m.kind);
      if (bucket) out[bucket].add(m.memberId);
    }
  }
  return {
    movers: { new: [...out.new], rejoined: [...out.rejoined], lost: [...out.lost], tasterAdded: [...out.tasterAdded] },
    basis: movementWindowBasis(window, first, input.boundary?.getTime() ?? null, estimatedMoves),
  };
}

/**
 * A window's movement basis: "none" when it ended before the club's earliest
 * event; "estimated" when it ended before the first recorded event (or none is
 * recorded); "recorded" when it began on or after that event and none of its
 * moves is reconstructed; otherwise "mixed" (partly estimated).
 */
export function movementWindowBasis(
  w: { start: Date; at: Date },
  firstEventAt: number | null,
  boundaryAt: number | null,
  estimatedMoves: number,
): MembershipBasis {
  if (firstEventAt === null || w.at.getTime() < firstEventAt) return "none";
  if (boundaryAt === null || w.at.getTime() < boundaryAt) return "estimated";
  return w.start.getTime() >= boundaryAt && estimatedMoves === 0 ? "recorded" : "mixed";
}

/** One basis for several months (a window total): ignores "none"; all the same, or "mixed". */
export function combinedBasis(bases: readonly MembershipBasis[]): MembershipBasis {
  const seen = bases.filter((b) => b !== "none");
  if (seen.length === 0) return "none";
  if (seen.every((b) => b === "recorded")) return "recorded";
  if (seen.every((b) => b === "estimated")) return "estimated";
  return "mixed";
}

export function buildMembership(input: BuildMembershipInput): MembershipSeries {
  const { now, timeZone, boundary } = input;
  const count = input.months ?? MEMBERSHIP_WINDOW_MONTHS;
  const { byMember, reconciled } = reconciledEvents(input);

  const windows = clubMonthWindows(now, timeZone, count);
  const openingAt = new Date(windows[0].start.getTime() - 1);
  const headcounts = windows.map(() => 0);
  // Active members at the instant whose state came from a reconstructed event (corrections aside).
  const estimatedActive = windows.map(() => 0);
  let openingHeadcount = 0;
  const allMoves: Movement[] = [];

  for (const list of byMember.values()) {
    allMoves.push(...memberMovements(list));
    if (stateAt(list, openingAt) === "active") openingHeadcount += 1;
    windows.forEach((w, i) => {
      let latest: MovementEvent | null = null;
      for (const e of list) {
        if (e.occurredAt.getTime() > w.at.getTime()) break;
        latest = e;
      }
      if (latest?.toStatus === "active") {
        headcounts[i] += 1;
        if (latest.estimated && !latest.correction) estimatedActive[i] += 1;
      }
    });
  }

  const tallies = movements(allMoves, windows);
  const estimatedMoves = windows.map(() => 0);
  for (const m of allMoves) {
    if (!m.estimated) continue;
    const t = m.at.getTime();
    const i = windows.findIndex((w) => t >= w.start.getTime() && t <= w.at.getTime());
    if (i >= 0) estimatedMoves[i] += 1;
  }

  // The earliest event of any kind. A month that ended before it has nothing to
  // count: it is "none" (no headcount), never an estimated or recorded zero.
  let first: number | null = null;
  for (const list of byMember.values()) {
    const t = list[0]?.occurredAt.getTime();
    if (t !== undefined && (first === null || t < first)) first = t;
  }
  const noData = (w: MonthWindow) => first === null || w.at.getTime() < first;

  const b = boundary?.getTime() ?? null;
  const movementBasis = (w: MonthWindow, i: number): MembershipBasis => movementWindowBasis(w, first, b, estimatedMoves[i]);
  const headcountBasis = (w: MonthWindow, i: number): MembershipBasis => {
    if (noData(w)) return "none";
    if (b === null || w.at.getTime() < b) return "estimated";
    return estimatedActive[i] > 0 ? "mixed" : "recorded";
  };
  const firstWithData = windows.find((w) => !noData(w)) ?? windows[windows.length - 1];

  const totals = emptyTally();
  for (const t of tallies) {
    for (const k of ["new", "rejoined", "lostCancelled", "lostCompleted", "imported", "otherIn", "otherOut", "tasterAdded"] as const) totals[k] += t[k];
  }
  totals.lost = totals.lostCancelled + totals.lostCompleted;
  totals.net = totals.new + totals.rejoined - totals.lost;

  return {
    timeZone,
    boundary: boundary ? boundary.toISOString() : null,
    firstDataAt: first === null ? null : new Date(first).toISOString(),
    window: { from: firstWithData.label, to: windows[windows.length - 1].label, months: windows.length - windows.indexOf(firstWithData) },
    openingHeadcount,
    headcountByMonth: windows.map((w, i) => ({
      month: w.key,
      label: w.label,
      headcount: noData(w) ? null : headcounts[i],
      basis: headcountBasis(w, i),
      isCurrentMonth: w.isCurrent,
      at: w.at.toISOString(),
    })),
    movementsByMonth: windows.map((w, i) => ({
      month: w.key,
      label: w.label,
      ...tallies[i],
      basis: movementBasis(w, i),
      isCurrentMonth: w.isCurrent,
    })),
    totals,
    reconciled,
  };
}
