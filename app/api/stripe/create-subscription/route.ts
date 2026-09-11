import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { ensureCanAcceptCharges } from "@/lib/stripe-account-status";
import { createSubscriptionForMember } from "@/lib/stripe/subscriptions";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";

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

  const tenant = await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: { stripeAccountId: true, stripeConnected: true, acceptsBacs: true, stripeAccountStatus: true },
    }),
  );

  if (!tenant?.stripeConnected || !tenant.stripeAccountId) {
    return NextResponse.json({ error: "Stripe not connected" }, { status: 400 });
  }

  const acceptCheck = await ensureCanAcceptCharges(session.user.tenantId, tenant.stripeAccountId, tenant.stripeAccountStatus);
  if (!acceptCheck.ok) {
    return NextResponse.json(
      { error: "This gym's Stripe account requires attention before subscriptions can be created." },
      { status: 503 },
    );
  }

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
  const { memberId, priceId, paymentMethodType } = parsed.data;
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
    return apiError(outcome.error, outcome.status, undefined, "[stripe/create-subscription]");
  }

  return NextResponse.json({
    subscriptionId: outcome.subscriptionId,
    clientSecret: outcome.clientSecret,
  });
}
