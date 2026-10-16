import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { withTenantContext } from "@/lib/prisma-tenant";
import OwnerOnboardingWizard, { type StoredAnswers } from "@/components/onboarding/OwnerOnboardingWizard";

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
      select: { onboardingCompleted: true, name: true, timezone: true, logoSize: true, onboardingAnswers: true },
    }),
  ).catch(() => null);
  const logoSize = tenant?.logoSize;
  const storedAnswers = readAnswers(tenant?.onboardingAnswers);

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
      storedAnswers={storedAnswers}
      // Unknown, not empty: the read failed, or the stored answers have a
      // shape step 6 doesn't write. Step 6 must not overwrite them blind.
      answersUnknown={!tenant || (tenant.onboardingAnswers != null && storedAnswers === null)}
    />
  );
}

/** The saved questionnaire answers, only if they have the shape step 6 writes. */
function readAnswers(raw: unknown): StoredAnswers | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.size !== "string" || typeof a.referral !== "string") return null;
  if (!Array.isArray(a.goals) || !a.goals.every((g) => typeof g === "string")) return null;
  const other = typeof a.referralOther === "string" ? a.referralOther : null;
  return { size: a.size, goals: a.goals as string[], referral: a.referral, referralOther: other };
}
