// POST   /api/admin/customers/[id]/soft-delete  → set Tenant.deletedAt = now
// DELETE /api/admin/customers/[id]/soft-delete  → clear deletedAt (restore)
//
// Soft-deleted tenants disappear from the active queries (deletedAt: null
// filter) and reject all logins at auth-time. Recoverable for 30 days; a
// future cron job hard-deletes after that window.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/admin-auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";

export const runtime = "nodejs";

const bodySchema = z.object({
  reason: z.string().min(5).max(500),
  confirmName: z.string().min(1),  // operator must type the gym name to confirm
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: tenantId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, deletedAt: true } }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  if (tenant.deletedAt) return NextResponse.json({ error: "Tenant already deleted" }, { status: 409 });

  if (parsed.data.confirmName.trim() !== tenant.name) {
    return NextResponse.json({ error: "Confirmation name does not match the tenant name" }, { status: 400 });
  }

  const now = new Date();
  await withRlsBypass((tx) =>
    tx.tenant.update({ where: { id: tenantId }, data: { deletedAt: now } }),
  );

  // Kick every active session in the tenant.
  await withRlsBypass((tx) =>
    tx.user.updateMany({ where: { tenantId }, data: { sessionVersion: { increment: 1 } } }),
  );

  const ctx = await getOperatorContext(req);
  await logAudit({
    tenantId,
    userId: null,
    action: "admin.tenant.soft_deleted",
    entityType: "Tenant",
    entityId: tenantId,
    metadata: { reason: parsed.data.reason, tenantName: tenant.name, hardDeleteAfter: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString() },
    actAsUserId: ctx.operatorId,
    req,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: tenantId } = await params;
  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, deletedAt: true } }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  if (!tenant.deletedAt) return NextResponse.json({ error: "Tenant is not soft-deleted" }, { status: 409 });

  await withRlsBypass((tx) =>
    tx.tenant.update({ where: { id: tenantId }, data: { deletedAt: null } }),
  );

  const ctx = await getOperatorContext(req);
  await logAudit({
    tenantId,
    userId: null,
    action: "admin.tenant.restored",
    entityType: "Tenant",
    entityId: tenantId,
    metadata: {},
    actAsUserId: ctx.operatorId,
    req,
  });

  return NextResponse.json({ ok: true });
}
