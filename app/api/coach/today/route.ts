import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { requireApiStaff } from "@/lib/api-authz";
import { todayWindow, usableTimezone } from "@/lib/class-time";

export async function GET() {
  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const { tenantId, userId, role } = gate;

  const isPrivileged = ["owner", "manager", "admin"].includes(role);

  const instances = await withTenantContext(tenantId, async (tx) => {
    // "Today" is the CLUB's day, not the process's. This used to be
    // `setHours(0,0,0,0)` plus a `toDateString()` comparison, both in the zone
    // the server happened to run in — UTC on Vercel — so a London club's
    // instance stored at 23:00Z (the seed writes BST midnight that way) was
    // filed on the previous day and the register listed Thursday's classes on
    // Friday. See `todayWindow` for the two spellings of a date this admits.
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    const { start, end } = todayWindow(new Date(), usableTimezone(tenant?.timezone));
    return tx.classInstance.findMany({
      where: {
        class: {
          tenantId,
          ...(isPrivileged ? {} : { instructorId: userId }),
        },
        date: { gte: start, lt: end },
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
  });

  // Dedupe by class+startTime so legacy pre-DST seed rows (the same class
  // written under two spellings of the same day) don't double-count.
  const seen = new Set<string>();
  const todays = instances
    .filter((inst) => {
      const k = `${inst.class.id}|${inst.startTime}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  // Lane 1 iter-2 L1-I2-S-02 [High]: real-time per-tenant schedule.
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
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
