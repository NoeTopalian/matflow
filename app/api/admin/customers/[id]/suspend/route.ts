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
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { cancelSubscriptionAtPeriodEnd } from "@/lib/stripe/subscriptions";

export const runtime = "nodejs";

const bodySchema = z.object({ reason: z.string().min(5).max(500) });

// Audit iter-1-operator-admin A6I1-S-5: rate-limit destructive admin ops.
// A compromised operator session could iterate every tenant ID and suspend
// them in seconds with no throttle. 20/hr is enough headroom for a normal
// operator triage shift without enabling mass disruption.
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
  if (!parsed.success) return NextResponse.json({ error: "Reason required (min 5 chars)" }, { status: 400 });

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, subscriptionStatus: true, stripeAccountId: true },
    }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  if (tenant.subscriptionStatus === "suspended") {
    return NextResponse.json({ error: "Tenant already suspended" }, { status: 409 });
  }

  // Audit iter-1-operator-admin A6I1-S-4: cancel Stripe subscriptions
  // before locking the tenant out. Without this, members keep being
  // charged monthly while the gym is suspended → chargeback liability +
  // FCA/EU consumer-rights breach. cancel_at_period_end means they get
  // the access they've already paid for, but no further renewal.
  // Best-effort: individual failures are logged but don't abort the
  // suspension (operator's intent — "lock them out" — must succeed even
  // if Stripe is degraded; the member-level cancel can be retried via
  // staff tooling).
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

  // Audit iter-1-operator-admin A6I1-P-2 + S-10: merge the 3 separate
  // withRlsBypass acquisitions (tenant.update + user.updateMany +
  // member.updateMany) into ONE atomic block. Closes the TOCTOU race
  // where a user request could land between flipping status and bumping
  // sessionVersion. Also drops 3 connection-pool checkouts to 1.
  // Audit iter-1-member-lifecycle A3H-4 (preserved): Members ALSO carry
  // sessionVersion-gated JWTs; suspension would be bypassable for up to
  // 30 days if we only bumped User.
  await withRlsBypass(async (tx) => {
    await tx.tenant.update({ where: { id: tenantId }, data: { subscriptionStatus: "suspended" } });
    await tx.user.updateMany({ where: { tenantId }, data: { sessionVersion: { increment: 1 } } });
    await tx.member.updateMany({ where: { tenantId }, data: { sessionVersion: { increment: 1 } } });
  });

  await logAudit({
    tenantId,
    userId: null,
    action: "admin.tenant.suspended",
    entityType: "Tenant",
    entityId: tenantId,
    metadata: {
      reason: parsed.data.reason,
      previousStatus: tenant.subscriptionStatus,
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
    tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, subscriptionStatus: true } }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  await withRlsBypass((tx) =>
    tx.tenant.update({ where: { id: tenantId }, data: { subscriptionStatus: "active" } }),
  );

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
