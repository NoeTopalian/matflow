import { requireStaff } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import TimetableManager from "@/components/dashboard/TimetableManager";

export type ClassRow = {
  id: string;
  name: string;
  coachName: string | null;
  coachUserId: string | null;
  coachUser: { id: string; name: string } | null;
  location: string | null;
  duration: number;
  maxCapacity: number | null;
  color: string | null;
  description: string | null;
  requiredRankId: string | null;
  requiredRank: { name: string; color: string | null; discipline: string } | null;
  maxRankId: string | null;
  maxRank: { name: string; color: string | null; discipline: string } | null;
  schedules: {
    id: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
  }[];
  roster?: { memberId: string }[];
};

export type CoachUserOption = { id: string; name: string; role: string };

async function getClasses(tenantId: string): Promise<ClassRow[]> {
  const rows = await withTenantContext(tenantId, (tx) =>
    tx.class.findMany({
      // RULES §5: soft-delete columns must be filtered by every reader.
      where: { tenantId, isActive: true, deletedAt: null },
      include: {
        schedules: { where: { isActive: true }, orderBy: { dayOfWeek: "asc" } },
        requiredRank: true,
        maxRank: true,
        coachUser: { select: { id: true, name: true } },
        // Without this the ClassRow handed to TimetableManager always had
        // `roster: undefined`, so the edit form initialised useRoster=false for
        // EVERY class, submitted `requiredRankId: null, maxRankId: null`, and
        // the PATCH route read those present-but-null keys as "set a rank gate"
        // and deleted the roster. Renaming a comp class converted it into an
        // open class. Both ends are fixed; this is the read end.
        rosterMembers: { select: { memberId: true } },
      },
      orderBy: { name: "asc" },
    }),
  );

  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    coachName: c.coachName,
    coachUserId: c.coachUserId,
    coachUser: c.coachUser ? { id: c.coachUser.id, name: c.coachUser.name } : null,
    location: c.location,
    duration: c.duration,
    maxCapacity: c.maxCapacity,
    color: c.color,
    description: c.description,
    requiredRankId: c.requiredRankId,
    requiredRank: c.requiredRank
      ? { name: c.requiredRank.name, color: c.requiredRank.color, discipline: c.requiredRank.discipline }
      : null,
    maxRankId: c.maxRankId,
    maxRank: c.maxRank
      ? { name: c.maxRank.name, color: c.maxRank.color, discipline: c.maxRank.discipline }
      : null,
    schedules: c.schedules.map((s) => ({
      id: s.id,
      dayOfWeek: s.dayOfWeek,
      startTime: s.startTime,
      endTime: s.endTime,
    })),
    roster: c.rosterMembers.map((r) => ({ memberId: r.memberId })),
  }));
}

async function getRankSystems(tenantId: string) {
  return withTenantContext(tenantId, (tx) =>
    tx.rankSystem.findMany({
      where: { tenantId },
      orderBy: [{ discipline: "asc" }, { order: "asc" }],
    }),
  );
}

async function getCoachUsers(tenantId: string): Promise<CoachUserOption[]> {
  return withTenantContext(tenantId, (tx) =>
    tx.user.findMany({
      where: { tenantId, role: { in: ["owner", "manager", "coach", "admin"] } },
      select: { id: true, name: true, role: true },
      orderBy: [{ role: "asc" }, { name: "asc" }],
    }),
  );
}

export default async function TimetablePage() {
  const { session } = await requireStaff();

  // UI-RULES §7: unguarded. An empty timetable used to be the failure mode as
  // well as the genuine state, so an outage looked like a gym that runs no
  // classes — and invited someone to rebuild a schedule that already exists.
  const [classes, rankSystems, coachUsers] = await Promise.all([
    getClasses(session!.user.tenantId),
    getRankSystems(session!.user.tenantId),
    getCoachUsers(session!.user.tenantId),
  ]);

  return (
    <TimetableManager
      initialClasses={classes}
      rankSystems={rankSystems.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        discipline: r.discipline,
      }))}
      coachUsers={coachUsers}
      primaryColor={session!.user.primaryColor}
      role={session!.user.role}
      currentUserId={session!.user.id}
    />
  );
}
