// POST /api/admin/customers/[id]/transfer-ownership
// Transfers the owner role from the current owner to a target user already
// in the tenant (manager / coach / admin). The current owner is demoted to
// manager. Both users get sessionVersion bumped to kick existing JWTs.
//
// Inviting a fresh user via email is intentionally out of scope here — the
// target must already exist on the tenant. Add via the dashboard first.
//
// GET /api/admin/customers/[id]/transfer-ownership
// Returns candidate target users (anyone on the tenant who isn't the
// current owner) so the operator UI can render a picker.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/admin-auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";

export const runtime = "nodejs";

const bodySchema = z.object({
  targetUserId: z.string().min(1),
  reason: z.string().min(5).max(500),
  confirmName: z.string().min(1),
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: tenantId } = await params;
  const users = await withRlsBypass((tx) =>
    tx.user.findMany({
      where: { tenantId, role: { not: "owner" } },
      select: { id: true, email: true, name: true, role: true, totpEnabled: true },
      orderBy: { createdAt: "asc" },
    }),
  );
  return NextResponse.json({ candidates: users });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: tenantId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "targetUserId, reason, confirmName required" }, { status: 400 });

  const tenant = await withRlsBypass((tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } }));
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  if (parsed.data.confirmName.trim() !== tenant.name) {
    return NextResponse.json({ error: "Gym name confirmation does not match" }, { status: 400 });
  }

  const [currentOwner, target] = await withRlsBypass(async (tx) => {
    const o = await tx.user.findFirst({
      where: { tenantId, role: "owner" },
      select: { id: true, email: true, name: true },
      orderBy: { createdAt: "asc" },
    });
    const t = await tx.user.findFirst({
      where: { id: parsed.data.targetUserId, tenantId },
      select: { id: true, email: true, name: true, role: true },
    });
    return [o, t];
  });

  if (!currentOwner) return NextResponse.json({ error: "Tenant has no current owner" }, { status: 404 });
  if (!target) return NextResponse.json({ error: "Target user not found on this tenant" }, { status: 404 });
  if (target.id === currentOwner.id) return NextResponse.json({ error: "Target is already the owner" }, { status: 400 });

  await withRlsBypass(async (tx) => {
    await tx.user.update({
      where: { id: currentOwner.id },
      data: { role: "manager", sessionVersion: { increment: 1 } },
    });
    await tx.user.update({
      where: { id: target.id },
      data: { role: "owner", sessionVersion: { increment: 1 } },
    });
  });

  const ctx = await getOperatorContext(req);
  await logAudit({
    tenantId,
    userId: target.id,
    action: "admin.tenant.ownership_transferred",
    entityType: "Tenant",
    entityId: tenantId,
    metadata: {
      reason: parsed.data.reason,
      previousOwnerId: currentOwner.id,
      previousOwnerEmail: currentOwner.email,
      newOwnerId: target.id,
      newOwnerEmail: target.email,
      previousTargetRole: target.role,
    },
    actAsUserId: ctx.operatorId,
    req,
  });

  return NextResponse.json({
    ok: true,
    previousOwner: { id: currentOwner.id, email: currentOwner.email, name: currentOwner.name },
    newOwner: { id: target.id, email: target.email, name: target.name },
    message: "Ownership transferred. Both users have been signed out and must log in again.",
  });
}
