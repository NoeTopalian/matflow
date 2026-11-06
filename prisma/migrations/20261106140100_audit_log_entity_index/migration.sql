-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Speed quick win 2h (6 Nov 2026): look-ups of one thing's history —
-- `WHERE "tenantId" = $1 AND "entityType" = $2 AND "entityId" = $3` (the
-- activity feed's member deletions, the DSAR export and count, tenant
-- lifecycle checks) — had only ("tenantId", "createdAt") to go on and read
-- every audit row of the club.
--
-- A plain build inside the wrapper: the table is small, and a build that
-- cannot finish within the bounds fails the deploy with nothing applied
-- rather than stalling it. Its own file, so no other table waits on it.
CREATE INDEX "AuditLog_tenantId_entityType_entityId_idx" ON "AuditLog"("tenantId", "entityType", "entityId");

COMMIT;
