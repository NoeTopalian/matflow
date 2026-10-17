/**
 * POST   /api/member/class-subscriptions/[classId]   — subscribe self to a class
 * DELETE /api/member/class-subscriptions/[classId]   — unsubscribe self
 *
 * Tenant-scoped: the class must belong to the member's tenant.
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { classTierCovers, tierRefusalSentence } from "@/lib/class-tier-gate";

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
      const locked = await tx.$queryRaw<{ id: string; name: string; maxCapacity: number | null }[]>`
        SELECT "id", "name", "maxCapacity"
          FROM "Class"
         WHERE "id" = ${classId} AND "tenantId" = ${r.tenantId}
           FOR UPDATE
      `;
      if (locked.length === 0) return "no-class" as const;

      // T6a: the same membership gate as the member app's check-in, read
      // after the same Class lock, so a booking and a check-in can never
      // disagree about who a class is for. A class with no memberships
      // selected, or with a roster, is not tier-gated.
      const tierRows = await tx.classMembershipTier.findMany({
        where: { classId, tenantId: r.tenantId },
        select: { tierId: true },
      });
      if (tierRows.length > 0) {
        const [rosterCount, member] = await Promise.all([
          tx.classRoster.count({ where: { classId, tenantId: r.tenantId } }),
          tx.member.findFirst({
            where: { id: r.memberId, tenantId: r.tenantId },
            select: { membershipTierId: true, membershipTier: { select: { name: true } } },
          }),
        ]);
        const covered = classTierCovers({
          allowedTierIds: tierRows.map((t) => t.tierId),
          memberTierId: member?.membershipTierId ?? null,
          hasRoster: rosterCount > 0,
        });
        if (!covered) {
          return { kind: "tier" as const, className: locked[0].name, tierName: member?.membershipTier?.name ?? null };
        }
      }

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
      return "ok" as const;
    });
    if (created === "no-class") return NextResponse.json({ error: "Class not found" }, { status: 404 });
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
  } catch (e: unknown) {
    // Idempotent: re-subscribe is a no-op via @@unique([memberId, classId])
    if ((e as { code?: string }).code !== "P2002") {
      return NextResponse.json({ error: "Failed to subscribe" }, { status: 500 });
    }
  }
  return NextResponse.json({ success: true, classId }, { status: 201 });
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
