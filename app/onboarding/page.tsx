import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import OwnerOnboardingWizard from "@/components/onboarding/OwnerOnboardingWizard";

export default async function OnboardingPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "owner") redirect("/dashboard");

  const tenant = await prisma.tenant.findUnique({
    where: { id: session.user.tenantId },
    select: { onboardingCompleted: true },
  }).catch(() => null);

  if (tenant?.onboardingCompleted) redirect("/dashboard");

  return (
    <OwnerOnboardingWizard
      tenantName={session.user.tenantName}
      ownerName={session.user.name}
      primaryColor={session.user.primaryColor ?? "#3b82f6"}
    />
  );
}
