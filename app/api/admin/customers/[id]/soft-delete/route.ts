// POST   /api/admin/customers/[id]/soft-delete  → set Tenant.deletedAt = now
// DELETE /api/admin/customers/[id]/soft-delete  → clear deletedAt (restore)
//
// Soft-deleted tenants disappear from the active queries (deletedAt: null
// filter) and reject all logins at auth-time. Recoverable for 30 days; after
// that window the retention cron (lib/tenant-purge.ts) hard-deletes, and
// restore is refused once the window has passed or the purge has claimed it.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/admin-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { cancelSubscriptionAtPeriodEnd } from "@/lib/stripe/subscriptions";
import { refuseIfReviewLocked } from "@/lib/review-lock";
import { requireStepUp, stepUpTarget } from "@/lib/operator-step-up";
import {
  isTenantRowBusyError,
  restoreRefusal,
  restoreSoftDeletedTenant,
  TENANT_SOFT_DELETE_GRACE_MS,
} from "@/lib/tenant-lifecycle";

export const runtime = "nodejs";

const bodySchema = z.object({
  reason: z.string().min(5).max(500),
  confirmName: z.string().min(1),  // operator must type the gym name to confirm
});

// Audit iter-1-operator-admin A6I1-S-5: rate-limit destructive admin ops.
const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // CSRF. The operator plane was excluded from the earlier sweep on the
  // reasoning that it is token-authenticated and therefore exempt. That does
  // not hold: lib/admin-auth.ts also accepts a `matflow_admin` COOKIE, and a
  // cookie rides along on a cross-site form post. So every mutation here was
  // reachable from any page the operator happened to have open — on the most
  // powerful surface in the product.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
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
  const reviewLocked = await refuseIfReviewLocked(tenantId, "club_delete");
  if (reviewLocked) return reviewLocked;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  // Fresh operator re-authentication bound to deleting THIS club (operator
  // audit 5 Oct 2026, Workstream A5). The Danger Zone sends the grant.
  const stepUp = await requireStepUp(req, ctx, "tenant.soft_delete", stepUpTarget(tenantId));
  if (stepUp) return stepUp;

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

  // Durable audit (operator audit 5 Oct 2026, Q9). The Stripe calls below are
  // outside any DB transaction, so the request is recorded FIRST, in its own
  // transaction, and nothing happens if that row cannot be written. The
  // outcome row then commits atomically with the deletion stamp. A request
  // row with no outcome row is an attempt that did not complete.
  try {
    await logAudit({
      durable: true,
      outcome: "requested",
      tenantId,
      userId: null,
      action: "admin.tenant.soft_delete.requested",
      entityType: "Tenant",
      entityId: tenantId,
      metadata: { reason: parsed.data.reason, tenantName: tenant.name },
      actAsUserId: ctx.operatorId,
      req,
    });
  } catch (err) {
    console.error("[soft-delete] audit write failed; refusing to delete", err);
    return NextResponse.json(
      { error: "The deletion could not be recorded, so nothing was changed. Try again with a new authenticator code." },
      { status: 500 },
    );
  }

  // Audit iter-1-operator-admin A6I1-S-4: cancel Stripe subscriptions
  // before soft-deleting the tenant. Same rationale as the suspend route
  // — members on auto-renew would keep being charged for service they
  // can never access again.
  // Audit iter-2-operator-admin A6I2-P-1: parallelise the Stripe-cancel loop.
  // See sibling suspend route for the full rationale.
  let stripeCancelled = 0;
  let stripeFailed = 0;
  const stripeFailedIds: string[] = [];
  if (tenant.stripeAccountId) {
    const subs = await withRlsBypass((tx) =>
      tx.member.findMany({
        where: { tenantId, stripeSubscriptionId: { not: null } },
        select: { id: true, stripeSubscriptionId: true },
      }),
    );
    const results = await Promise.allSettled(
      subs.map((m) =>
        cancelSubscriptionAtPeriodEnd({
          tenant: { stripeAccountId: tenant.stripeAccountId! },
          stripeSubscriptionId: m.stripeSubscriptionId!,
        }).then((outcome) => ({ subId: m.stripeSubscriptionId!, outcome })),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.outcome.ok) {
        stripeCancelled += 1;
      } else {
        stripeFailed += 1;
        stripeFailedIds.push(
          r.status === "fulfilled" ? r.value.subId : "(promise rejected)",
        );
      }
    }
  }

  const now = new Date();
  // Audit iter-1-operator-admin A6I1-P-2 + S-10: merge 3 sequential
  // withRlsBypass calls (tenant.update + user.updateMany + member.updateMany)
  // into ONE atomic block. Closes the TOCTOU race window between status
  // change and session invalidation.
  // Conditional on the club still being live: two concurrent soft-deletes (or
  // a soft-delete racing a restore) cannot both stamp, and the clock that the
  // retention purge reads is set exactly once.
  //
  // A retry after a failure here repeats only idempotent Stripe calls
  // (cancel_at_period_end is already true); the stamp happens once.
  let stamped: boolean;
  try {
    stamped = await withRlsBypass(async (tx) => {
      const res = await tx.tenant.updateMany({ where: { id: tenantId, deletedAt: null }, data: { deletedAt: now } });
      if (res.count !== 1) return false;
      await tx.user.updateMany({ where: { tenantId }, data: { sessionVersion: { increment: 1 } } });
      await tx.member.updateMany({ where: { tenantId }, data: { sessionVersion: { increment: 1 } } });
      await logAudit({
        tx,
        tenantId,
        userId: null,
        action: "admin.tenant.soft_deleted",
        entityType: "Tenant",
        entityId: tenantId,
        metadata: {
          reason: parsed.data.reason,
          tenantName: tenant.name,
          hardDeleteAfter: new Date(now.getTime() + TENANT_SOFT_DELETE_GRACE_MS).toISOString(),
          stripeCancelled,
          stripeFailed,
          stripeFailedIds: stripeFailedIds.length ? stripeFailedIds : undefined,
        },
        actAsUserId: ctx.operatorId,
        req,
      });
      return true;
    });
  } catch (err) {
    console.error("[soft-delete] stamp or audit write failed; club not deleted", err);
    return NextResponse.json(
      {
        error:
          "The deletion could not be recorded, so the club was not deleted. Member subscriptions may already be set " +
          "to stop renewing; check them in Stripe, then try again with a new authenticator code.",
        stripeCancelled,
        stripeFailed,
      },
      { status: 500 },
    );
  }
  if (!stamped) return NextResponse.json({ error: "Tenant already deleted" }, { status: 409 });

  return NextResponse.json({ ok: true, stripeCancelled, stripeFailed });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // CSRF. The operator plane was excluded from the earlier sweep on the
  // reasoning that it is token-authenticated and therefore exempt. That does
  // not hold: lib/admin-auth.ts also accepts a `matflow_admin` COOKIE, and a
  // cookie rides along on a cross-site form post. So every mutation here was
  // reachable from any page the operator happened to have open — on the most
  // powerful surface in the product.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
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
  // Restore versus purge (operator audit 5 Oct 2026, finding 5). This was a
  // read followed by an unconditional write with no window check, so a restore
  // landing mid-purge answered 200 while the cron went on to delete the club.
  // Now ONE conditional write on the Tenant row: it succeeds only inside the
  // 30-day window and only while no purge has claimed the club; otherwise the
  // operator is told the real state. See lib/tenant-lifecycle.ts.
  //
  // Restore needs no step-up (decision, lane D 6 Oct 2026): it destroys
  // nothing, it is undone by another soft-delete, and it is the recovery path
  // after a mistaken or malicious deletion. It is still durably audited.
  //
  // The restored row is audited in the SAME transaction as the restore. The
  // restore does not resume member billing: soft-delete set every live
  // subscription to stop renewing, and that may now be the member's own
  // wish, so the operator is told to review rather than anything being
  // resumed automatically (review of lane C, D6).
  const now = new Date();
  let restored;
  try {
    restored = await withRlsBypass(async (tx) => {
      const outcome = await restoreSoftDeletedTenant(tx, tenantId, now);
      if (outcome.kind !== "restored") return { outcome, billingReview: null };
      const deletion = await tx.auditLog.findFirst({
        where: { tenantId, action: "admin.tenant.soft_deleted", entityType: "Tenant", entityId: tenantId },
        orderBy: { createdAt: "desc" },
        select: { metadata: true },
      });
      const subs = await tx.member.findMany({
        where: { tenantId, stripeSubscriptionId: { not: null } },
        select: { stripeSubscriptionId: true },
      });
      const meta = (deletion?.metadata ?? null) as Record<string, unknown> | null;
      const stoppedByDeletion = typeof meta?.stripeCancelled === "number" ? meta.stripeCancelled : null;
      const billingReview = {
        required: subs.length > 0 && stoppedByDeletion !== 0,
        reason:
          subs.length === 0
            ? "No member of this club has a Stripe subscription."
            : "Deleting this club set its members' Stripe subscriptions to stop renewing at the end of the " +
              "period, and restoring it has not changed that. Review each one with the club before anything " +
              "is resumed: a member may since have chosen to leave.",
        stripeCancelledByDeletion: stoppedByDeletion,
        stripeSubscriptionIds: subs.map((m) => m.stripeSubscriptionId!),
      };
      await logAudit({
        tx,
        tenantId,
        userId: null,
        action: "admin.tenant.restored",
        entityType: "Tenant",
        entityId: tenantId,
        metadata: { billingReviewRequired: billingReview.required, liveStripeSubscriptions: subs.length },
        actAsUserId: ctx.operatorId,
        req,
      });
      return { outcome, billingReview };
    });
  } catch (err) {
    // A purge step holds the Tenant row lock for up to a minute; a restore
    // that waits past its transaction budget is "busy", not a failure, and
    // nothing changed (review of lane C, D3).
    if (isTenantRowBusyError(err)) {
      return NextResponse.json(
        { error: "This club is busy (a deletion step is running). Nothing was changed. Try again in a minute.", state: "busy" },
        { status: 503, headers: { "Retry-After": "60" } },
      );
    }
    console.error("[soft-delete] restore or audit write failed; nothing changed", err);
    return NextResponse.json({ error: "The restore could not be recorded, so nothing was changed. Try again." }, { status: 500 });
  }
  if (restored.outcome.kind !== "restored") {
    const refusal = restoreRefusal(restored.outcome);
    return NextResponse.json({ error: refusal.error, state: refusal.state }, { status: refusal.status });
  }

  return NextResponse.json({ ok: true, billingReview: restored.billingReview });
}
