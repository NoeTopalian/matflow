// POST /api/member/family/[id]/billing/portal
//
// B4 — parent opens a Stripe Customer Portal session for the kid's
// payments. Same composite-predicate scoping as the other parent→kid
// billing routes: { id, tenantId, parentMemberId } so a parent can ONLY
// reach their own linked kid.
//
// Why this exists: the parent paid for the kid through F3 with a card
// attached to the KID's Stripe customer. Stripe's Customer Portal is the
// canonical UI for managing that card (swap, view invoices, see receipts)
// without ever leaving Stripe's hosted page. We mint a short-lived
// portal session and redirect — no local state, no card data handling.

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const parentMemberId = (session.user as { memberId?: string }).memberId;
  if (!parentMemberId) return apiError("Not a member account", 403);

  const { id: kidMemberId } = await params;

  const tenant = await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: { stripeAccountId: true, stripeConnected: true, memberSelfBilling: true },
    }),
  );
  if (!tenant) return apiError("Tenant not found", 404);
  if (!tenant.memberSelfBilling) {
    return apiError("This gym manages payments centrally — please speak to staff", 403);
  }
  if (!tenant.stripeConnected || !tenant.stripeAccountId) {
    return apiError("This gym hasn't connected payments yet", 503);
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return apiError("Stripe not configured", 503);
  }

  // Composite predicate — defence-in-depth on I4. 404 not 403 so the
  // existence of another parent's kid is never disclosed.
  const kid = await withTenantContext(session.user.tenantId, (tx) =>
    tx.member.findFirst({
      where: {
        id: kidMemberId,
        tenantId: session.user.tenantId,
        parentMemberId,
      },
      select: { id: true, stripeCustomerId: true, name: true },
    }),
  );
  if (!kid) return apiError("Kid not found in your family", 404);
  if (!kid.stripeCustomerId) {
    // No Stripe customer = no portal yet. Subscribe first via /start-for-kid.
    return apiError("No billing on file — start a subscription first", 404);
  }

  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-03-25.dahlia",
    });

    // Return URL: send the parent back to the kid's family page on
    // matflow.studio so they see the updated billing state. Build from
    // request origin so dev + prod work without env-var gymnastics.
    const origin = req.headers.get("origin") ?? new URL(req.url).origin;
    const returnUrl = `${origin}/member/family/${kid.id}`;

    const portal = await stripe.billingPortal.sessions.create(
      {
        customer: kid.stripeCustomerId,
        return_url: returnUrl,
      },
      { stripeAccount: tenant.stripeAccountId },
    );

    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id ?? null,
      action: "member.subscription.portal.kid",
      entityType: "Member",
      entityId: kid.id,
      metadata: { parentMemberId, portalSessionId: portal.id },
      req,
    });

    return NextResponse.json({ url: portal.url });
  } catch (e) {
    return apiError("Failed to open billing portal", 500, e, "[member/family/billing/portal]");
  }
}
