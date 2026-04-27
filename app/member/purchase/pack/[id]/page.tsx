import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import PurchasePackClient from "@/components/member/PurchasePackClient";

type Props = { params: Promise<{ id: string }> };

export default async function PurchasePackPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { id } = await params;
  const tenantId = session.user.tenantId;

  const pack = await prisma.classPack.findFirst({
    where: { id, tenantId, isActive: true },
    select: { id: true, name: true, description: true, totalCredits: true, validityDays: true, pricePence: true, currency: true },
  });
  if (!pack) notFound();

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, stripeConnected: true },
  });

  return (
    <PurchasePackClient
      pack={pack}
      gymName={tenant?.name ?? "Your gym"}
      stripeAvailable={tenant?.stripeConnected ?? false}
      primaryColor={session.user.primaryColor ?? "#3b82f6"}
    />
  );
}
