import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { withTenantContext } from "@/lib/prisma-tenant";
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

  const tenant = await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: { onboardingCompleted: true, name: true, timezone: true, logoSize: true },
    }),
  ).catch(() => null);
  const logoSize = tenant?.logoSize;

  // Wizard v2: ?resume=1 lets owners re-enter the wizard from the dashboard
  // SetupBanner even if onboardingCompleted=true. Skipped items can be
  // walked through again via the same UI.
  if (tenant?.onboardingCompleted && resume !== "1") redirect("/dashboard");

  return (
    <OwnerOnboardingWizard
      tenantName={session.user.tenantName}
      ownerName={session.user.name}
      primaryColor={session.user.primaryColor ?? "#3b82f6"}
      // Batch 1 (16 Oct 2026): the wizard compares against these so passing
      // a step never re-saves a value the owner did not change.
      storedName={tenant?.name ?? null}
      storedTimezone={tenant?.timezone ?? null}
      storedLogoSize={logoSize === "sm" || logoSize === "md" || logoSize === "lg" ? logoSize : null}
      // Fail closed: if the club could not be read, treat it as set up so the
      // wizard never moves a live club's time zone on a guess.
      alreadyOnboarded={tenant ? tenant.onboardingCompleted : true}
    />
  );
}
