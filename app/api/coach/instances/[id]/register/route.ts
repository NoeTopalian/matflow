import { withTenantContext } from "@/lib/prisma-tenant";
import { medicalNotesText } from "@/lib/medical-notes";
import { NextResponse } from "next/server";
import { requireApiStaff } from "@/lib/api-authz";

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const { tenantId, role } = gate;
  const { id: classInstanceId } = await params;

  const isPrivileged = ["owner", "manager", "admin"].includes(role);
  const showMedical = isPrivileged; // medical notes redacted from coach role

  const data = await withTenantContext(tenantId, async (tx) => {
    const instance = await tx.classInstance.findFirst({
      where: {
        id: classInstanceId,
        // Every staff role may open any register in the club (Noe, 17 Sep
        // 2026). Only the medical column stays privileged, via showMedical.
        class: { tenantId },
      },
      include: {
        class: {
          select: { id: true, name: true, location: true, coachName: true, maxCapacity: true, color: true, isKids: true },
        },
      },
    });
    if (!instance) return null;
    const [bookings, attendances, waitlist] = await Promise.all([
      tx.classSubscription.findMany({
        where: { classId: instance.class.id, member: { tenantId } },
        include: {
          member: {
            select: {
              id: true, name: true, email: true, status: true, accountType: true,
              membershipType: true,
              waiverAccepted: true, waiverAcceptedAt: true,
              ...(showMedical ? { medicalConditions: true } : {}),
              paymentStatus: true,
              holdUntil: true,
              billedBy: true,
              billingStatusAsOf: true,
              memberRanks: {
                orderBy: { achievedAt: "desc" },
                take: 1,
                include: { rankSystem: { select: { name: true, color: true, discipline: true } } },
              },
            },
          },
        },
      }),
      tx.attendanceRecord.findMany({
        where: { classInstanceId },
        select: { id: true, memberId: true, checkInTime: true, checkInMethod: true },
      }),
      tx.classWaitlist.findMany({
        where: { classInstanceId, status: "waiting" },
        orderBy: { position: "asc" },
        include: {
          member: { select: { id: true, name: true, email: true, status: true } },
        },
      }),
    ]);
    // The roster is NOT the subscriber list. A member who was scanned in with
    // a card, marked on Mark Attendance, or added to the club that morning has
    // an AttendanceRecord and no ClassSubscription — and used to be invisible
    // on the very screen the coach opens to see who is here. Anyone with a
    // record for this instance is on the register; those not booked carry
    // `walkIn` so the coach can tell a drop-in from a no-show. Same tenant
    // filter, same select, so a walk-in row is shaped exactly like a booked one.
    const bookedIds = new Set(bookings.map((b) => b.member.id));
    const walkInIds = [...new Set(attendances.map((a) => a.memberId))].filter((id) => !bookedIds.has(id));
    const walkIns = walkInIds.length
      ? await tx.member.findMany({
          where: { id: { in: walkInIds }, tenantId },
          select: {
            id: true, name: true, email: true, status: true, accountType: true,
            membershipType: true,
            waiverAccepted: true, waiverAcceptedAt: true,
            ...(showMedical ? { medicalConditions: true } : {}),
            paymentStatus: true,
            holdUntil: true,
            billedBy: true,
            billingStatusAsOf: true,
            memberRanks: {
              orderBy: { achievedAt: "desc" },
              take: 1,
              include: { rankSystem: { select: { name: true, color: true, discipline: true } } },
            },
          },
        })
      : [];
    const roster = [
      ...bookings.map((b) => ({ member: b.member, walkIn: false })),
      ...walkIns.map((member) => ({ member, walkIn: true })),
    ];
    const memberIds = roster.map((r) => r.member.id);
    // Audit memory-storage 2026-08-16 P1-4: this was a `findMany` with
    // `distinct: ["memberId"]` and no `take`. Prisma applies distinct
    // in-process (no `nativeDistinct`), so opening the register fetched every
    // booked member's entire attendance history — ~9k rows for 30 members
    // after two years, growing forever. `groupBy` + `_max` pushes the
    // "last visit per member" reduction into Postgres: one row per member.
    // Members with no prior visit are simply absent from the result, so the
    // consumer must default their last visit to null (it does — Map miss).
    const lastVisits = memberIds.length
      ? await tx.attendanceRecord.groupBy({
          by: ["memberId"],
          where: { memberId: { in: memberIds }, classInstanceId: { not: classInstanceId } },
          _max: { checkInTime: true },
        })
      : [];
    // Which of this session's check-ins spent a class-pack credit. The undo
    // dialog promises the credit back only for those — it used to promise it
    // to a monthly member who never had one (end-user round 2, 4.8).
    const attendanceIds = attendances.map((a) => a.id).filter((id): id is string => typeof id === "string");
    const redemptions = attendanceIds.length
      ? await tx.classPackRedemption.findMany({
          where: { attendanceRecordId: { in: attendanceIds } },
          select: { attendanceRecordId: true },
        })
      : [];
    return { instance, roster, attendances, waitlist, lastVisits, redemptions };
  });
  if (!data) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  const { instance, roster, attendances, waitlist, lastVisits, redemptions } = data;
  const redeemedAttendanceIds = new Set(redemptions.map((r) => r.attendanceRecordId));
  const attendedById = new Map(attendances.map((a) => [a.memberId, a]));
  const lastVisitById = new Map(lastVisits.map((lv) => [lv.memberId, lv._max.checkInTime]));

  return NextResponse.json({
    instance: {
      id: instance.id,
      classId: instance.class.id,
      name: instance.class.name,
      location: instance.class.location,
      coachName: instance.class.coachName,
      color: instance.class.color,
      maxCapacity: instance.class.maxCapacity,
      // The register asks before marking an adult into a kids class.
      isKids: instance.class.isKids,
      date: instance.date.toISOString(),
      startTime: instance.startTime,
      endTime: instance.endTime,
    },
    expected: roster.map((b) => {
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
        walkIn: b.walkIn,
        rank: rank ? {
          name: rank.rankSystem.name,
          color: rank.rankSystem.color,
          discipline: rank.rankSystem.discipline,
          stripes: rank.stripes,
        } : null,
        attended: !!attended,
        attendedAt: attended?.checkInTime.toISOString() ?? null,
        attendedMethod: attended?.checkInMethod ?? null,
        // The later of any other visit and this session's own check-in: a
        // member ticked in today read "Last seen Never" (end-user round 2,
        // 4.x) because the visit query leaves this session out.
        lastVisitAt: latest(lastVisitById.get(b.member.id) ?? null, attended?.checkInTime ?? null)?.toISOString() ?? null,
        usedPackCredit: !!attended && redeemedAttendanceIds.has(attended.id),
        medicalConditions: showMedical ? medicalNotesText(m.medicalConditions) : null,
        onHold: (b.member as { paymentStatus?: string | null }).paymentStatus === "paused",
        holdUntil: (b.member as { holdUntil?: Date | null }).holdUntil?.toISOString() ?? null,
        // TeamUp bridge (readiness spec v3 §7): the desk sees how old a
        // TeamUp standing is. Informational only — it never refuses a check-in.
        billedBy: b.member.billedBy,
        billingStatusAsOf: b.member.billingStatusAsOf?.toISOString() ?? null,
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
