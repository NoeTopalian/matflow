import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import SettingsPage from "@/components/dashboard/SettingsPage";
import { redirect } from "next/navigation";

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
  memberCount: number;
  staffCount: number;
  classCount: number;
  stripeConnected: boolean;
  stripeAccountId: string | null;
  acceptsBacs: boolean;
  memberSelfBilling: boolean;
  billingContactEmail: string | null;
  billingContactUrl: string | null;
  privacyContactEmail: string | null;
  privacyPolicyUrl: string | null;
  instagramUrl: string | null;
  facebookUrl: string | null;
  tiktokUrl: string | null;
  youtubeUrl: string | null;
  twitterUrl: string | null;
  websiteUrl: string | null;
  waiverTitle: string | null;
  waiverContent: string | null;
};

export type StaffMember = {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
};

async function getData(tenantId: string, userId: string) {
  const [tenant, staff, memberStats, currentUser] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      include: {
        _count: {
          select: {
            members: true,
            users: true,
            classes: { where: { isActive: true } },
          },
        },
      },
    }),
    prisma.user.findMany({
      where: { tenantId },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
      orderBy: [{ role: "asc" }, { name: "asc" }],
    }),
    prisma.member.groupBy({
      by: ["status"],
      where: { tenantId },
      _count: { status: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { totpEnabled: true },
    }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const s of memberStats) statusCounts[s.status] = s._count.status;

  return { tenant, staff, statusCounts, totpEnabled: currentUser?.totpEnabled ?? false };
}

export default async function Settings() {
  const session = await auth();
  if (!session) redirect("/login");
  if (session.user.role !== "owner") redirect("/dashboard");

  let settings: TenantSettings | null = null;
  let staff: StaffMember[] = [];
  let statusCounts: Record<string, number> = {};
  let totpEnabled = false;

  try {
    const { tenant, staff: staffRows, statusCounts: counts, totpEnabled: totp } = await getData(session.user.tenantId, session.user.id);
    totpEnabled = totp;
    settings = {
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
      memberSelfBilling: tenant.memberSelfBilling,
      billingContactEmail: tenant.billingContactEmail,
      billingContactUrl: tenant.billingContactUrl,
      privacyContactEmail: tenant.privacyContactEmail,
      privacyPolicyUrl: tenant.privacyPolicyUrl,
      instagramUrl: tenant.instagramUrl,
      facebookUrl: tenant.facebookUrl,
      tiktokUrl: tenant.tiktokUrl,
      youtubeUrl: tenant.youtubeUrl,
      twitterUrl: tenant.twitterUrl,
      websiteUrl: tenant.websiteUrl,
      waiverTitle: tenant.waiverTitle,
      waiverContent: tenant.waiverContent,
    };
    staff = staffRows.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() }));
    statusCounts = counts;
  } catch {
    // DB not connected
  }

  return (
    <SettingsPage
      settings={settings}
      staff={staff}
      statusCounts={statusCounts}
      primaryColor={session.user.primaryColor}
      role={session.user.role}
      currentUserId={session.user.id}
      totpEnabled={totpEnabled}
      stripeConnected={settings?.stripeConnected ?? false}
      stripeAccountId={settings?.stripeAccountId ?? null}
    />
  );
}
