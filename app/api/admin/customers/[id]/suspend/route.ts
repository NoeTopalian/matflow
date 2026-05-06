// POST   /api/admin/customers/[id]/suspend  → set subscriptionStatus = "suspended"
// DELETE /api/admin/customers/[id]/suspend  → revert to "active"
//
// Suspended tenants reject login at auth.ts authorize-time. Reversible —
// no data is destroyed, just gated.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/admin-auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";

export const runtime = "nodejs";

const bodySchema = z.object({ reason: z.string().min(5).max(500) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: tenantId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Reason required (min 5 chars)" }, { status: 400 });

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, subscriptionStatus: true } }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  if (tenant.subscriptionStatus === "suspended") {
    return NextResponse.json({ error: "Tenant already suspended" }, { status: 409 });
  }

  await withRlsBypass((tx) =>
    tx.tenant.update({ where: { id: tenantId }, data: { subscriptionStatus: "suspended" } }),
  );

  // Bump sessionVersion on every user in this tenant so existing JWTs die.
  await withRlsBypass((tx) =>
    tx.user.updateMany({ where: { tenantId }, data: { sessionVersion: { increment: 1 } } }),
  );

  const ctx = await getOperatorContext(req);
  await logAudit({
    tenantId,
    userId: null,
    action: "admin.tenant.suspended",
    entityType: "Tenant",
    entityId: tenantId,
    metadata: { reason: parsed.data.reason, previousStatus: tenant.subscriptionStatus },
    actAsUserId: ctx.operatorId,
    req,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: tenantId } = await params;
  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, subscriptionStatus: true } }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  await withRlsBypass((tx) =>
    tx.tenant.update({ where: { id: tenantId }, data: { subscriptionStatus: "active" } }),
  );

  const ctx = await getOperatorContext(req);
  await logAudit({
    tenantId,
    userId: null,
    action: "admin.tenant.reactivated",
    entityType: "Tenant",
    entityId: tenantId,
    metadata: { previousStatus: tenant.subscriptionStatus },
    actAsUserId: ctx.operatorId,
    req,
  });

  return NextResponse.json({ ok: true });
}
