import type { Prisma } from "@prisma/client";

type TxClient = Prisma.TransactionClient;

export type SetupGap = { label: string; href: string };

/**
 * Wizard v2 SetupBanner support: detect setup gaps for owner accounts that
 * skipped wizard steps. Returns the list of remaining items with deep links.
 * Empty array = banner hidden.
 *
 * Every link opens the page that does the job. Onboarding batch 1 (16 Oct
 * 2026): "Connect Stripe" and "Add your first members" used to send a set-up
 * club back through the whole wizard via /onboarding?resume=1.
 */
export async function getSetupGaps(tx: TxClient, tenantId: string, role: string): Promise<SetupGap[]> {
  if (role !== "owner") return [];
  const [tenant, tierCount, classCount, memberCount] = await Promise.all([
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeConnected: true, onboardingCompleted: true, contactEmail: true, billingContactEmail: true },
    }),
    tx.membershipTier.count({ where: { tenantId } }),
    tx.class.count({ where: { tenantId, deletedAt: null } }),
    tx.member.count({ where: { tenantId } }),
  ]);

  // Don't show the banner until the wizard has been completed at least once
  // — otherwise we'd be nudging a user who is mid-onboarding.
  if (!tenant?.onboardingCompleted) return [];

  const gaps: SetupGap[] = [];
  if (!tenant.stripeConnected) {
    gaps.push({ label: "Connect Stripe", href: "/dashboard/settings?tab=revenue" });
  }
  if (tierCount === 0) {
    gaps.push({ label: "Add a membership tier", href: "/dashboard/memberships" });
  }
  if (classCount === 0) {
    gaps.push({ label: "Schedule a class", href: "/dashboard/timetable" });
  }
  if (memberCount === 0) {
    gaps.push({ label: "Add your first members", href: "/dashboard/settings?tab=import" });
  }
  // The club's public address (1 Oct 2026): until it is set, members have no
  // one to write to and their replies to receipts go nowhere.
  if (!tenant.contactEmail && !tenant.billingContactEmail) {
    gaps.push({ label: "Add your club's contact email so members can reach you", href: "/dashboard/settings" });
  }
  return gaps;
}
