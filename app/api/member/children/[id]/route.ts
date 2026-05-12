import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return apiError("Not found", 404);

  const { id } = await params;

  try {
    const child = await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.findFirst({
        where: {
          id,
          parentMemberId: memberId,
          tenantId: session.user.tenantId,
        },
        select: {
          id: true,
          name: true,
          dateOfBirth: true,
          accountType: true,
          waiverAccepted: true,
          joinedAt: true,
          memberRanks: {
            orderBy: { achievedAt: "desc" },
            take: 1,
            include: { rankSystem: true },
          },
          attendances: {
            orderBy: { checkInTime: "desc" },
            take: 20,
            include: {
              classInstance: {
                include: { class: { select: { name: true } } },
              },
            },
          },
          _count: { select: { attendances: true } },
        },
      }),
    );

    if (!child) return apiError("Not found", 404);

    const currentRank = child.memberRanks[0];
    return NextResponse.json({
      id: child.id,
      name: child.name,
      dateOfBirth: child.dateOfBirth ? child.dateOfBirth.toISOString() : null,
      accountType: child.accountType,
      waiverAccepted: child.waiverAccepted,
      joinedAt: child.joinedAt.toISOString(),
      belt: currentRank
        ? {
            name: currentRank.rankSystem.name,
            color: currentRank.rankSystem.color ?? "#e5e7eb",
            stripes: currentRank.stripes,
            achievedAt: currentRank.achievedAt.toISOString(),
          }
        : null,
      totalClasses: child._count.attendances,
      recentAttendance: child.attendances.map((a) => ({
        id: a.id,
        className: a.classInstance.class.name,
        date: a.classInstance.date.toISOString(),
        checkInTime: a.checkInTime.toISOString(),
      })),
    });
  } catch (e) {
    return apiError("Failed to load child", 500, e, "[member/children/[id]]");
  }
}

/**
 * DELETE /api/member/children/[id]
 *
 * Parent removes one of their kids. Because almost every Member-referencing FK
 * is ON DELETE RESTRICT (see migrations), a naive Member.delete fails with
 * P2003 the moment the kid has any attendance, rank, pack, etc. We purge each
 * dependent table inside a single transaction in dependency order, then drop
 * the Member row.
 *
 * Notes:
 *  - ClassRoster has ON DELETE CASCADE (migration 20260509115719) so it
 *    drops automatically when the Member row goes.
 *  - Payment, Order, Notification are ON DELETE SET NULL — preserved for
 *    audit / accounting, with memberId becoming null.
 *  - We only ever delete a row whose parentMemberId matches the session's
 *    member, so a parent cannot purge themselves or another adult member via
 *    this endpoint.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const parentMemberId = session.user.memberId as string | undefined;
  if (!parentMemberId) return apiError("Not a member account", 403);
  const tenantId: string = session.user.tenantId;

  const { id: childId } = await params;

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      const kid = await tx.member.findFirst({
        where: { id: childId, tenantId, parentMemberId },
        select: { id: true, name: true },
      });
      if (!kid) return { kind: "not-found" } as const;

      // Order matters: every table below RESTRICTS Member deletion until empty.
      // RankHistory references MemberRank, so wipe that first.
      const ranks = await tx.memberRank.findMany({
        where: { memberId: childId },
        select: { id: true },
      });
      if (ranks.length > 0) {
        await tx.rankHistory.deleteMany({
          where: { memberRankId: { in: ranks.map((r) => r.id) } },
        });
      }
      await tx.memberRank.deleteMany({ where: { memberId: childId } });

      // ClassPackRedemption references MemberClassPack — same drill.
      const packs = await tx.memberClassPack.findMany({
        where: { memberId: childId },
        select: { id: true },
      });
      if (packs.length > 0) {
        await tx.classPackRedemption.deleteMany({
          where: { memberPackId: { in: packs.map((p) => p.id) } },
        });
      }
      await tx.memberClassPack.deleteMany({ where: { memberId: childId } });

      await tx.attendanceRecord.deleteMany({ where: { memberId: childId } });
      await tx.classSubscription.deleteMany({ where: { memberId: childId } });
      await tx.classWaitlist.deleteMany({ where: { memberId: childId } });
      await tx.signedWaiver.deleteMany({ where: { memberId: childId } });

      // ClassRoster cascades on Member delete (CASCADE FK).
      // Payment / Order / Notification are SET NULL — they survive as audit.
      const deleted = await tx.member.deleteMany({
        where: { id: childId, tenantId, parentMemberId },
      });
      if (deleted.count === 0) return { kind: "race" } as const;
      return { kind: "ok", name: kid.name } as const;
    });

    if (outcome.kind === "not-found") return apiError("Not found", 404);
    if (outcome.kind === "race") return apiError("Conflict — child already removed", 409);

    await logAudit({
      tenantId,
      userId: session.user.id ?? null,
      action: "member.child.delete",
      entityType: "Member",
      entityId: childId,
      metadata: { parentMemberId, childName: outcome.name },
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError("Failed to remove child", 500, e, "[member/children/[id] DELETE]");
  }
}
