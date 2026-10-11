import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { clubAccountOrRefusal } from "@/lib/stripe/club-account";
import { createSubscriptionForMember } from "@/lib/stripe/subscriptions";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";
import { refuseIfReviewLocked } from "@/lib/review-lock";
import { refuseIfBilledElsewhere } from "@/lib/billing-source-server";

// Staff-side subscription creator. Owner / manager loads a member's billing
// screen and presses Subscribe on their behalf — most common when collecting
// the first month at the front desk.
//
// The actual Stripe call lives in lib/stripe/subscriptions.ts. This route is
// just the authorisation gate + tenant/member load + outcome → HTTP mapping.
// The member self-serve endpoint (POST /api/member/subscriptions/start) and
// the parent-pays-for-kid endpoint (POST /api/member/subscriptions/start-for-
// kid) both call the same helper so all three rows look the same in Stripe.

const createSubscriptionSchema = z.object({
  memberId: z.string().min(1).max(50),
  priceId: z.string().min(1).max(100).regex(/^price_/, "must be a Stripe price id"),
  paymentMethodType: z.enum(["card", "bacs_debit"]).optional(),
  /**
   * Client-minted id for this subscribe intent — the Stripe idempotency key.
   * Held across retries of the same click and re-minted for a deliberate new
   * one, so a double-submit collapses to one subscription. Optional so an
   * older client is refused explicitly below rather than silently unprotected.
   */
  requestId: z.string().min(8).max(100).optional(),
  /**
   * The tier the drawer picked (payments RP-2). Optional so an older client
   * still works: the tier is then resolved from the price, as the member
   * routes do. Never written to the member here — the tier is granted by the
   * webhook on the first paid invoice.
   */
  membershipTierId: z.string().min(1).max(50).optional(),
});

export async function POST(req: Request) {
  // Audit iter-1-member-lifecycle A3H-1: CSRF guard on a staff-authenticated
  // mutating endpoint that creates a Stripe subscription for a member.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session || !["owner", "manager"].includes(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const reviewLocked = await refuseIfReviewLocked(session.user.tenantId, "subscription_start");
  if (reviewLocked) return reviewLocked;

  const tenant = await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: session.user.tenantId },
      // The Stripe connection is read by requireChargeableClubAccount below.
      select: { acceptsBacs: true },
    }),
  );

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = createSubscriptionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  }
  const { memberId, priceId, paymentMethodType, requestId, membershipTierId } = parsed.data;

  // A subscribe request without a request id has NO protection against a
  // double-submit: the Stripe idempotency key is derived from it. Refuse
  // explicitly rather than minting one server-side, which would be per-request
  // and therefore no protection at all while looking like some.
  if (!requestId) {
    return NextResponse.json(
      { error: "Missing requestId — refresh the page and try again" },
      { status: 400 },
    );
  }

  const requestedMethod: "card" | "bacs_debit" = paymentMethodType === "bacs_debit" ? "bacs_debit" : "card";

  const member = await withTenantContext(session.user.tenantId, (tx) =>
    tx.member.findFirst({
      where: { id: memberId, tenantId: session.user.tenantId },
      select: {
        id: true,
        email: true,
        name: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
      },
    }),
  );
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  // TeamUp bridge (readiness spec v3 §7): a member TeamUp bills is never
  // given a second collection here. Before any provider call.
  const billedElsewhere = await refuseIfBilledElsewhere(session.user.tenantId, memberId);
  if (billedElsewhere) return billedElsewhere;

  // The drawer also hides the button for an already-subscribed member, but that
  // check reads an SSR snapshot taken when the page rendered. Two tabs, or two
  // staff at the desk, both see "no subscription" and can each pick a different
  // tier — different price, different idempotency key, two live subscriptions.
  // Member.stripeSubscriptionId then keeps whichever wrote last, so the other
  // bills on with nothing in MatFlow pointing at it. Refuse here, where the
  // read and the write are in the same request.
  if (member.stripeSubscriptionId) {
    return NextResponse.json(
      { error: "This member already has a subscription. Cancel it before starting another." },
      { status: 409 },
    );
  }

  // Payments RP-2 (lane PA round 2): the price must belong to an active tier of
  // THIS club. With membershipTierId the drawer named the tier, and it must be
  // that tier's own price (one tier cannot be paired with another's price);
  // without it the tier is resolved from the price exactly as
  // member/subscriptions/start does. Nothing here writes Member.membershipTierId
  // or membershipType. lib/stripe/subscriptions.ts records the price tier on
  // the subscription mapping and the webhook grants it on the first payment.
  const tier = await withTenantContext(session.user.tenantId, (tx) =>
    membershipTierId
      ? tx.membershipTier.findFirst({
          where: { id: membershipTierId, tenantId: session.user.tenantId, isActive: true },
          select: { id: true, stripePriceId: true },
        })
      : tx.membershipTier.findFirst({
          where: { stripePriceId: priceId, tenantId: session.user.tenantId, isActive: true },
          select: { id: true, stripePriceId: true },
        }),
  );
  if (!tier || tier.stripePriceId !== priceId) {
    return NextResponse.json(
      { error: "Plan not found — pick one of this club's membership plans." },
      { status: 400 },
    );
  }

  // Payments lane PA: one guard for every Stripe call, after the TeamUp bridge
  // and the duplicate check so those answers are unchanged. The id it read in
  // the same query as the flag and the status is the only one Stripe sees.
  const club = await clubAccountOrRefusal(session.user.tenantId, "subscription_start", { audience: "staff" });
  if (!club.ok) return club.response;

  const outcome = await createSubscriptionForMember({
    tenant: {
      id: session.user.tenantId,
      stripeAccountId: club.account.stripeAccountId,
      acceptsBacs: tenant?.acceptsBacs ?? false,
    },
    member,
    priceId,
    requestId,
    membershipTierId: tier.id,
    paymentMethodType: requestedMethod,
  });

  if (!outcome.ok) {
    return apiError(outcome.error, outcome.status, undefined, "[stripe/create-subscription]");
  }

  return NextResponse.json({
    subscriptionId: outcome.subscriptionId,
    clientSecret: outcome.clientSecret,
  });
}
