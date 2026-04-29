import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import MemberProfile, { MemberDetail, MembershipTierOption, RankOption } from "@/components/dashboard/MemberProfile";

async function getMember(memberId: string, tenantId: string): Promise<MemberDetail | null> {
  const m = await prisma.member.findFirst({
    where: { id: memberId, tenantId },
    include: {
      memberRanks: {
        include: { rankSystem: true },
        orderBy: { achievedAt: "desc" },
      },
      attendances: {
        include: {
          classInstance: {
            include: { class: { select: { name: true } } },
          },
        },
        orderBy: { checkInTime: "desc" },
        take: 50,
      },
      subscriptions: {
        include: { class: { select: { id: true, name: true, coachName: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!m) return null;

  return {
    id: m.id,
    name: m.name,
    email: m.email,
    phone: m.phone ?? null,
    membershipType: m.membershipType ?? null,
    status: m.status,
    paymentStatus: m.paymentStatus,
    notes: m.notes ?? null,
    joinedAt: m.joinedAt.toISOString(),
    emergencyContactName: m.emergencyContactName ?? null,
    emergencyContactPhone: m.emergencyContactPhone ?? null,
    medicalConditions: m.medicalConditions ?? null,
    dateOfBirth: m.dateOfBirth ? m.dateOfBirth.toISOString() : null,
    waiverAccepted: m.waiverAccepted,
    waiverAcceptedAt: m.waiverAcceptedAt ? m.waiverAcceptedAt.toISOString() : null,
    subscriptions: m.subscriptions.map((s) => ({
      id: s.id,
      classId: s.classId,
      className: s.class.name,
      coachName: s.class.coachName ?? null,
    })),
    ranks: m.memberRanks.map((r) => ({
      id: r.id,
      rankSystemId: r.rankSystemId,
      discipline: r.rankSystem.discipline,
      rankName: r.rankSystem.name,
      color: r.rankSystem.color ?? "#888888",
      stripes: r.stripes,
      achievedAt: r.achievedAt.toISOString(),
    })),
    attendances: m.attendances.map((a) => ({
      id: a.id,
      className: a.classInstance.class.name,
      date: a.classInstance.date.toISOString().split("T")[0],
      checkInTime: a.checkInTime.toISOString(),
      method: a.checkInMethod,
    })),
  };
}

async function getRankOptions(tenantId: string): Promise<RankOption[]> {
  const ranks = await prisma.rankSystem.findMany({
    where: { tenantId },
    orderBy: [{ discipline: "asc" }, { order: "asc" }],
  });
  return ranks.map((r) => ({
    id: r.id,
    discipline: r.discipline,
    name: r.name,
    color: r.color ?? "#888888",
    order: r.order,
  }));
}

async function getMembershipTiers(tenantId: string): Promise<MembershipTierOption[]> {
  const tiers = await prisma.membershipTier.findMany({
    where: { tenantId, isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  return tiers;
}

export default async function MemberProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { session } = await requireStaff();
  const { id } = await params;

  let member: MemberDetail | null = null;
  let rankOptions: RankOption[] = [];
  let tiers: MembershipTierOption[] = [];

  try {
    [member, rankOptions, tiers] = await Promise.all([
      getMember(id, session!.user.tenantId),
      getRankOptions(session!.user.tenantId),
      getMembershipTiers(session!.user.tenantId),
    ]);
  } catch {
    // DB not connected
  }

  if (!member) notFound();

  return (
    <MemberProfile
      member={member}
      rankOptions={rankOptions}
      tiers={tiers}
      primaryColor={session!.user.primaryColor}
      role={session!.user.role}
      tenantSlug={session!.user.tenantSlug}
    />
  );
}
