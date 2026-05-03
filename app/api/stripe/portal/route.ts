import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { getBaseUrl } from "@/lib/env-url";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json({ error: "No member account linked" }, { status: 404 });

  const { member, tenant } = await withTenantContext(session.user.tenantId, async (tx) => {
    const m = await tx.member.findFirst({
      where: { id: memberId, tenantId: session.user.tenantId },
      select: { id: true, tenantId: true, stripeCustomerId: true },
    });
    const t = m
      ? await tx.tenant.findUnique({
          where: { id: m.tenantId },
          select: { stripeAccountId: true, stripeConnected: true, memberSelfBilling: true },
        })
      : null;
    return { member: m, tenant: t };
  });
  if (!member?.stripeCustomerId) {
    return NextResponse.json({ error: "No billing account yet — set up a payment method first." }, { status: 400 });
  }
  if (!tenant?.memberSelfBilling) {
    return NextResponse.json(
      { error: "Self-service billing is not enabled. Contact your gym." },
      { status: 403 },
    );
  }
  if (!tenant?.stripeAccountId) return NextResponse.json({ error: "Gym billing not configured" }, { status: 400 });
  // Fix 3 (T-2): refuse portal session when the connected account has been
  // disconnected. The stripeAccountId may still be set as residual data, but
  // calling Stripe with a stale/disconnected account would fail confusingly.
  if (!tenant.stripeConnected) {
    return NextResponse.json({ error: "Gym billing has been disconnected. Contact your gym." }, { status: 503 });
  }
  if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });

  const returnUrl = `${getBaseUrl(req)}/member/profile`;

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
