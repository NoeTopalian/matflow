import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";

const schema = z.object({ packId: z.string().min(1) });

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json({ error: "Member account not linked" }, { status: 400 });

  const rl = await checkRateLimit(`pack:buy:${memberId}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many purchase attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  const tenantId = session.user.tenantId;
  const member = await prisma.member.findFirst({
    where: { id: memberId, tenantId },
    select: { id: true, email: true, name: true, stripeCustomerId: true },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const pack = await prisma.classPack.findFirst({
    where: { id: parsed.data.packId, tenantId, isActive: true },
  });
  if (!pack || !pack.stripePriceId) return NextResponse.json({ error: "Pack unavailable" }, { status: 404 });

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { stripeAccountId: true, stripeConnected: true },
  });
  if (!tenant?.stripeConnected || !tenant.stripeAccountId) {
    return NextResponse.json({ error: "Stripe not connected" }, { status: 400 });
  }
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });

  const successUrl = `${process.env.NEXTAUTH_URL ?? new URL(req.url).origin}/member/profile?pack=success`;
  const cancelUrl = `${process.env.NEXTAUTH_URL ?? new URL(req.url).origin}/member/profile?pack=cancel`;

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });

    let customerId = member.stripeCustomerId;
    if (!customerId) {
      // Race-safe: only one request can flip stripeCustomerId from null to a real value.
      const customer = await stripe.customers.create(
        { email: member.email, name: member.name },
        { stripeAccount: tenant.stripeAccountId },
      );
      const updated = await prisma.member.updateMany({
        where: { id: member.id, stripeCustomerId: null },
        data: { stripeCustomerId: customer.id },
      });
      if (updated.count === 1) {
        customerId = customer.id;
      } else {
        // Another concurrent request beat us. Re-read the winner's customerId.
        const fresh = await prisma.member.findUnique({
          where: { id: member.id },
          select: { stripeCustomerId: true },
        });
        customerId = fresh?.stripeCustomerId ?? customer.id;
      }
    }

    const checkoutSession = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer: customerId,
        line_items: [{ price: pack.stripePriceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          matflowKind: "class_pack",
          tenantId,
          memberId: member.id,
          packId: pack.id,
        },
      },
      { stripeAccount: tenant.stripeAccountId },
    );

    return NextResponse.json({ url: checkoutSession.url });
  } catch (e) {
    return apiError("Class pack operation failed", 500, e, "[member/class-packs/buy]");
  }
}
