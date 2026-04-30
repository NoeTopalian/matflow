import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/authz";

export async function GET() {
  const { tenantId, userId, role } = await requireStaff();

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  // Widen the SQL window by ±12h so seeded rows whose stored timestamps drifted
  // across DST/UTC boundaries (e.g. instance created with a TZ offset that
  // landed on UTC date Apr 29 23:00 instead of Apr 30 00:00 BST) are still
  // considered. We then strictly filter by today's local calendar date below.
  const queryStart = new Date(startOfDay.getTime() - 12 * 60 * 60 * 1000);
  const queryEnd   = new Date(endOfDay.getTime()   + 12 * 60 * 60 * 1000);

  const isPrivileged = ["owner", "manager", "admin"].includes(role);

  const instances = await prisma.classInstance.findMany({
    where: {
      class: {
        tenantId,
        ...(isPrivileged ? {} : { instructorId: userId }),
      },
      date: { gte: queryStart, lte: queryEnd },
      isCancelled: false,
    },
    include: {
      class: {
        select: { id: true, name: true, location: true, coachName: true, instructorId: true, maxCapacity: true, color: true },
      },
      _count: { select: { attendances: true, waitlists: true } },
    },
    orderBy: { startTime: "asc" },
  });

  // Strict same-local-day filter + dedupe by class+startTime so the legacy
  // pre-DST seed rows don't double-count.
  const todayKey = startOfDay.toDateString();
  const seen = new Set<string>();
  const todays = instances
    .filter((inst) => new Date(inst.date).toDateString() === todayKey)
    .filter((inst) => {
      const k = `${inst.class.id}|${inst.startTime}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  return NextResponse.json(
    todays.map((inst) => ({
      id: inst.id,
      classId: inst.class.id,
      name: inst.class.name,
      coachName: inst.class.coachName,
      location: inst.class.location,
      color: inst.class.color,
      startTime: inst.startTime,
      endTime: inst.endTime,
      maxCapacity: inst.class.maxCapacity,
      attendedCount: inst._count.attendances,
      waitlistCount: inst._count.waitlists,
    })),
  );
}
