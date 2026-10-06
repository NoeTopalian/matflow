// POST   /api/admin/customers/[id]/suspend  → set subscriptionStatus = "suspended"
// DELETE /api/admin/customers/[id]/suspend  → restore the status it had before
//
// Suspended tenants reject login at auth.ts authorize-time. Reversible —
// no data is destroyed, just gated.
//
// Member billing (operator audit 5 Oct 2026, finding 6; policy in
// docs/runbooks/SUSPENSION-BILLING-POLICY.md). Suspension used to ask Stripe to
// stop renewing every member subscription, carried on when Stripe refused, and
// un-suspension flipped the club to "active" whatever it had been and never
// looked at those cancellations again. Clubs are Standard Connect merchants:
// the members' subscriptions are contracts between the member and the club,
// not with MatFlow, and suspending a club's MatFlow access does not end the
// club's service to its members. So suspension no longer touches member
// billing at all. It records the status to come back to and an inventory of
// the live member subscriptions it left alone; closing a club for good is
// soft-delete, which does stop renewals. TeamUp-billed memberships carry no
// Stripe subscription in MatFlow and were never in scope.

import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { isAdminAuthed } from "@/lib/admin-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { requireStepUp, stepUpTarget } from "@/lib/operator-step-up";

export const runtime = "nodejs";

const bodySchema = z.object({ reason: z.string().min(5).max(500) });

// Audit iter-1-operator-admin A6I1-S-5: rate-limit destructive admin ops.
// A compromised operator session could iterate every tenant ID and suspend
// them in seconds with no throttle. 20/hr is enough headroom for a normal
// operator triage shift without enabling mass disruption.
const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;

/** Statuses un-suspension may restore. Anything else falls back to "active", flagged. */
const RESTORABLE = new Set(["trial", "active", "cancelled"]);

/** What a suspension records about member billing (Tenant.suspensionBilling). */
type SuspensionBilling = {
  policy: "member-billing-unchanged";
  recordedAt: string;
  liveStripeSubscriptions: number;
  stripeSubscriptionIds: string[];
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // CSRF. lib/admin-auth.ts also accepts a `matflow_admin` COOKIE, and a
  // cookie rides along on a cross-site form post.
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
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Reason required (min 5 chars)" }, { status: 400 });

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, subscriptionStatus: true, deletedAt: true },
    }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  // A club marked for deletion is closed: suspension is not a state it can
  // enter (E2E finding, 6 Oct 2026 — this used to return 200). Nothing written.
  if (tenant.deletedAt) {
    return NextResponse.json({ error: "This club is marked for deletion, so it cannot be suspended." }, { status: 409 });
  }
  if (tenant.subscriptionStatus === "suspended") {
    return NextResponse.json({ error: "Tenant already suspended" }, { status: 409 });
  }

  // Fresh operator re-authentication bound to suspending THIS club (review of
  // lanes A/B/D, 6 Oct 2026): a suspension signs every user and member of the
  // club out. The Danger Zone sends the grant. Un-suspending (DELETE) is the
  // recovery direction and deliberately asks for none. Checked AFTER the club
  // read and its 404/409 refusals (review of lane I), as the impersonate route
  // does: the grant is single-use, and a refused suspend must not spend it.
  // The flip below is conditional on the status read here, so a change in
  // between is still a 409.
  const stepUp = await requireStepUp(req, ctx, "tenant.suspend", stepUpTarget(tenantId));
  if (stepUp) return stepUp;

  const previousStatus = tenant.subscriptionStatus;

  // ONE transaction: the status flip is conditional on the status we read (a
  // concurrent suspend, or any other writer, makes this a 409 rather than a
  // second suspension that would overwrite the recorded previous status), and
  // the session bumps commit with it so no request lands between them.
  // Audit iter-1-member-lifecycle A3H-4 (preserved): Members ALSO carry
  // sessionVersion-gated JWTs, so both tables are bumped.
  // The audit row is written in the same transaction (operator audit 5 Oct
  // 2026, Q9): no suspension without its record.
  let outcome: SuspensionBilling | null;
  try {
    outcome = await withRlsBypass(async (tx) => {
      const subs = await tx.member.findMany({
        where: { tenantId, stripeSubscriptionId: { not: null } },
        select: { stripeSubscriptionId: true },
      });
      const billing: SuspensionBilling = {
        policy: "member-billing-unchanged",
        recordedAt: new Date().toISOString(),
        liveStripeSubscriptions: subs.length,
        stripeSubscriptionIds: subs.map((s) => s.stripeSubscriptionId!),
      };
      const flipped = await tx.tenant.updateMany({
        where: { id: tenantId, subscriptionStatus: previousStatus, deletedAt: null },
        data: {
          subscriptionStatus: "suspended",
          suspendedPreviousStatus: previousStatus,
          suspensionBilling: billing as unknown as Prisma.InputJsonValue,
        },
      });
      if (flipped.count !== 1) return null;
      await tx.user.updateMany({ where: { tenantId }, data: { sessionVersion: { increment: 1 } } });
      await tx.member.updateMany({ where: { tenantId }, data: { sessionVersion: { increment: 1 } } });
      await logAudit({
        tx,
        tenantId,
        userId: null,
        action: "admin.tenant.suspended",
        entityType: "Tenant",
        entityId: tenantId,
        metadata: {
          reason: parsed.data.reason,
          previousStatus,
          memberBilling: billing.policy,
          liveStripeSubscriptions: billing.liveStripeSubscriptions,
          stripeSubscriptionIds: billing.stripeSubscriptionIds,
        },
        actAsUserId: ctx.operatorId,
        req,
      });
      return billing;
    });
  } catch (err) {
    console.error("[suspend] suspension or audit write failed; nothing changed", err);
    return NextResponse.json({ error: "The suspension could not be recorded, so nothing was changed. Try again." }, { status: 500 });
  }
  if (!outcome) {
    return NextResponse.json(
      { error: "The club's status changed while suspending. Reload and try again." },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    previousStatus,
    memberBilling: outcome.policy,
    liveStripeSubscriptions: outcome.liveStripeSubscriptions,
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // CSRF. As above.
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
  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, subscriptionStatus: true, suspendedPreviousStatus: true, suspensionBilling: true, deletedAt: true },
    }),
  );
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  // Un-suspending a club marked for deletion would write an admitting status
  // ("active") onto a closed club with deletedAt still set (E2E finding, 6 Oct
  // 2026). Restore it first (soft-delete DELETE), then un-suspend. Nothing written.
  if (tenant.deletedAt) {
    return NextResponse.json({ error: "This club is marked for deletion. Restore it before re-enabling it." }, { status: 409 });
  }
  // This used to set "active" on ANY club, so un-suspending a trial club that
  // was never suspended quietly took it out of trial.
  if (tenant.subscriptionStatus !== "suspended") {
    return NextResponse.json({ error: "Tenant is not suspended" }, { status: 409 });
  }

  // The status to restore: the one this suspension recorded. A club suspended
  // before that record existed falls back to the suspension's audit row, and
  // only then to "active" — flagged, so the operator can correct it.
  let restoredStatus: string | null = null;
  let previousStatusSource: "recorded" | "audit" | "default" = "recorded";
  let legacy: { stripeCancelled?: unknown; stripeFailed?: unknown; stripeFailedIds?: unknown } | null = null;
  if (tenant.suspendedPreviousStatus && RESTORABLE.has(tenant.suspendedPreviousStatus)) {
    restoredStatus = tenant.suspendedPreviousStatus;
  }
  if (!tenant.suspensionBilling) {
    const row = await withRlsBypass((tx) =>
      tx.auditLog.findFirst({
        where: { tenantId, action: "admin.tenant.suspended", entityType: "Tenant", entityId: tenantId },
        orderBy: { createdAt: "desc" },
        select: { metadata: true },
      }),
    );
    const meta = (row?.metadata ?? null) as Record<string, unknown> | null;
    legacy = meta ?? {};
    if (!restoredStatus && typeof meta?.previousStatus === "string" && RESTORABLE.has(meta.previousStatus)) {
      restoredStatus = meta.previousStatus;
      previousStatusSource = "audit";
    }
  }
  if (!restoredStatus) {
    restoredStatus = "active";
    previousStatusSource = "default";
  }

  // What the operator must review. Un-suspension NEVER clears a period-end
  // cancellation by itself: by now the flag may be the member's own choice,
  // and resuming a renewal a member asked to stop is taking money without
  // consent. See the policy for the per-subscription procedure.
  const billingReview = legacy
    ? {
        required: true,
        reason:
          "This club was suspended before suspension stopped changing member billing. That suspension asked " +
          "Stripe to stop renewing member subscriptions at period end, and nothing has reversed it. Review " +
          "each one with the club before anything is resumed.",
        stripeCancelledBySuspension: typeof legacy.stripeCancelled === "number" ? legacy.stripeCancelled : null,
        stripeFailedIds: Array.isArray(legacy.stripeFailedIds) ? legacy.stripeFailedIds : [],
        currentStripeSubscriptionIds: (
          await withRlsBypass((tx) =>
            tx.member.findMany({
              where: { tenantId, stripeSubscriptionId: { not: null } },
              select: { stripeSubscriptionId: true },
            }),
          )
        ).map((m) => m.stripeSubscriptionId!),
      }
    : {
        required: false,
        reason: "This suspension did not change member billing.",
      };

  // Conditional on the SAME suspension we read (review of lane C, D4): an
  // un-suspend, re-suspend and second un-suspend interleaved between our read
  // and this write must not restore the status recorded by a different
  // suspension. The audit row commits with the flip (operator audit Q9).
  let flippedCount: number;
  try {
    flippedCount = await withRlsBypass(async (tx) => {
      const flipped = await tx.tenant.updateMany({
        where: { id: tenantId, subscriptionStatus: "suspended", suspendedPreviousStatus: tenant.suspendedPreviousStatus, deletedAt: null },
        data: {
          subscriptionStatus: restoredStatus,
          suspendedPreviousStatus: null,
          suspensionBilling: Prisma.DbNull,
        },
      });
      if (flipped.count !== 1) return flipped.count;
      await logAudit({
        tx,
        tenantId,
        userId: null,
        action: "admin.tenant.reactivated",
        entityType: "Tenant",
        entityId: tenantId,
        metadata: {
          previousStatus: "suspended",
          restoredStatus,
          previousStatusSource,
          billingReviewRequired: billingReview.required,
          legacySuspension: legacy !== null,
        },
        actAsUserId: ctx.operatorId,
        req,
      });
      return flipped.count;
    });
  } catch (err) {
    console.error("[suspend] reactivation or audit write failed; nothing changed", err);
    return NextResponse.json({ error: "The reactivation could not be recorded, so nothing was changed. Try again." }, { status: 500 });
  }
  if (flippedCount !== 1) {
    return NextResponse.json({ error: "The club's suspension changed while re-enabling. Reload and try again." }, { status: 409 });
  }

  return NextResponse.json({ ok: true, restoredStatus, previousStatusSource, billingReview });
}
