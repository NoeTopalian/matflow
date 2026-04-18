import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import TimetableManager from "@/components/dashboard/TimetableManager";

export type ClassRow = {
  id: string;
  name: string;
  coachName: string | null;
  location: string | null;
  duration: number;
  maxCapacity: number | null;
  color: string | null;
  description: string | null;
  requiredRankId: string | null;
  requiredRank: { name: string; color: string | null; discipline: string } | null;
  schedules: {
    id: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
  }[];
};

async function getClasses(tenantId: string): Promise<ClassRow[]> {
  const rows = await prisma.class.findMany({
    where: { tenantId, isActive: true },
    include: {
      schedules: { where: { isActive: true }, orderBy: { dayOfWeek: "asc" } },
      requiredRank: true,
    },
    orderBy: { name: "asc" },
  });

  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    coachName: c.coachName,
    location: c.location,
    duration: c.duration,
    maxCapacity: c.maxCapacity,
    color: c.color,
    description: c.description,
    requiredRankId: c.requiredRankId,
    requiredRank: c.requiredRank
      ? { name: c.requiredRank.name, color: c.requiredRank.color, discipline: c.requiredRank.discipline }
      : null,
    schedules: c.schedules.map((s) => ({
      id: s.id,
      dayOfWeek: s.dayOfWeek,
      startTime: s.startTime,
      endTime: s.endTime,
    })),
  }));
}

async function getRankSystems(tenantId: string) {
  return prisma.rankSystem.findMany({
    where: { tenantId },
    orderBy: [{ discipline: "asc" }, { order: "asc" }],
  });
}

export default async function TimetablePage() {
  const session = await auth();

  let classes: ClassRow[] = [];
  let rankSystems: Awaited<ReturnType<typeof getRankSystems>> = [];

  try {
    [classes, rankSystems] = await Promise.all([
      getClasses(session!.user.tenantId),
      getRankSystems(session!.user.tenantId),
    ]);
  } catch {
    // DB not connected — empty state shown
  }

  return (
    <TimetableManager
      initialClasses={classes}
      rankSystems={rankSystems.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        discipline: r.discipline,
      }))}
      primaryColor={session!.user.primaryColor}
      role={session!.user.role}
    />
  );
}
