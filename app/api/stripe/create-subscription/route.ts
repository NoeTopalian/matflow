import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { ensureCanAcceptCharges } from "@/lib/stripe-account-status";

export async function POST(req: Request) {
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

  if (!tenant?.stripeConnected || !tenant.stripeAccountId || !process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "Stripe not connected" }, { status: 400 });
  }

  // Fix 3: gate on Stripe Connect account capability.
  const acceptCheck = await ensureCanAcceptCharges(session.user.tenantId, tenant.stripeAccountId, tenant.stripeAccountStatus);
  if (!acceptCheck.ok) {
    return NextResponse.json(
      { error: "This gym's Stripe account requires attention before subscriptions can be created." },
      { status: 503 },
    );
  }

  const { memberId, priceId, paymentMethodType } = await req.json() as {
    memberId: string;
    priceId: string;
    paymentMethodType?: "card" | "bacs_debit";
  };
  if (!memberId || !priceId) {
    return NextResponse.json({ error: "memberId and priceId required" }, { status: 400 });
  }
  const requestedMethod: "card" | "bacs_debit" = paymentMethodType === "bacs_debit" ? "bacs_debit" : "card";

  if (requestedMethod === "bacs_debit" && !tenant.acceptsBacs) {
    return NextResponse.json({ error: "Direct Debit is not enabled for this gym" }, { status: 400 });
  }

  const member = await withTenantContext(session.user.tenantId, (tx) =>
    tx.member.findFirst({
      where: { id: memberId, tenantId: session.user.tenantId },
      select: { id: true, email: true, name: true, stripeCustomerId: true },
    }),
  );
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const stripeAccount = tenant.stripeAccountId;

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });

    // Find or create Stripe Customer on the connected account
    let customerId = member.stripeCustomerId;
    if (!customerId) {
      // Race-safe: only one request can flip stripeCustomerId from null to a real value.
      const customer = await stripe.customers.create(
        { email: member.email, name: member.name },
        { stripeAccount },
      );
      const winnerId = await withTenantContext(session.user.tenantId, async (tx) => {
        const u = await tx.member.updateMany({
          where: { id: memberId, stripeCustomerId: null },
          data: { stripeCustomerId: customer.id },
        });
        if (u.count === 1) return customer.id;
        // Another concurrent request beat us. Re-read the winner's customerId.
        const fresh = await tx.member.findUnique({
          where: { id: memberId },
          select: { stripeCustomerId: true },
        });
        return fresh?.stripeCustomerId ?? customer.id;
        // (We've created an orphan Stripe customer for the loser. Acceptable — leak is one customer record per losing race.)
      });
      customerId = winnerId;
    }

    const subscription = await stripe.subscriptions.create(
      {
        customer: customerId,
        items: [{ price: priceId }],
        payment_behavior: "default_incomplete",
        payment_settings: {
          payment_method_types: requestedMethod === "bacs_debit" ? ["bacs_debit"] : ["card"],
          save_default_payment_method: "on_subscription",
        },
        expand: ["latest_invoice.payment_intent"],
      },
      { stripeAccount },
    );

    await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.update({
        where: { id: memberId },
        data: {
          stripeSubscriptionId: subscription.id,
          preferredPaymentMethod: requestedMethod,
        },
      }),
    );

    const invoice = subscription.latest_invoice as { payment_intent?: { client_secret?: string } } | null;
    return NextResponse.json({
      subscriptionId: subscription.id,
      clientSecret: invoice?.payment_intent?.client_secret ?? null,
    });
  } catch (err: unknown) {
    return apiError("Stripe operation failed", 500, err, "[stripe/create-subscription]");
  }
}
