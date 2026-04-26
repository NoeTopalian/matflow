import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const session = await auth();
  if (!session || !["owner", "manager"].includes(session.user.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: session.user.tenantId },
    select: { stripeAccountId: true, stripeConnected: true, acceptsBacs: true },
  });

  if (!tenant?.stripeConnected || !tenant.stripeAccountId || !process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "Stripe not connected" }, { status: 400 });
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

  const member = await prisma.member.findFirst({
    where: { id: memberId, tenantId: session.user.tenantId },
    select: { id: true, email: true, name: true, stripeCustomerId: true },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const stripeAccount = tenant.stripeAccountId;

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });

    // Find or create Stripe Customer on the connected account
    let customerId = member.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create(
        { email: member.email, name: member.name },
        { stripeAccount },
      );
      customerId = customer.id;
      await prisma.member.update({
        where: { id: memberId },
        data: { stripeCustomerId: customerId },
      });
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

    await prisma.member.update({
      where: { id: memberId },
      data: {
        stripeSubscriptionId: subscription.id,
        preferredPaymentMethod: requestedMethod,
      },
    });

    const invoice = subscription.latest_invoice as { payment_intent?: { client_secret?: string } } | null;
    return NextResponse.json({
      subscriptionId: subscription.id,
      clientSecret: invoice?.payment_intent?.client_secret ?? null,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to create subscription";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
