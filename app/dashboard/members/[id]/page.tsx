import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import MemberProfile, { MemberDetail, MembershipTierOption, RankOption } from "@/components/dashboard/MemberProfile";
import OwnerFamilyManagement, {
  FamilyChildSummary,
  FamilyParentSummary,
} from "@/components/dashboard/OwnerFamilyManagement";

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
            include: {
              class: {
                select: {
                  name: true,
                  coachName: true,
                  location: true,
                },
              },
            },
          },
        },
        orderBy: { checkInTime: "desc" },
        take: 50,
      },
      subscriptions: {
        include: {
          class: {
            select: {
              id: true,
              name: true,
              coachName: true,
              location: true,
              schedules: {
                where: { isActive: true },
                select: {
                  dayOfWeek: true,
                  startTime: true,
                  endTime: true,
                },
                orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
              },
            },
          },
        },
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
    emergencyContactRelation: m.emergencyContactRelation ?? null,
    medicalConditions: m.medicalConditions ?? null,
    dateOfBirth: m.dateOfBirth ? m.dateOfBirth.toISOString() : null,
    waiverAccepted: m.waiverAccepted,
    waiverAcceptedAt: m.waiverAcceptedAt ? m.waiverAcceptedAt.toISOString() : null,
    subscriptions: m.subscriptions
      .map((s) => ({
        id: s.id,
        classId: s.classId,
        className: s.class.name,
        coachName: s.class.coachName ?? null,
        location: s.class.location ?? null,
        createdAt: s.createdAt.toISOString(),
        schedules: s.class.schedules.map((schedule) => ({
          dayOfWeek: schedule.dayOfWeek,
          startTime: schedule.startTime,
          endTime: schedule.endTime,
        })),
      }))
      .sort((a, b) => a.className.localeCompare(b.className)),
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
      startTime: a.classInstance.startTime,
      endTime: a.classInstance.endTime,
      checkInTime: a.checkInTime.toISOString(),
      method: a.checkInMethod,
      coachName: a.classInstance.class.coachName ?? null,
      location: a.classInstance.class.location ?? null,
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

async function getFamily(memberId: string, tenantId: string): Promise<{
  parent: FamilyParentSummary | null;
  children: FamilyChildSummary[];
  hasKidsHint: boolean;
}> {
  const m = await prisma.member.findFirst({
    where: { id: memberId, tenantId },
    select: {
      hasKidsHint: true,
      parent: { select: { id: true, name: true } },
      children: {
        select: {
          id: true,
          name: true,
          accountType: true,
          dateOfBirth: true,
          waiverAccepted: true,
        },
        orderBy: { name: "asc" },
      },
    },
  });
  if (!m) return { parent: null, children: [], hasKidsHint: false };
  return {
    hasKidsHint: m.hasKidsHint,
    parent: m.parent ? { id: m.parent.id, name: m.parent.name } : null,
    children: m.children.map((c) => ({
      id: c.id,
      name: c.name,
      accountType: c.accountType ?? null,
      dateOfBirth: c.dateOfBirth ? c.dateOfBirth.toISOString() : null,
      waiverAccepted: c.waiverAccepted,
    })),
  };
}

export default async function MemberProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { session } = await requireStaff();
  const { id } = await params;

  let member: MemberDetail | null = null;
  let rankOptions: RankOption[] = [];
  let tiers: MembershipTierOption[] = [];
  let family: { parent: FamilyParentSummary | null; children: FamilyChildSummary[]; hasKidsHint: boolean } = {
    parent: null,
    children: [],
    hasKidsHint: false,
  };

  try {
    [member, rankOptions, tiers, family] = await Promise.all([
      getMember(id, session!.user.tenantId),
      getRankOptions(session!.user.tenantId),
      getMembershipTiers(session!.user.tenantId),
      getFamily(id, session!.user.tenantId),
    ]);
  } catch {
    // DB not connected
  }

  if (!member) notFound();

  return (
    <>
      {/* MemberProfile first — the page should open with the member you clicked,
          not with the family management panel. The family panel is supplementary
          context and lives below the member detail. */}
      <MemberProfile
        member={member}
        rankOptions={rankOptions}
        tiers={tiers}
        primaryColor={session!.user.primaryColor}
        role={session!.user.role}
        tenantSlug={session!.user.tenantSlug}
      />
      <OwnerFamilyManagement
        memberId={member.id}
        memberName={member.name}
        hasKidsHint={family.hasKidsHint}
        parent={family.parent}
        initialChildren={family.children}
        primaryColor={session!.user.primaryColor}
        role={session!.user.role}
      />
    </>
  );
}
