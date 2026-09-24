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
      select: { id: true, paymentStatus: true, holdUntil: true, stripeSubscriptionId: true },
    });
    if (!member) return null;
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { stripeAccountId: true, stripeConnected: true } });
    return { member, tenant };
  });
  if (!found) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  const { member, tenant } = found;
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
      data: { paymentStatus: "paid", holdUntil: null },
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

  return NextResponse.json({ ok: true, memberId: member.id, paymentStatus: "paid", holdUntil: null, stripeResumed });
}
