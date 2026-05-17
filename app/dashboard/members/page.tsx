import { requireStaff } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import MembersList, { MemberRow } from "@/components/dashboard/MembersList";

async function getMembers(tenantId: string): Promise<MemberRow[]> {
  const rows = await withTenantContext(tenantId, (tx) =>
    tx.member.findMany({
      where: { tenantId },
      // Explicit select to skip the wide columns (passwordHash, sessionVersion,
      // totpSecret, medicalConditions, etc.) that this page never renders.
      // Cuts the row payload from Postgres -> Node by ~60-80% on this hot path.
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        membershipType: true,
        status: true,
        paymentStatus: true,
        waiverAccepted: true,
        accountType: true,
        dateOfBirth: true,
        parentMemberId: true,
        hasKidsHint: true,
        joinedAt: true,
        memberRanks: {
          select: {
            stripes: true,
            rankSystem: { select: { name: true, color: true, discipline: true } },
          },
          orderBy: { achievedAt: "desc" },
          take: 1,
        },
        attendances: {
          orderBy: { checkInTime: "desc" },
          take: 1,
          select: { checkInTime: true },
        },
      },
      orderBy: { name: "asc" },
    }),
  );

  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    phone: m.phone,
    membershipType: m.membershipType,
    status: m.status,
    paymentStatus: m.paymentStatus,
    waiverAccepted: m.waiverAccepted,
    accountType: m.accountType ?? "adult",
    dateOfBirth: m.dateOfBirth ? m.dateOfBirth.toISOString() : null,
    parentMemberId: m.parentMemberId,
    hasKidsHint: m.hasKidsHint,
    joinedAt: m.joinedAt.toISOString(),
    lastVisitAt: m.attendances[0]?.checkInTime.toISOString() ?? null,
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
