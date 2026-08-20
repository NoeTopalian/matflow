// GET /api/members/[id]/payment-method
// Returns the member's saved Stripe card details (last4, brand, expiry).
// Returns { card: null } if no saved method or Stripe not configured.
// Auth: requireOwner

import { requireApiOwner } from "@/lib/api-authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import Stripe from "stripe";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;
  const { id: memberId } = await params;

  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ card: null });

  const { member, tenant } = await withTenantContext(tenantId, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: memberId, tenantId },
      select: { stripeCustomerId: true },
    });
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeAccountId: true },
    });
    return { member, tenant };
  });

  if (!member?.stripeCustomerId || !tenant?.stripeAccountId) {
    return NextResponse.json({ card: null });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-03-25.dahlia",
    });
    const methods = await stripe.customers.listPaymentMethods(
      member.stripeCustomerId,
      { type: "card", limit: 1 },
      { stripeAccount: tenant.stripeAccountId },
    );
    const card = methods.data[0]?.card ?? null;
    return NextResponse.json({
      card: card
        ? {
            brand: card.brand,
            last4: card.last4,
            expMonth: card.exp_month,
            expYear: card.exp_year,
          }
        : null,
    });
  } catch {
    return NextResponse.json({ card: null });
  }
}
