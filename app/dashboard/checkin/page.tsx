import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import AdminCheckin from "@/components/dashboard/AdminCheckin";

export type CheckinClassInstance = {
  id: string;
  name: string;
  coachName: string | null;
  location: string | null;
  startTime: string;
  endTime: string;
  maxCapacity: number | null;
  color: string | null;
};

export type CheckinMember = {
  id: string;
  name: string;
  membershipType: string | null;
  rankName: string | null;
  rankColor: string | null;
  checkedIn: boolean;
};

async function getTodayInstances(tenantId: string): Promise<CheckinClassInstance[]> {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(now); end.setHours(23, 59, 59, 999);

  const instances = await prisma.classInstance.findMany({
    where: {
      class: { tenantId },
      date: { gte: start, lte: end },
      isCancelled: false,
    },
    include: { class: true },
    orderBy: { startTime: "asc" },
  });

  return instances.map((inst) => ({
    id: inst.id,
    name: inst.class.name,
    coachName: inst.class.coachName,
    location: inst.class.location,
    startTime: inst.startTime,
    endTime: inst.endTime,
    maxCapacity: inst.class.maxCapacity,
    color: inst.class.color,
  }));
}

async function getMembersForInstance(instanceId: string, tenantId: string): Promise<CheckinMember[]> {
  const [members, attendances] = await Promise.all([
    prisma.member.findMany({
      where: { tenantId, status: { in: ["active", "taster"] } },
      include: {
        memberRanks: {
          include: { rankSystem: true },
          orderBy: { achievedAt: "desc" },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.attendanceRecord.findMany({
      where: { classInstanceId: instanceId },
      select: { memberId: true },
    }),
  ]);

  const checkedInIds = new Set(attendances.map((a) => a.memberId));

  return members.map((m) => ({
    id: m.id,
    name: m.name,
    membershipType: m.membershipType,
    rankName: m.memberRanks[0]?.rankSystem.name ?? null,
    rankColor: m.memberRanks[0]?.rankSystem.color ?? null,
    checkedIn: checkedInIds.has(m.id),
  }));
}

export default async function CheckinPage() {
  const session = await auth();

  let instances: CheckinClassInstance[] = [];
  let initialMembers: CheckinMember[] = [];
  let initialInstanceId: string | null = null;

  try {
    instances = await getTodayInstances(session!.user.tenantId);
    if (instances.length > 0) {
      initialInstanceId = instances[0].id;
      initialMembers = await getMembersForInstance(instances[0].id, session!.user.tenantId);
    }
  } catch {
    // DB not connected
  }

  return (
    <AdminCheckin
      instances={instances}
      initialInstanceId={initialInstanceId}
      initialMembers={initialMembers}
      primaryColor={session!.user.primaryColor}
      tenantSlug={session!.user.tenantSlug}
    />
  );
}
