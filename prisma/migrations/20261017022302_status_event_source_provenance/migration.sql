-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- T8d (17 Oct 2026): status events written by a TeamUp import carry the job
-- that wrote them and what that job was doing (create, refresh, or a refresh
-- rollback), so a headcount or churn series built from events can be audited
-- per job and a back-fill can key on it.
--
-- Expand-only. Both columns are nullable with no default and no back-fill
-- here: every existing row reads as before, and a build from before this
-- migration (whose Prisma client never names these columns) keeps writing
-- events with both columns null. Never drop them while that build is a
-- rollback target. The provenance back-fill on existing create events is a
-- separate, idempotent script (scripts/backfill-status-event-provenance.ts),
-- run per club after this migration; it never touches "occurredAt".
--
-- Deliberately NO foreign key to "ImportJob": purging a job must not cascade
-- into, or block on, status history.
--
-- No new table, so no new RLS policy: the columns ride on tenant-scoped rows
-- already covered by the "MemberStatusEvent" tenant policy.

ALTER TABLE "MemberStatusEvent" ADD COLUMN "sourceJobId" TEXT,
ADD COLUMN "sourceAction" TEXT;

-- NOT VALID then VALIDATE: the constraint is added without a full-table check
-- under the ALTER's lock, then checked. Every existing row is null, so it
-- validates trivially.
ALTER TABLE "MemberStatusEvent"
  ADD CONSTRAINT "MemberStatusEvent_sourceAction_check"
  CHECK ("sourceAction" IN ('import_create', 'import_refresh', 'import_rollback')) NOT VALID;

ALTER TABLE "MemberStatusEvent" VALIDATE CONSTRAINT "MemberStatusEvent_sourceAction_check";

-- Non-concurrent because it runs inside the transaction; the table is small.
CREATE INDEX "MemberStatusEvent_tenantId_sourceJobId_idx" ON "MemberStatusEvent"("tenantId", "sourceJobId");

COMMIT;
