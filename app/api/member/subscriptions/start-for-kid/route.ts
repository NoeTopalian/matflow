// POST /api/member/subscriptions/start-for-kid
//
// F3 — parent subscribes a kid.
//
// The mirror of /start, scoped to a kid the calling parent is linked to.
// Composite predicate { id: kidMemberId, parentMemberId: session.memberId,
// tenantId } enforces invariant I4: a parent can only subscribe their OWN
// kid, never another parent's, never a cross-tenant kid.
//
// Plan must be isKids: true. Adult tiers go through /start (the parent
// themselves). The kid's own Stripe customer is created so cancellation,
// invoices, and tax are cleanly scoped to that kid — even though the
// **payment method** today defaults to the parent's saved card.
//
// Payment-method scope (locked 2026-05-15): same card by default, per-kid
// override available later via a "Use different card" Stripe customer
// portal session. v1 always uses the kid's own Stripe customer so a future
// override can attach a different PaymentMethod without surgery.

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { ensureCanAcceptCharges } from "@/lib/stripe-account-status";
import { createSubscriptionForMember } from "@/lib/stripe/subscriptions";
import { z } from "zod";

const bodySchema = z.object({
  kidMemberId: z.string().min(1).max(50),
  priceId: z.string().min(1).max(100).regex(/^price_/, "must be a Stripe price id"),
  paymentMethodType: z.enum(["card", "bacs_debit"]).optional(),
  /**
   * Client-minted id for this subscribe intent — the Stripe idempotency key.
   * Held across retries of the same click and re-minted for a deliberate new
   * one, so a double-submit collapses to one subscription. Optional so an
   * older client is refused explicitly below rather than silently unprotected.
   */
  requestId: z.string().min(8).max(100).optional(),
});

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const parentMemberId = (session.user as { memberId?: string }).memberId;
  if (!parentMemberId) return apiError("Not a member account", 403);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON", 400);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }
  const { kidMemberId, priceId, paymentMethodType, requestId } = parsed.data;

  // A subscribe request without a request id has NO protection against a
  // double-submit: the Stripe idempotency key is derived from it. Refuse
  // explicitly rather than minting one server-side, which would be per-request
  // and therefore no protection at all while looking like some.
  if (!requestId) {
    return apiError("Missing requestId — refresh the page and try again", 400);
  }

  const requestedMethod: "card" | "bacs_debit" = paymentMethodType === "bacs_debit" ? "bacs_debit" : "card";

  const tenant = await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: {
        stripeAccountId: true,
        stripeConnected: true,
        acceptsBacs: true,
        stripeAccountStatus: true,
        memberSelfBilling: true,
      },
    }),
  );
  if (!tenant) return apiError("Tenant not found", 404);
  if (!tenant.memberSelfBilling) {
    return apiError("This gym manages payments centrally — please speak to staff", 403);
  }
  if (!tenant.stripeConnected || !tenant.stripeAccountId) {
    return apiError("This gym hasn't connected payments yet", 503);
  }
  const acceptCheck = await ensureCanAcceptCharges(
    session.user.tenantId,
    tenant.stripeAccountId,
    tenant.stripeAccountStatus,
  );
  if (!acceptCheck.ok) {
    return apiError(
      "This gym's Stripe account requires attention before subscriptions can be created.",
      503,
    );
  }

  // Composite predicate — defence-in-depth on I4: a parent can ONLY subscribe
  // their own linked kid. Cross-parent attempts return 404, not 403, so the
  // existence of the other kid is never disclosed.
  //
  // Kid-tier validation: MembershipTier.stripePriceId shipped in migration
  // 20260515000002, so we resolve the picked Stripe price → tier in the same
  // transaction and refuse if the tier isn't marked isKids. Unmapped tiers
  // 404 here so an owner mistakenly exposing an adult plan to the parent UI
  // can't fire a non-kid intent against a kid's row.
  const [kid, tier] = await withTenantContext(session.user.tenantId, async (tx) => {
    const k = await tx.member.findFirst({
      where: {
        id: kidMemberId,
        tenantId: session.user.tenantId,
        parentMemberId,
      },
      select: {
        id: true,
        email: true,
        name: true,
        stripeCustomerId: true,
        accountType: true,
        // Read so the duplicate guard below can be evaluated at all.
        stripeSubscriptionId: true,
      },
    });
    const t = await tx.membershipTier.findFirst({
      where: { stripePriceId: priceId, tenantId: session.user.tenantId, isActive: true },
      select: { id: true, isKids: true, name: true },
    });
    return [k, t] as const;
  });

  if (!kid) return apiError("Kid not found in your family", 404);
  if (!tier) return apiError("Plan not found or not configured for self-billing", 404);
  if (!tier.isKids) return apiError("Pick a kid-eligible plan", 400);

  // Refuse a SECOND subscription for this child. The staff route has always
  // done this (app/api/stripe/create-subscription/route.ts:90-95); the
  // member-facing twins never did, so the guard sat on the surface a coach
  // uses and not on the one a parent uses on their phone.
  //
  // This is the likelier of the two to fire in practice: the Subscribe button
  // in components/member/KidBillingCard.tsx guards a double-tap with React
  // state, which is asynchronous, so two taps inside one tick both pass. On gym
  // wifi, where the first tap shows nothing for a second or two, tapping again
  // is normal behaviour — not an edge case. lib/stripe/subscriptions.ts then
  // writes the new subscription id over the old, and the first bills forever
  // with nothing in MatFlow pointing at it.
  if (kid.stripeSubscriptionId) {
    return apiError(
      `${kid.name} already has an active membership. Cancel it before starting another.`,
      409,
    );
  }

  const outcome = await createSubscriptionForMember({
    tenant: {
      id: session.user.tenantId,
      stripeAccountId: tenant.stripeAccountId,
      acceptsBacs: tenant.acceptsBacs,
    },
    member: {
      id: kid.id,
      // The kid's synthesised email lives on Member.email — that's what Stripe
      // sees as the customer email. Receipts can be re-routed to the parent
      // later via Stripe customer settings; v1 keeps the email aligned with
      // the Member row so audit trails stay clean.
      email: kid.email,
      name: kid.name,
      stripeCustomerId: kid.stripeCustomerId,
    },
    priceId,
    requestId,
    paymentMethodType: requestedMethod,
  });

  if (!outcome.ok) {
    return apiError(outcome.error, outcome.status, undefined, "[member/subscriptions/start-for-kid]");
  }

  await logAudit({
    tenantId: session.user.tenantId,
    userId: session.user.id ?? null,
    action: "member.subscription.create.kid",
    entityType: "Member",
    entityId: kid.id,
    metadata: { parentMemberId, priceId, paymentMethodType: requestedMethod },
    req,
  });

  return NextResponse.json(
    {
      subscriptionId: outcome.subscriptionId,
      clientSecret: outcome.clientSecret,
    },
    { status: 201 },
  );
}
