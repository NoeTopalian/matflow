// Attendance leaderboard (M4) — recompute-on-read, no snapshot table.
//
// One `groupBy` on AttendanceRecord over the current calendar month (in the
// club's timezone), plus the same for the prior month so the board can show a
// "vs last month" movement arrow per member. Both queries lean on the existing
// composite index `@@index([tenantId, checkInTime])` — no new index is added.
//
// The whole thing is wrapped in a 60s `unstable_cache` so a TV left on the
// board does not re-scan attendance on every poll.
//
// PAYLOAD SAFETY: the returned entries carry a display name (first name + last
// initial ONLY) and a count. No ids, emails or photos ever leave this module.
// A photographed public TV must reveal nothing that identifies a member beyond
// what a poster on the wall already would. `Member.leaderboardOptOut` members
// are excluded ENTIRELY — both at the query level (a relation filter) and again
// in the pure `buildLeaderboard` below, so a regression on either layer is
// caught by the unit test rather than by a member finding themselves on a
// screen they opted off.

import { unstable_cache } from "next/cache";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { zoneOffsetMs, usableTimezone } from "@/lib/class-time";

/** A member's check-in tally for one month window. */
export type CheckInRow = { memberId: string; count: number };

/** The minimal member facts the board needs — never surfaced verbatim. */
export type MemberMeta = { id: string; name: string; leaderboardOptOut: boolean };

/**
 * Where this member sits versus last month.
 * `null` during cold start (no prior month to compare against).
 */
export type Movement = "up" | "down" | "same" | "new" | null;

/** One row of the public board. Deliberately id-free, email-free, photo-free. */
export type LeaderboardEntry = {
  rank: number;
  name: string;
  checkIns: number;
  movement: Movement;
};

export interface LeaderboardResult {
  /** e.g. "September 2026", rendered in the club's timezone. */
  monthLabel: string;
  /**
   * True when the prior month held no ranked attendance, so movement arrows
   * would be meaningless. The board then shows plain ranks and says movement
   * arrows start next month.
   */
  coldStart: boolean;
  entries: LeaderboardEntry[];
}

/**
 * Public-safe display name: first name + last initial only ("Alex J.").
 * A single-token name is shown as-is; an empty name falls back to "Anonymous"
 * rather than leaking a blank row.
 */
export function formatDisplayName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Anonymous";
  const first = parts[0];
  if (parts.length === 1) return first;
  const lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
  return `${first} ${lastInitial}.`;
}

/**
 * Opt-out-excluded, deterministically-ordered member ids for one window.
 * Sort is count DESC then memberId ASC — the tie-break is stable and does not
 * depend on database row order, so the same attendance always ranks the same.
 */
function rankMemberIds(rows: CheckInRow[], optOut: Set<string>, known: Set<string>): string[] {
  return rows
    .filter((r) => !optOut.has(r.memberId) && known.has(r.memberId))
    .slice()
    .sort((a, b) => b.count - a.count || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0))
    .map((r) => r.memberId);
}

/**
 * The pure core: given raw monthly tallies and member metadata, produce the
 * ranked, opt-out-excluded, name-masked board plus each member's movement.
 * No I/O — this is what the unit test drives red-on-revert.
 */
export function buildLeaderboard(params: {
  currentRows: CheckInRow[];
  priorRows: CheckInRow[];
  members: MemberMeta[];
  monthLabel: string;
}): LeaderboardResult {
  const optOut = new Set(params.members.filter((m) => m.leaderboardOptOut).map((m) => m.id));
  const nameById = new Map(params.members.map((m) => [m.id, m.name] as const));
  const known = new Set(nameById.keys());
  const countById = new Map(params.currentRows.map((r) => [r.memberId, r.count] as const));

  const currentOrder = rankMemberIds(params.currentRows, optOut, known);
  const priorOrder = rankMemberIds(params.priorRows, optOut, known);
  const priorRank = new Map(priorOrder.map((id, i) => [id, i + 1] as const));
  const coldStart = priorOrder.length === 0;

  const entries: LeaderboardEntry[] = currentOrder.map((id, i) => {
    const rank = i + 1;
    let movement: Movement = null;
    if (!coldStart) {
      const pr = priorRank.get(id);
      if (pr === undefined) movement = "new";
      else if (pr > rank) movement = "up";
      else if (pr < rank) movement = "down";
      else movement = "same";
    }
    return {
      rank,
      name: formatDisplayName(nameById.get(id) ?? ""),
      checkIns: countById.get(id) ?? 0,
      movement,
    };
  });

  return { monthLabel: params.monthLabel, coldStart, entries };
}

/**
 * Start of a calendar month in `timeZone`, as a UTC instant.
 *
 * `monthOffset` shifts by whole months (−1 = last month's start, +1 = next
 * month's start). The zone offset is read twice, exactly as `lib/class-time`'s
 * `parseTime` does, so a month boundary that lands on a DST changeover morning
 * still resolves to true local midnight.
 */
export function zonedMonthStart(now: Date, timeZone: string, monthOffset = 0): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === "year")?.value ?? 0);
  const month = Number(parts.find((p) => p.type === "month")?.value ?? 1); // 1–12
  const naive = Date.UTC(year, month - 1 + monthOffset, 1, 0, 0, 0, 0);
  const firstOffset = zoneOffsetMs(new Date(naive), timeZone);
  const secondOffset = zoneOffsetMs(new Date(naive - firstOffset), timeZone);
  return new Date(naive - secondOffset);
}

/**
 * The uncached aggregate. Runs under `withRlsBypass` because the public board
 * has no session — the application-layer `where: { tenantId }` filter is still
 * present on every query (CLAUDE.md: RLS is the backstop, not the primary
 * defence).
 */
async function computeLeaderboard(tenantId: string, timeZoneRaw: string | null): Promise<LeaderboardResult> {
  const timeZone = usableTimezone(timeZoneRaw);
  const now = new Date();
  const currentStart = zonedMonthStart(now, timeZone, 0);
  const nextStart = zonedMonthStart(now, timeZone, 1);
  const priorStart = zonedMonthStart(now, timeZone, -1);

  const { currentRows, priorRows, members } = await withRlsBypass(async (tx) => {
    const [cur, prev] = await Promise.all([
      tx.attendanceRecord.groupBy({
        by: ["memberId"],
        where: {
          tenantId,
          checkInTime: { gte: currentStart, lt: nextStart },
          member: { leaderboardOptOut: false },
        },
        _count: { _all: true },
      }),
      tx.attendanceRecord.groupBy({
        by: ["memberId"],
        where: {
          tenantId,
          checkInTime: { gte: priorStart, lt: currentStart },
          member: { leaderboardOptOut: false },
        },
        _count: { _all: true },
      }),
    ]);

    const ids = Array.from(new Set([...cur, ...prev].map((r) => r.memberId)));
    const mem = ids.length
      ? await tx.member.findMany({
          where: { tenantId, id: { in: ids } },
          select: { id: true, name: true, leaderboardOptOut: true },
        })
      : [];

    return {
      currentRows: cur.map((r) => ({ memberId: r.memberId, count: r._count._all })),
      priorRows: prev.map((r) => ({ memberId: r.memberId, count: r._count._all })),
      members: mem,
    };
  });

  const monthLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    month: "long",
    year: "numeric",
  }).format(currentStart);

  return buildLeaderboard({ currentRows, priorRows, members, monthLabel });
}

/**
 * 60-second cached read of the public board. Keyed by tenant + timezone; the
 * `leaderboard-<tenantId>` tag lets a future settings save bust it early via
 * `revalidateTag`, mirroring the branding cache.
 */
export function getLeaderboard(tenantId: string, timeZone: string | null): Promise<LeaderboardResult> {
  return unstable_cache(
    () => computeLeaderboard(tenantId, timeZone),
    ["leaderboard", tenantId, timeZone ?? "default"],
    { revalidate: 60, tags: [`leaderboard-${tenantId}`] },
  )();
}
