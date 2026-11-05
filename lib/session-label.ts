import { formatDayLabel } from "@/lib/date";

/**
 * "Advanced No-Gi · Wed 4 Nov, 19:00" — one session, named the same wherever
 * it is linked from.
 *
 * `ClassInstance.date` is a UTC day marker and `startTime` is the club's wall
 * clock as "HH:mm". So the marker is formatted in UTC and the time is printed
 * as stored: building a Date from the two and formatting it would move the
 * session by the reader's (or the server's) offset.
 */
export function sessionLabel(className: string, date: Date | string, startTime: string): string {
  return `${className} · ${formatDayLabel(date, "UTC")}, ${startTime}`;
}
