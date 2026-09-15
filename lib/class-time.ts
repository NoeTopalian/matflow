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
function zoneOffsetMs(instant: Date, timeZone: string): number {
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
export function parseTime(hhmm: string, baseDate: Date, timeZone: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const naiveUtc = Date.UTC(
    baseDate.getUTCFullYear(),
    baseDate.getUTCMonth(),
    baseDate.getUTCDate(),
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
