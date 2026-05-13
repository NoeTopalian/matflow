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
import { calculateStreak } from "@/lib/streak";
import { resolveCoachName } from "@/lib/class-coach";

export type AttendanceByClass = { id: string; name: string; count: number };

export type MemberStats = {
  thisWeek: number;
  thisMonth: number;
  thisYear: number;
  streakWeeks: number;
  totalClasses: number;
  attendanceByClass: AttendanceByClass[];
  avgClassesPerWeek: number;
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
  const oneYearAgo = new Date(now);
  oneYearAgo.setDate(now.getDate() - 364);
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(now.getDate() - 90);
  const eightWeeksAgo = new Date(now);
  eightWeeksAgo.setDate(now.getDate() - 56);

  const [thisWeek, thisMonth, thisYear, attendanceDates, byClassAgg, last8w, totalClasses, nextInstance] = await Promise.all([
    tx.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfWeek } } }),
    tx.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfMonth } } }),
    tx.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfYear } } }),
    tx.attendanceRecord.findMany({
      where: { memberId, checkInTime: { gte: oneYearAgo } },
      select: { checkInTime: true },
      orderBy: { checkInTime: "desc" },
    }),
    tx.attendanceRecord.findMany({
      where: { memberId, checkInTime: { gte: ninetyDaysAgo } },
      select: { classInstance: { select: { class: { select: { id: true, name: true } } } } },
    }),
    tx.attendanceRecord.count({ where: { memberId, checkInTime: { gte: eightWeeksAgo } } }),
    tx.attendanceRecord.count({ where: { memberId } }),
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

  const streakWeeks = calculateStreak(
    attendanceDates.map((r) => r.checkInTime),
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
