/**
 * Shared member stats helper.
 *
 * Single source of truth for the attendance/stats/nextClass shape returned by
 * BOTH the adult dashboard (`/api/member/me`) AND each kid detail endpoint
 * (`/api/member/children/[id]`). Co-locating the computation here guarantees
 * the two response shapes can't drift — a parent looking at their own dashboard
 * and at their kid's dashboard sees the same fields populated by the same logic.
 */

import type { Prisma } from "@prisma/client";
import { calculateStreak, getWeekKey } from "@/lib/streak";
import { resolveCoachName } from "@/lib/class-coach";

export type AttendanceByClass = { id: string; name: string; count: number };

/**
 * A family of related badges. The track is what makes relevance filtering
 * possible: `selectVisibleBadges` surfaces only the next rung within each
 * track, so a member on their first class never sees "250 classes — 1 of 250".
 */
export type BadgeTrack = "volume" | "consistency" | "intensity" | "tenure" | "breadth";

/** Rendered verbatim after the numbers: "3 of 4 weeks". */
export type BadgeUnit = "classes" | "sessions" | "weeks" | "months" | "class types";

/**
 * Milestone badge (member Progress page). Everything is derived from REAL
 * attendance rows — earned badges carry the date of the check-in that crossed
 * the threshold; locked badges carry live progress. Never fabricated
 * (UI-RULES §7).
 *
 * Two things are deliberately absent and must stay absent:
 *
 * 1. No promotion/rank badges. Promotions are the coach's call and nothing
 *    here predicts or promises one. `RankRequirement` (minAttendances /
 *    minMonths) is staff-only and must never be imported on this path — it is
 *    the one model that would turn a badge into "24 of 30 to blue belt".
 *
 * 2. No hour-of-day badges (early bird / night owl). `checkInTime` looks like
 *    free data for these, but `AttendanceRecord.checkInMethod` distinguishes
 *    kiosk/self check-ins from admin/auto ones precisely because a coach
 *    marking a register writes `now()` — hours after the class actually ran.
 *    Filtering to self-check-ins is worse, not better: the badge would then
 *    depend on whether the gym bought a kiosk rather than on the member, which
 *    is a plausible-looking number the member cannot audit. That is the §7
 *    fabrication failure with better camouflage.
 */
export type MemberBadge = {
  id: string;
  label: string;
  description: string;
  track: BadgeTrack;
  /** 1-based rung within its track; relevance surfaces tier N+1 once N is earned. */
  tier: number;
  earned: boolean;
  /** ISO date of the check-in that earned the badge; null while locked. */
  earnedAt: string | null;
  /**
   * Live progress while locked; null when earned, or when the badge is one we
   * deliberately refuse to nudge. A null here also hides the badge from the
   * locked candidates in `selectVisibleBadges` — the mechanism is kept because
   * any future non-nudgeable badge needs it, even though the resilience track
   * that first required it was removed on 2026-08-20.
   */
  progress: { current: number; target: number; unit: BadgeUnit } | null;
};

/** One check-in, reduced to what badge derivation needs. */
export type BadgeRow = { at: Date; classId: string | null };

/** One Monday-based week of the Progress heat strip. */
export type WeeklyCount = {
  /** ISO date (YYYY-MM-DD) of the Monday starting this week. */
  weekStart: string;
  count: number;
  /** That week's attended classes — names + ISO check-in dates only. */
  classes: { name: string; date: string }[];
};

export type MemberStats = {
  thisWeek: number;
  thisMonth: number;
  thisYear: number;
  streakWeeks: number;
  totalClasses: number;
  attendanceByClass: AttendanceByClass[];
  avgClassesPerWeek: number;
  /** ISO timestamp of the member's first-ever check-in; null if none yet. */
  firstCheckInAt: string | null;
  badges: MemberBadge[];
  /** Last 12 Monday-based weeks (oldest first, current week last). */
  weeklyCounts: WeeklyCount[];
};

export type NextClassShape = {
  id: string;
  classId: string;
  name: string;
  coach: string | null;
  location: string | null;
  date: string;
  startTime: string;
  endTime: string;
} | null;

export type MemberStatsResult = {
  stats: MemberStats;
  nextClass: NextClassShape;
};

/**
 * Computes attendance-windowed stats + the next upcoming class instance for
 * a given member. Pass an already-tenant-scoped Prisma transaction client
 * (`withTenantContext`'s callback argument). The function does NOT call
 * `withTenantContext` itself so callers can batch multiple stats reads in
 * a single transaction if they need to.
 */
export async function computeMemberStats(
  tx: Prisma.TransactionClient,
  args: { memberId: string; tenantId: string },
): Promise<MemberStatsResult> {
  const { memberId, tenantId } = args;
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  startOfWeek.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(now.getDate() - 90);
  const eightWeeksAgo = new Date(now);
  eightWeeksAgo.setDate(now.getDate() - 56);

  // ONE full-history read serves badges, the 90-day "most attended" list and
  // the 12-week heat strip. It deliberately fetches everything (ascending):
  // milestone badges need the exact check-in that crossed each threshold (the
  // date of the 100th class), and the breadth badges need lifetime distinct
  // class ids — neither of which a windowed query can answer. It also replaces
  // the separate totalClasses count. Even a decade of daily training is only
  // ~3k tiny rows.
  //
  // The 90-day and 12-week views are sliced from these rows in memory rather
  // than fetched separately. Widening the old 90-day query in place would have
  // been the smaller diff but it would have silently falsified the UI's
  // "Most attended (90 days)" label.
  const [thisWeek, thisMonth, thisYear, attendanceRows, last8w, nextInstance] = await Promise.all([
    tx.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfWeek } } }),
    tx.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfMonth } } }),
    tx.attendanceRecord.count({ where: { memberId, checkInTime: { gte: startOfYear } } }),
    tx.attendanceRecord.findMany({
      where: { memberId },
      select: { checkInTime: true, classInstance: { select: { class: { select: { id: true, name: true } } } } },
      orderBy: { checkInTime: "asc" },
    }),
    tx.attendanceRecord.count({ where: { memberId, checkInTime: { gte: eightWeeksAgo } } }),
    tx.classInstance.findFirst({
      where: {
        class: { tenantId, isActive: true },
        date: { gte: now },
        isCancelled: false,
      },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
      select: {
        id: true,
        date: true,
        startTime: true,
        endTime: true,
        class: {
          select: {
            id: true,
            name: true,
            coachName: true,
            coachUser: { select: { id: true, name: true } },
            location: true,
          },
        },
      },
    }),
  ]);

  // Top 3 classes by attendance count over the last 90 days. Sliced in memory
  // from the full history — the window here is what keeps the UI's
  // "Most attended (90 days)" label true.
  const classCounts = new Map<string, AttendanceByClass>();
  for (const row of attendanceRows) {
    if (row.checkInTime < ninetyDaysAgo) continue;
    const c = row.classInstance?.class;
    if (!c) continue;
    const existing = classCounts.get(c.id);
    if (existing) existing.count += 1;
    else classCounts.set(c.id, { id: c.id, name: c.name, count: 1 });
  }
  const attendanceByClass = Array.from(classCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  const avgClassesPerWeek = Math.round((last8w / 8) * 10) / 10;

  const datesAsc = attendanceRows.map((r) => r.checkInTime);
  const totalClasses = datesAsc.length;

  const streakWeeks = calculateStreak(datesAsc, now);

  const badges = computeBadges(
    attendanceRows.map((r) => ({ at: r.checkInTime, classId: r.classInstance?.class?.id ?? null })),
    streakWeeks,
    now,
  );
  // computeWeeklyCounts ignores anything outside its 12-week window, so
  // handing it the full history is harmless.
  const weeklyCounts = computeWeeklyCounts(
    attendanceRows.map((r) => ({
      checkInTime: r.checkInTime,
      className: r.classInstance?.class?.name ?? null,
    })),
    now,
  );

  return {
    stats: {
      thisWeek,
      thisMonth,
      thisYear,
      streakWeeks,
      totalClasses,
      attendanceByClass,
      avgClassesPerWeek,
      firstCheckInAt: datesAsc[0]?.toISOString() ?? null,
      badges,
      weeklyCounts,
    },
    nextClass: nextInstance
      ? {
          id: nextInstance.id,
          classId: nextInstance.class.id,
          name: nextInstance.class.name,
          coach: resolveCoachName(nextInstance.class),
          location: nextInstance.class.location ?? null,
          date: nextInstance.date.toISOString(),
          startTime: nextInstance.startTime,
          endTime: nextInstance.endTime,
        }
      : null,
  };
}

// ─── Milestone badges ────────────────────────────────────────────────────────

const CLASS_MILESTONES: { target: number; id: string; label: string; description: string }[] = [
  { target: 1,   id: "classes-1",   label: "First class",  description: "Your first check-in" },
  { target: 10,  id: "classes-10",  label: "10 classes",   description: "10 check-ins" },
  { target: 25,  id: "classes-25",  label: "25 classes",   description: "25 check-ins" },
  { target: 50,  id: "classes-50",  label: "50 classes",   description: "50 check-ins" },
  { target: 100, id: "classes-100", label: "100 classes",  description: "100 check-ins" },
  { target: 250, id: "classes-250", label: "250 classes",  description: "250 check-ins" },
  { target: 500, id: "classes-500", label: "500 classes",  description: "500 check-ins" },
];

const STREAK_MILESTONES: { target: number; id: string; label: string; description: string }[] = [
  { target: 4,  id: "streak-4",  label: "4-week streak",  description: "Train every week for a month" },
  { target: 12, id: "streak-12", label: "12-week streak", description: "Train every week for three months" },
  { target: 26, id: "streak-26", label: "26-week streak", description: "Train every week for six months" },
  { target: 52, id: "streak-52", label: "52-week streak", description: "Train every week for a year" },
];

/** Most sessions inside one calendar bucket, ever. */
const INTENSITY_MILESTONES: {
  target: number; id: string; label: string; description: string;
  bucket: "week" | "month" | "year";
}[] = [
  { target: 3,   id: "week-3",    label: "Three in a week",    description: "Three sessions in a single week",     bucket: "week" },
  { target: 5,   id: "week-5",    label: "Five in a week",     description: "Five sessions in a single week",      bucket: "week" },
  { target: 12,  id: "month-12",  label: "Twelve in a month",  description: "Twelve sessions in one calendar month", bucket: "month" },
  { target: 100, id: "year-100",  label: "A hundred in a year", description: "One hundred sessions in one calendar year", bucket: "year" },
];

const TENURE_MILESTONES: { months: number; id: string; label: string; description: string }[] = [
  { months: 6,  id: "tenure-6m", label: "Six months in", description: "Still training six months after your first class" },
  { months: 12, id: "tenure-1y", label: "One year in",   description: "Still training a year after your first class" },
  { months: 24, id: "tenure-2y", label: "Two years in",  description: "Still training two years after your first class" },
  { months: 60, id: "tenure-5y", label: "Five years in", description: "Still training five years after your first class" },
];

const VARIETY_MILESTONES: { target: number; id: string; label: string; description: string }[] = [
  { target: 3, id: "variety-3", label: "Three classes", description: "Checked in to three different classes" },
  { target: 5, id: "variety-5", label: "Five classes",  description: "Checked in to five different classes" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Adds whole months in UTC, clamping to the end of the target month so that
 * 31 January + 1 month is 28/29 February rather than silently rolling into
 * March (which is what the naive `setMonth` does).
 */
function addMonthsUTC(d: Date, months: number): Date {
  const target = new Date(d.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return target;
}

/** Whole months elapsed between two instants, never negative. */
function wholeMonthsBetween(from: Date, to: Date): number {
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const yearKey = (d: Date) => String(d.getUTCFullYear());

/**
 * Walks the history bucketing by `keyOf`, returning the check-in that first
 * pushed any single bucket to `target`, plus the best bucket ever seen.
 *
 * Progress for these badges is the BEST-EVER bucket, not the current one: the
 * badge asks "have you ever", and a current-week figure would reset to zero
 * every Monday, which reads as losing progress.
 */
function bucketCrossing(
  rows: BadgeRow[],
  keyOf: (d: Date) => string,
  target: number,
): { earnedAt: Date | null; best: number } {
  const counts = new Map<string, number>();
  let earnedAt: Date | null = null;
  let best = 0;
  for (const r of rows) {
    const k = keyOf(r.at);
    const n = (counts.get(k) ?? 0) + 1;
    counts.set(k, n);
    if (n > best) best = n;
    if (n === target && !earnedAt) earnedAt = r.at;
  }
  return { earnedAt, best };
}

/**
 * Derives every milestone badge from the member's real check-in history.
 *
 * - Volume: earned on the exact check-in that crossed the threshold
 *   (rows[target - 1]); locked shows live progress.
 * - Consistency: earned the first time in HISTORY a run of consecutive
 *   Monday-based training weeks reached the target — the achievement date is
 *   the first check-in of the week that completed the run. Once earned, always
 *   earned (a broken streak doesn't un-earn history). Locked progress shows
 *   the current streak.
 * - Intensity: most sessions in a single week/month/year, ever. Locked
 *   progress is the best bucket ever, not the current one.
 * - Tenure: earned on the first check-in ON OR AFTER the anniversary of the
 *   member's first class — never on the calendar crossing alone. Awarding
 *   "one year in" by clock would hand it to someone who quit after three
 *   months while they were nowhere near the gym, which is exactly the
 *   fabrication §7 forbids. Anchored on the first check-in rather than
 *   `Member.joinedAt`, which is back-dateable by CSV import.
 * - Breadth: distinct classes attended, lifetime.
 * - Resilience: a check-in after a gap of ≥30 days, then four straight weeks
 *   after it. Both carry `progress: null` — counting days away is not
 *   something we nudge, and a null progress also keeps them out of the
 *   "next up" list entirely.
 *
 * @param rows every check-in (oldest first) with the class it belonged to
 * @param currentStreakWeeks the member's live streak, for locked progress
 * @param now evaluation time, injected so tests are deterministic
 */
export function computeBadges(rows: BadgeRow[], currentStreakWeeks: number, now: Date = new Date()): MemberBadge[] {
  const total = rows.length;
  const badges: MemberBadge[] = [];

  CLASS_MILESTONES.forEach((m, i) => {
    const earned = total >= m.target;
    badges.push({
      id: m.id,
      label: m.label,
      description: m.description,
      track: "volume",
      tier: i + 1,
      earned,
      earnedAt: earned ? rows[m.target - 1].at.toISOString() : null,
      progress: earned ? null : { current: total, target: m.target, unit: "classes" },
    });
  });

  // Historical streak runs over Monday-based weeks.
  const firstByWeek = new Map<string, Date>();
  for (const r of rows) {
    const k = getWeekKey(r.at);
    if (!firstByWeek.has(k)) firstByWeek.set(k, r.at);
  }
  const weekKeys = Array.from(firstByWeek.keys()).sort();
  let runLen = 0;
  let prevMs = 0;
  const streakEarnedAt = new Map<number, Date>();
  for (const k of weekKeys) {
    const ms = Date.parse(`${k}T00:00:00.000Z`);
    runLen = prevMs !== 0 && ms - prevMs === 7 * DAY_MS ? runLen + 1 : 1;
    prevMs = ms;
    for (const m of STREAK_MILESTONES) {
      if (runLen === m.target && !streakEarnedAt.has(m.target)) streakEarnedAt.set(m.target, firstByWeek.get(k)!);
    }
  }
  STREAK_MILESTONES.forEach((m, i) => {
    const at = streakEarnedAt.get(m.target) ?? null;
    badges.push({
      id: m.id,
      label: m.label,
      description: m.description,
      track: "consistency",
      tier: i + 1,
      earned: at !== null,
      earnedAt: at ? at.toISOString() : null,
      progress: at ? null : { current: Math.min(currentStreakWeeks, m.target), target: m.target, unit: "weeks" },
    });
  });

  INTENSITY_MILESTONES.forEach((m, i) => {
    const keyOf = m.bucket === "week" ? getWeekKey : m.bucket === "month" ? monthKey : yearKey;
    const { earnedAt, best } = bucketCrossing(rows, keyOf, m.target);
    badges.push({
      id: m.id,
      label: m.label,
      description: m.description,
      track: "intensity",
      tier: i + 1,
      earned: earnedAt !== null,
      earnedAt: earnedAt ? earnedAt.toISOString() : null,
      progress: earnedAt ? null : { current: Math.min(best, m.target), target: m.target, unit: "sessions" },
    });
  });

  const firstEver = rows[0]?.at ?? null;
  TENURE_MILESTONES.forEach((m, i) => {
    let at: Date | null = null;
    if (firstEver) {
      const threshold = addMonthsUTC(firstEver, m.months);
      at = rows.find((r) => r.at.getTime() >= threshold.getTime())?.at ?? null;
    }
    // Elapsed months since a real first check-in is itself a real fact, so it
    // is legitimate progress; only the EARNED state requires an attendance row.
    const elapsed = firstEver ? wholeMonthsBetween(firstEver, now) : 0;
    badges.push({
      id: m.id,
      label: m.label,
      description: m.description,
      track: "tenure",
      tier: i + 1,
      earned: at !== null,
      earnedAt: at ? at.toISOString() : null,
      progress: at ? null : { current: Math.min(elapsed, m.months), target: m.months, unit: "months" },
    });
  });

  const seenClasses = new Set<string>();
  const varietyCrossing = new Map<number, Date>();
  for (const r of rows) {
    if (!r.classId || seenClasses.has(r.classId)) continue;
    seenClasses.add(r.classId);
    for (const m of VARIETY_MILESTONES) {
      if (seenClasses.size === m.target && !varietyCrossing.has(m.target)) varietyCrossing.set(m.target, r.at);
    }
  }
  VARIETY_MILESTONES.forEach((m, i) => {
    const at = varietyCrossing.get(m.target) ?? null;
    badges.push({
      id: m.id,
      label: m.label,
      description: m.description,
      track: "breadth",
      tier: i + 1,
      earned: at !== null,
      earnedAt: at ? at.toISOString() : null,
      progress: at ? null : { current: Math.min(seenClasses.size, m.target), target: m.target, unit: "class types" },
    });
  });

  // The "resilience" track (Comeback + Back for good) was REMOVED on Noe's
  // instruction, 2026-08-20. Both badges keyed off a ≥30-day absence, so the
  // pair went together: "Back for good" is meaningless without a break to
  // come back from. Nothing else derives from a gap in attendance.

  return badges;
}

/** What the Milestones card actually renders. */
export type VisibleBadges = {
  /** Earned, most recent first, capped. */
  earned: MemberBadge[];
  /** The single next rung in each track, closest first, capped. */
  next: MemberBadge[];
  /** Every badge earned, including those not shown. */
  earnedTotal: number;
  /** How many badges "show all" would reveal. */
  hiddenCount: number;
};

/**
 * Chooses which badges are worth a member's attention right now.
 *
 * Kept separate from `computeBadges` on purpose: that function states what is
 * TRUE and gains no knowledge of display, so "why can't I see my badge?" can
 * never be a server bug. This one is pure and lives in lib/ (not the
 * component) so it can be unit-tested without React and shared by the member
 * and kid surfaces without them drifting.
 *
 * Two rules do the work:
 *
 * 1. A locked badge is only a candidate when its tier is exactly one above the
 *    highest earned in its track. That is what stops a day-one member being
 *    shown "250 classes — 1 of 250".
 * 2. A badge with `progress: null` is never a locked candidate — the escape
 *    hatch for any badge that should not be dangled as a goal. No badge uses
 *    it today; the resilience track that did was removed on 2026-08-20.
 */
export function selectVisibleBadges(
  badges: MemberBadge[],
  opts?: { maxEarned?: number; maxNext?: number },
): VisibleBadges {
  const maxEarned = opts?.maxEarned ?? 6;
  const maxNext = opts?.maxNext ?? 3;

  const allEarned = badges.filter((b) => b.earned);
  // Recency first, so a five-year member leads with their hardest badges
  // rather than "First class" from years ago.
  const earned = [...allEarned]
    .sort((a, b) => (b.earnedAt ?? "").localeCompare(a.earnedAt ?? "") || b.tier - a.tier)
    .slice(0, maxEarned);

  const highestByTrack = new Map<BadgeTrack, number>();
  for (const b of allEarned) {
    highestByTrack.set(b.track, Math.max(highestByTrack.get(b.track) ?? 0, b.tier));
  }

  const next = badges
    .filter((b) => !b.earned && b.progress !== null && b.tier === (highestByTrack.get(b.track) ?? 0) + 1)
    .sort((a, b) => {
      // Volume always leads. It is the spine of the feature and the ladder
      // members actually think in ("my first 10 classes"), and on a pure
      // closest-first sort it loses every time — 1 of 10 is a worse ratio than
      // 1 of 3, so the headline goal would be crowded out by side quests.
      const va = a.track === "volume" ? 0 : 1;
      const vb = b.track === "volume" ? 0 : 1;
      if (va !== vb) return va - vb;
      const ra = a.progress!.current / a.progress!.target;
      const rb = b.progress!.current / b.progress!.target;
      // Then closest to done; then the smaller goal, so early members get
      // something reachable rather than several equally distant zeros.
      return rb - ra || a.progress!.target - b.progress!.target;
    })
    .slice(0, maxNext);

  return {
    earned,
    next,
    earnedTotal: allEarned.length,
    hiddenCount: badges.length - earned.length - next.length,
  };
}

// ─── 12-week heat strip ──────────────────────────────────────────────────────

/**
 * Buckets the supplied check-ins (must cover at least the last 12 Monday-based
 * weeks — the 90-day byClassAgg window does) into the last 12 weeks, oldest
 * first, current week last. Each bucket carries that week's attended class
 * names + check-in dates so the client can expand a week without refetching.
 */
export function computeWeeklyCounts(
  rows: { checkInTime: Date; className: string | null }[],
  now: Date,
): WeeklyCount[] {
  const currentMonday = new Date(`${getWeekKey(now)}T00:00:00.000Z`);
  const buckets = new Map<string, WeeklyCount>();
  const order: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(currentMonday);
    d.setUTCDate(currentMonday.getUTCDate() - i * 7);
    const key = d.toISOString().split("T")[0];
    order.push(key);
    buckets.set(key, { weekStart: key, count: 0, classes: [] });
  }
  for (const r of rows) {
    const bucket = buckets.get(getWeekKey(r.checkInTime));
    if (!bucket) continue;
    bucket.count += 1;
    bucket.classes.push({ name: r.className ?? "Check-in", date: r.checkInTime.toISOString() });
  }
  for (const key of order) {
    buckets.get(key)!.classes.sort((a, b) => a.date.localeCompare(b.date));
  }
  return order.map((key) => buckets.get(key)!);
}
