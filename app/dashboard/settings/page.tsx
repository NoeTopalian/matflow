import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import SettingsPage from "@/components/dashboard/SettingsPage";

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
};

export type StaffMember = {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
};

async function getData(tenantId: string) {
  const [tenant, staff, memberStats] = await Promise.all([
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
  ]);

  const statusCounts: Record<string, number> = {};
  for (const s of memberStats) statusCounts[s.status] = s._count.status;

  return { tenant, staff, statusCounts };
}

export default async function Settings() {
  const session = await auth();

  let settings: TenantSettings | null = null;
  let staff: StaffMember[] = [];
  let statusCounts: Record<string, number> = {};

  try {
    const { tenant, staff: staffRows, statusCounts: counts } = await getData(session!.user.tenantId);
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
      primaryColor={session!.user.primaryColor}
      role={session!.user.role}
      currentUserId={session!.user.id}
    />
  );
}
