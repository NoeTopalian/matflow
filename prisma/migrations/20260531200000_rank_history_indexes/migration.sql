-- Audit iter-2-member-surface A5I2-P-1: index RankHistory.
--
-- Backs GET /api/member/me/recent-demotion (every member-home page load runs a
-- relation-filtered scan: WHERE memberRank.memberId = ? AND promotedAt >= ?
-- ORDER BY promotedAt DESC LIMIT 5). Without these indexes the planner falls
-- back to a sequential scan on RankHistory, which doesn't matter at single-
-- tenant demo volumes but breaks once we cross ~500 members × ~5 rank events
-- (= 2.5k rows scanned per home load × every active member).
--
-- IF NOT EXISTS guards keep the migration idempotent — safe to apply against
-- a freshly-pulled test branch that may have already-divergent state from
-- earlier `prisma db push` runs.

CREATE INDEX IF NOT EXISTS "RankHistory_memberRankId_idx" ON "RankHistory"("memberRankId");
CREATE INDEX IF NOT EXISTS "RankHistory_promotedAt_idx" ON "RankHistory"("promotedAt");
