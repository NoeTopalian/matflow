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
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { cancelSubscriptionAtPeriodEnd } from "@/lib/stripe/subscriptions";

export const runtime = "nodejs";

const bodySchema = z.object({
  reason: z.string().min(5).max(500),
  confirmName: z.string().min(1),  // operator must type the gym name to confirm
});

// Audit iter-1-operator-admin A6I1-S-5: rate-limit destructive admin ops.
const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const ctx = await getOperatorContext(req);
  const rl = await checkRateLimit(`admin:tenant-action:${ctx.operatorId}:${getClientIp(req)}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many admin actions. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const { id: tenantId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, deletedAt: true, stripeAccountId: true },
    }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  if (tenant.deletedAt) return NextResponse.json({ error: "Tenant already deleted" }, { status: 409 });

  if (parsed.data.confirmName.trim() !== tenant.name) {
    return NextResponse.json({ error: "Confirmation name does not match the tenant name" }, { status: 400 });
  }

  // Audit iter-1-operator-admin A6I1-S-4: cancel Stripe subscriptions
  // before soft-deleting the tenant. Same rationale as the suspend route
  // — members on auto-renew would keep being charged for service they
  // can never access again.
  let stripeCancelled = 0;
  let stripeFailed = 0;
  if (tenant.stripeAccountId) {
    const subs = await withRlsBypass((tx) =>
      tx.member.findMany({
        where: { tenantId, stripeSubscriptionId: { not: null } },
        select: { id: true, stripeSubscriptionId: true },
      }),
    );
    for (const m of subs) {
      const outcome = await cancelSubscriptionAtPeriodEnd({
        tenant: { stripeAccountId: tenant.stripeAccountId },
        stripeSubscriptionId: m.stripeSubscriptionId!,
      });
      if (outcome.ok) stripeCancelled += 1; else stripeFailed += 1;
    }
  }

  const now = new Date();
  // Audit iter-1-operator-admin A6I1-P-2 + S-10: merge 3 sequential
  // withRlsBypass calls (tenant.update + user.updateMany + member.updateMany)
  // into ONE atomic block. Closes the TOCTOU race window between status
  // change and session invalidation.
  await withRlsBypass(async (tx) => {
    await tx.tenant.update({ where: { id: tenantId }, data: { deletedAt: now } });
    await tx.user.updateMany({ where: { tenantId }, data: { sessionVersion: { increment: 1 } } });
    await tx.member.updateMany({ where: { tenantId }, data: { sessionVersion: { increment: 1 } } });
  });

  await logAudit({
    tenantId,
    userId: null,
    action: "admin.tenant.soft_deleted",
    entityType: "Tenant",
    entityId: tenantId,
    metadata: {
      reason: parsed.data.reason,
      tenantName: tenant.name,
      hardDeleteAfter: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      stripeCancelled,
      stripeFailed,
    },
    actAsUserId: ctx.operatorId,
    req,
  });

  return NextResponse.json({ ok: true, stripeCancelled, stripeFailed });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthed(req))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const ctx = await getOperatorContext(req);
  const rl = await checkRateLimit(`admin:tenant-action:${ctx.operatorId}:${getClientIp(req)}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many admin actions. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const { id: tenantId } = await params;
  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, deletedAt: true } }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  if (!tenant.deletedAt) return NextResponse.json({ error: "Tenant is not soft-deleted" }, { status: 409 });

  await withRlsBypass((tx) =>
    tx.tenant.update({ where: { id: tenantId }, data: { deletedAt: null } }),
  );

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
