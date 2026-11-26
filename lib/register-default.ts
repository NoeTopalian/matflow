/**
 * Which session the staff register opens on (25 Nov 2026).
 *
 * The times are instants (milliseconds), already worked out in the CLUB's
 * zone by `sessionBounds`, so nothing here depends on the phone's clock zone.
 * Only sessions the member of staff may mark, on the club's day, are passed
 * in; a cancelled session is never chosen.
 *
 *  1. On now (start <= now < end). Several: the signed-in coach's own first,
 *     then the one that started most recently.
 *  2. Otherwise the next to start. Several at once: the coach's own first.
 *  3. Otherwise the one that ended most recently ("Last class today"), which
 *     is not always the one that started last.
 *  4. Nothing eligible: no choice.
 *
 * Every remaining tie goes to the club's mat order, then the session id, so
 * the same day always opens on the same session.
 */

export type RegisterPickReason = "on_now" | "up_next" | "last_today";

export interface RegisterPickSession {
  id: string;
  /** Start instant. */
  start: number;
  /** End instant; null when no end is recorded (such a session is never "on now"). */
  end: number | null;
  isCancelled: boolean;
  /** The signed-in member of staff coaches it. False for a support session. */
  isMine: boolean;
  /** Position of its mat in the club's order; null when it has no mat (sorts last). */
  matOrder: number | null;
}

export interface RegisterPick {
  id: string;
  reason: RegisterPickReason;
}

const NO_MAT = Number.MAX_SAFE_INTEGER;

function tieBreak(a: RegisterPickSession, b: RegisterPickSession): number {
  return (a.matOrder ?? NO_MAT) - (b.matOrder ?? NO_MAT) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const mineFirst = (a: RegisterPickSession, b: RegisterPickSession) => Number(b.isMine) - Number(a.isMine);

export function pickRegisterSession(sessions: RegisterPickSession[], now: number): RegisterPick | null {
  const live = sessions.filter((s) => !s.isCancelled);
  if (live.length === 0) return null;

  const running = live.filter((s) => s.end !== null && s.start <= now && now < s.end);
  if (running.length > 0) {
    running.sort((a, b) => mineFirst(a, b) || b.start - a.start || tieBreak(a, b));
    return { id: running[0].id, reason: "on_now" };
  }

  const upcoming = live.filter((s) => s.start > now);
  if (upcoming.length > 0) {
    upcoming.sort((a, b) => a.start - b.start || mineFirst(a, b) || tieBreak(a, b));
    return { id: upcoming[0].id, reason: "up_next" };
  }

  // Everything has started and nothing is running: the day is over. A session
  // with no recorded end is placed by its start.
  const finished = (s: RegisterPickSession) => s.end ?? s.start;
  const ended = live.slice().sort((a, b) => finished(b) - finished(a) || mineFirst(a, b) || tieBreak(a, b));
  return { id: ended[0].id, reason: "last_today" };
}

/** How many sessions are on now: the register says "2 classes on now" when another is running. */
export function countRunning(sessions: RegisterPickSession[], now: number): number {
  return sessions.filter((s) => !s.isCancelled && s.end !== null && s.start <= now && now < s.end).length;
}
