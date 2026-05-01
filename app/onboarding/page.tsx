import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import OwnerOnboardingWizard from "@/components/onboarding/OwnerOnboardingWizard";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ resume?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (session.user.role !== "owner") redirect("/dashboard");

  const { resume } = await searchParams;

  const tenant = await prisma.tenant.findUnique({
    where: { id: session.user.tenantId },
    select: { onboardingCompleted: true },
  }).catch(() => null);

  // Wizard v2: ?resume=1 lets owners re-enter the wizard from the dashboard
  // SetupBanner even if onboardingCompleted=true. Skipped items can be
  // walked through again via the same UI.
  if (tenant?.onboardingCompleted && resume !== "1") redirect("/dashboard");

  return (
    <OwnerOnboardingWizard
      tenantName={session.user.tenantName}
      ownerName={session.user.name}
      primaryColor={session.user.primaryColor ?? "#3b82f6"}
    />
  );
}
