/**
 * POST   /api/member/class-subscriptions/[classId]   — subscribe self to a class
 * DELETE /api/member/class-subscriptions/[classId]   — unsubscribe self
 *
 * Tenant-scoped: the class must belong to the member's tenant.
 */
import type { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { classTierCovers, tierRefusalSentence } from "@/lib/class-tier-gate";
import { classNotLiveSentence } from "@/lib/class-live";
import { doorLifecycle } from "@/lib/class-lifecycle";
import { checkinRefusal } from "@/lib/checkin-refusal";
import { allowanceVerdict, allowanceBookingNotice, nowMinute, slotMinute } from "@/lib/class-allowance";
import { readAllowanceSnapshot } from "@/lib/class-allowance-count";
import { usableTimezone } from "@/lib/class-time";

export const runtime = "nodejs";

async function resolveMember() {
  const session = await auth();
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return { error: NextResponse.json({ error: "Member not found" }, { status: 404 }) };
  return { memberId, tenantId: session.user.tenantId };
}

export async function POST(req: Request, ctx: { params: Promise<{ classId: string }> }) {
  // Audit iter-1-member-surface A5H-1: CSRF guard on a session-authenticated
  // state-mutating route. Without this, a cross-origin forge could silently
  // subscribe the victim to classes.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const { classId } = await ctx.params;
  const r = await resolveMember();
  if ("error" in r) return r.error;

  try {
    const created = await withTenantContext(r.tenantId, async (tx) => {
      // Round 1 defect L-F 1: `maxCapacity` was enforced nowhere. The member
      // schedule prints it as `capacity` for every class, so a class that
      // seats one took as many bookings as it was offered.
      //
      // The read takes a row lock rather than using `findFirst`, because a
      // count followed by an insert is not enough on its own: under READ
      // COMMITTED two members booking the last place both read the same count
      // and both insert. Locking the Class row makes the second booking wait
      // for the first to commit, then re-count and see the place gone. Both
      // statements run inside the one transaction `withTenantContext` opens.
      const locked = await tx.$queryRaw<{
        id: string;
        name: string;
        maxCapacity: number | null;
        isActive: boolean;
        deletedAt: Date | null;
        sourceImportJobId: string | null;
      }[]>`
        SELECT "id", "name", "maxCapacity", "isActive", "deletedAt", "sourceImportJobId"
          FROM "Class"
         WHERE "id" = ${classId} AND "tenantId" = ${r.tenantId}
           FOR UPDATE
      `;
      // Imported history is not a class anyone books: it answers like a
      // missing one (T6b / T4d acceptance 2).
      if (locked.length === 0 || locked[0].sourceImportJobId) return "no-class" as const;

      // T6b: a paused or archived class takes no new bookings. Read after the
      // Class lock, so a pause that committed first is honoured. Existing
      // bookings are kept (and hidden) by the pause itself.
      // doorLifecycle reads a pre-T6b archive (no deletedAt) as archived.
      const state = await doorLifecycle(tx, r.tenantId, locked[0]);
      if (state !== "active") {
        return { kind: "not_live" as const, className: locked[0].name, state };
      }

      // A class with a roster (a comp / squad class) admits only members on
      // it, here as at every check-in door; a member who is not on it is
      // refused with the check-in's own sentence. Being on it does not excuse
      // the membership list below (owner decision, 20 Oct 2026: both hold).
      const rosterCount = await tx.classRoster.count({ where: { classId, tenantId: r.tenantId } });
      if (rosterCount > 0) {
        const onRoster = await tx.classRoster.findFirst({
          where: { classId, memberId: r.memberId, tenantId: r.tenantId },
          select: { id: true },
        });
        if (!onRoster) return "not-rostered" as const;
      }

      // T6a: the same membership gate as the member app's check-in, read
      // after the same Class lock, so a booking and a check-in can never
      // disagree about who a class is for. A class with no memberships
      // selected is not tier-gated; a rostered one is.
      const tierRows = await tx.classMembershipTier.findMany({
        where: { classId, tenantId: r.tenantId },
        select: { tierId: true },
      });
      if (tierRows.length > 0) {
        const member = await tx.member.findFirst({
          where: { id: r.memberId, tenantId: r.tenantId },
          select: { membershipTierId: true, membershipTier: { select: { name: true } } },
        });
        const covered = classTierCovers({
          allowedTierIds: tierRows.map((t) => t.tierId),
          memberTierId: member?.membershipTierId ?? null,
        });
        if (!covered) {
          return { kind: "tier" as const, className: locked[0].name, tierName: member?.membershipTier?.name ?? null };
        }
      }

      // A member who already holds this booking (a re-tap, a client retry)
      // keeps the idempotent success.
      const already = await tx.classSubscription.findFirst({
        where: { classId, memberId: r.memberId },
        select: { id: true },
      });
      if (already) return "ok" as const;

      const { maxCapacity } = locked[0];
      if (maxCapacity !== null) {
        // Excluding the caller keeps a re-booking idempotent: a member who
        // already holds the only place must not be told the class is full by
        // their own request. The duplicate then falls to P2002 below, as before.
        const taken = await tx.classSubscription.count({
          where: { classId, memberId: { not: r.memberId } },
        });
        if (taken >= maxCapacity) return "full" as const;
      }

      await tx.classSubscription.create({
        data: { memberId: r.memberId, classId },
      });
      // T7 (owner decision, 20 Oct 2026): a booking consumes nothing and is
      // never refused for the allowance — only confirmed attendance counts,
      // and a booking is not a guarantee of admission. The member is told
      // what the door will say: the class's next session (or now, when none
      // is scheduled yet) is judged, and a used-up period becomes a notice
      // on the booked state, not a refusal.
      const allowance = await bookingAllowance(tx, r.tenantId, r.memberId, classId);
      return { kind: "booked" as const, allowanceNotice: allowance ? allowanceBookingNotice(allowance) : null };
    });
    if (created === "no-class") return NextResponse.json({ error: "Class not found" }, { status: 404 });
    if (created === "not-rostered") {
      // The check-in's own roster refusal, so both doors read the same.
      const refusal = checkinRefusal({ kind: "roster_not_listed" })!;
      return NextResponse.json(refusal.body, { status: refusal.status });
    }
    if (typeof created === "object" && created.kind === "not_live") {
      return NextResponse.json(
        { error: classNotLiveSentence(created.className, created.state), reason: "class_paused" },
        { status: 409 },
      );
    }
    if (typeof created === "object" && created.kind === "tier") {
      return NextResponse.json(
        { error: tierRefusalSentence(created.className, created.tierName), reason: "tier_not_included" },
        { status: 403 },
      );
    }
    if (created === "full") {
      return NextResponse.json(
        {
          error:
            "This class is full. There is no waiting list yet — ask your gym about another session.",
        },
        { status: 409 },
      );
    }
    if (typeof created === "object" && created.kind === "booked") {
      return NextResponse.json({ success: true, classId, allowanceNotice: created.allowanceNotice }, { status: 201 });
    }
  } catch (e: unknown) {
    // Idempotent: re-subscribe is a no-op via @@unique([memberId, classId])
    if ((e as { code?: string }).code !== "P2002") {
      return NextResponse.json({ error: "Failed to subscribe" }, { status: 500 });
    }
  }
  return NextResponse.json({ success: true, classId, allowanceNotice: null }, { status: 201 });
}

/**
 * T7: the allowance verdict for a booking when the plan's period is already
 * used up, or null when it allows the session (or is Unlimited). Judged at
 * the class's next session that has not started yet in the club's clock;
 * with none scheduled, at now. Informational only: see POST.
 */
async function bookingAllowance(
  tx: Prisma.TransactionClient,
  tenantId: string,
  memberId: string,
  classId: string,
) {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  const now = new Date();
  const nowAt = nowMinute(now, usableTimezone(tenant?.timezone));
  const upcoming = await tx.classInstance.findMany({
    where: {
      classId,
      class: { tenantId },
      isCancelled: false,
      sourceImportJobId: null,
      date: { gte: new Date(now.getTime() - 2 * 86_400_000) },
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
    select: { id: true, date: true, startTime: true },
    take: 20,
  });
  const next = upcoming.find((i) => slotMinute(i) >= nowAt) ?? null;
  const snap = await readAllowanceSnapshot(tx, {
    tenantId,
    memberId,
    centre: next?.date ?? now,
    currentInstanceId: next?.id ?? null,
  });
  if (!snap?.allowance) return null;
  const v = allowanceVerdict(snap.allowance, next ? slotMinute(next) : nowAt, snap.visits);
  return v.exhausted ? v : null;
}

export async function DELETE(req: Request, ctx: { params: Promise<{ classId: string }> }) {
  // Audit iter-1-member-surface A5H-1: CSRF guard. DELETE with query params
  // bypasses CORS preflight on some browsers — the explicit guard is the
  // defence.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const { classId } = await ctx.params;
  const r = await resolveMember();
  if ("error" in r) return r.error;

  // Tenant-scoped delete via the class relation; deleteMany returns count
  // so cross-tenant attempts no-op silently rather than 404-leaking.
  const result = await withTenantContext(r.tenantId, (tx) =>
    tx.classSubscription.deleteMany({
      where: {
        memberId: r.memberId,
        classId,
        class: { tenantId: r.tenantId },
      },
    }),
  );
  return NextResponse.json({ success: true, removed: result.count });
}
