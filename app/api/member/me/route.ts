/**
 * GET /api/member/me
 * Returns the logged-in member's profile, current belt, and attendance stats.
 * Falls back to demo data if not connected to DB.
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { getWeekKey, calculateStreak } from "@/lib/streak";
import { resolveCoachName } from "@/lib/class-coach";

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
    attendanceByClass: [
      { id: "demo-c1", name: "Beginner BJJ", count: 18 },
      { id: "demo-c2", name: "No-Gi", count: 12 },
      { id: "demo-c3", name: "Open Mat", count: 9 },
    ],
    avgClassesPerWeek: 3.2,
  },
  nextClass: {
    id: "demo-inst-1",
    classId: "demo-c1",
    name: "Beginner BJJ",
    coach: "Coach Mike",
    location: "Mat 1",
    date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    startTime: "18:00",
    endTime: "19:00",
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
        emergencyContactRelation: true,
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

    // Sprint 4-A US-401: extra windows for richer stats + next-class lookup
    const ninetyDaysAgo = new Date(now);
    ninetyDaysAgo.setDate(now.getDate() - 90);
    const eightWeeksAgo = new Date(now);
    eightWeeksAgo.setDate(now.getDate() - 56);

    const [thisWeek, thisMonth, thisYear, attendanceDates, byClassAgg, last8w, nextInstance] = await Promise.all([
      prisma.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfWeek } } }),
      prisma.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfMonth } } }),
      prisma.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfYear } } }),
      prisma.attendanceRecord.findMany({
        where: { memberId, checkInTime: { gte: oneYearAgo } },
        select: { checkInTime: true },
        orderBy: { checkInTime: "desc" },
      }),
      prisma.attendanceRecord.findMany({
        where: { memberId, checkInTime: { gte: ninetyDaysAgo } },
        select: { classInstance: { select: { class: { select: { id: true, name: true } } } } },
      }),
      prisma.attendanceRecord.count({ where: { memberId, checkInTime: { gte: eightWeeksAgo } } }),
      prisma.classInstance.findFirst({
        where: {
          class: { tenantId: session.user.tenantId, isActive: true },
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

    // Top 3 classes by attendance count over last 90 days
    const classCounts = new Map<string, { id: string; name: string; count: number }>();
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
      attendanceDates.map((r: typeof attendanceDates[number]) => r.checkInTime),
      now,
    );

    const currentRank = member.memberRanks[0];

    // LB-007 (audit H4): resolve promoter's name when promotedById is set.
    // Previously promotedBy was hardcoded to null even though promotedById is
    // stored on every promotion (see /api/members/[id]/rank lines 66, 71, 95, 100).
    let promotedBy: { id: string; name: string } | null = null;
    if (currentRank?.promotedById) {
      const promoter = await prisma.user.findUnique({
        where: { id: currentRank.promotedById },
        select: { id: true, name: true },
      });
      if (promoter) promotedBy = promoter;
    }

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
      emergencyContactRelation: member.emergencyContactRelation ?? null,
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
            promotedBy,
          }
        : null,
      stats: {
        thisWeek,
        thisMonth,
        thisYear,
        streakWeeks,
        totalClasses: member._count.attendances,
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
      emergencyContactRelation?: string;
      medicalConditions?: string[];
      dateOfBirth?: string;
      waiverAccepted?: boolean;
      hasKidsHint?: boolean;
    };
    const { onboardingCompleted, name, phone, belt, stripes,
            emergencyContactName, emergencyContactPhone, emergencyContactRelation,
            medicalConditions, dateOfBirth, waiverAccepted, hasKidsHint } = body;

    const updateData: Record<string, unknown> = {};
    if (typeof onboardingCompleted === "boolean") updateData.onboardingCompleted = onboardingCompleted;
    if (typeof name === "string" && name.trim()) updateData.name = name.trim();
    if (typeof phone === "string") updateData.phone = phone.trim() || null;
    if (typeof emergencyContactName === "string") updateData.emergencyContactName = emergencyContactName.trim().slice(0, 120) || null;
    if (typeof emergencyContactPhone === "string") updateData.emergencyContactPhone = emergencyContactPhone.trim().slice(0, 30) || null;
    if (typeof emergencyContactRelation === "string") updateData.emergencyContactRelation = emergencyContactRelation.trim().slice(0, 60) || null;
    if (Array.isArray(medicalConditions)) updateData.medicalConditions = JSON.stringify(medicalConditions);
    if (typeof dateOfBirth === "string" && dateOfBirth) {
      const d = new Date(dateOfBirth);
      if (!isNaN(d.getTime())) updateData.dateOfBirth = d;
    }
    if (typeof hasKidsHint === "boolean") updateData.hasKidsHint = hasKidsHint;

    // Server-side trio enforcement: setting onboardingCompleted=true requires
    // emergency contact name/phone/relation. Mirrors the waiver gate below so
    // a client that bypasses step-6 client validation can't slip through.
    if (onboardingCompleted === true) {
      const existingForOnboarding = await prisma.member.findFirst({
        where: { id: memberId, tenantId: session.user.tenantId },
        select: {
          onboardingCompleted: true,
          emergencyContactName: true,
          emergencyContactPhone: true,
          emergencyContactRelation: true,
        },
      });
      if (!existingForOnboarding?.onboardingCompleted) {
        const trioName = typeof emergencyContactName === "string"
          ? emergencyContactName.trim()
          : existingForOnboarding?.emergencyContactName?.trim();
        const trioPhone = typeof emergencyContactPhone === "string"
          ? emergencyContactPhone.trim()
          : existingForOnboarding?.emergencyContactPhone?.trim();
        const trioRelation = typeof emergencyContactRelation === "string"
          ? emergencyContactRelation.trim()
          : existingForOnboarding?.emergencyContactRelation?.trim();
        if (!trioName || !trioPhone || !trioRelation) {
          return NextResponse.json(
            { error: "Emergency contact name, phone, and relation are required to complete onboarding." },
            { status: 400 },
          );
        }
      }
    }

    // Waiver must be server-stamped — never trust client-sent timestamps/IPs
    let createSignedWaiverFor: { memberName: string; ip: string; ua: string } | null = null;
    if (waiverAccepted === true) {
      const existing = await prisma.member.findFirst({
        where: { id: memberId, tenantId: session.user.tenantId },
        select: {
          waiverAccepted: true,
          name: true,
          emergencyContactName: true,
          emergencyContactPhone: true,
          emergencyContactRelation: true,
        },
      });
      if (!existing?.waiverAccepted) {
        const emergencyNameForWaiver =
          typeof emergencyContactName === "string" ? emergencyContactName.trim() : existing?.emergencyContactName?.trim();
        const emergencyPhoneForWaiver =
          typeof emergencyContactPhone === "string" ? emergencyContactPhone.trim() : existing?.emergencyContactPhone?.trim();
        const emergencyRelationForWaiver =
          typeof emergencyContactRelation === "string" ? emergencyContactRelation.trim() : existing?.emergencyContactRelation?.trim();
        if (!emergencyNameForWaiver || !emergencyPhoneForWaiver || !emergencyRelationForWaiver) {
          return NextResponse.json(
            { error: "Emergency contact name, phone, and relation are required before signing." },
            { status: 400 },
          );
        }
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

    // Optionally create/update MemberRank from onboarding belt selection.
    // Belt rank can only be set during onboarding; post-onboarding changes must
    // come from the staff endpoint /api/members/[id]/rank.
    if (belt && typeof stripes === "number") {
      const existing = await prisma.member.findFirst({
        where: { id: memberId, tenantId: session.user.tenantId },
        select: { onboardingCompleted: true },
      });
      if (!existing?.onboardingCompleted) {
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
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
