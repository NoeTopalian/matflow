// POST /api/admin/impersonate — start an impersonation session
// DELETE /api/admin/impersonate — end the current session
//
// Both routes require a valid MATFLOW_ADMIN_SECRET cookie/header. The POST
// flow mints a signed `matflow_impersonation` cookie which the auth.ts jwt()
// callback reads and uses to override the session identity to the target
// user. The DELETE flow clears that cookie. Every start/end is audit-logged.

import { NextResponse } from "next/server";
import { z } from "zod";
import { withRlsBypass } from "@/lib/prisma-tenant";
import {
  setImpersonationCookie,
  clearImpersonationCookie,
  readImpersonationCookie,
} from "@/lib/impersonation";
import { logAudit } from "@/lib/audit-log";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getOperatorContext } from "@/lib/operator-context";

export const runtime = "nodejs";

const startSchema = z.object({
  targetUserId: z.string().min(1),
  reason: z.string().min(5).max(500),
});

export async function POST(req: Request) {
  const operator = await getOperatorContext(req);
  if (!operator.authed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ip = getClientIp(req);
  const rl = await checkRateLimit(`admin:impersonate:${ip}`, 30, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  }
  const { targetUserId, reason } = parsed.data;

  // Look up target user pre-session via bypass — admin secret is the credential here.
  const target = await withRlsBypass((tx) =>
    tx.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, tenantId: true, email: true, name: true, role: true },
    }),
  );
  if (!target) {
    return NextResponse.json({ error: "Target user not found" }, { status: 404 });
  }

  // The shared admin secret has no individual identity in v1. Stamp a sentinel
  // adminUserId so audit rows still record "an admin acted" — distinguishable
  // from regular user actions but anonymous within the admin pool.
  const adminUserId = operator.operatorId;

  await setImpersonationCookie({
    adminUserId,
    targetUserId: target.id,
    targetTenantId: target.tenantId,
    reason,
  });

  await logAudit({
    tenantId: target.tenantId,
    userId: target.id,
    action: "admin.impersonate.start",
    entityType: "User",
    entityId: target.id,
    metadata: {
      reason,
      targetEmail: target.email,
      targetRole: target.role,
      operatorEmail: operator.operatorEmail,
    },
    actAsUserId: adminUserId,
    req,
  });

  return NextResponse.json({ ok: true, redirectTo: "/dashboard" });
}

export async function DELETE(req: Request) {
  // End-impersonation does NOT require admin secret — anyone holding the
  // impersonation cookie should be able to end it (banner button etc).
  const current = await readImpersonationCookie();
  if (current) {
    await logAudit({
      tenantId: current.targetTenantId,
      userId: current.targetUserId,
      action: "admin.impersonate.end",
      entityType: "User",
      entityId: current.targetUserId,
      metadata: { reason: current.reason },
      actAsUserId: current.adminUserId,
      req,
    });
  }
  await clearImpersonationCookie();
  return NextResponse.json({ ok: true, redirectTo: "/admin/tenants" });
}
