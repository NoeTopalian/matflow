// /member/membership — payments lane PB (11 Oct 2026), audit F1.
//
// The adult member's own "start a membership and pay for it" page: the caller
// POST /api/member/subscriptions/start never had. Reads the club's adult plans
// and the member's current subscription state on the server (tenant-scoped),
// then hands them to SelfSubscribeCard, which starts the subscription and
// takes the first payment on the club's own Stripe account.
//
// Reading only: nothing here writes a member, a mapping or a payment. The
// load is not wrapped in try/catch, so a failure renders app/member/error.tsx
// rather than an empty plan list (UI-RULES §7).

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import SelfSubscribeCard, { type SelfSubscribeState } from "@/components/member/SelfSubscribeCard";
import { isBilledElsewhere } from "@/lib/billing-source";

const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]{1,200}$/;

export default async function MemberMembershipPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const memberId = (session.user as { memberId?: string }).memberId;
  if (!memberId) notFound();
  const tenantId = session.user.tenantId;

  const data = await withTenantContext(tenantId, async (tx) => {
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, memberSelfBilling: true, stripeConnected: true },
    });
    const member = await tx.member.findFirst({
      where: { id: memberId, tenantId },
      select: {
        id: true,
        parentMemberId: true,
        billedBy: true,
        paymentStatus: true,
        membershipType: true,
        stripeSubscriptionId: true,
      },
    });
    const plans = await tx.membershipTier.findMany({
      where: { tenantId, isActive: true, isKids: false, stripePriceId: { not: null } },
      select: { id: true, name: true, description: true, pricePence: true, currency: true, billingCycle: true, stripePriceId: true },
      orderBy: { pricePence: "asc" },
    });
    const mapping = member?.stripeSubscriptionId
      ? await tx.memberSubscription.findFirst({
          where: { tenantId, stripeSubscriptionId: member.stripeSubscriptionId },
          select: { status: true, endedAt: true },
        })
      : null;
    return { tenant, member, plans, mapping };
  });

  if (!data.member || !data.tenant) notFound();
  // A child sub-account has no login of its own; its guardian pays from the family page.
  if (data.member.parentMemberId) redirect("/member/profile");

  const { member, tenant, mapping } = data;
  const state: SelfSubscribeState = !member.stripeSubscriptionId
    ? { kind: "none" }
    : mapping && mapping.status === "incomplete" && !mapping.endedAt
      ? { kind: "unpaid", subscriptionId: member.stripeSubscriptionId }
      : { kind: "active", membershipType: member.membershipType, paymentStatus: member.paymentStatus };

  // Stripe returns here after a redirect-based payment method with this
  // marker; only the member's own current subscription is honoured.
  const params = await searchParams;
  const marker = typeof params.subscriptionPayment === "string" ? params.subscriptionPayment : null;
  const returningSubscriptionId =
    marker && SUBSCRIPTION_ID.test(marker) && marker === member.stripeSubscriptionId ? marker : null;

  return (
    <div className="px-4 pt-4 pb-8">
      <div className="flex items-center gap-2 mb-5">
        <Link
          href="/member/billing"
          className="inline-flex items-center gap-1 text-sm"
          style={{ color: "var(--member-text-muted)" }}
        >
          <ChevronLeft className="w-4 h-4" />
          Billing
        </Link>
      </div>
      <h1 className="text-xl font-bold mb-1" style={{ color: "var(--member-text)" }}>
        Membership
      </h1>
      <p className="text-xs mb-5" style={{ color: "var(--member-text-muted)" }}>
        Start a membership at {tenant.name} and pay for it here.
      </p>
      <SelfSubscribeCard
        gymName={tenant.name}
        canSelfSubscribe={tenant.memberSelfBilling && tenant.stripeConnected}
        billedElsewhere={isBilledElsewhere(member)}
        plans={data.plans.map((p) => ({ ...p, stripePriceId: p.stripePriceId as string }))}
        state={state}
        returningSubscriptionId={returningSubscriptionId}
      />
    </div>
  );
}
