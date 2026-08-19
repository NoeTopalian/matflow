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

/** "15 Aug 2026" */
export function formatDate(d: DateInput): string {
  return toDate(d).toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "15 August 2026" */
export function formatDateLong(d: DateInput): string {
  return toDate(d).toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** "18:05" (24-hour) */
export function formatTime(d: DateInput): string {
  return toDate(d).toLocaleTimeString(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "Fri 15 Aug" */
export function formatDayLabel(d: DateInput): string {
  return toDate(d).toLocaleDateString(LOCALE, {
    weekday: "short",
    day: "numeric",
    month: "short",
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
export function formatDateTime(d: DateInput): string {
  return `${formatDate(d)}, ${formatTime(d)}`;
}
