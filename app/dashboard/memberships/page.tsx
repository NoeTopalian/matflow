import { requireRole } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import MembershipsManager from "@/components/dashboard/MembershipsManager";

export type MembershipTierRow = {
  id: string;
  name: string;
  description: string | null;
  pricePence: number;
  currency: string;
  billingCycle: string;
  maxClassesPerWeek: number | null;
  isKids: boolean;
  isActive: boolean;
  createdAt: string;
  stripePriceId: string | null;
  stripeProductId: string | null;
  /** Members on this tier whose status is active. A count of people, not of
   *  subscriptions — a family on one tier counts each member. */
  activeMembers: number;
  /** ADR-001 D2 slice 2: the venue this tier covers; null = every venue. */
  locationId: string | null;
  locationName: string | null;
};

export default async function MembershipsPage() {
  const { session } = await requireRole(["owner"]);

  // UI-RULES §7: unguarded. A read failure used to render "no membership
  // plans", inviting an owner to recreate plans that already exist (and, with
  // Stripe products attached, to create duplicates upstream too).
  const rows = await withTenantContext(session.user.tenantId, (tx) =>
    tx.membershipTier.findMany({
      where: { tenantId: session.user.tenantId, isActive: true },
      orderBy: { createdAt: "asc" },
      // Active-member count per tier, the number the previous platform's
      // catalogue shows beside every plan and the one reconciliation reads.
      include: { _count: { select: { members: { where: { status: "active" } } } }, locationRef: { select: { name: true } } },
    }),
  );

  const tiers: MembershipTierRow[] = rows.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    pricePence: t.pricePence,
    currency: t.currency,
    billingCycle: t.billingCycle,
    maxClassesPerWeek: t.maxClassesPerWeek,
    isKids: t.isKids,
    isActive: t.isActive,
    createdAt: t.createdAt.toISOString(),
    stripePriceId: t.stripePriceId,
    stripeProductId: t.stripeProductId,
    activeMembers: t._count.members,
    locationId: t.locationId,
    locationName: t.locationRef?.name ?? null,
  }));

  return (
    <MembershipsManager
      initialTiers={tiers}
      primaryColor={session.user.primaryColor}
    />
  );
}
