// The day a staff register was read for (25 Nov 2026, Noe).
//
// Mark attendance reads the club's day from /api/coach/today, which says in a
// header (X-Club-Date) which club date the list is for. Every write the page
// then makes — a mark, an un-mark, a card read, a cancel or restore — carries
// that date as `registerDay` ("YYYY-MM-DD"). When it is present and is no longer
// the club's date by the SERVER's clock in the club's zone, the route writes
// nothing and answers 409 REGISTER_DAY_STALE with the club's date, so a tablet
// left open across the club's midnight cannot mark into yesterday's class even
// when its own clock is wrong. When it is absent, nothing changes: the kiosk,
// the member's own check-in, the timetable and older clients never send it.
// Staff may still mark an earlier session on purpose from screens that do not
// send it; this refuses only "today's register" that is no longer today.

import { usableTimezone } from "@/lib/class-time";

export const REGISTER_DAY_STALE = "REGISTER_DAY_STALE";
export const REGISTER_DAY_INVALID = "REGISTER_DAY_INVALID";

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written YYYY-MM-DD. */
export function isRegisterDay(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = SHAPE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = new Date(Date.UTC(y, mo - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d;
}

/** The club's date at `at`, YYYY-MM-DD in the club's zone. */
export function clubDateKey(timeZone: string | null | undefined, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: usableTimezone(timeZone) }).format(at);
}

function label(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

export type RegisterDayRefusal = { status: 400 | 409; body: Record<string, unknown> };

/**
 * `null` when the write may go ahead: no `registerDay` was sent, or it is the
 * club's date now. Otherwise the refusal to send: 400 for a malformed value,
 * 409 REGISTER_DAY_STALE (with the club's date) for a day that has passed.
 * Call it after authorisation and tenant scoping, before any write.
 */
export function registerDayRefusal(registerDay: unknown, timeZone: string | null | undefined, now: Date = new Date()): RegisterDayRefusal | null {
  if (registerDay === undefined || registerDay === null) return null;
  if (!isRegisterDay(registerDay)) {
    return { status: 400, body: { error: "registerDay must be a date written YYYY-MM-DD.", code: REGISTER_DAY_INVALID } };
  }
  const clubDate = clubDateKey(timeZone, now);
  if (registerDay === clubDate) return null;
  return {
    status: 409,
    body: {
      error: `This register is for ${label(registerDay)}. It is now ${label(clubDate)} at the club. Reload to see today's classes.`,
      code: REGISTER_DAY_STALE,
      reason: "register_day_stale",
      registerDay,
      clubDate,
    },
  };
}
