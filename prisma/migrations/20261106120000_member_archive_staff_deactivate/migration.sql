-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- PR 3 (6 Nov 2026): removing a member archives them; removing a staff
-- account deactivates it. Expand-only and nullable: no row is rewritten,
-- nothing is dropped, and code from before this migration ignores the columns.

ALTER TABLE "User" ADD COLUMN "deactivatedAt" TIMESTAMP(3);

ALTER TABLE "Member" ADD COLUMN "archivedAt" TIMESTAMP(3),
ADD COLUMN "archivedById" TEXT;

CREATE INDEX "Member_tenantId_archivedAt_idx" ON "Member"("tenantId", "archivedAt");

ALTER TABLE "Member" ADD CONSTRAINT "Member_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
