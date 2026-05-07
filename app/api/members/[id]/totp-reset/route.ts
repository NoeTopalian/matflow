// POST /api/members/[id]/totp-reset
//
// Staff-facing member TOTP reset (2FA-optional spec, 2026-05-07).
// Gym owner / manager / admin / coach can clear a member's totpEnabled
// without escalating to MatFlow operator support. Eliminates the operator
// bottleneck for the common "member lost their phone" case.
//
// Audit code: member.totp_reset (vs admin.member.totp_reset for operator path).

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";

export const runtime = "nodejs";

const bodySchema = z.object({
  reason: z.string().min(5).max(500),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const ctx = await requireStaff();
  const { id: memberId } = await params;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Reason (min 5 chars) required" }, { status: 400 });
  }

  // Tenant scope enforced by withTenantContext + the where clause; we never
  // touch a Member from a different tenant even if memberId is forged.
  const result = await withTenantContext(ctx.tenantId, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: memberId, tenantId: ctx.tenantId },
      select: { id: true, email: true, name: true, totpEnabled: true },
    });
    if (!member) return { kind: "not-found" as const };

    await tx.member.update({
      where: { id: member.id },
      data: {
        totpEnabled: false,
        totpSecret: null,
        totpRecoveryCodes: undefined,
        sessionVersion: { increment: 1 },
      },
    });
    return { kind: "ok" as const, member };
  });

  if (result.kind === "not-found") {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  await logAudit({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action: "member.totp_reset",
    entityType: "Member",
    entityId: result.member.id,
    metadata: {
      reason: parsed.data.reason,
      memberEmail: result.member.email,
      wasEnrolled: result.member.totpEnabled,
    },
    req,
  });

  return NextResponse.json({
    ok: true,
    memberEmail: result.member.email,
    memberName: result.member.name,
    message: "Member TOTP reset. They will be prompted to re-enrol on next sign-in.",
  });
}
