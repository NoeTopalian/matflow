import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/authz";

export async function GET() {
  const { tenantId, userId, role } = await requireStaff();

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const isPrivileged = ["owner", "manager", "admin"].includes(role);

  const instances = await prisma.classInstance.findMany({
    where: {
      class: {
        tenantId,
        ...(isPrivileged ? {} : { instructorId: userId }),
      },
      date: { gte: startOfDay, lte: endOfDay },
      isCancelled: false,
    },
    include: {
      class: {
        select: { id: true, name: true, location: true, coachName: true, instructorId: true, maxCapacity: true, color: true },
      },
      attendances: { select: { id: true } },
      waitlists: { select: { id: true } },
    },
    orderBy: { startTime: "asc" },
  });

  return NextResponse.json(
    instances.map((inst) => ({
      id: inst.id,
      classId: inst.class.id,
      name: inst.class.name,
      coachName: inst.class.coachName,
      location: inst.class.location,
      color: inst.class.color,
      startTime: inst.startTime,
      endTime: inst.endTime,
      maxCapacity: inst.class.maxCapacity,
      attendedCount: inst.attendances.length,
      waitlistCount: inst.waitlists.length,
    })),
  );
}
