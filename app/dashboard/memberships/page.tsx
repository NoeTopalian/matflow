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
};

export default async function MembershipsPage() {
  const { session } = await requireRole(["owner"]);

  let tiers: MembershipTierRow[] = [];

  try {
    const rows = await withTenantContext(session.user.tenantId, (tx) =>
      tx.membershipTier.findMany({
        where: { tenantId: session.user.tenantId, isActive: true },
        orderBy: { createdAt: "asc" },
      }),
    );
    tiers = rows.map((t) => ({
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
    }));
  } catch {
    // DB not connected
  }

  return (
    <MembershipsManager
      initialTiers={tiers}
      primaryColor={session.user.primaryColor}
    />
  );
}
