/**
 * POST /api/members/[id]/unlock
 *
 * Staff-facing route to unlock a Member whose account lockout has triggered
 * (10 failed password attempts → 1h lockedUntil). Clears failedLoginCount
 * and lockedUntil so the member can sign in immediately without waiting
 * for the TTL.
 *
 * Authz: requireStaff (owner | manager | coach | admin). Tenant scope
 * enforced by withTenantContext + explicit `where: { tenantId }` on the
 * lookup. CSRF via assertSameOrigin.
 *
 * Audit iter-1-auth-boundary AH-5 (2026-05-30): closes the gap where a
 * locked member had no recovery path besides the 1-hour TTL — no staff
 * route or admin route existed to unlock. The User-side equivalent lives
 * inside /api/admin/customers/[id]/force-password-reset which is operator-
 * gated; this route is gym-staff-gated for the common case.
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { STAFF_ROLES } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!STAFF_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenantId = session.user.tenantId;
  const { id: memberId } = await params;

  // Atomic: only clear lock state if the member exists in this tenant.
  // updateMany returns count=0 if the WHERE doesn't match (cross-tenant
  // or missing) — distinguished below by a follow-up findFirst on the
  // unhappy path to give a clean 404.
  const result = await withTenantContext(tenantId, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: memberId, tenantId },
      select: {
        id: true,
        name: true,
        email: true,
        failedLoginCount: true,
        lockedUntil: true,
      },
    });
    if (!member) return { kind: "not-found" as const };
    const wasLocked = !!(member.lockedUntil && member.lockedUntil > new Date());
    await tx.member.update({
      where: { id: member.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    return { kind: "ok" as const, member, wasLocked };
  });

  if (result.kind === "not-found") {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  await logAudit({
    tenantId,
    userId: session.user.id,
    action: "member.unlock",
    entityType: "Member",
    entityId: result.member.id,
    metadata: {
      memberEmail: result.member.email,
      wasLocked: result.wasLocked,
      priorFailedLoginCount: result.member.failedLoginCount,
    },
    req,
  });

  return NextResponse.json({
    ok: true,
    memberId: result.member.id,
    memberName: result.member.name,
    memberEmail: result.member.email,
    wasLocked: result.wasLocked,
    message: result.wasLocked
      ? "Member account unlocked. They can sign in immediately."
      : "Member was not locked. Counter reset.",
  });
}
