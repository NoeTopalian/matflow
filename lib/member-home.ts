/**
 * Shared data-assembly helpers for the member home screen.
 *
 * Audit Lane 4 A15: app/member/home/page.tsx fired 4 separate mount-time
 * fetches (/api/member/me, /api/member/schedule, /api/member/me/children,
 * /api/announcements) — 4 serverless invocations + 4 DB transactions per app
 * open. These helpers hold the exact query/shaping logic each of those
 * routes already used, so /api/member/home can run all four inside ONE
 * withTenantContext transaction while the original standalone routes (still
 * used by other pages) call the same helpers inside their own transaction.
 *
 * Each function takes an already-tenant-scoped Prisma transaction client
 * (the callback argument of `withTenantContext`) and does NOT open its own
 * transaction — callers control transaction scope/batching.
 */
import type { Prisma } from "@prisma/client";
import { computeMemberStats } from "@/lib/member-stats";
import { resolveCoachName } from "@/lib/class-coach";

type TxClient = Prisma.TransactionClient;

// ─── Rank timeline ("Your Journey") ─────────────────────────────────────────

/**
 * One node of the member Progress page's lineage timeline. Deliberately
 * carries NO pace, percentage, or next-rank data — promotions are the coach's
 * call and nothing in this payload may predict or promise one.
 */
export type RankTimelineNode = {
  id: string;
  /** "stripe" when the RankHistory row has fromRankId === toRankId. */
  kind: "promotion" | "stripe";
  rankName: string;
  rankColor: string | null;
  /** ISO timestamp of the promotion / stripe award. */
  date: string;
  promotedBy: { id: string; name: string } | null;
  /** True on the node representing the member's current rank. */
  current: boolean;
};

/**
 * Builds the member's rank lineage, newest first:
 * - RankHistory rows ordered by promotedAt; demotions (toRank.order below
 *   fromRank.order within the same discipline) are omitted — the timeline is
 *   a record of awards, not a ledger.
 * - Stripe events (fromRankId === toRankId) keep kind "stripe" — per-event
 *   stripe numbers are not stored, so the client labels them "Stripe awarded".
 * - Promoter names batch-resolved in one user.findMany (LB-007 pattern from
 *   /api/members/[id]).
 * - The current MemberRank (latest achievedAt) is marked `current`; when no
 *   history row matches it (e.g. onboarding-set ranks have no RankHistory), a
 *   node is synthesised from the MemberRank itself so the timeline always has
 *   an anchor.
 */
export async function buildRankTimeline(
  tx: TxClient,
  args: { memberId: string },
): Promise<RankTimelineNode[]> {
  const { memberId } = args;

  const rows = await tx.rankHistory.findMany({
    where: { memberRank: { memberId } },
    select: { id: true, fromRankId: true, toRankId: true, promotedAt: true, promotedById: true },
    orderBy: { promotedAt: "asc" },
  });

  const currentRank = await tx.memberRank.findFirst({
    where: { memberId },
    orderBy: { achievedAt: "desc" },
    select: {
      rankSystemId: true,
      achievedAt: true,
      promotedById: true,
      rankSystem: { select: { name: true, color: true } },
    },
  });

  if (rows.length === 0 && !currentRank) return [];

  const rankIds = new Set<string>();
  for (const row of rows) {
    if (row.fromRankId) rankIds.add(row.fromRankId);
    rankIds.add(row.toRankId);
  }
  const ranks = rankIds.size > 0
    ? await tx.rankSystem.findMany({
        where: { id: { in: Array.from(rankIds) } },
        select: { id: true, name: true, color: true, order: true, discipline: true },
      })
    : [];
  const rankMap = new Map(ranks.map((r) => [r.id, r]));

  const promoterIds = new Set<string>();
  for (const row of rows) {
    if (row.promotedById) promoterIds.add(row.promotedById);
  }
  if (currentRank?.promotedById) promoterIds.add(currentRank.promotedById);
  let promoterMap = new Map<string, { id: string; name: string }>();
  if (promoterIds.size > 0) {
    const users = await tx.user.findMany({
      where: { id: { in: Array.from(promoterIds) } },
      select: { id: true, name: true },
    });
    promoterMap = new Map(users.map((u) => [u.id, u]));
  }

  type InternalNode = RankTimelineNode & { toRankId: string | null };
  const nodes: InternalNode[] = [];
  for (const row of rows) {
    const toR = rankMap.get(row.toRankId);
    if (!toR) continue;
    const fromR = row.fromRankId ? rankMap.get(row.fromRankId) : null;
    const isStripe = row.fromRankId !== null && row.fromRankId === row.toRankId;
    // Demotion → omit entirely.
    if (
      !isStripe &&
      fromR &&
      fromR.discipline === toR.discipline &&
      toR.order < fromR.order
    ) {
      continue;
    }
    nodes.push({
      id: row.id,
      kind: isStripe ? "stripe" : "promotion",
      rankName: toR.name,
      rankColor: toR.color ?? null,
      date: row.promotedAt.toISOString(),
      promotedBy: row.promotedById ? promoterMap.get(row.promotedById) ?? null : null,
      current: false,
      toRankId: row.toRankId,
    });
  }

  if (currentRank) {
    // Mark the newest promotion node that granted the current rank; synthesise
    // one from the MemberRank when history has no such row.
    let matched = false;
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].kind === "promotion" && nodes[i].toRankId === currentRank.rankSystemId) {
        nodes[i].current = true;
        matched = true;
        break;
      }
    }
    if (!matched) {
      nodes.push({
        id: `current-${currentRank.rankSystemId}`,
        kind: "promotion",
        rankName: currentRank.rankSystem.name,
        rankColor: currentRank.rankSystem.color ?? null,
        date: currentRank.achievedAt.toISOString(),
        promotedBy: currentRank.promotedById
          ? promoterMap.get(currentRank.promotedById) ?? null
          : null,
        current: true,
        toRankId: currentRank.rankSystemId,
      });
      nodes.sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  // Newest first, internal field stripped.
  return nodes
    .reverse()
    .map(({ toRankId: _toRankId, ...node }) => node);
}

// ─── /api/member/me ─────────────────────────────────────────────────────────

export async function buildMemberMeData(
  tx: TxClient,
  args: { memberId: string | undefined; tenantId: string; primaryColor: string },
) {
  const { memberId, tenantId, primaryColor } = args;
  if (!memberId) return null;

  const m = await tx.member.findFirst({
    where: { id: memberId, tenantId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      membershipType: true,
      status: true,
      joinedAt: true,
      onboardingCompleted: true,
      accountType: true,
      emergencyContactName: true,
      emergencyContactPhone: true,
      emergencyContactRelation: true,
      medicalConditions: true,
      dateOfBirth: true,
      waiverAccepted: true,
      waiverAcceptedAt: true,
      classReminders: true,
      beltPromotions: true,
      gymAnnouncements: true,
      totpEnabled: true,
      passwordHash: true,
      memberRanks: {
        orderBy: { achievedAt: "desc" },
        take: 1,
        include: { rankSystem: true },
      },
      photos: {
        where: { kind: "profile" },
        select: { url: true },
        take: 1,
      },
    },
  });

  if (!m) return null;

  const { stats, nextClass } = await computeMemberStats(tx, { memberId, tenantId });

  const rankTimeline = await buildRankTimeline(tx, { memberId });

  const cr = m.memberRanks[0];

  let promotedBy: { id: string; name: string } | null = null;
  if (cr?.promotedById) {
    const promoter = await tx.user.findUnique({
      where: { id: cr.promotedById },
      select: { id: true, name: true },
    });
    if (promoter) promotedBy = promoter;
  }

  return {
    id: m.id,
    name: m.name,
    email: m.email,
    phone: m.phone,
    membershipType: m.membershipType,
    status: m.status,
    joinedAt: m.joinedAt.toISOString(),
    primaryColor,
    onboardingCompleted: m.onboardingCompleted,
    accountType: m.accountType,
    emergencyContactName: m.emergencyContactName ?? null,
    emergencyContactPhone: m.emergencyContactPhone ?? null,
    emergencyContactRelation: m.emergencyContactRelation ?? null,
    medicalConditions: m.medicalConditions ?? null,
    dateOfBirth: m.dateOfBirth ? m.dateOfBirth.toISOString() : null,
    waiverAccepted: m.waiverAccepted,
    waiverAcceptedAt: m.waiverAcceptedAt ? m.waiverAcceptedAt.toISOString() : null,
    classReminders: m.classReminders,
    beltPromotions: m.beltPromotions,
    gymAnnouncements: m.gymAnnouncements,
    totpEnabled: m.totpEnabled,
    hasPassword: m.passwordHash !== null,
    belt: cr
      ? {
          name: cr.rankSystem.name,
          color: cr.rankSystem.color ?? "#e5e7eb",
          stripes: cr.stripes,
          achievedAt: cr.achievedAt.toISOString(),
          promotedBy,
        }
      : null,
    rankTimeline,
    stats,
    nextClass,
    profilePictureUrl: m.photos[0]?.url ?? null,
  };
}

export type MemberMeData = NonNullable<Awaited<ReturnType<typeof buildMemberMeData>>>;

// ─── /api/member/schedule ───────────────────────────────────────────────────

export async function buildMemberSchedule(
  tx: TxClient,
  args: { tenantId: string; memberId: string | undefined; dateParam: string | null },
) {
  const { tenantId, memberId, dateParam } = args;

  const cls = await tx.class.findMany({
    // RULES §5: same soft-delete filter as /api/member/schedule. These two
    // queries are the same read behind two routes; a filter added to one and
    // not the other is a hole with a fix in front of it.
    where: { tenantId, isActive: true, deletedAt: null },
    select: {
      id: true,
      name: true,
      color: true,
      coachName: true,
      coachUser: { select: { id: true, name: true } },
      location: true,
      maxCapacity: true,
      requiredRank: { select: { id: true, name: true, discipline: true, order: true } },
      maxRank: { select: { id: true, name: true, discipline: true, order: true } },
      schedules: {
        where: { isActive: true },
        select: { id: true, dayOfWeek: true, startTime: true, endTime: true },
      },
    },
  });

  const instanceMap = new Map<string, string>();
  if (dateParam) {
    const startOfDay = new Date(`${dateParam}T00:00:00.000Z`);
    const endOfDay = new Date(`${dateParam}T23:59:59.999Z`);
    const instances = await tx.classInstance.findMany({
      where: {
        class: { tenantId },
        date: { gte: startOfDay, lte: endOfDay },
        isCancelled: false,
      },
      select: { id: true, classId: true, startTime: true },
    });
    for (const inst of instances) {
      instanceMap.set(`${inst.classId}-${inst.startTime}`, inst.id);
    }
  }

  const memberRanks = memberId
    ? await tx.memberRank.findMany({
        where: { memberId },
        include: { rankSystem: { select: { id: true, discipline: true, order: true } } },
      })
    : [];
  const rosterMembershipsRaw = memberId
    ? await tx.classRoster.findMany({
        where: { memberId },
        select: { classId: true },
      })
    : [];
  const rosterClassIds = new Set(rosterMembershipsRaw.map((r) => r.classId));

  const counts = await tx.classRoster.groupBy({
    by: ["classId"],
    where: { tenantId, classId: { in: cls.map((c) => c.id) } },
    _count: { _all: true },
  });
  const rosterCounts = new Map<string, number>(counts.map((c) => [c.classId, c._count._all]));

  type Cls = typeof cls[number];
  type Sched = Cls["schedules"][number];

  return cls.flatMap((cls: Cls) => {
    const isRosterMode = (rosterCounts.get(cls.id) ?? 0) > 0;
    const memberOnRoster = rosterClassIds.has(cls.id);

    // Roster-only class member is NOT on → server-side hide entirely.
    if (isRosterMode && !memberOnRoster) return [];

    let eligibility: "ok" | "rank_below" | "rank_above" | "roster_ok" = "ok";
    if (memberOnRoster) {
      eligibility = "roster_ok";
    } else if (cls.requiredRank) {
      const r = memberRanks.find((mr) => mr.rankSystem.discipline === cls.requiredRank!.discipline);
      if (!r || r.rankSystem.order < cls.requiredRank.order) eligibility = "rank_below";
    }
    if (eligibility === "ok" && cls.maxRank) {
      const r = memberRanks.find((mr) => mr.rankSystem.discipline === cls.maxRank!.discipline);
      if (r && r.rankSystem.order > cls.maxRank.order) eligibility = "rank_above";
    }

    return cls.schedules.map((sched: Sched) => ({
      id: `${cls.id}-${sched.id}`,
      classId: cls.id,
      scheduleId: sched.id,
      name: cls.name,
      color: cls.color,
      startTime: sched.startTime,
      endTime: sched.endTime,
      coach: resolveCoachName(cls) ?? "TBC",
      location: cls.location ?? "",
      capacity: cls.maxCapacity,
      dayOfWeek: sched.dayOfWeek,
      classInstanceId: instanceMap.get(`${cls.id}-${sched.startTime}`) ?? null,
      eligibility,
      requiredRankName: cls.requiredRank?.name ?? null,
      maxRankName: cls.maxRank?.name ?? null,
    }));
  });
}

export type MemberScheduleEntry = Awaited<ReturnType<typeof buildMemberSchedule>>[number];

// ─── /api/member/me/children ────────────────────────────────────────────────

export type KidTimetableEntry = {
  classInstanceId: string;
  classId: string;
  className: string;
  date: string; // ISO date (YYYY-MM-DD)
  startTime: string;
  endTime: string;
  coach: string | null;
  location: string | null;
  isCancelled: boolean;
};

function startOfTodayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function plusDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

export async function buildMemberChildren(
  tx: TxClient,
  args: { tenantId: string; memberId: string | undefined; includeTimetable: boolean },
) {
  const { tenantId, memberId, includeTimetable } = args;
  if (!memberId) return [];

  const children = await tx.member.findMany({
    where: { parentMemberId: memberId, tenantId },
    select: {
      id: true,
      name: true,
      dateOfBirth: true,
      accountType: true,
      waiverAccepted: true,
      memberRanks: {
        orderBy: { achievedAt: "desc" },
        take: 1,
        select: {
          stripes: true,
          rankSystem: { select: { name: true, color: true } },
        },
      },
      _count: { select: { attendances: true } },
    },
    orderBy: { name: "asc" },
  });

  const base = children.map((c) => ({
    id: c.id,
    name: c.name,
    dateOfBirth: c.dateOfBirth ? c.dateOfBirth.toISOString() : null,
    accountType: c.accountType,
    waiverAccepted: c.waiverAccepted,
    belt: c.memberRanks[0]
      ? {
          name: c.memberRanks[0].rankSystem.name,
          color: c.memberRanks[0].rankSystem.color ?? "#e5e7eb",
          stripes: c.memberRanks[0].stripes,
        }
      : null,
    totalClasses: c._count.attendances,
  }));

  if (!includeTimetable || base.length === 0) {
    return base.map((kid) => ({ ...kid, timetable: undefined as KidTimetableEntry[] | undefined }));
  }

  const windowStart = startOfTodayUTC();
  const windowEnd = plusDays(windowStart, 7); // exclusive — covers today + next 6 days

  const kidIds = base.map((k) => k.id);
  const subs = await tx.classSubscription.findMany({
    where: { memberId: { in: kidIds } },
    select: { memberId: true, classId: true },
  });

  const subsByMember = new Map<string, string[]>();
  const allClassIds = new Set<string>();
  for (const s of subs) {
    const arr = subsByMember.get(s.memberId) ?? [];
    arr.push(s.classId);
    subsByMember.set(s.memberId, arr);
    allClassIds.add(s.classId);
  }

  if (allClassIds.size === 0) {
    return base.map((kid) => ({ ...kid, timetable: [] as KidTimetableEntry[] }));
  }

  const instances = await tx.classInstance.findMany({
    where: {
      classId: { in: Array.from(allClassIds) },
      date: { gte: windowStart, lt: windowEnd },
    },
    select: {
      id: true,
      classId: true,
      date: true,
      startTime: true,
      endTime: true,
      isCancelled: true,
      class: {
        select: {
          name: true,
          coachName: true,
          location: true,
          tenantId: true,
        },
      },
    },
    orderBy: [{ date: "asc" }, { startTime: "asc" }],
  });

  const ourInstances = instances.filter((i) => i.class.tenantId === tenantId);
  const byClassId = new Map<string, typeof ourInstances>();
  for (const inst of ourInstances) {
    const arr = byClassId.get(inst.classId) ?? [];
    arr.push(inst);
    byClassId.set(inst.classId, arr);
  }

  return base.map((kid) => {
    const myClassIds = subsByMember.get(kid.id) ?? [];
    const myInstances = myClassIds.flatMap((cid) => byClassId.get(cid) ?? []);
    myInstances.sort((a, b) => {
      const d = a.date.getTime() - b.date.getTime();
      return d !== 0 ? d : a.startTime.localeCompare(b.startTime);
    });
    const timetable: KidTimetableEntry[] = myInstances.map((i) => ({
      classInstanceId: i.id,
      classId: i.classId,
      className: i.class.name,
      date: i.date.toISOString().slice(0, 10),
      startTime: i.startTime,
      endTime: i.endTime,
      coach: i.class.coachName,
      location: i.class.location,
      isCancelled: i.isCancelled,
    }));
    return { ...kid, timetable };
  });
}

export type MemberChild = Awaited<ReturnType<typeof buildMemberChildren>>[number];

// ─── /api/announcements ─────────────────────────────────────────────────────

export async function buildAnnouncementsData(
  tx: TxClient,
  args: { tenantId: string; role: string; memberId: string | undefined; take: number },
) {
  const { tenantId, role, memberId, take } = args;

  const a = await tx.announcement.findMany({
    where: { tenantId },
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
    take,
  });

  let seen: Date | null = null;
  if (role === "member" && memberId) {
    const m = await tx.member.findUnique({
      where: { id: memberId },
      select: { lastAnnouncementSeenAt: true },
    });
    seen = m?.lastAnnouncementSeenAt ?? null;
  }

  return {
    announcements: a.map((ann) => ({
      ...ann,
      unseen: role === "member" ? !seen || ann.createdAt > seen : false,
    })),
  };
}

export type AnnouncementsData = Awaited<ReturnType<typeof buildAnnouncementsData>>;
