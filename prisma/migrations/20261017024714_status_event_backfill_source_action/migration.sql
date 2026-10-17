-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- T8b (17 Oct 2026): widen the MemberStatusEvent.sourceAction CHECK from
-- {import_create, import_refresh, import_rollback} (migration
-- 20261017022302_status_event_source_provenance) to add import_backfill: the
-- source-dated history the T8b back-fill reconstructs from a job's TeamUp
-- ledger. The back-fill keys its idempotency ("already applied") and its
-- rollback on this value, so it must be distinct from the create, refresh and
-- rollback events of the same job. The canonical list is
-- MEMBER_STATUS_EVENT_SOURCE_ACTIONS in lib/member-status.ts.
--
-- Additive in effect: every existing row already satisfies the wider set, and
-- a build from before this migration never writes import_backfill (it writes
-- the first three, or null). Same drop-and-re-add pattern as
-- 20260923220000_billing_cycle_weekly; both statements run in this one
-- transaction, so there is no moment without a CHECK. No column, table, index
-- or policy changes; no row is written here.

ALTER TABLE "MemberStatusEvent" DROP CONSTRAINT IF EXISTS "MemberStatusEvent_sourceAction_check";

ALTER TABLE "MemberStatusEvent"
  ADD CONSTRAINT "MemberStatusEvent_sourceAction_check"
  CHECK ("sourceAction" IN ('import_create', 'import_refresh', 'import_rollback', 'import_backfill')) NOT VALID;

ALTER TABLE "MemberStatusEvent" VALIDATE CONSTRAINT "MemberStatusEvent_sourceAction_check";

COMMIT;
