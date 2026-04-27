/**
 * GET /api/member/me
 * Returns the logged-in member's profile, current belt, and attendance stats.
 * Falls back to demo data if not connected to DB.
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { getWeekKey, calculateStreak } from "@/lib/streak";

const DEMO_RESPONSE = {
  id: "demo-member",
  name: "Alex Johnson",
  email: "alex@example.com",
  phone: null,
  membershipType: "Monthly",
  status: "active",
  joinedAt: "2025-09-01T00:00:00.000Z",
  primaryColor: "#3b82f6",
  onboardingCompleted: false,
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

    const member = await prisma.member.findFirst({
      where: { id: memberId, tenantId: session.user.tenantId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        membershipType: true,
        status: true,
        joinedAt: true,
        onboardingCompleted: true,
        emergencyContactName: true,
        emergencyContactPhone: true,
        medicalConditions: true,
        dateOfBirth: true,
        waiverAccepted: true,
        waiverAcceptedAt: true,
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

    const oneYearAgo = new Date(now);
    oneYearAgo.setDate(now.getDate() - 364);

    const [thisWeek, thisMonth, thisYear, attendanceDates] = await Promise.all([
      prisma.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfWeek } } }),
      prisma.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfMonth } } }),
      prisma.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfYear } } }),
      prisma.attendanceRecord.findMany({
        where: { memberId, checkInTime: { gte: oneYearAgo } },
        select: { checkInTime: true },
        orderBy: { checkInTime: "desc" },
      }),
    ]);

    const streakWeeks = calculateStreak(
      attendanceDates.map((r: typeof attendanceDates[number]) => r.checkInTime),
      now,
    );

    const currentRank = member.memberRanks[0];

    return NextResponse.json({
      id: member.id,
      name: member.name,
      email: member.email,
      phone: member.phone,
      membershipType: member.membershipType,
      status: member.status,
      joinedAt: member.joinedAt.toISOString(),
      primaryColor: session.user.primaryColor ?? "#3b82f6",
      onboardingCompleted: member.onboardingCompleted,
      emergencyContactName: member.emergencyContactName ?? null,
      emergencyContactPhone: member.emergencyContactPhone ?? null,
      medicalConditions: member.medicalConditions ?? null,
      dateOfBirth: member.dateOfBirth ? member.dateOfBirth.toISOString() : null,
      waiverAccepted: member.waiverAccepted,
      waiverAcceptedAt: member.waiverAcceptedAt ? member.waiverAcceptedAt.toISOString() : null,
      belt: currentRank
        ? {
            name: currentRank.rankSystem.name,
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
        streakWeeks,
        totalClasses: member._count.attendances,
      },
    });
  } catch {
    return NextResponse.json(DEMO_RESPONSE);
  }
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberId = session.user.memberId as string | undefined;
  if (!memberId || session.user.tenantId === "demo-tenant") {
    return NextResponse.json({ ok: true }); // no-op for demo
  }

  try {
    const body = await req.json() as {
      onboardingCompleted?: boolean;
      name?: string;
      phone?: string;
      belt?: string;
      stripes?: number;
      emergencyContactName?: string;
      emergencyContactPhone?: string;
      medicalConditions?: string[];
      dateOfBirth?: string;
      waiverAccepted?: boolean;
    };
    const { onboardingCompleted, name, phone, belt, stripes,
            emergencyContactName, emergencyContactPhone,
            medicalConditions, dateOfBirth, waiverAccepted } = body;

    const updateData: Record<string, unknown> = {};
    if (typeof onboardingCompleted === "boolean") updateData.onboardingCompleted = onboardingCompleted;
    if (typeof name === "string" && name.trim()) updateData.name = name.trim();
    if (typeof phone === "string") updateData.phone = phone.trim() || null;
    if (typeof emergencyContactName === "string") updateData.emergencyContactName = emergencyContactName.trim() || null;
    if (typeof emergencyContactPhone === "string") updateData.emergencyContactPhone = emergencyContactPhone.trim() || null;
    if (Array.isArray(medicalConditions)) updateData.medicalConditions = JSON.stringify(medicalConditions);
    if (typeof dateOfBirth === "string" && dateOfBirth) {
      const d = new Date(dateOfBirth);
      if (!isNaN(d.getTime())) updateData.dateOfBirth = d;
    }

    // Waiver must be server-stamped — never trust client-sent timestamps/IPs
    let createSignedWaiverFor: { memberName: string; ip: string; ua: string } | null = null;
    if (waiverAccepted === true) {
      const existing = await prisma.member.findUnique({
        where: { id: memberId },
        select: { waiverAccepted: true, name: true },
      });
      if (!existing?.waiverAccepted) {
        const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
        updateData.waiverAccepted = true;
        updateData.waiverAcceptedAt = new Date();
        updateData.waiverIpAddress = ip;
        createSignedWaiverFor = {
          memberName: (typeof name === "string" && name.trim()) || existing?.name || "",
          ip,
          ua: req.headers.get("user-agent")?.slice(0, 500) ?? "",
        };
      }
    }

    if (Object.keys(updateData).length > 0) {
      await prisma.member.updateMany({
        where: { id: memberId, tenantId: session.user.tenantId },
        data: updateData,
      });
    }

    // Append-only legal record of exactly what the member agreed to.
    if (createSignedWaiverFor) {
      try {
        const tenant = await prisma.tenant.findUnique({
          where: { id: session.user.tenantId },
          select: { name: true, waiverTitle: true, waiverContent: true },
        });
        const { buildDefaultWaiverTitle, buildDefaultWaiverContent } = await import("@/lib/default-waiver");
        const signed = await prisma.signedWaiver.create({
          data: {
            memberId,
            tenantId: session.user.tenantId,
            titleSnapshot: tenant?.waiverTitle ?? buildDefaultWaiverTitle(tenant?.name),
            contentSnapshot: tenant?.waiverContent ?? buildDefaultWaiverContent(tenant?.name),
            signerName: createSignedWaiverFor.memberName || null,
            ipAddress: createSignedWaiverFor.ip,
            userAgent: createSignedWaiverFor.ua,
          },
        });
        const { logAudit } = await import("@/lib/audit-log");
        await logAudit({
          tenantId: session.user.tenantId,
          userId: null,
          action: "waiver.sign",
          entityType: "Member",
          entityId: memberId,
          metadata: { signedWaiverId: signed.id },
          req,
        });
      } catch {
        // Best-effort — don't fail the user-facing request if logging fails.
      }
    }

    // Optionally create/update MemberRank from onboarding belt selection
    if (belt && typeof stripes === "number") {
      const rankSystem = await prisma.rankSystem.findFirst({
        where: { tenantId: session.user.tenantId, name: { contains: belt } },
      });
      if (rankSystem) {
        await prisma.memberRank.upsert({
          where: { memberId_rankSystemId: { memberId, rankSystemId: rankSystem.id } },
          create: { memberId, rankSystemId: rankSystem.id, stripes },
          update: { stripes },
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
