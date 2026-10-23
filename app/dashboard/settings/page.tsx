import { withTenantContext } from "@/lib/prisma-tenant";
import SettingsPage from "@/components/dashboard/SettingsPage";
import { requireRole } from "@/lib/authz";
import { ACTIVE_MEMBER, CURRENT_MEMBER, GUARDIAN_ACCOUNT, ON_HOLD, TRAINING_MEMBER } from "@/lib/member-population";

export type TenantSettings = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  logoSize: string;
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  subscriptionStatus: string;
  subscriptionTier: string;
  createdAt: string;
  /** Active training members (lib/member-population.ts ACTIVE_MEMBER) — never guardians. */
  memberCount: number;
  staffCount: number;
  classCount: number;
  stripeConnected: boolean;
  stripeAccountId: string | null;
  acceptsBacs: boolean;
  paymentRail: string | null;
  memberSelfBilling: boolean;
  billingContactEmail: string | null;
  /** The club's public contact address (1 Oct 2026). Not a login. */
  contactEmail: string | null;
  billingContactUrl: string | null;
  privacyContactEmail: string | null;
  privacyPolicyUrl: string | null;
  instagramUrl: string | null;
  facebookUrl: string | null;
  tiktokUrl: string | null;
  youtubeUrl: string | null;
  twitterUrl: string | null;
  websiteUrl: string | null;
  groupChatUrl: string | null;
  waiverTitle: string | null;
  waiverContent: string | null;
  kidsWaiverTitle: string | null;
  kidsWaiverContent: string | null;
  checkinWindowBeforeMin: number;
  checkinWindowAfterMin: number;
};

export type StaffMember = {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  /** ISO time a brute-force lockout ends; null when not locked (or expired). */
  lockedUntil?: string | null;
  /** Whether they have enrolled an authenticator — the owner can reset it (1 Oct 2026). */
  totpEnabled?: boolean;
};

/**
 * Population counts shown beside the status rows (T1, 17 Oct 2026). A hold is
 * the billing axis (paymentStatus "paused"), never a status row; guardian
 * accounts are not members and are counted under their own label.
 */
/**
 * onHold: current members on hold (any status). activeOnHold: the part of
 * "Active members" that is on hold, which the tile marks (Q4 A-1).
 */
export type SettingsPopulationCounts = { onHold: number; guardians: number; activeOnHold?: number };

async function getData(tenantId: string, userId: string) {
  const [tenant, staff, memberStats, currentUser, onHold, guardians, activeOnHold] = await withTenantContext(tenantId, (tx) =>
    Promise.all([
      tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        include: {
          _count: {
            select: {
              members: { where: { ...ACTIVE_MEMBER } },
              users: true,
              classes: { where: { isActive: true } },
            },
          },
        },
      }),
      tx.user.findMany({
        where: { tenantId },
        select: { id: true, name: true, email: true, role: true, createdAt: true, lockedUntil: true, totpEnabled: true },
        orderBy: [{ role: "asc" }, { name: "asc" }],
      }),
      tx.member.groupBy({
        by: ["status"],
        where: { tenantId, ...TRAINING_MEMBER },
        _count: { status: true },
      }),
      tx.user.findUnique({
        where: { id: userId },
        select: { totpEnabled: true },
      }),
      tx.member.count({ where: { tenantId, ...CURRENT_MEMBER, ...ON_HOLD } }),
      tx.member.count({ where: { tenantId, ...GUARDIAN_ACCOUNT, status: { not: "cancelled" } } }),
      tx.member.count({ where: { tenantId, ...ACTIVE_MEMBER, ...ON_HOLD } }),
    ]),
  );

  const statusCounts: Record<string, number> = {};
  for (const s of memberStats) statusCounts[s.status] = s._count.status;

  const populationCounts: SettingsPopulationCounts = { onHold, guardians, activeOnHold };

  return { tenant, staff, statusCounts, populationCounts, totpEnabled: currentUser?.totpEnabled ?? false };
}

export default async function Settings() {
  // Audit iter-1-dashboard A4C-3: use centralised authz helper.
  const { session } = await requireRole(["owner"]);

  // UI-RULES §7: unguarded on purpose, and this page was the most dangerous of
  // the twelve. Catching left `settings` null, so the settings form rendered
  // blank and default values — an owner who pressed Save on that would
  // overwrite real configuration (waiver text, branding, billing contacts,
  // check-in windows) with defaults, turning a read failure into data loss.
  // A throw now reaches app/dashboard/error.tsx and there is no form to save.
  const { tenant, staff: staffRows, statusCounts, populationCounts, totpEnabled } = await getData(
    session.user.tenantId,
    session.user.id,
  );

  const settings: TenantSettings = {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    logoUrl: tenant.logoUrl,
    logoSize: tenant.logoSize,
    primaryColor: tenant.primaryColor,
    secondaryColor: tenant.secondaryColor,
    textColor: tenant.textColor,
    subscriptionStatus: tenant.subscriptionStatus,
    subscriptionTier: tenant.subscriptionTier,
    createdAt: tenant.createdAt.toISOString(),
    memberCount: tenant._count.members,
    staffCount: tenant._count.users,
    classCount: tenant._count.classes,
    stripeConnected: tenant.stripeConnected,
    stripeAccountId: tenant.stripeAccountId,
    acceptsBacs: tenant.acceptsBacs,
    paymentRail: tenant.paymentRail,
    memberSelfBilling: tenant.memberSelfBilling,
    billingContactEmail: tenant.billingContactEmail,
    contactEmail: tenant.contactEmail,
    billingContactUrl: tenant.billingContactUrl,
    privacyContactEmail: tenant.privacyContactEmail,
    privacyPolicyUrl: tenant.privacyPolicyUrl,
    instagramUrl: tenant.instagramUrl,
    facebookUrl: tenant.facebookUrl,
    tiktokUrl: tenant.tiktokUrl,
    youtubeUrl: tenant.youtubeUrl,
    twitterUrl: tenant.twitterUrl,
    websiteUrl: tenant.websiteUrl,
    groupChatUrl: tenant.groupChatUrl,
    waiverTitle: tenant.waiverTitle,
    waiverContent: tenant.waiverContent,
    kidsWaiverTitle: tenant.kidsWaiverTitle,
    kidsWaiverContent: tenant.kidsWaiverContent,
    checkinWindowBeforeMin: tenant.checkinWindowBeforeMin,
    checkinWindowAfterMin: tenant.checkinWindowAfterMin,
  };

  const now = new Date();
  const staff: StaffMember[] = staffRows.map((s) => ({
    ...s,
    createdAt: s.createdAt.toISOString(),
    // Only a live lockout reaches the client; an expired one is not a state.
    lockedUntil: s.lockedUntil && s.lockedUntil > now ? s.lockedUntil.toISOString() : null,
  }));

  return (
    <SettingsPage
      settings={settings}
      staff={staff}
      statusCounts={statusCounts}
      populationCounts={populationCounts}
      primaryColor={session.user.primaryColor}
      role={session.user.role}
      currentUserId={session.user.id}
      totpEnabled={totpEnabled}
      stripeConnected={settings.stripeConnected}
      stripeAccountId={settings.stripeAccountId}
      supportScope={(session.user as { supportScope?: "view" | "edit" }).supportScope ?? null}
    />
  );
}
