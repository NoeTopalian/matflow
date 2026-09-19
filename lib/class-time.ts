/**
 * Shared time helpers for class scheduling.
 *
 * ## The bug these exist to close
 *
 * A class's `startTime` is the string `"18:00"` — a WALL CLOCK time at the gym.
 * Turning that into an instant needs the gym's timezone, and until now nothing
 * supplied one:
 *
 *     const d = new Date(baseDate);
 *     d.setHours(h, m, 0, 0);          // ...in whose zone?
 *
 * `setHours` resolves in the zone of the process, which on Vercel is UTC. So for
 * a London club through British Summer Time, an 18:00 class was treated as 18:00
 * UTC — 19:00 local — and the check-in window opened and closed **an hour late**
 * for the seven months from late March to late October. A member arriving at
 * 17:45 for a 18:00 class was told they were outside the window.
 *
 * `Tenant.timezone` has existed the whole time (`schema.prisma:31`, IANA, default
 * `Europe/London`, written at onboarding step 1 from the owner's browser) and
 * was read by **nothing** — a repo-wide grep for it returned zero hits outside
 * the schema line. So the fix is to consume a column that was already there,
 * not to add one.
 *
 * The timezone parameter is deliberately **required**, not defaulted. A default
 * would let a future caller keep the old bug silently; a missing argument is a
 * compile error.
 */

/** Matches `Tenant.timezone`'s schema default, for callers with no tenant row. */
export const DEFAULT_TIMEZONE = "Europe/London";

/**
 * How far ahead of UTC the zone is at this instant, in milliseconds.
 *
 * Formats the instant AS that zone, reads the resulting wall clock back as
 * though it were UTC, and takes the difference. This is the standard
 * dependency-free way to get a zone's offset including DST, and it stays correct
 * across rule changes because `Intl` carries the tz database.
 */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  // `hour12: false` renders midnight as 24 in some ICU versions.
  const hour = read("hour") % 24;

  const asIfUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    hour,
    read("minute"),
    read("second"),
  );
  return asIfUtc - instant.getTime();
}

/**
 * The instant at which `hh:mm` occurs, on `baseDate`'s calendar day, in `timeZone`.
 *
 * `baseDate` is `ClassInstance.date`, a Postgres `timestamp` without time zone
 * that Prisma round-trips as a UTC wall clock — so the calendar day is read from
 * its UTC components, never its local ones.
 *
 * The offset is applied twice on purpose. The first pass uses the offset at the
 * naive guess; near a DST boundary the corrected instant can fall on the other
 * side of the transition and carry a different offset, so it is re-read and
 * re-applied. Without that, one class a year on the changeover morning resolves
 * an hour out — which is exactly the class of bug this file exists to remove,
 * and it would be invisible for eleven months.
 */
/**
 * THE one spelling of a calendar-day marker: `00:00:00.000Z` of that date.
 *
 * `ClassInstance.date` is a calendar-day marker, not an instant, and until the
 * round-3 migration each writer spelled it in the PROCESS's zone — 00:00Z on
 * Vercel, 23:00Z of the previous day on a BST laptop, 16:00Z on a Bali one.
 * Every writer now normalises through here, so one calendar date has exactly
 * one byte pattern and `@@unique([classId, date, startTime])` can actually do
 * the deduplication it is relied on for.
 *
 * Normalising to the NEAREST UTC midnight rather than truncating is deliberate
 * and is the whole compatibility story: rows already in the database under an
 * off-midnight spelling (23:00Z, 16:00Z) round FORWARD to the date their writer
 * meant, so a legacy row and a fresh one for the same day are the same day
 * here. Truncating with `getUTCDate()` would file the 23:00Z spelling a day
 * early — the exact bug `parseTime` was fixed for on 18 Sep.
 */
export function dayMarkerUtc(d: Date): Date {
  return new Date(Math.round(d.getTime() / 86_400_000) * 86_400_000);
}

export function parseTime(hhmm: string, baseDate: Date, timeZone: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  // The marker's calendar day is the UTC midnight NEAREST the stored instant
  // — the same rule todayWindow uses to admit it. The cron spells 18 Sep as
  // 18 Sep 00:00Z, a BST laptop as 17 Sep 23:00Z, a Bali laptop as 17 Sep
  // 16:00Z: all one day. Reading the UTC components directly filed the
  // off-midnight spellings a day EARLY, so on any process not running in UTC
  // a class's check-in window and its "on now" status were wrong all day.
  // X-7 Task 5 (Q4 on f27b97f, M2), pulled forward on 18 Sep when the
  // attendance hub's "Now" badge read "Ended" on the laptop.
  const marker = dayMarkerUtc(baseDate);
  const naiveUtc = Date.UTC(
    marker.getUTCFullYear(),
    marker.getUTCMonth(),
    marker.getUTCDate(),
    h ?? 0,
    m ?? 0,
    0,
    0,
  );

  const firstOffset = zoneOffsetMs(new Date(naiveUtc), timeZone);
  let instant = naiveUtc - firstOffset;

  const secondOffset = zoneOffsetMs(new Date(instant), timeZone);
  if (secondOffset !== firstOffset) instant = naiveUtc - secondOffset;

  return new Date(instant);
}

/**
 * The band of `ClassInstance.date` values that mean "the club's calendar date
 * today": half a day either side of that date's UTC midnight.
 *
 * `ClassInstance.date` is a calendar-day MARKER, not an instant. It is a
 * `timestamp` without zone that Prisma reads back as a UTC wall clock, and its
 * writers spell the same date differently: the class-instances cron writes the
 * PROCESS's midnight (00:00Z on Vercel — `lib/class-instances.ts`), the seed
 * writes the seeding laptop's midnight (23:00Z of the previous day, from a BST
 * machine). So the question "what is on today" is "which rows were written for
 * calendar date D", where D is today in the club's zone — and every writer's
 * spelling of D lies within twelve hours of D's UTC midnight, while no
 * spelling of D±1 does (for any offset inside ±12 h).
 *
 * Two wrong answers this replaces, both found by review: comparing
 * `toDateString()` in the process zone filed the seeded 23:00Z row on the
 * previous day when the process ran in UTC; and a window of local-day
 * INSTANTS ([04:00Z, 04:00Z) for New York) excluded the cron's 00:00Z marker
 * for today and admitted tomorrow's, so a club west of UTC saw tomorrow's
 * timetable all day. The date D is resolved in `timeZone`; the band is not.
 */
export function todayWindow(now: Date, timeZone: string): { start: Date; end: Date } {
  const local = new Date(now.getTime() + zoneOffsetMs(now, timeZone));
  const dayMidnightUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const halfDay = 12 * 60 * 60 * 1000;
  return { start: new Date(dayMidnightUtc - halfDay), end: new Date(dayMidnightUtc + halfDay) };
}

/**
 * `Tenant.timezone` as something `Intl` will accept. The column defaults to
 * Europe/London and onboarding writes the owner's browser zone, so a bad value
 * is rare — but `Intl.DateTimeFormat` throws a RangeError on one, and a coach
 * asking "what is on today" must never get a 500 for a settings typo.
 */
export function usableTimezone(timeZone: string | null | undefined): string {
  if (!timeZone) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function formatHHmm(d: Date, timeZone: string): string {
  // Rendered in the CLUB's zone, not the server's and not the reader's. The old
  // version used getHours(), so the same class read differently server-side and
  // in the browser.
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(d)
    .replace(/ /g, " "); // ICU uses a narrow no-break space before AM/PM
}

export type ClassStatusVariant = "future" | "soon" | "ongoing" | "ended";

export interface ClassStatus {
  label: string;
  variant: ClassStatusVariant;
}

export function classStatus(
  inst: { date: Date; startTime: string; endTime: string },
  timeZone: string,
  now: Date = new Date(),
): ClassStatus {
  const start = parseTime(inst.startTime, inst.date, timeZone);
  const end = parseTime(inst.endTime, inst.date, timeZone);
  const minToStart = (start.getTime() - now.getTime()) / 60_000;

  if (now > end) return { label: "Ended", variant: "ended" };
  if (now >= start) return { label: "Ongoing", variant: "ongoing" };
  if (minToStart <= 60)
    return { label: `Starts in ${Math.ceil(minToStart)} min`, variant: "soon" };
  return { label: `Starts at ${formatHHmm(start, timeZone)}`, variant: "future" };
}
