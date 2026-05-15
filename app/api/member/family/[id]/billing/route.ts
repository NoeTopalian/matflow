// GET /api/member/family/[id]/billing
//
// F3 read surface — what a parent sees on /member/family/[id] when the
// Manage button is tapped:
//   - Whether the gym has self-billing on at all
//   - The kid's current subscription status (membershipType + paymentStatus)
//   - Available isKids: true plans to subscribe to
//   - Last few Payment rows attached to this kid (read-only history)
//
// Composite predicate via parentMemberId on every kid lookup — cross-parent
// requests return 404 so existence is never disclosed.

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const parentMemberId = (session.user as { memberId?: string }).memberId;
  if (!parentMemberId) return apiError("Not a member account", 403);

  const { id: kidMemberId } = await params;

  // Load all four things in one tenant-scoped pass — keeps the route fast
  // even when the parent has 10 kids each generating their own card.
  const result = await withTenantContext(session.user.tenantId, async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: {
        memberSelfBilling: true,
        stripeConnected: true,
        currency: true,
      },
    });

    const kid = await tx.member.findFirst({
      where: {
        id: kidMemberId,
        tenantId: session.user.tenantId,
        parentMemberId,
      },
      select: {
        id: true,
        name: true,
        membershipType: true,
        paymentStatus: true,
        stripeSubscriptionId: true,
      },
    });

    if (!kid) {
      return { kind: "not-found" as const };
    }

    const tiers = await tx.membershipTier.findMany({
      where: { tenantId: session.user.tenantId, isActive: true, isKids: true },
      select: {
        id: true,
        name: true,
        description: true,
        pricePence: true,
        currency: true,
        billingCycle: true,
        // Note: MembershipTier doesn't yet store a stripePriceId. When that
        // column ships (matching ClassPack), surface it here so the parent
        // UI can fire start-for-kid without a second round-trip to Stripe.
      },
      orderBy: { pricePence: "asc" },
    });

    const payments = await tx.payment.findMany({
      where: { memberId: kid.id, tenantId: session.user.tenantId },
      select: {
        id: true,
        amountPence: true,
        currency: true,
        status: true,
        description: true,
        paidAt: true,
        refundedAt: true,
      },
      orderBy: { paidAt: "desc" },
      take: 6,
    });

    return {
      kind: "ok" as const,
      tenant: {
        selfBillingEnabled: !!tenant?.memberSelfBilling,
        stripeConnected: !!tenant?.stripeConnected,
        currency: tenant?.currency ?? "GBP",
      },
      kid: {
        id: kid.id,
        name: kid.name,
        membershipType: kid.membershipType,
        paymentStatus: kid.paymentStatus,
        hasActiveSubscription: !!kid.stripeSubscriptionId,
      },
      plans: tiers,
      payments,
    };
  });

  if (result.kind === "not-found") return apiError("Kid not found in your family", 404);
  return NextResponse.json(result);
}
