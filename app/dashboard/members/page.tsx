import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import MembersList, { MemberRow } from "@/components/dashboard/MembersList";

async function getMembers(tenantId: string): Promise<MemberRow[]> {
  const rows = await prisma.member.findMany({
    where: { tenantId },
    include: {
      memberRanks: {
        include: { rankSystem: true },
        orderBy: { achievedAt: "desc" },
        take: 1,
      },
    },
    orderBy: { name: "asc" },
  });

  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    phone: m.phone,
    membershipType: m.membershipType,
    status: m.status,
    accountType: (m as any).accountType ?? "adult",
    dateOfBirth: m.dateOfBirth ? m.dateOfBirth.toISOString() : null,
    joinedAt: m.joinedAt.toISOString(),
    rank: m.memberRanks[0]
      ? {
          name: m.memberRanks[0].rankSystem.name,
          color: m.memberRanks[0].rankSystem.color,
          discipline: m.memberRanks[0].rankSystem.discipline,
          stripes: m.memberRanks[0].stripes,
        }
      : null,
  }));
}

export default async function MembersPage() {
  const { session } = await requireStaff();

  let members: MemberRow[] = [];
  try {
    members = await getMembers(session!.user.tenantId);
  } catch {
    // DB not yet connected — empty state shown
  }

  return (
    <MembersList
      members={members}
      primaryColor={session!.user.primaryColor}
      role={session!.user.role}
    />
  );
}
