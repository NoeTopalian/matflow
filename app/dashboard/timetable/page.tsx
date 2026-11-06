import type { Prisma } from "@prisma/client";
import { requireStaff } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import TimetableManager from "@/components/dashboard/TimetableManager";
import { classLifecycle, inactiveClassWhere, liveClassWhere, type ClassLifecycle } from "@/lib/class-live";
import { legacyArchivedAt } from "@/lib/class-lifecycle";
import { readMatsForTimetable } from "@/lib/mats-store";

type Tx = Prisma.TransactionClient;

export type ClassRow = {
  id: string;
  name: string;
  coachName: string | null;
  coachUserId: string | null;
  coachUser: { id: string; name: string } | null;
  location: string | null;
  /** ADR-001 D2: the venue; null = every location of the club. */
  locationId: string | null;
  /** The mat the class runs on; null/absent = no mat. On a mat, `location` is that mat's name. */
  matId?: string | null;
  duration: number | null;
  maxCapacity: number | null;
  /** A kids class: adults are refused at self/kiosk check-in and asked about on the register. */
  isKids?: boolean;
  /** T6c: a key from lib/class-category.ts; null/absent = uncategorised. */
  category?: string | null;
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
  /** T6d: `name` lets the picker show a rostered guardian account it no longer lists. */
  roster?: { memberId: string; name?: string }[];
  /** T6a: memberships that include the class. [] = everyone. */
  allowedTiers?: { id: string; name: string; isActive: boolean }[];
  /** T6b: "active" on the timetable; "paused" / "archived" in the Paused and archived section. */
  lifecycle?: ClassLifecycle;
  /** T6b: when it was archived (ISO), for the archived list. */
  archivedAt?: string | null;
};

/** T6a: a membership the class form can offer under "Who can attend". */
export type TierOption = { id: string; name: string; isActive: boolean };

export type CoachUserOption = { id: string; name: string; role: string };

/** One of the club's mats, in the club's order (the order of the columns). */
export type MatOption = { id: string; name: string };

/**
 * `live`: the classes on the timetable (T6b `liveClassWhere`; RULES §5, the
 * soft-delete column is filtered). `inactive`: the paused and archived classes
 * for the "Paused and archived" section, imported history excepted. Both
 * carry the same fields, roster included, so Resume / Restore can put the row
 * straight back on the timetable and its edit form cannot wipe a roster.
 */
async function getClasses(tx: Tx, tenantId: string, which: "live" | "inactive" = "live"): Promise<ClassRow[]> {
  const { rows, legacy } = await (async () => {
    const found = await tx.class.findMany({
      where: which === "live" ? liveClassWhere(tenantId) : inactiveClassWhere(tenantId),
      include: {
        schedules: { where: { isActive: true }, orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] },
        requiredRank: true,
        maxRank: true,
        coachUser: { select: { id: true, name: true } },
        // Without this the ClassRow handed to TimetableManager always had
        // `roster: undefined`, so the edit form initialised useRoster=false for
        // EVERY class, submitted `requiredRankId: null, maxRankId: null`, and
        // the PATCH route read those present-but-null keys as "set a rank gate"
        // and deleted the roster. Renaming a comp class converted it into an
        // open class. Both ends are fixed; this is the read end.
        rosterMembers: { select: { memberId: true, member: { select: { name: true } } } },
        allowedTiers: { select: { tier: { select: { id: true, name: true, isActive: true } } } },
      },
      orderBy: { name: "asc" },
    });
    // Classes archived before T6b look paused (isActive false, no deletedAt):
    // read them as the archive they were (lib/class-lifecycle#legacyArchivedAt).
    const pausedIds = which === "inactive" ? found.filter((c) => classLifecycle(c) === "paused").map((c) => c.id) : [];
    const legacyMap = pausedIds.length > 0 ? await legacyArchivedAt(tx, tenantId, pausedIds) : new Map<string, Date>();
    return { rows: found, legacy: legacyMap };
  })();

  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    coachName: c.coachName,
    coachUserId: c.coachUserId,
    coachUser: c.coachUser ? { id: c.coachUser.id, name: c.coachUser.name } : null,
    location: c.location,
    locationId: c.locationId,
    matId: c.matId,
    duration: c.duration,
    maxCapacity: c.maxCapacity,
    isKids: c.isKids,
    category: c.category,
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
    roster: c.rosterMembers.map((r) => ({ memberId: r.memberId, name: r.member?.name })),
    allowedTiers: (c.allowedTiers ?? []).map((t) => t.tier),
    lifecycle: legacy.has(c.id) ? "archived" : classLifecycle(c),
    archivedAt: c.deletedAt ? c.deletedAt.toISOString() : (legacy.get(c.id)?.toISOString() ?? null),
  }));
}

function getTiers(tx: Tx, tenantId: string): Promise<TierOption[]> {
  return tx.membershipTier.findMany({
    where: { tenantId },
    select: { id: true, name: true, isActive: true },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
}

function getRankSystems(tx: Tx, tenantId: string) {
  return tx.rankSystem.findMany({
    where: { tenantId },
    orderBy: [{ discipline: "asc" }, { order: "asc" }],
  });
}

function getCoachUsers(tx: Tx, tenantId: string): Promise<CoachUserOption[]> {
  return tx.user.findMany({
    where: { tenantId, role: { in: ["owner", "manager", "coach", "admin"] } },
    select: { id: true, name: true, role: true },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
}

/**
 * Everything the page reads, in ONE tenant transaction with the reads one
 * after another (S3, 6 Nov 2026). It used to open six transactions at once,
 * more than the pool of five connections per instance (lib/prisma.ts).
 */
async function loadTimetable(tenantId: string) {
  return withTenantContext(tenantId, async (tx) => {
    const classes = await getClasses(tx, tenantId);
    const rankSystems = await getRankSystems(tx, tenantId);
    const coachUsers = await getCoachUsers(tx, tenantId);
    const membershipTiers = await getTiers(tx, tenantId);
    const inactiveClasses = await getClasses(tx, tenantId, "inactive");
    // Guarded on purpose (lib/mats-store.ts): the one read here that may fail without failing the page. It runs last,
    // behind a savepoint, so a failed mats statement cannot abort the class reads above.
    const matsAndLayout = await readMatsForTimetable(tx, tenantId);
    return { classes, rankSystems, coachUsers, membershipTiers, inactiveClasses, matsAndLayout };
  });
}

export default async function TimetablePage() {
  const { session } = await requireStaff();

  // UI-RULES §7: unguarded. An empty timetable used to be the failure mode as
  // well as the genuine state, so an outage looked like a gym that runs no
  // classes — and invited someone to rebuild a schedule that already exists.
  const { classes, rankSystems, coachUsers, membershipTiers, inactiveClasses, matsAndLayout } = await loadTimetable(
    session!.user.tenantId,
  );

  return (
    <TimetableManager
      initialClasses={classes}
      initialInactiveClasses={inactiveClasses}
      rankSystems={rankSystems.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        discipline: r.discipline,
      }))}
      coachUsers={coachUsers}
      membershipTiers={membershipTiers}
      mats={matsAndLayout.mats}
      storedLayout={matsAndLayout.storedLayout}
      matsLoadFailed={matsAndLayout.failed}
      // A MatFlow support session can put a class on a mat, but cannot set up mats or change the split.
      supportSession={typeof (session!.user as { impersonatedBy?: unknown }).impersonatedBy === "string"}
      primaryColor={session!.user.primaryColor}
      role={session!.user.role}
      currentUserId={session!.user.id}
    />
  );
}
