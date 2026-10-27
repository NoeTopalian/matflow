import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import { recordKeptBookings } from "@/lib/booking-eligibility-db";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string; memberId: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["owner", "manager", "admin"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id, memberId } = await ctx.params;
  const tenantId = session.user.tenantId;

  try {
    // Every statement is scoped to the CALLER'S tenant. Previously they keyed
    // on (classId, memberId) straight from the URL with no tenant predicate
    // and no ownership check anywhere in the handler, so an owner/manager/
    // admin of gym A holding a gym B classId + memberId could remove that
    // member from gym B's class and cancel their subscription. The audit row
    // below is written against the CALLER's tenantId, so gym B's log would
    // show nothing either.
    const removed = await withTenantContext(tenantId, async (tx) => {
      // D2: the Class row lock first, as the class PATCH and every check-in
      // take it (Class, then Member, lib/checkin.ts). A check-in for this
      // member is then judged on the squad list before or after this removal,
      // never in between; and the booking read below is the one this removal
      // turns away. A class of another club matches nothing.
      const cls = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Class" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE
      `;
      if (cls.length === 0) return { count: 0, bookingKept: false };
      const rosterSize = await tx.classRoster.count({ where: { classId: id, tenantId } });
      const result = await tx.classRoster.deleteMany({
        where: { classId: id, memberId, tenantId },
      });
      if (result.count === 0) return { count: 0, bookingKept: false };
      // D2 (approved 21 Oct 2026): the booking is KEPT. It used to be deleted
      // here in the same breath as the roster row. While others remain on the
      // squad list the member is now turned away at every door; their booking
      // stays, shown as "not eligible", and is recorded durably below. When
      // they were the last on the list the class has no squad list any more
      // and admits them (an empty roster is no roster), so nothing is
      // recorded. ClassSubscription carries no tenantId: scoped through the member.
      const booking = await tx.classSubscription.findFirst({
        where: { classId: id, memberId, member: { tenantId } },
        select: { id: true },
      });
      const turnedAway = !!booking && rosterSize > 1;
      if (turnedAway) {
        await recordKeptBookings(tx, {
          tenantId,
          userId: session.user.id,
          classId: id,
          cause: "class.roster.remove",
          byTrigger: { squad: [memberId] },
          req,
        });
      }
      return { count: result.count, bookingKept: !!booking };
    });

    if (removed.count === 0) {
      return NextResponse.json({ error: "Roster entry not found" }, { status: 404 });
    }

    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "class.roster.remove",
      entityType: "ClassRoster",
      entityId: `${id}:${memberId}`,
      // D2: the booking is never cancelled by a squad removal any more.
      metadata: { classId: id, memberId, bookingKept: removed.bookingKept },
      req,
    });
    return NextResponse.json({ ok: true, bookingKept: removed.bookingKept });
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2025") {
      return NextResponse.json({ error: "Roster entry not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Failed to remove from roster" }, { status: 500 });
  }
}
