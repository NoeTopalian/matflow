/**
 * POST /api/auth/staff-unlock/[id]
 *
 * Clear a member of STAFF out of a brute-force lockout (ten failed password
 * attempts → `lockedUntil` one hour out, `auth.ts:319-338`).
 *
 * Why this route exists. `POST /api/members/[id]/unlock` recovers a locked
 * Member; there was no equivalent for a `User`, and handing that route a User
 * id 404s — correctly, because a member of staff is not a member of the club.
 * So an owner, manager, coach or admin who mistyped their password ten times
 * was locked out for a full hour with no gym-side recovery at all: not the
 * password reset the login page names, not a screen, only the operator's
 * `force-password-reset` or the clock. A coach locked out ten minutes before
 * the 19:00 class cannot take the register, and nobody in the building can help
 * them.
 *
 * Authz: `requireApiOwner` — owner only, one step tighter than the member
 * unlock's owner+manager. Clearing a lockout is half of the attack the lockout
 * exists to stop, and a staff account reaches money, the full roster and the
 * export; a manager runs the desk, but nobody needs to unlock a COLLEAGUE at
 * the desk. Tenant scope is enforced by `withTenantContext` plus an explicit
 * `where: { tenantId }`. CSRF via `assertSameOrigin`.
 *
 * Path note for the reviewer: this sits under `app/api/auth/**` beside
 * `forgot-password` and `reset-password`, with which it shares a purpose —
 * getting a locked-out person back in. `app/api/staff/[id]/unlock` would read
 * more naturally beside the other staff mutations; that directory belongs to
 * another lane this round, so the move is flagged rather than made.
 */
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { requireApiOwner } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { hashToken } from "@/lib/token-hash";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const session = gate.session;

  const tenantId = session.user.tenantId;
  const { id: staffId } = await params;

  const result = await withTenantContext(tenantId, async (tx) => {
    // Scoped to the tenant, so a staff id from another club is simply not
    // found. A 403 here would confirm the id exists somewhere.
    const staff = await tx.user.findFirst({
      where: { id: staffId, tenantId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        failedLoginCount: true,
        lockedUntil: true,
      },
    });
    if (!staff) return { kind: "not-found" as const };
    const wasLocked = !!(staff.lockedUntil && staff.lockedUntil > new Date());
    await tx.user.update({
      where: { id: staff.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    return { kind: "ok" as const, staff, wasLocked };
  });

  if (result.kind === "not-found") {
    return NextResponse.json({ ok: false, error: "Staff member not found" }, { status: 404 });
  }

  await logAudit({
    tenantId,
    userId: session.user.id,
    action: "staff.unlock",
    entityType: "User",
    entityId: result.staff.id,
    metadata: {
      // AuditLog rows survive an Article 17 erasure for the published
      // twelve-month window, so a cleartext address here would re-plant the
      // PII the erase destroyed. Hashed, as members/[id]/unlock and the DSAR
      // export already do.
      staffEmailHash: hashToken(result.staff.email),
      staffRole: result.staff.role,
      wasLocked: result.wasLocked,
      priorFailedLoginCount: result.staff.failedLoginCount,
    },
    req,
  });

  return NextResponse.json({
    ok: true,
    staffId: result.staff.id,
    staffName: result.staff.name,
    wasLocked: result.wasLocked,
    message: result.wasLocked
      ? "Staff account unlocked. They can sign in immediately."
      : "This member of staff was not locked. Counter reset.",
  });
}
