import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json({ error: "No member account linked" }, { status: 404 });

  const member = await prisma.member.findFirst({
    where: { id: memberId, tenantId: session.user.tenantId },
    select: { id: true, tenantId: true, stripeCustomerId: true },
  });
  if (!member?.stripeCustomerId) {
    return NextResponse.json({ error: "No billing account yet — set up a payment method first." }, { status: 400 });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: member.tenantId },
    select: { stripeAccountId: true },
  });
  if (!tenant?.stripeAccountId) return NextResponse.json({ error: "Gym billing not configured" }, { status: 400 });
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });

  const returnUrl = `${process.env.NEXTAUTH_URL ?? new URL(req.url).origin}/member/profile`;

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });
    const portalSession = await stripe.billingPortal.sessions.create(
      { customer: member.stripeCustomerId, return_url: returnUrl },
      { stripeAccount: tenant.stripeAccountId },
    );

    await logAudit({
      tenantId: member.tenantId,
      userId: null,
      action: "billing.portal.open",
      entityType: "Member",
      entityId: member.id,
      req,
    });

    return NextResponse.json({ url: portalSession.url });
  } catch (e) {
    return apiError("Stripe operation failed", 500, e, "[stripe/portal]");
  }
}
