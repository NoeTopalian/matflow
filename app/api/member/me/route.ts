/**
 * GET /api/member/me
 * Returns the logged-in member's profile, current belt, and attendance stats.
 * Falls back to demo data if not connected to DB.
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

const DEMO_RESPONSE = {
  id: "demo-member",
  name: "Alex Johnson",
  email: "alex@example.com",
  phone: null,
  membershipType: "Monthly",
  status: "active",
  joinedAt: "2025-09-01T00:00:00.000Z",
  belt: {
    name: "Blue Belt",
    color: "#3b82f6",
    stripes: 3,
    achievedAt: "2026-02-01T00:00:00.000Z",
    promotedBy: "Coach Mike",
  },
  stats: {
    thisWeek: 3,
    thisMonth: 9,
    thisYear: 47,
    streakWeeks: 8,
    totalClasses: 47,
  },
};

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Demo fallback
  if (session.user.tenantId === "demo-tenant") {
    return NextResponse.json({ ...DEMO_RESPONSE, name: session.user.name ?? DEMO_RESPONSE.name });
  }

  try {
    const memberId = session.user.memberId as string | undefined;
    if (!memberId) {
      return NextResponse.json(DEMO_RESPONSE);
    }

    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        membershipType: true,
        status: true,
        joinedAt: true,
        memberRanks: {
          orderBy: { achievedAt: "desc" },
          take: 1,
          include: { rankSystem: true },
        },
        _count: { select: { attendances: true } },
      },
    });

    if (!member) return NextResponse.json(DEMO_RESPONSE);

    // Attendance stats
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    const [thisWeek, thisMonth, thisYear] = await Promise.all([
      prisma.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfWeek } } }),
      prisma.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfMonth } } }),
      prisma.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfYear } } }),
    ]);

    const currentRank = member.memberRanks[0];

    return NextResponse.json({
      id: member.id,
      name: member.name,
      email: member.email,
      phone: member.phone,
      membershipType: member.membershipType,
      status: member.status,
      joinedAt: member.joinedAt.toISOString(),
      belt: currentRank
        ? {
            name: `${currentRank.rankSystem.name} Belt`,
            color: currentRank.rankSystem.color ?? "#e5e7eb",
            stripes: currentRank.stripes,
            achievedAt: currentRank.achievedAt.toISOString(),
            promotedBy: null,
          }
        : null,
      stats: {
        thisWeek,
        thisMonth,
        thisYear,
        streakWeeks: 0, // TODO: calculate streak
        totalClasses: member._count.attendances,
      },
    });
  } catch {
    return NextResponse.json(DEMO_RESPONSE);
  }
}
