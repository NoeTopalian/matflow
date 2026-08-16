/**
 * Shared member stats helper.
 *
 * Single source of truth for the attendance/stats/nextClass shape returned by
 * BOTH the adult dashboard (`/api/member/me`) AND each kid detail endpoint
 * (`/api/member/children/[id]`). Co-locating the computation here guarantees
 * the two response shapes can't drift — a parent looking at their own dashboard
 * and at their kid's dashboard sees the same fields populated by the same logic.
 */

import type { Prisma } from "@prisma/client";
import { calculateStreak, getWeekKey } from "@/lib/streak";
import { resolveCoachName } from "@/lib/class-coach";

export type AttendanceByClass = { id: string; name: string; count: number };

/**
 * Milestone badge (member Progress page). Everything is derived from REAL
 * attendance rows — earned badges carry the date of the check-in that crossed
 * the threshold; locked badges carry live progress. Never fabricated
 * (UI-RULES §7). Deliberately no promotion/rank badges: promotions are the
 * coach's call and nothing here predicts or promises one.
 */
export type MemberBadge = {
  id: string;
  label: string;
  description: string;
  earned: boolean;
  /** ISO date of the check-in that earned the badge; null while locked. */
  earnedAt: string | null;
  /** Live progress while locked ("84 of 100"); null when earned or N/A. */
  progress: { current: number; target: number } | null;
};

/** One Monday-based week of the Progress heat strip. */
export type WeeklyCount = {
  /** ISO date (YYYY-MM-DD) of the Monday starting this week. */
  weekStart: string;
  count: number;
  /** That week's attended classes — names + ISO check-in dates only. */
  classes: { name: string; date: string }[];
};

export type MemberStats = {
  thisWeek: number;
  thisMonth: number;
  thisYear: number;
  streakWeeks: number;
  totalClasses: number;
  attendanceByClass: AttendanceByClass[];
  avgClassesPerWeek: number;
  /** ISO timestamp of the member's first-ever check-in; null if none yet. */
  firstCheckInAt: string | null;
  badges: MemberBadge[];
  /** Last 12 Monday-based weeks (oldest first, current week last). */
  weeklyCounts: WeeklyCount[];
};

export type NextClassShape = {
  id: string;
  classId: string;
  name: string;
  coach: string | null;
  location: string | null;
  date: string;
  startTime: string;
  endTime: string;
} | null;

export type MemberStatsResult = {
  stats: MemberStats;
  nextClass: NextClassShape;
};

/**
 * Computes attendance-windowed stats + the next upcoming class instance for
 * a given member. Pass an already-tenant-scoped Prisma transaction client
 * (`withTenantContext`'s callback argument). The function does NOT call
 * `withTenantContext` itself so callers can batch multiple stats reads in
 * a single transaction if they need to.
 */
export async function computeMemberStats(
  tx: Prisma.TransactionClient,
  args: { memberId: string; tenantId: string },
): Promise<MemberStatsResult> {
  const { memberId, tenantId } = args;
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  startOfWeek.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(now.getDate() - 90);
  const eightWeeksAgo = new Date(now);
  eightWeeksAgo.setDate(now.getDate() - 56);

  // attendanceDates deliberately fetches the FULL history (ascending, one
  // timestamp column): milestone badges need the exact check-in that crossed
  // each threshold (e.g. the date of the 100th class), which a 1-year window
  // cannot answer. It also replaces the separate totalClasses count query
  // (totalClasses === attendanceDates.length). Even a decade of daily training
  // is only ~3k tiny rows.
  const [thisWeek, thisMonth, thisYear, attendanceDates, byClassAgg, last8w, nextInstance] = await Promise.all([
    tx.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfWeek } } }),
    tx.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfMonth } } }),
    tx.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfYear } } }),
    tx.attendanceRecord.findMany({
      where: { memberId },
      select: { checkInTime: true },
      orderBy: { checkInTime: "asc" },
    }),
    // checkInTime added for the 12-week heat strip: the last 12 Monday-based
    // weeks reach back at most 83 days, so the existing 90-day window covers it.
    tx.attendanceRecord.findMany({
      where: { memberId, checkInTime: { gte: ninetyDaysAgo } },
      select: { checkInTime: true, classInstance: { select: { class: { select: { id: true, name: true } } } } },
    }),
    tx.attendanceRecord.count({ where: { memberId, checkInTime: { gte: eightWeeksAgo } } }),
    tx.classInstance.findFirst({
      where: {
        class: { tenantId, isActive: true },
        date: { gte: now },
        isCancelled: false,
      },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
      select: {
        id: true,
        date: true,
        startTime: true,
        endTime: true,
        class: {
          select: {
            id: true,
            name: true,
            coachName: true,
            coachUser: { select: { id: true, name: true } },
            location: true,
          },
        },
      },
    }),
  ]);

  // Top 3 classes by attendance count over the last 90 days.
  const classCounts = new Map<string, AttendanceByClass>();
  for (const row of byClassAgg) {
    const c = row.classInstance?.class;
    if (!c) continue;
    const existing = classCounts.get(c.id);
    if (existing) existing.count += 1;
    else classCounts.set(c.id, { id: c.id, name: c.name, count: 1 });
  }
  const attendanceByClass = Array.from(classCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  const avgClassesPerWeek = Math.round((last8w / 8) * 10) / 10;

  const datesAsc = attendanceDates.map((r) => r.checkInTime);
  const totalClasses = datesAsc.length;

  const streakWeeks = calculateStreak(datesAsc, now);

  const badges = computeBadges(datesAsc, streakWeeks);
  const weeklyCounts = computeWeeklyCounts(
    byClassAgg.map((r) => ({
      checkInTime: r.checkInTime,
      className: r.classInstance?.class?.name ?? null,
    })),
    now,
  );

  return {
    stats: {
      thisWeek,
      thisMonth,
      thisYear,
      streakWeeks,
      totalClasses,
      attendanceByClass,
      avgClassesPerWeek,
      firstCheckInAt: datesAsc[0]?.toISOString() ?? null,
      badges,
      weeklyCounts,
    },
    nextClass: nextInstance
      ? {
          id: nextInstance.id,
          classId: nextInstance.class.id,
          name: nextInstance.class.name,
          coach: resolveCoachName(nextInstance.class),
          location: nextInstance.class.location ?? null,
          date: nextInstance.date.toISOString(),
          startTime: nextInstance.startTime,
          endTime: nextInstance.endTime,
        }
      : null,
  };
}

// ─── Milestone badges ────────────────────────────────────────────────────────

const CLASS_MILESTONES: { target: number; id: string; label: string; description: string }[] = [
  { target: 1,   id: "classes-1",   label: "First class",  description: "Your first check-in" },
  { target: 10,  id: "classes-10",  label: "10 classes",   description: "10 check-ins" },
  { target: 25,  id: "classes-25",  label: "25 classes",   description: "25 check-ins" },
  { target: 50,  id: "classes-50",  label: "50 classes",   description: "50 check-ins" },
  { target: 100, id: "classes-100", label: "100 classes",  description: "100 check-ins" },
  { target: 250, id: "classes-250", label: "250 classes",  description: "250 check-ins" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Derives every milestone badge from the member's real check-in history.
 *
 * - Class-count thresholds: earned on the exact check-in that crossed the
 *   threshold (datesAsc[target - 1]); locked shows live progress.
 * - Streak badges: earned the first time in HISTORY a run of consecutive
 *   Monday-based training weeks reached 4 / 12 — the achievement date is the
 *   first check-in of the week that completed the run. Once earned, always
 *   earned (a broken streak doesn't un-earn history). Locked progress shows
 *   the current streak.
 * - Comeback: a check-in after a gap of ≥30 days — earned on the (earliest)
 *   returning check-in. No progress bar while locked: counting days away is
 *   not something we nudge.
 *
 * @param datesAsc every check-in timestamp, oldest first
 */
export function computeBadges(datesAsc: Date[], currentStreakWeeks: number): MemberBadge[] {
  const total = datesAsc.length;
  const badges: MemberBadge[] = [];

  for (const m of CLASS_MILESTONES) {
    const earned = total >= m.target;
    badges.push({
      id: m.id,
      label: m.label,
      description: m.description,
      earned,
      earnedAt: earned ? datesAsc[m.target - 1].toISOString() : null,
      progress: earned ? null : { current: total, target: m.target },
    });
  }

  // Historical streak runs over Monday-based weeks.
  const firstByWeek = new Map<string, Date>();
  for (const d of datesAsc) {
    const k = getWeekKey(d);
    if (!firstByWeek.has(k)) firstByWeek.set(k, d);
  }
  const weekKeys = Array.from(firstByWeek.keys()).sort();
  let runLen = 0;
  let prevMs = 0;
  let earned4: Date | null = null;
  let earned12: Date | null = null;
  for (const k of weekKeys) {
    const ms = Date.parse(`${k}T00:00:00.000Z`);
    runLen = prevMs !== 0 && ms - prevMs === 7 * DAY_MS ? runLen + 1 : 1;
    prevMs = ms;
    if (runLen === 4 && !earned4) earned4 = firstByWeek.get(k)!;
    if (runLen === 12 && !earned12) earned12 = firstByWeek.get(k)!;
  }
  badges.push({
    id: "streak-4",
    label: "4-week streak",
    description: "Train every week for a month",
    earned: earned4 !== null,
    earnedAt: earned4 ? earned4.toISOString() : null,
    progress: earned4 ? null : { current: Math.min(currentStreakWeeks, 4), target: 4 },
  });
  badges.push({
    id: "streak-12",
    label: "12-week streak",
    description: "Train every week for three months",
    earned: earned12 !== null,
    earnedAt: earned12 ? earned12.toISOString() : null,
    progress: earned12 ? null : { current: Math.min(currentStreakWeeks, 12), target: 12 },
  });

  // Comeback — a check-in after ≥30 days away (earliest occurrence).
  let comeback: Date | null = null;
  for (let i = 1; i < datesAsc.length; i++) {
    if (datesAsc[i].getTime() - datesAsc[i - 1].getTime() >= 30 * DAY_MS) {
      comeback = datesAsc[i];
      break;
    }
  }
  badges.push({
    id: "comeback",
    label: "Comeback",
    description: "Back after 30+ days away",
    earned: comeback !== null,
    earnedAt: comeback ? comeback.toISOString() : null,
    progress: null,
  });

  return badges;
}

// ─── 12-week heat strip ──────────────────────────────────────────────────────

/**
 * Buckets the supplied check-ins (must cover at least the last 12 Monday-based
 * weeks — the 90-day byClassAgg window does) into the last 12 weeks, oldest
 * first, current week last. Each bucket carries that week's attended class
 * names + check-in dates so the client can expand a week without refetching.
 */
export function computeWeeklyCounts(
  rows: { checkInTime: Date; className: string | null }[],
  now: Date,
): WeeklyCount[] {
  const currentMonday = new Date(`${getWeekKey(now)}T00:00:00.000Z`);
  const buckets = new Map<string, WeeklyCount>();
  const order: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(currentMonday);
    d.setUTCDate(currentMonday.getUTCDate() - i * 7);
    const key = d.toISOString().split("T")[0];
    order.push(key);
    buckets.set(key, { weekStart: key, count: 0, classes: [] });
  }
  for (const r of rows) {
    const bucket = buckets.get(getWeekKey(r.checkInTime));
    if (!bucket) continue;
    bucket.count += 1;
    bucket.classes.push({ name: r.className ?? "Check-in", date: r.checkInTime.toISOString() });
  }
  for (const key of order) {
    buckets.get(key)!.classes.sort((a, b) => a.date.localeCompare(b.date));
  }
  return order.map((key) => buckets.get(key)!);
}
