import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { deleteMemberCascade } from "@/lib/member-delete";
import { computeMemberStats } from "@/lib/member-stats";

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

    // US-4: hand off to the shared stats helper so the kid response shape
    // matches /api/member/me exactly. `recentAttendance` (the existing last-20
    // list) is preserved alongside the new stats block for backward compat
    // with the kid detail page's existing renderer.
    const { stats, nextClass } = await withTenantContext(session.user.tenantId, (tx) =>
      computeMemberStats(tx, { memberId: child.id, tenantId: session.user.tenantId }),
    );

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
      stats,
      nextClass,
    });
  } catch (e) {
    return apiError("Failed to load child", 500, e, "[member/children/[id]]");
  }
}

/**
 * PATCH /api/member/children/[id]
 *
 * Parent edits ONLY `name` and `dateOfBirth` on their own kid. Every other
 * field stays staff-managed:
 *  - belt / accountType / waiverAccepted / status / parentMemberId are all
 *    silently dropped if the client sends them (defence-in-depth alongside
 *    the explicit zod allowlist)
 *  - email is never editable (kids never log in; the synthetic
 *    kid-{uuid}@kids.local stays put)
 *
 * Guard: composite predicate { id, tenantId, parentMemberId } applied at
 * both the existence check and the updateMany — same pattern as Session E
 * DELETE. A parent cannot reach another adult member or someone else's kid
 * via this route.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const parentMemberId = session.user.memberId as string | undefined;
  if (!parentMemberId) return apiError("Not a member account", 403);
  const tenantId: string = session.user.tenantId;

  const { id: childId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON", 400);
  }

  // Strict allowlist — only these two fields land in the DB. Anything else
  // the client sends (status, accountType, waiverAccepted, belt, …) never
  // even enters `updateData`, so the route cannot be tricked into staff
  // territory.
  const raw = body as Record<string, unknown>;
  const updateData: { name?: string; dateOfBirth?: Date | null } = {};

  if (typeof raw.name === "string") {
    const trimmed = raw.name.trim();
    if (!trimmed || trimmed.length > 120) return apiError("Invalid name", 400);
    updateData.name = trimmed;
  }
  if (raw.dateOfBirth === null) {
    updateData.dateOfBirth = null;
  } else if (typeof raw.dateOfBirth === "string" && raw.dateOfBirth.length > 0) {
    const d = new Date(raw.dateOfBirth);
    if (isNaN(d.getTime())) return apiError("Invalid date of birth", 400);
    if (d > new Date()) return apiError("Date of birth cannot be in the future", 400);
    updateData.dateOfBirth = d;
  }

  if (Object.keys(updateData).length === 0) {
    return apiError("No editable fields provided", 400);
  }

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      const result = await tx.member.updateMany({
        where: { id: childId, tenantId, parentMemberId },
        data: updateData,
      });
      if (result.count === 0) return { kind: "not-found" } as const;
      const fresh = await tx.member.findFirst({
        where: { id: childId, tenantId, parentMemberId },
        select: {
          id: true,
          name: true,
          dateOfBirth: true,
          accountType: true,
          waiverAccepted: true,
        },
      });
      return { kind: "ok", kid: fresh } as const;
    });

    if (outcome.kind === "not-found") return apiError("Not found", 404);

    await logAudit({
      tenantId,
      userId: session.user.id ?? null,
      action: "member.child.update",
      entityType: "Member",
      entityId: childId,
      metadata: { parentMemberId, fields: Object.keys(updateData) },
      req,
    });

    return NextResponse.json({
      id: outcome.kid!.id,
      name: outcome.kid!.name,
      dateOfBirth: outcome.kid!.dateOfBirth ? outcome.kid!.dateOfBirth.toISOString() : null,
      accountType: outcome.kid!.accountType,
      waiverAccepted: outcome.kid!.waiverAccepted,
    });
  } catch (e) {
    return apiError("Failed to update child", 500, e, "[member/children/[id] PATCH]");
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
    // Composite predicate enforces parent-of-kid scoping at every step of
    // the cleanup — a parent can never reach another adult member or
    // someone else's kid through this endpoint.
    const outcome = await withTenantContext(tenantId, (tx) =>
      deleteMemberCascade(tx, { id: childId, tenantId, parentMemberId }),
    );

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
