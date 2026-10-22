/**
 * "This month", defined once, in the CLUB's time zone (review L4, 23 Oct 2026).
 *
 * Reports' "Joined this month" and "Cancelled this month" tiles used the
 * server process's calendar month (UTC on Vercel), while the Members page
 * drill-through behind them recomputed "this month" in the BROWSER's zone. For
 * a club east or west of both, the tile and the rows it links to disagreed for
 * hours either side of every month boundary: at 2026-10-31T23:30Z an Auckland
 * club is already in November, the server is still in October, and a browser
 * in Los Angeles is in October too — three answers to one question.
 *
 * Now the server resolves the month once, from `Tenant.timezone`, as a
 * half-open window [monthStart, nextMonthStart) of instants, and every surface
 * compares instants against those two boundaries: Reports' tiles and CSV, the
 * Members page counts, and the drill-through rows. Nothing recomputes the
 * month in the browser.
 *
 * Runtime imports: lib/class-time only, which is itself pure, so client
 * components may import `inMonthWindow`.
 */
import { DEFAULT_TIMEZONE, usableTimezone, zoneOffsetMs } from "@/lib/class-time";

/**
 * Start of a calendar month in `timeZone`, as a UTC instant.
 *
 * `monthOffset` shifts by whole months (−1 = last month's start, +1 = next
 * month's start). The zone offset is read twice, exactly as `lib/class-time`'s
 * `parseTime` does, so a month boundary that lands on a DST changeover morning
 * still resolves to true local midnight. (Moved here from lib/leaderboard.ts,
 * which re-exports it.)
 */
export function zonedMonthStart(now: Date, timeZone: string, monthOffset = 0): Date {
  const { year, month } = zonedYearMonth(now, timeZone);
  return monthStartFor(year, month - 1 + monthOffset, timeZone);
}

/** The calendar year and month (1–12) of `instant` on the club's wall clock. */
export function zonedYearMonth(instant: Date, timeZone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(instant);
  const year = Number(parts.find((p) => p.type === "year")?.value ?? 0);
  const month = Number(parts.find((p) => p.type === "month")?.value ?? 1);
  return { year, month };
}

/** "2026-10": the club-zone month an instant falls in. Month buckets key on it. */
export function clubMonthKey(instant: Date, timeZone: string): string {
  const { year, month } = zonedYearMonth(instant, timeZone);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** monthIndex is 0-based and may overflow either way (Date.UTC normalises it). */
function monthStartFor(year: number, monthIndex: number, timeZone: string): Date {
  const naive = Date.UTC(year, monthIndex, 1, 0, 0, 0, 0);
  const firstOffset = zoneOffsetMs(new Date(naive), timeZone);
  const secondOffset = zoneOffsetMs(new Date(naive - firstOffset), timeZone);
  return new Date(naive - secondOffset);
}

/**
 * One club month as instants. Serialisable as it stands (ISO strings), so the
 * server can hand the very same boundaries to a client component.
 */
export type ClubMonthWindow = {
  /** The zone the month was resolved in (Tenant.timezone, or the default when unusable). */
  timeZone: string;
  /** Inclusive lower bound: midnight on the 1st, club time. ISO. */
  monthStart: string;
  /** Exclusive upper bound: midnight on the 1st of the next month, club time. ISO. */
  nextMonthStart: string;
  /** "2026-10". */
  monthKey: string;
  /** "October 2026". */
  label: string;
};

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

function windowFor(year: number, month: number, timeZone: string): ClubMonthWindow {
  const start = monthStartFor(year, month - 1, timeZone);
  const next = monthStartFor(year, month, timeZone);
  return {
    timeZone,
    monthStart: start.toISOString(),
    nextMonthStart: next.toISOString(),
    monthKey: `${year}-${String(month).padStart(2, "0")}`,
    // Mid-month at noon UTC names the month in any zone.
    label: new Date(Date.UTC(year, month - 1, 15, 12)).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
  };
}

/**
 * The club month containing `now` (shifted by `monthOffset` whole months), in
 * the club's zone. `timeZoneRaw` is `Tenant.timezone` as stored; an unusable
 * value falls back to the schema default rather than throwing.
 */
export function clubMonthWindow(now: Date, timeZoneRaw: string | null | undefined, monthOffset = 0): ClubMonthWindow {
  const timeZone = usableTimezone(timeZoneRaw);
  const { year, month } = zonedYearMonth(now, timeZone);
  const shifted = new Date(Date.UTC(year, month - 1 + monthOffset, 1));
  return windowFor(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, timeZone);
}

/**
 * The window for a "YYYY-MM" key (the `month` a Reports drill-through link
 * carries), or null when the key is malformed. Lets the Members page open on
 * exactly the month a cached report counted, even if the calendar has turned
 * over since the report was computed.
 */
export function clubMonthWindowForKey(monthKey: string | null | undefined, timeZoneRaw: string | null | undefined): ClubMonthWindow | null {
  const match = monthKey ? MONTH_KEY.exec(monthKey) : null;
  if (!match) return null;
  return windowFor(Number(match[1]), Number(match[2]), usableTimezone(timeZoneRaw));
}

/** Half-open: monthStart ≤ instant < nextMonthStart. A missing instant is outside. */
export function inMonthWindow(
  instant: string | Date | null | undefined,
  window: Pick<ClubMonthWindow, "monthStart" | "nextMonthStart">,
): boolean {
  if (!instant) return false;
  const t = (instant instanceof Date ? instant : new Date(instant)).getTime();
  if (Number.isNaN(t)) return false;
  return t >= new Date(window.monthStart).getTime() && t < new Date(window.nextMonthStart).getTime();
}

/** The Prisma range for one window: `{ gte: monthStart, lt: nextMonthStart }`. */
export function monthRange(window: Pick<ClubMonthWindow, "monthStart" | "nextMonthStart">): { gte: Date; lt: Date } {
  return { gte: new Date(window.monthStart), lt: new Date(window.nextMonthStart) };
}

/** The month a client falls back to when no server window was passed: the schema-default zone, never the browser's. */
export function defaultClubMonthWindow(now: Date = new Date()): ClubMonthWindow {
  return clubMonthWindow(now, DEFAULT_TIMEZONE);
}
