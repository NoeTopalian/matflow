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
  }));

  return (
    <MembershipsManager
      initialTiers={tiers}
      primaryColor={session.user.primaryColor}
    />
  );
}
