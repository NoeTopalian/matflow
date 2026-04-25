import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: { type: string; account?: string; data: { object: Record<string, unknown> } };
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" });
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret) as unknown as typeof event;
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Map connected account to tenant
  const stripeAccountId = event.account;
  let tenantId: string | null = null;
  if (stripeAccountId) {
    const tenant = await prisma.tenant.findFirst({
      where: { stripeAccountId },
      select: { id: true },
    });
    tenantId = tenant?.id ?? null;
  }

  const obj = event.data.object as Record<string, unknown>;

  if (event.type === "customer.subscription.deleted") {
    const customerId = obj.customer as string;
    if (customerId) {
      await prisma.member.updateMany({
        where: tenantId ? { stripeCustomerId: customerId, tenantId } : { stripeCustomerId: customerId },
        data: { paymentStatus: "cancelled", stripeSubscriptionId: null },
      });
    }
  }

  if (event.type === "invoice.payment_failed") {
    const customerId = obj.customer as string;
    if (customerId) {
      await prisma.member.updateMany({
        where: tenantId ? { stripeCustomerId: customerId, tenantId } : { stripeCustomerId: customerId },
        data: { paymentStatus: "overdue" },
      });
    }
  }

  if (event.type === "invoice.payment_succeeded") {
    const customerId = obj.customer as string;
    if (customerId) {
      await prisma.member.updateMany({
        where: tenantId ? { stripeCustomerId: customerId, tenantId } : { stripeCustomerId: customerId },
        data: { paymentStatus: "paid" },
      });
    }
  }

  return NextResponse.json({ received: true });
}
