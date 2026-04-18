/**
 * GET /api/dashboard/stats
 * Returns key metrics for the owner dashboard.
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { tenantId } = session.user;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  startOfWeek.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  try {
    const [
      totalActive,
      newThisMonth,
      cancelledThisMonth,
      attendanceThisMonth,
      attendanceLastMonth,
      attendanceThisWeek,
    ] = await Promise.all([
      prisma.member.count({ where: { tenantId, status: "active" } }),
      prisma.member.count({ where: { tenantId, joinedAt: { gte: startOfMonth } } }),
      prisma.member.count({ where: { tenantId, status: "cancelled", updatedAt: { gte: startOfMonth } } }),
      prisma.attendanceRecord.count({
        where: { member: { tenantId }, checkInTime: { gte: startOfMonth } },
      }),
      prisma.attendanceRecord.count({
        where: {
          member: { tenantId },
          checkInTime: { gte: startOfLastMonth, lte: endOfLastMonth },
        },
      }),
      prisma.attendanceRecord.count({
        where: { member: { tenantId }, checkInTime: { gte: startOfWeek, lte: endOfWeek } },
      }),
    ]);

    const attendanceTrend =
      attendanceLastMonth > 0
        ? Math.round(((attendanceThisMonth - attendanceLastMonth) / attendanceLastMonth) * 100)
        : null;

    return NextResponse.json({
      totalActive,
      newThisMonth,
      cancelledThisMonth,
      attendanceThisMonth,
      attendanceThisWeek,
      attendanceTrend,
    });
  } catch {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
