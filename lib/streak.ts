/** Returns the ISO date string (YYYY-MM-DD) of the Monday that starts the week containing d (UTC). */
export function getWeekKey(d: Date): string {
  const date = new Date(d);
  date.setUTCHours(0, 0, 0, 0);
  const offset = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().split("T")[0];
}

/**
 * Counts consecutive weeks (Monday-start) with attendance, walking back from `now`.
 * A gap in the CURRENT week (w=0) does not break the streak — you may not have trained yet this week.
 * A gap in any previous week breaks immediately.
 */
export function calculateStreak(attendanceDates: Date[], now: Date = new Date()): number {
  const weekSet = new Set(attendanceDates.map(getWeekKey));
  let streakWeeks = 0;
  for (let w = 0; w <= 52; w++) {
    const check = new Date(now);
    check.setUTCDate(now.getUTCDate() - w * 7);
    if (weekSet.has(getWeekKey(check))) {
      streakWeeks++;
    } else if (w > 0) {
      break;
    }
  }
  return streakWeeks;
}
