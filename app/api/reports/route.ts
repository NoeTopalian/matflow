/**
 * GET /api/reports
 * Returns aggregated analytics for the owner reports dashboard.
 * Query params:
 *   weeks=12  (how many weeks of attendance history to return, default 12)
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canView = ["owner", "manager"].includes(session.user.role);
  if (!canView) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { tenantId } = session.user;
  const { searchParams } = new URL(req.url);
  const weeksBack = Math.min(parseInt(searchParams.get("weeks") ?? "12"), 24);

  const now = new Date();

  // ── Weekly attendance (last N weeks) ──────────────────────────────────────
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7) - (weeksBack - 1) * 7);
  weekStart.setHours(0, 0, 0, 0);

  const allRecords = await prisma.attendanceRecord.findMany({
    where: {
      member: { tenantId },
      checkInTime: { gte: weekStart },
    },
    select: { checkInTime: true, checkInMethod: true },
  });

  // Build weekly buckets
  const weeklyMap = new Map<string, number>();
  for (let i = 0; i < weeksBack; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i * 7);
    const label = `${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}`;
    weeklyMap.set(label, 0);
  }
  for (const rec of allRecords) {
    const d = new Date(rec.checkInTime);
    // Find the Monday of this record's week
    const mon = new Date(d);
    mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    mon.setHours(0, 0, 0, 0);
    const label = `${mon.getDate()} ${mon.toLocaleString("en-GB", { month: "short" })}`;
    if (weeklyMap.has(label)) {
      weeklyMap.set(label, (weeklyMap.get(label) ?? 0) + 1);
    }
  }
  const weeklyAttendance = Array.from(weeklyMap.entries()).map(([week, count]) => ({ week, count }));

  // ── Check-in method breakdown (all time) ─────────────────────────────────
  const methodCounts = await prisma.attendanceRecord.groupBy({
    by: ["checkInMethod"],
    where: { member: { tenantId } },
    _count: true,
  });
  const checkInMethods = methodCounts.map((m) => ({
    method: m.checkInMethod,
    count: m._count,
  }));

  // ── Member status breakdown ───────────────────────────────────────────────
  const memberStatusCounts = await prisma.member.groupBy({
    by: ["status"],
    where: { tenantId },
    _count: true,
  });
  const membersByStatus = memberStatusCounts.map((m) => ({
    status: m.status,
    count: m._count,
  }));

  // ── Monthly new member signups (last 6 months) ────────────────────────────
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const newMembers = await prisma.member.findMany({
    where: { tenantId, joinedAt: { gte: sixMonthsAgo } },
    select: { joinedAt: true },
  });
  const monthlyMap = new Map<string, number>();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleString("en-GB", { month: "short", year: "2-digit" });
    monthlyMap.set(label, 0);
  }
  for (const m of newMembers) {
    const label = m.joinedAt.toLocaleString("en-GB", { month: "short", year: "2-digit" });
    if (monthlyMap.has(label)) {
      monthlyMap.set(label, (monthlyMap.get(label) ?? 0) + 1);
    }
  }
  const monthlySignups = Array.from(monthlyMap.entries()).map(([month, count]) => ({ month, count }));

  // ── Top 5 classes by attendance ───────────────────────────────────────────
  const topClasses = await prisma.attendanceRecord.groupBy({
    by: ["classInstanceId"],
    where: { member: { tenantId } },
    _count: true,
    orderBy: { _count: { classInstanceId: "desc" } },
    take: 50,
  });

  // Get class names for top instances
  const instanceIds = topClasses.map((t) => t.classInstanceId);
  const instances = await prisma.classInstance.findMany({
    where: { id: { in: instanceIds } },
    include: { class: { select: { name: true } } },
  });

  // Aggregate by class name
  const classNameMap = new Map<string, number>();
  for (const t of topClasses) {
    const inst = instances.find((i) => i.id === t.classInstanceId);
    if (!inst) continue;
    const name = inst.class.name;
    classNameMap.set(name, (classNameMap.get(name) ?? 0) + t._count);
  }
  const topClassesByAttendance = Array.from(classNameMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // ── Summary totals ────────────────────────────────────────────────────────
  const [totalMembers, totalCheckIns, totalClasses] = await Promise.all([
    prisma.member.count({ where: { tenantId } }),
    prisma.attendanceRecord.count({ where: { member: { tenantId } } }),
    prisma.class.count({ where: { tenantId, isActive: true } }),
  ]);

  return NextResponse.json({
    summary: { totalMembers, totalCheckIns, totalClasses },
    weeklyAttendance,
    monthlySignups,
    membersByStatus,
    checkInMethods,
    topClassesByAttendance,
  });
}
