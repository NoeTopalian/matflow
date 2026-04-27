import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/authz";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { tenantId, userId, role } = await requireStaff();
  const { id: classInstanceId } = await params;

  const isPrivileged = ["owner", "manager", "admin"].includes(role);
  const showMedical = isPrivileged; // medical notes redacted from coach role

  const instance = await prisma.classInstance.findFirst({
    where: {
      id: classInstanceId,
      class: {
        tenantId,
        ...(isPrivileged ? {} : { instructorId: userId }),
      },
    },
    include: {
      class: {
        select: { id: true, name: true, location: true, coachName: true, maxCapacity: true, color: true },
      },
    },
  });
  if (!instance) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const [bookings, attendances, waitlist] = await Promise.all([
    prisma.classSubscription.findMany({
      where: { classId: instance.class.id, member: { tenantId } },
      include: {
        member: {
          select: {
            id: true, name: true, email: true, status: true, accountType: true,
            membershipType: true,
            waiverAccepted: true, waiverAcceptedAt: true,
            ...(showMedical ? { medicalConditions: true } : {}),
            memberRanks: {
              orderBy: { achievedAt: "desc" },
              take: 1,
              include: { rankSystem: { select: { name: true, color: true, discipline: true } } },
            },
          },
        },
      },
    }),
    prisma.attendanceRecord.findMany({
      where: { classInstanceId },
      select: { memberId: true, checkInTime: true, checkInMethod: true },
    }),
    prisma.classWaitlist.findMany({
      where: { classInstanceId, status: "waiting" },
      orderBy: { position: "asc" },
      include: {
        member: { select: { id: true, name: true, email: true, status: true } },
      },
    }),
  ]);

  const attendedById = new Map(attendances.map((a) => [a.memberId, a]));

  const memberIds = bookings.map((b) => b.member.id);
  const lastVisits = memberIds.length
    ? await prisma.attendanceRecord.findMany({
        where: { memberId: { in: memberIds }, classInstanceId: { not: classInstanceId } },
        orderBy: { checkInTime: "desc" },
        distinct: ["memberId"],
        select: { memberId: true, checkInTime: true },
      })
    : [];
  const lastVisitById = new Map(lastVisits.map((lv) => [lv.memberId, lv.checkInTime]));

  return NextResponse.json({
    instance: {
      id: instance.id,
      classId: instance.class.id,
      name: instance.class.name,
      location: instance.class.location,
      coachName: instance.class.coachName,
      color: instance.class.color,
      maxCapacity: instance.class.maxCapacity,
      date: instance.date.toISOString(),
      startTime: instance.startTime,
      endTime: instance.endTime,
    },
    expected: bookings.map((b) => {
      const attended = attendedById.get(b.member.id);
      const rank = b.member.memberRanks?.[0];
      const m = b.member as typeof b.member & { medicalConditions?: string | null };
      return {
        memberId: b.member.id,
        name: b.member.name,
        email: b.member.email,
        status: b.member.status,
        accountType: b.member.accountType,
        membershipType: b.member.membershipType,
        waiverAccepted: b.member.waiverAccepted,
        rank: rank ? {
          name: rank.rankSystem.name,
          color: rank.rankSystem.color,
          discipline: rank.rankSystem.discipline,
          stripes: rank.stripes,
        } : null,
        attended: !!attended,
        attendedAt: attended?.checkInTime.toISOString() ?? null,
        attendedMethod: attended?.checkInMethod ?? null,
        lastVisitAt: lastVisitById.get(b.member.id)?.toISOString() ?? null,
        medicalConditions: showMedical ? m.medicalConditions ?? null : null,
      };
    }),
    waitlist: waitlist.map((w) => ({
      memberId: w.member.id,
      name: w.member.name,
      position: w.position,
      status: w.status,
    })),
    showMedical,
  });
}
