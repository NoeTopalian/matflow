/**
 * POST /api/members/[id]/resume
 *
 * End a membership hold: Stripe's pause_collection is cleared first (when
 * the member has a subscription — collection restarts on the subscription's
 * own schedule, nothing is back-billed because the hold voided its
 * invoices), then paymentStatus → "paid" and holdUntil → null. A cash
 * member's nextDueAt is left where it was: the next payment is owed on
 * return, and the overdue derivation says so honestly.
 *
 * Owner + manager, CSRF, audit `member.hold.end`.
 */
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { assertSameOrigin } from "@/lib/csrf";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { RESUME_COLLECTION_PARAMS } from "@/lib/member-hold";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const { id: memberId } = await params;

  const found = await withTenantContext(tenantId, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: memberId, tenantId },
      select: { id: true, paymentStatus: true, holdUntil: true, stripeSubscriptionId: true, billedBy: true },
    });
    if (!member) return null;
    // Has this member ever paid? A member who joined with "No payment yet" and
    // was then held must not come back as "Paid" (30 Sep 2026, decision 1).
    const paidOnce = await tx.payment.count({ where: { tenantId, memberId: member.id, status: "succeeded" } });
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { stripeAccountId: true, stripeConnected: true } });
    return { member, tenant, paidOnce };
  });
  if (!found) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  const { member, tenant, paidOnce } = found;
  // Back to what they were before the hold: Stripe and TeamUp keep their own
  // standing ("paid", overdue derived from the due date as before); a member
  // MatFlow bills who has never paid is "No payment yet" again.
  const resumedStatus = !member.stripeSubscriptionId && member.billedBy !== "teamup" && paidOnce === 0 ? "pending" : "paid";
  if (member.paymentStatus !== "paused") {
    return NextResponse.json({ error: "This membership is not on hold" }, { status: 409 });
  }

  let stripeResumed = false;
  if (member.stripeSubscriptionId) {
    if (!process.env.STRIPE_SECRET_KEY) return apiError("Stripe is not configured", 503);
    if (!tenant?.stripeConnected || !tenant.stripeAccountId) {
      return NextResponse.json({ error: "This member has a Stripe subscription but the club's Stripe is not connected — reconnect under Settings → Revenue first" }, { status: 409 });
    }
    try {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });
      await stripe.subscriptions.update(member.stripeSubscriptionId, RESUME_COLLECTION_PARAMS, { stripeAccount: tenant.stripeAccountId });
      stripeResumed = true;
    } catch (e) {
      return apiError("Stripe would not resume this subscription — nothing was changed", 502, e, "[members/resume]");
    }
  }

  await withTenantContext(tenantId, (tx) =>
    tx.member.update({
      where: { id: member.id },
      data: { paymentStatus: resumedStatus, holdUntil: null },
    }),
  );

  await logAudit({
    tenantId,
    userId,
    action: "member.hold.end",
    entityType: "Member",
    entityId: member.id,
    metadata: {
      holdUntil: member.holdUntil ? member.holdUntil.toISOString() : null,
      stripeSubscriptionId: member.stripeSubscriptionId,
      stripeResumed,
    },
    req,
  });

  return NextResponse.json({ ok: true, memberId: member.id, paymentStatus: resumedStatus, holdUntil: null, stripeResumed });
}
