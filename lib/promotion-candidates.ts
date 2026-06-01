import { withTenantContext } from "@/lib/prisma-tenant";

/**
 * Assessment Fix #1: compute "ready for promotion" candidates for a tenant.
 *
 * For each MemberRank in the tenant, we look up the matching RankRequirement
 * (or fall back to defaults) and check whether the member has met both:
 *   - minAttendances attendances since MemberRank.achievedAt
 *   - minMonths calendar months since MemberRank.achievedAt
 *
 * Returns the candidate list sorted by (months elapsed) desc — owners
 * see the most-overdue promotions first.
 *
 * NOTE: this is computed live, not via a cron. For a tenant with hundreds
 * of members + a dozen rank systems this is a handful of small queries
 * that should complete in <500ms. If we ever hit performance issues, the
 * obvious next step is a nightly cron + cached `PromotionCandidate` table.
 */

export type DefaultThresholds = { minAttendances: number; minMonths: number };

// Discipline-specific defaults — sensible starting points per martial art.
// These are only used when no RankRequirement row exists for the rankSystem.
const DEFAULT_THRESHOLDS_BY_DISCIPLINE: Record<string, DefaultThresholds> = {
  BJJ:        { minAttendances: 50, minMonths: 6 },   // BJJ pace: ~2 classes/week for 6 months between stripes
  Judo:       { minAttendances: 60, minMonths: 12 },  // belt promotions are slower in Judo
  Karate:     { minAttendances: 60, minMonths: 9 },
  Wrestling:  { minAttendances: 30, minMonths: 3 },   // faster ladder
  MuayThai:   { minAttendances: 40, minMonths: 6 },
  MMA:        { minAttendances: 40, minMonths: 6 },
  Kickboxing: { minAttendances: 40, minMonths: 6 },
};

const FALLBACK_THRESHOLD: DefaultThresholds = { minAttendances: 30, minMonths: 6 };

export function defaultThresholdsFor(discipline: string): DefaultThresholds {
  return DEFAULT_THRESHOLDS_BY_DISCIPLINE[discipline] ?? FALLBACK_THRESHOLD;
}

export type PromotionCandidate = {
  memberId: string;
  memberName: string;
  rankSystemId: string;
  rankSystemName: string;
  discipline: string;
  currentStripes: number;
  achievedAt: string;          // ISO
  monthsAtRank: number;
  attendancesSinceRank: number;
  threshold: { minAttendances: number; minMonths: number };
  thresholdSource: "tenant_override" | "discipline_default" | "fallback";
};

/**
 * Pure function: given a current MemberRank + the threshold + an attendance
 * count, decide if the member is a candidate. Exposed for unit tests.
 */
export function meetsPromotionThreshold(args: {
  achievedAt: Date;
  attendancesSince: number;
  threshold: { minAttendances: number; minMonths: number };
  now?: Date;
}): boolean {
  const now = args.now ?? new Date();
  const monthsElapsed = (now.getTime() - args.achievedAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  return args.attendancesSince >= args.threshold.minAttendances && monthsElapsed >= args.threshold.minMonths;
}

export async function listPromotionCandidates(tenantId: string): Promise<PromotionCandidate[]> {
  const { memberRanks, reqByRankSystem, counts } = await withTenantContext(tenantId, async (tx) => {
    // 1. All MemberRanks in the tenant — only for non-deleted members.
    const ranks = await tx.memberRank.findMany({
      where: {
        member: { tenantId, status: { in: ["active", "taster"] } },
      },
      include: {
        member: { select: { id: true, name: true, tenantId: true } },
        rankSystem: { select: { id: true, name: true, discipline: true, deletedAt: true } },
      },
    });

    // 2. All RankRequirement rows for this tenant (one query, indexed).
    const requirements = await tx.rankRequirement.findMany({
      where: { tenantId },
      select: { rankSystemId: true, minAttendances: true, minMonths: true },
    });
    const reqMap = new Map(requirements.map((r) => [r.rankSystemId, r]));

    // 3. Compute attendance counts since each rank's achievedAt.
    // Audit iter-1-database A8I1-P-1 [Critical]: collapse the per-rank N+1.
    // Was: one `count()` per MemberRank row × 200 members × 3 disciplines =
    // 600 round-trips per /api/promotions/candidates call (~3-6s wall-clock).
    // Now: ONE `findMany({ memberId in [...], checkInTime gte earliest })`
    // returning (memberId, checkInTime) tuples; bucket per-rank in JS.
    // The result-set is bounded by the earliest achievedAt across all ranks
    // (typically months ago) and the candidate member pool — for a tenant
    // with 200 members and 12 months of history this is ~70k rows ×
    // ~30 bytes = ~2MB transferred once, vs 600 connection-bound round-
    // trips. Worst case (10k members) we'd revisit and chunk; not the
    // current scale.
    let cs: number[] = [];
    if (ranks.length > 0) {
      const memberIds = Array.from(new Set(ranks.map((r) => r.memberId)));
      const earliestAchievedAt = ranks.reduce(
        (min, r) => (r.achievedAt.getTime() < min.getTime() ? r.achievedAt : min),
        ranks[0].achievedAt,
      );
      const records = await tx.attendanceRecord.findMany({
        where: {
          tenantId,
          memberId: { in: memberIds },
          checkInTime: { gte: earliestAchievedAt },
        },
        select: { memberId: true, checkInTime: true },
      });
      // Pre-sort per member by checkInTime so the per-rank count is just a
      // binary-search-like upper-bound walk. For our scale a linear filter
      // is fine; switch to sorted + bsearch if this surfaces in profiling.
      const byMember = new Map<string, Date[]>();
      for (const r of records) {
        const arr = byMember.get(r.memberId);
        if (arr) arr.push(r.checkInTime);
        else byMember.set(r.memberId, [r.checkInTime]);
      }
      cs = ranks.map((mr) => {
        const times = byMember.get(mr.memberId);
        if (!times) return 0;
        let count = 0;
        for (const t of times) if (t.getTime() >= mr.achievedAt.getTime()) count += 1;
        return count;
      });
    }
    return { memberRanks: ranks, reqByRankSystem: reqMap, counts: cs };
  });

  const now = new Date();
  const candidates: PromotionCandidate[] = [];
  for (let i = 0; i < memberRanks.length; i++) {
    const mr = memberRanks[i];
    if (mr.rankSystem.deletedAt !== null) continue; // skip soft-deleted rank systems
    const attendancesSince = counts[i];

    const override = reqByRankSystem.get(mr.rankSystemId);
    let threshold: { minAttendances: number; minMonths: number };
    let source: PromotionCandidate["thresholdSource"];
    if (override) {
      threshold = { minAttendances: override.minAttendances, minMonths: override.minMonths };
      source = "tenant_override";
    } else {
      const def = defaultThresholdsFor(mr.rankSystem.discipline);
      threshold = def;
      source = def === FALLBACK_THRESHOLD ? "fallback" : "discipline_default";
    }

    if (meetsPromotionThreshold({ achievedAt: mr.achievedAt, attendancesSince, threshold, now })) {
      const monthsAtRank =
        Math.round(((now.getTime() - mr.achievedAt.getTime()) / (1000 * 60 * 60 * 24 * 30.44)) * 10) / 10;
      candidates.push({
        memberId: mr.memberId,
        memberName: mr.member.name,
        rankSystemId: mr.rankSystemId,
        rankSystemName: mr.rankSystem.name,
        discipline: mr.rankSystem.discipline,
        currentStripes: mr.stripes,
        achievedAt: mr.achievedAt.toISOString(),
        monthsAtRank,
        attendancesSinceRank: attendancesSince,
        threshold,
        thresholdSource: source,
      });
    }
  }

  // Most-overdue first.
  candidates.sort((a, b) => b.monthsAtRank - a.monthsAtRank);
  return candidates;
}

/**
 * Quick-check variant for the member-detail chip — does THIS member have
 * any rank that's currently promotion-ready? Returns true on first match.
 */
export async function isPromotionReady(memberId: string): Promise<boolean> {
  // First fetch the tenantId via memberRanks → member relation. We can't yet
  // know the tenant context, so this initial lookup is a single bypass query
  // restricted to one memberId. Subsequent reads happen inside withTenantContext.
  const { withRlsBypass } = await import("@/lib/prisma-tenant");
  const memberRanks = await withRlsBypass((tx) =>
    tx.memberRank.findMany({
      where: { memberId, member: { status: { in: ["active", "taster"] } } },
      include: {
        member: { select: { tenantId: true } },
        rankSystem: { select: { id: true, discipline: true, deletedAt: true } },
      },
    }),
  );
  if (memberRanks.length === 0) return false;

  const tenantId = memberRanks[0].member.tenantId;
  return withTenantContext(tenantId, async (tx) => {
    const overrides = await tx.rankRequirement.findMany({
      where: { tenantId, rankSystemId: { in: memberRanks.map((mr) => mr.rankSystemId) } },
      select: { rankSystemId: true, minAttendances: true, minMonths: true },
    });
    const reqByRankSystem = new Map(overrides.map((r) => [r.rankSystemId, r]));

    // Audit iter-1-database A8I1-P-1: same per-rank N+1 as
    // listPromotionCandidates above — collapsed to a single findMany.
    // Member-detail chip path is also called per-page-render so worth fixing.
    const activeRanks = memberRanks.filter((mr) => mr.rankSystem.deletedAt === null);
    if (activeRanks.length === 0) return false;
    const earliestAchievedAt = activeRanks.reduce(
      (min, r) => (r.achievedAt.getTime() < min.getTime() ? r.achievedAt : min),
      activeRanks[0].achievedAt,
    );
    const records = await tx.attendanceRecord.findMany({
      where: {
        tenantId,
        memberId,
        checkInTime: { gte: earliestAchievedAt },
      },
      select: { checkInTime: true },
    });
    const times = records.map((r) => r.checkInTime);

    const now = new Date();
    for (const mr of activeRanks) {
      const attendances = times.reduce(
        (n, t) => (t.getTime() >= mr.achievedAt.getTime() ? n + 1 : n),
        0,
      );
      const override = reqByRankSystem.get(mr.rankSystemId);
      const threshold = override
        ? { minAttendances: override.minAttendances, minMonths: override.minMonths }
        : defaultThresholdsFor(mr.rankSystem.discipline);
      if (meetsPromotionThreshold({ achievedAt: mr.achievedAt, attendancesSince: attendances, threshold, now })) {
        return true;
      }
    }
    return false;
  });
}
