/**
 * Canonical date/time formatting for MatFlow.
 *
 * All user-facing dates go through here (UI-RULES §10) — never bare
 * toLocaleDateString(). Every formatter is hard-locked to the `en-GB`
 * locale so a US-locale browser never renders "08/15/2026" to a UK gym.
 */

const LOCALE = "en-GB";

type DateInput = Date | string | number;

function toDate(d: DateInput): Date {
  return d instanceof Date ? d : new Date(d);
}

/** `{ timeZone }` when one is given: the formatters below default to the reader's zone. */
function zone(timeZone: string | undefined): { timeZone?: string } {
  return timeZone ? { timeZone } : {};
}

/** "15 Aug 2026". Pass `timeZone` (the club's) to format an instant on that clock, not the reader's. */
export function formatDate(d: DateInput, timeZone?: string): string {
  return toDate(d).toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...zone(timeZone),
  });
}

/** "Wednesday 4 November 2026" — built from parts, so no ICU version adds a comma after the weekday. */
export function formatDateFull(d: DateInput, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    ...zone(timeZone),
  }).formatToParts(toDate(d));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")} ${part("year")}`;
}

/** "15 August 2026" */
export function formatDateLong(d: DateInput): string {
  return toDate(d).toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** "18:05" (24-hour). Pass `timeZone` to read the club's clock. */
export function formatTime(d: DateInput, timeZone?: string): string {
  return toDate(d).toLocaleTimeString(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...zone(timeZone),
  });
}

/**
 * "Fri 15 Aug". Pass `timeZone` to name the day in that zone rather than the
 * reader's — "UTC" for a day marker such as `ClassInstance.date`.
 */
export function formatDayLabel(d: DateInput, timeZone?: string): string {
  return toDate(d).toLocaleDateString(LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(timeZone ? { timeZone } : {}),
  });
}

/** "Week of 11 Aug" — label for the week containing the given date (Monday start). */
export function formatWeekLabel(d: DateInput): string {
  const date = toDate(d);
  const monday = new Date(date);
  const day = monday.getDay(); // 0 = Sunday
  monday.setDate(monday.getDate() - ((day + 6) % 7));
  return `Week of ${monday.toLocaleDateString(LOCALE, { day: "numeric", month: "short" })}`;
}

/** "15 Aug 2026, 18:05" */
export function formatDateTime(d: DateInput, timeZone?: string): string {
  return `${formatDate(d, timeZone)}, ${formatTime(d, timeZone)}`;
}

/**
 * "October 2026" — a calendar month named in `timeZone` (default UTC, so a
 * mid-month instant names its month whatever the reader's zone). Used for the
 * club-zone month windows in lib/club-month.ts (review L4).
 */
export function formatMonthYear(d: DateInput, timeZone = "UTC"): string {
  return toDate(d).toLocaleDateString(LOCALE, { month: "long", year: "numeric", timeZone });
}
