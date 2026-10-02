/**
 * The date an import reads entitlement at: the export's snapshot time, as a
 * calendar date in the CLUB's timezone (a TeamUp start/expiry date is a club
 * day, not an instant). Without a recorded snapshot time the only honest
 * choice is today in the club's zone — the preview says so.
 */
import { clubDayMarker } from "@/lib/today-sessions";
import { usableTimezone } from "@/lib/class-time";

export function asOfDate(sourceExportedAt: Date | null | undefined, timeZone: string | null | undefined): string {
  const tz = usableTimezone(timeZone);
  const instant = sourceExportedAt ?? new Date();
  return clubDayMarker(instant, tz).toISOString().slice(0, 10);
}
