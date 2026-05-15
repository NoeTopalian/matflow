// POST /api/member/subscriptions/start
//
// F2 — member self-subscribe.
//
// A logged-in member subscribes themselves to one of the tenant's
// MembershipTier rows that is NOT marked isKids. Kid-tier rows go through
// /start-for-kid (F3) so a parent can subscribe their kid — adult members
// hitting them here returns 400 with a clear message.
//
// Gated three ways:
//   1. Caller must be a logged-in member with a memberId on the session
//   2. Tenant.memberSelfBilling must be true (owner has opted in)
//   3. Tenant Stripe Connect must be healthy (ensureCanAcceptCharges)
//
// Cancellation is a separate route. This endpoint never deletes or modifies
// existing subscriptions — to swap plans, the member cancels first.

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { ensureCanAcceptCharges } from "@/lib/stripe-account-status";
import { createSubscriptionForMember } from "@/lib/stripe/subscriptions";
import { z } from "zod";

const bodySchema = z.object({
  priceId: z.string().min(1).max(100).regex(/^price_/, "must be a Stripe price id"),
  paymentMethodType: z.enum(["card", "bacs_debit"]).optional(),
});

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const memberId = (session.user as { memberId?: string }).memberId;
  if (!memberId) return apiError("Not a member account", 403);

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
  const { priceId, paymentMethodType } = parsed.data;
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

  // Load the calling member. Kid/adult plan validation is NOT enforced
  // here yet — MembershipTier has no stripePriceId column today so we
  // can't look up the picked Stripe price → tier server-side. Owners are
  // trusted to surface only adult tiers in the member portal. Once
  // MembershipTier.stripePriceId ships (matches the existing ClassPack
  // shape), reinstate the lookup:
  //   const tier = await tx.membershipTier.findFirst({
  //     where: { stripePriceId: priceId, tenantId, isActive: true },
  //     select: { isKids: true },
  //   });
  //   if (!tier) return apiError("Plan not found", 404);
  //   if (tier.isKids) return apiError("Kids plan — subscribe via parent", 400);
  // For now, the parent-pays-for-kid endpoint enforces the inverse check
  // (its priceId must be isKids: true) via the same TODO.
  const member = await withTenantContext(session.user.tenantId, (tx) =>
    tx.member.findFirst({
      where: { id: memberId, tenantId: session.user.tenantId },
      select: {
        id: true,
        email: true,
        name: true,
        stripeCustomerId: true,
        parentMemberId: true,
      },
    }),
  );

  if (!member) return apiError("Member not found", 404);
  // A passwordless kid sub-account should never hit this endpoint — the
  // session lookup would 401 first since kids have no login. Defence-in-depth
  // anyway: a member whose parentMemberId is set is a sub-account.
  if (member.parentMemberId !== null) {
    return apiError("Sub-accounts can't self-subscribe — your parent manages billing", 403);
  }

  const outcome = await createSubscriptionForMember({
    tenant: {
      id: session.user.tenantId,
      stripeAccountId: tenant.stripeAccountId,
      acceptsBacs: tenant.acceptsBacs,
    },
    member,
    priceId,
    paymentMethodType: requestedMethod,
  });

  if (!outcome.ok) {
    return apiError(outcome.error, outcome.status, undefined, "[member/subscriptions/start]");
  }

  return NextResponse.json(
    {
      subscriptionId: outcome.subscriptionId,
      clientSecret: outcome.clientSecret,
    },
    { status: 201 },
  );
}
