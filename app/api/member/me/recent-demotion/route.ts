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

      for (const row of rows) {
        if (!row.fromRankId) continue; // initial assignment, not a demotion
        const [fromR, toR] = await Promise.all([
          tx.rankSystem.findUnique({ where: { id: row.fromRankId }, select: { order: true, discipline: true, name: true } }),
          tx.rankSystem.findUnique({ where: { id: row.toRankId }, select: { order: true, discipline: true, name: true } }),
        ]);
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
