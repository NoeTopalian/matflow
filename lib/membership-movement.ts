/**
 * T8c (17 Oct 2026): membership movement and headcount, replayed from status
 * history. Pure: no database, no clock, no React. `lib/membership-report.ts`
 * feeds it; Reports, the Net New Members card and the CSV only ever show what
 * this returns.
 *
 * Owner decisions Q6 (Noe, 17 Oct 2026), per calendar month in the club's
 * timezone:
 * - New       first ever start (first entry to active).
 * - Rejoined  a start after a previous end (re-entry to active).
 * - Lost      a cancellation, plus a completed prepaid course from its dated
 *             end (B-2: the member stays inactive, labelled "Completed course").
 * - Net       new + rejoined - lost.
 * - Headcount active training members at month end; the current month is
 *             "now", so the last point equals the live "Active members" tile.
 *
 * Two kinds of move cross the active line without being a join or a loss, and
 * are counted apart so the headcount always adds up (acceptance 1):
 * - imported  a member brought over by a TeamUp import with no earlier dated
 *             history (the import is an opening balance, not a join);
 * - otherIn / otherOut  corrections: an import refresh rollback, a member
 *             set inactive or taster by hand, and the reconciliation below.
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
import { parseTime, zoneOffsetMs } from "./class-time";

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

export type MovementKind = "new" | "rejoined" | "lostCancelled" | "lostCompleted" | "imported" | "otherIn" | "otherOut";

export interface Movement {
  memberId: string;
  at: Date;
  kind: MovementKind;
  estimated: boolean;
}

/** recorded: from events written at the time · estimated: reconstructed · mixed: some of each. */
export type MembershipBasis = "recorded" | "estimated" | "mixed";

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
  /** Active training members at month end (now, for the current month). */
  headcount: number;
  basis: MembershipBasis;
  isCurrentMonth: boolean;
  /** The instant counted (ISO): the last millisecond of the month, or now. */
  at: string;
}

export interface MembershipSeries {
  timeZone: string;
  /** First recorded (not back-filled) status event, ISO; months before it are estimated. Null when nothing is recorded. */
  boundary: string | null;
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
    "New: first ever start. Rejoined: started again after leaving. Lost: cancelled, or finished a prepaid course. Net = new + rejoined − lost.",
  headcount: "Active members at month end",
  headcountAxis: "Active members",
  estimated: "Estimated from your TeamUp history",
  deletion: "Members deleted from MatFlow are not in past months.",
  imported: "brought over from TeamUp without dated history",
  other: "other changes (set inactive or taster by hand, or corrected)",
} as const;

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

/** Every crossing of the active line for ONE member, oldest first. */
export function memberMovements(events: readonly MovementEvent[]): Movement[] {
  const sorted = [...events].sort(compareEvents);
  const out: Movement[] = [];
  let state: string | null = null;
  let everActive = false;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].occurredAt.getTime() === sorted[i].occurredAt.getTime()) j += 1;
    const last = sorted[j];
    const wasActive = state === "active";
    const isActive = last.toStatus === "active";
    if (wasActive !== isActive) {
      let kind: MovementKind;
      if (isActive) {
        kind = isImportOpening(last) ? "imported" : isCorrection(last) ? "otherIn" : everActive ? "rejoined" : "new";
        everActive = true;
      } else if (isImportOpening(last) || isCorrection(last)) {
        kind = "otherOut";
      } else if (last.toStatus === "cancelled") {
        kind = "lostCancelled";
      } else if (endsCourse(last)) {
        kind = "lostCompleted";
      } else {
        kind = "otherOut";
      }
      out.push({ memberId: last.memberId, at: last.occurredAt, kind, estimated: last.estimated === true });
    }
    state = last.toStatus;
    i = j + 1;
  }
  return out;
}

export function emptyTally(): MovementTally {
  return { new: 0, rejoined: 0, lost: 0, lostCancelled: 0, lostCompleted: 0, net: 0, imported: 0, otherIn: 0, otherOut: 0 };
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

export function clubMonthStart(year: number, monthIndex: number, timeZone: string): Date {
  return parseTime("00:00", new Date(Date.UTC(year, monthIndex, 1)), timeZone);
}

/** The last `count` calendar months in the club's timezone, oldest first, ending with the month that holds `now`. */
export function clubMonthWindows(now: Date, timeZone: string, count: number): MonthWindow[] {
  const local = new Date(now.getTime() + zoneOffsetMs(now, timeZone));
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const out: MonthWindow[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const marker = new Date(Date.UTC(y, m - i, 1));
    const start = clubMonthStart(y, m - i, timeZone);
    const next = clubMonthStart(y, m - i + 1, timeZone);
    out.push({
      key: marker.toISOString().slice(0, 7),
      label: marker.toLocaleString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }),
      start,
      at: i === 0 ? now : new Date(next.getTime() - 1),
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

export function buildMembership(input: BuildMembershipInput): MembershipSeries {
  const { now, timeZone, boundary } = input;
  const count = input.months ?? MEMBERSHIP_WINDOW_MONTHS;
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

  const b = boundary?.getTime() ?? null;
  const movementBasis = (w: MonthWindow, i: number): MembershipBasis => {
    if (b === null || w.at.getTime() < b) return "estimated";
    return w.start.getTime() >= b && estimatedMoves[i] === 0 ? "recorded" : "mixed";
  };
  const headcountBasis = (w: MonthWindow, i: number): MembershipBasis => {
    if (b === null || w.at.getTime() < b) return "estimated";
    return estimatedActive[i] > 0 ? "mixed" : "recorded";
  };

  const totals = emptyTally();
  for (const t of tallies) {
    for (const k of ["new", "rejoined", "lostCancelled", "lostCompleted", "imported", "otherIn", "otherOut"] as const) totals[k] += t[k];
  }
  totals.lost = totals.lostCancelled + totals.lostCompleted;
  totals.net = totals.new + totals.rejoined - totals.lost;

  return {
    timeZone,
    boundary: boundary ? boundary.toISOString() : null,
    window: { from: windows[0].label, to: windows[windows.length - 1].label, months: count },
    openingHeadcount,
    headcountByMonth: windows.map((w, i) => ({
      month: w.key,
      label: w.label,
      headcount: headcounts[i],
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
