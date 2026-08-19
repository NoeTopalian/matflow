/**
 * Demo-tenant attendance history.
 *
 * The demo fixtures used to omit `badges` entirely, so the Milestones card
 * silently vanished on demo tenants while the same fixture claimed 47 classes
 * — the numbers contradicted each other on screen.
 *
 * The fix is deliberately NOT a hand-written array of badges with authored
 * `earnedAt` dates: "no placeholder milestones" is the example UI-RULES §7
 * gives by name. Instead we synthesise a plausible check-in history and run the
 * REAL `computeBadges` over it, so every demo badge is genuinely derived and
 * every date is the real crossing point of that history.
 */

import { computeBadges, type BadgeRow, type MemberBadge } from "@/lib/member-stats";

/** Matches the fixtures' `totalClasses: 47` / `thisYear: 47` / `streakWeeks: 8`. */
const DEMO_TOTAL = 47;
const DEMO_STREAK_WEEKS = 8;

/** The three classes the demo fixture already advertises in attendanceByClass. */
const DEMO_CLASS_IDS = ["demo-c1", "demo-c2", "demo-c3"];

/**
 * 47 check-ins ending today, roughly three a week, cycling the three demo
 * classes. Anchored on the supplied `now` so the demo never drifts into
 * looking abandoned.
 */
export function demoAttendanceRows(now: Date): BadgeRow[] {
  const rows: BadgeRow[] = [];
  // Three sessions a week: Monday, Wednesday, Friday, walking backwards.
  const offsets = [0, 2, 4];
  let index = 0;
  for (let week = 0; index < DEMO_TOTAL; week++) {
    for (const dayOffset of offsets) {
      if (index >= DEMO_TOTAL) break;
      const at = new Date(now.getTime());
      at.setUTCDate(at.getUTCDate() - week * 7 - dayOffset);
      at.setUTCHours(18, 30, 0, 0);
      rows.push({ at, classId: DEMO_CLASS_IDS[index % DEMO_CLASS_IDS.length] });
      index++;
    }
  }
  // computeBadges expects oldest first.
  return rows.reverse();
}

export function demoBadges(now: Date = new Date()): MemberBadge[] {
  return computeBadges(demoAttendanceRows(now), DEMO_STREAK_WEEKS, now);
}
