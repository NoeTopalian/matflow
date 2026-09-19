import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { requireApiStaff } from "@/lib/api-authz";
import { classStatus, todayWindow, usableTimezone, type ClassStatusVariant } from "@/lib/class-time";
import { ensureTodayInstances } from "@/lib/today-sessions";

export async function GET() {
  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  // Every staff role sees every session today. Noe, 17 Sep 2026: "coaches
  // should see all classes but theirs should be specifically highlighted."
  // The old `instructorId: userId` narrowing hid EVERY class from EVERY coach,
  // because nothing in the product ever wrote Class.instructorId — the
  // timetable writes coachUserId. `isMine` below is the highlight.
  const { rows: instances, tz } = await withTenantContext(tenantId, async (tx) => {
    // "Today" is the CLUB's day, not the process's. This used to be
    // `setHours(0,0,0,0)` plus a `toDateString()` comparison, both in the zone
    // the server happened to run in — UTC on Vercel — so a London club's
    // instance stored at 23:00Z (the seed writes BST midnight that way) was
    // filed on the previous day and the register listed Thursday's classes on
    // Friday. See `todayWindow` for the two spellings of a date this admits.
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    const tz = usableTimezone(tenant?.timezone);
    // Today's rows exist before we ask for them: a class on the timetable is
    // offered for check-in whether or not the nightly cron ever ran (on
    // production it never has). Idempotent — see lib/today-sessions.ts.
    await ensureTodayInstances(tx, tenantId, tz);
    const { start, end } = todayWindow(new Date(), tz);
    const rows = await tx.classInstance.findMany({
      where: {
        class: { tenantId },
        date: { gte: start, lt: end },
        // CANCELLED SESSIONS ARE INCLUDED, flagged. `isCancelled: false` used
        // to sit here, so calling off tonight's class made it disappear from
        // the staff's own view of the day — and a coach who was not told, or
        // who forgot, saw an evening with a hole in it and no explanation.
        // A register that silently omits a session cannot be checked against
        // the timetable. The row carries `isCancelled` and the hub strikes it
        // through; check-in still refuses it at `lib/checkin.ts:148`.
      },
      include: {
        class: {
          select: { id: true, name: true, location: true, coachName: true, instructorId: true, coachUserId: true, maxCapacity: true, color: true },
        },
        _count: { select: { attendances: true, waitlists: true } },
      },
      // A cancelled session is still part of the day, so it keeps its place in
      // the running order rather than being swept to the end.
      orderBy: { startTime: "asc" },
    });
    return { rows, tz };
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

  // The session on NOW comes first and is what the client preselects; then
  // the next one; then the rest of the day; finished sessions last. Mark
  // Attendance used to open on instances[0] — the earliest class of the day —
  // so at 12:30 it offered the 10:00 class. Status is computed in the club's
  // zone by lib/class-time#classStatus. Noe, 18 Sep 2026.
  const RANK: Record<ClassStatusVariant, number> = { ongoing: 0, soon: 1, future: 2, ended: 3 };
  const now = new Date();
  const ordered = todays
    .map((inst) => ({ inst, status: classStatus(inst, tz, now).variant }))
    .sort(
      (a, b) =>
        // A cancelled session is visible but never preselected: it sorts below
        // everything that is actually running, so "the session on now" — which
        // the client opens on — is one a member can still be checked into.
        Number(a.inst.isCancelled) - Number(b.inst.isCancelled) ||
        RANK[a.status] - RANK[b.status] ||
        a.inst.startTime.localeCompare(b.inst.startTime),
    );

  // Lane 1 iter-2 L1-I2-S-02 [High]: real-time per-tenant schedule.
  return NextResponse.json(
    ordered.map(({ inst, status }) => ({
      id: inst.id,
      status,
      classId: inst.class.id,
      name: inst.class.name,
      coachName: inst.class.coachName,
      location: inst.class.location,
      color: inst.class.color,
      startTime: inst.startTime,
      endTime: inst.endTime,
      isCancelled: inst.isCancelled,
      cancellationReason: inst.cancellationReason,
      maxCapacity: inst.class.maxCapacity,
      attendedCount: inst._count.attendances,
      waitlistCount: inst._count.waitlists,
      // The highlight: this staff member teaches it, by either column the
      // product has used for the coach.
      isMine: inst.class.coachUserId === userId || inst.class.instructorId === userId,
    })),
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
