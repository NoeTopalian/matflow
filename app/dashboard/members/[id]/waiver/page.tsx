import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { buildDefaultWaiverTitle, buildDefaultWaiverContent } from "@/lib/default-waiver";
import SupervisedWaiverPage from "@/components/dashboard/SupervisedWaiverPage";

export default async function WaiverPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, tenantId } = await requireStaff();
  const { id: memberId } = await params;

  // Tenant-scope enforcement: never bare findUnique
  const member = await prisma.member.findFirst({
    where: { id: memberId, tenantId },
    select: {
      id: true,
      name: true,
      emergencyContactName: true,
      emergencyContactPhone: true,
      emergencyContactRelation: true,
    },
  });
  if (!member) notFound();

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, waiverTitle: true, waiverContent: true, primaryColor: true },
  });

  const tenantName = tenant?.name ?? "Your Gym";
  const waiverTitle = tenant?.waiverTitle ?? buildDefaultWaiverTitle(tenantName);
  const waiverContent = tenant?.waiverContent ?? buildDefaultWaiverContent(tenantName);
  const primaryColor = (tenant as { primaryColor?: string | null } | null)?.primaryColor ?? session.user.primaryColor ?? "#6366f1";
  const ownerName = session.user.name ?? "Staff";

  return (
    <SupervisedWaiverPage
      memberId={member.id}
      memberName={member.name}
      tenantName={tenantName}
      waiverTitle={waiverTitle}
      waiverContent={waiverContent}
      primaryColor={primaryColor}
      ownerName={ownerName}
      emergencyContactName={member.emergencyContactName ?? ""}
      emergencyContactPhone={member.emergencyContactPhone ?? ""}
      emergencyContactRelation={member.emergencyContactRelation ?? ""}
    />
  );
}
