/**
 * GET /api/member/me/recent-demotion
 *
 * Task 15 (rank/access spec): backs the member-home demotion banner.
 *
 * Returns the member's most recent demotion within the last 14 days, if any.
 * A "demotion" is detected as a RankHistory row where the toRank's `order`
 * is strictly LESS than the fromRank's `order` (within the same discipline).
 * Used to render an in-app banner so the member learns immediately why some
 * class subscriptions disappeared.
 *
 * Response: `{ demoted: false }` OR
 *   `{ demoted: true, rankName: "White", discipline: "BJJ", at: "2026-05-09T..." }`.
 *
 * The banner UI dismisses via localStorage (no server-side dismiss state — too
 * much for v1; stale row falls off naturally when achievedAt > 14 days).
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

const WINDOW_DAYS = 14;

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const memberId = session.user.memberId;
  if (!memberId) return NextResponse.json({ demoted: false });

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  try {
    const recent = await withTenantContext(session.user.tenantId, async (tx) => {
      // Pull recent RankHistory rows for this member; resolve from/to rank order
      // to detect demotion direction.
      const rows = await tx.rankHistory.findMany({
        where: {
          memberRank: { memberId },
          promotedAt: { gte: since },
        },
        include: {
          memberRank: true,
        },
        orderBy: { promotedAt: "desc" },
        take: 5,
      });

      if (rows.length === 0) return { demoted: false as const };

      // Audit iter-2 A5I2-P-1: collapse the per-row N+1 lookup.
      // Was: up to 10 sequential rankSystem.findUnique trips (one Promise.all
      // pair per RankHistory row). Now: 1 bulk findMany covering every
      // from/to ID across all rows + an in-memory Map lookup. Worst case
      // (5 rows, all with fromRankId set) drops from 11 round-trips to 2.
      const allRankIds = new Set<string>();
      for (const row of rows) {
        if (row.fromRankId) allRankIds.add(row.fromRankId);
        allRankIds.add(row.toRankId);
      }
      const ranks = await tx.rankSystem.findMany({
        where: { id: { in: Array.from(allRankIds) } },
        select: { id: true, order: true, discipline: true, name: true },
      });
      const rankMap = new Map(ranks.map((r) => [r.id, r]));

      for (const row of rows) {
        if (!row.fromRankId) continue; // initial assignment, not a demotion
        const fromR = rankMap.get(row.fromRankId);
        const toR = rankMap.get(row.toRankId);
        if (!fromR || !toR) continue;
        if (toR.order < fromR.order) {
          return {
            demoted: true,
            rankName: toR.name,
            discipline: toR.discipline,
            at: row.promotedAt.toISOString(),
            historyId: row.id,
          };
        }
      }
      return { demoted: false as const };
    });

    return NextResponse.json(recent);
  } catch {
    return NextResponse.json({ demoted: false });
  }
}
