// POST /api/admin/customers/[id]/member-totp-reset
//
// Operator support action: clears TOTP on a specific Member of the named
// tenant. Mirrors /api/admin/customers/[id]/totp-reset (which is User-side,
// owner-scoped) — but for Member rows, where multiple members per tenant
// exist, so memberId is required in the body.
//
// Why this exists: a member loses their phone / authenticator app and needs
// 2FA reset. The 2FA-optional spec (2026-05-07) explicitly forbids
// self-disable; this is one of the two unlock paths (the other being the
// staff-facing /api/members/[id]/totp-reset for gym-owner self-service).
//
// Audit code: admin.member.totp_reset

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/admin-auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";

export const runtime = "nodejs";

const bodySchema = z.object({
  memberId: z.string().min(1),
  reason: z.string().min(5).max(500),
  confirmName: z.string().min(1),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: tenantId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "memberId, reason (min 5), and confirmName required" }, { status: 400 });
  }

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  if (parsed.data.confirmName.trim() !== tenant.name) {
    return NextResponse.json({ error: "Gym name confirmation does not match" }, { status: 400 });
  }

  const member = await withRlsBypass((tx) =>
    tx.member.findFirst({
      where: { id: parsed.data.memberId, tenantId },
      select: { id: true, email: true, name: true, totpEnabled: true },
    }),
  );
  if (!member) return NextResponse.json({ error: "Member not found in this tenant" }, { status: 404 });

  await withRlsBypass((tx) =>
    tx.member.update({
      where: { id: member.id },
      data: {
        totpEnabled: false,
        totpSecret: null,
        totpRecoveryCodes: undefined,
        sessionVersion: { increment: 1 },
      },
    }),
  );

  const ctx = await getOperatorContext(req);
  await logAudit({
    tenantId,
    userId: null,
    action: "admin.member.totp_reset",
    entityType: "Member",
    entityId: member.id,
    metadata: {
      reason: parsed.data.reason,
      memberEmail: member.email,
      wasEnrolled: member.totpEnabled,
    },
    actAsUserId: ctx.operatorId,
    req,
  });

  return NextResponse.json({
    ok: true,
    memberEmail: member.email,
    memberName: member.name,
    message: "TOTP disabled. Member will be prompted to re-enrol on next login.",
  });
}
