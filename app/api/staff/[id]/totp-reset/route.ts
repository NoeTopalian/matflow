// POST /api/staff/[id]/totp-reset
//
// The OWNER's recovery path for a manager, admin or coach who lost their
// authenticator (1 Oct 2026). With TOTP mandatory for managers and admins
// (lib/mfa-policy.ts), a lost phone would otherwise lock them out until
// MatFlow support stepped in. The owner's own reset stays operator-only
// (app/api/admin/customers/[id]/totp-reset) — nobody inside a club can strip
// the owner's second factor.
//
// Audit code: staff.totp_reset (vs member.totp_reset for members).

import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireApiOwner } from "@/lib/api-authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import { hashToken } from "@/lib/token-hash";

export const runtime = "nodejs";

const bodySchema = z.object({
  reason: z.string().min(5).max(500),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const ctx = gate;
  const { id: staffId } = await params;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Reason (min 5 chars) required" }, { status: 400 });
  }

  // Tenant scope + "never the owner": the query itself excludes owner rows,
  // so an owner id (including the caller's own) resolves to nothing.
  const result = await withTenantContext(ctx.tenantId, async (tx) => {
    const staff = await tx.user.findFirst({
      where: { id: staffId, tenantId: ctx.tenantId, role: { not: "owner" } },
      select: { id: true, email: true, name: true, role: true, totpEnabled: true },
    });
    if (!staff) return { kind: "not-found" as const };

    await tx.user.update({
      where: { id: staff.id },
      data: {
        totpEnabled: false,
        totpSecret: null,
        // Prisma.JsonNull, never `undefined` (a no-op): the old recovery codes
        // must die with the secret, or /api/auth/totp/recover — which is
        // unauthenticated — still accepts them (review finding, 1 Oct 2026).
        totpRecoveryCodes: Prisma.JsonNull,
        // Every live session dies: they sign in again, and (manager/admin)
        // are held at enrolment until they have a new authenticator.
        sessionVersion: { increment: 1 },
      },
    });
    return { kind: "ok" as const, staff };
  });

  if (result.kind === "not-found") {
    return NextResponse.json({ error: "Staff member not found" }, { status: 404 });
  }

  await logAudit({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action: "staff.totp_reset",
    entityType: "User",
    entityId: result.staff.id,
    metadata: {
      reason: parsed.data.reason,
      role: result.staff.role,
      staffEmailHash: hashToken(result.staff.email),
      wasEnrolled: result.staff.totpEnabled,
    },
    req,
  });

  return NextResponse.json({
    ok: true,
    staffName: result.staff.name,
    message: `${result.staff.name}'s authenticator has been reset. They will set up a new one at their next sign-in.`,
  });
}
