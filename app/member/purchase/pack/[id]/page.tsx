import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { redirect, notFound } from "next/navigation";
import PurchasePackClient from "@/components/member/PurchasePackClient";

type Props = { params: Promise<{ id: string }> };

export default async function PurchasePackPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { id } = await params;
  const tenantId = session.user.tenantId;

  const { pack, tenant } = await withTenantContext(tenantId, async (tx) => {
    const pack = await tx.classPack.findFirst({
      where: { id, tenantId, isActive: true },
      select: { id: true, name: true, description: true, totalCredits: true, validityDays: true, pricePence: true, currency: true },
    });
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, stripeConnected: true },
    });
    return { pack, tenant };
  });
  if (!pack) notFound();

  return (
    <PurchasePackClient
      pack={pack}
      gymName={tenant?.name ?? "Your gym"}
      stripeAvailable={tenant?.stripeConnected ?? false}
      primaryColor={session.user.primaryColor ?? "#3b82f6"}
    />
  );
}
