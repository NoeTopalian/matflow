-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Session cover (Noe, 26 Nov 2026): who teaches ONE dated session when its regular coach is away or it has none.
--
-- Expand-only. No data is written and no existing table changes: every session keeps exactly the coach its class
-- has. Promoting back to the previous build is safe only while this table is EMPTY: the previous build deletes
-- sessions (weekly-slot edit, import rollback) and clubs (purge) without touching SessionCover, so once a cover row
-- exists those deletes fail on its RESTRICT keys. Before going back, export and remove the cover rows first
-- (docs/runbooks/SESSION-COVER-ROLLBACK.md, scripts/session-cover-rollback.mjs).

CREATE TABLE "SessionCover" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "classInstanceId" TEXT,
    "status" TEXT NOT NULL,
    "coverUserId" TEXT,
    "requestedById" TEXT NOT NULL,
    "needsReconfirm" BOOLEAN NOT NULL DEFAULT false,
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionCover_pkey" PRIMARY KEY ("id"),
    -- The four states, and what each one carries: a covered row names its coach and only a covered row does; only a
    -- covered row can be waiting for its coach to reconfirm; only an ended row may have lost its session.
    CONSTRAINT "SessionCover_status_check" CHECK ("status" IN ('open', 'covered', 'withdrawn', 'closed')),
    CONSTRAINT "SessionCover_cover_coach_check" CHECK (("status" = 'covered') = ("coverUserId" IS NOT NULL)),
    CONSTRAINT "SessionCover_reconfirm_check" CHECK (NOT "needsReconfirm" OR "status" = 'covered'),
    CONSTRAINT "SessionCover_session_check" CHECK ("classInstanceId" IS NOT NULL OR "status" IN ('withdrawn', 'closed'))
);

-- One cover row per dated session.
CREATE UNIQUE INDEX "SessionCover_classInstanceId_key" ON "SessionCover"("classInstanceId");
CREATE INDEX "SessionCover_tenantId_status_idx" ON "SessionCover"("tenantId", "status");
CREATE INDEX "SessionCover_tenantId_coverUserId_idx" ON "SessionCover"("tenantId", "coverUserId");

-- RESTRICT everywhere (as Mat): the writers that remove a session, a person or a club move, close or delete the
-- cover row first (lib/session-cover.ts, lib/attendance-import.ts, lib/tenant-purge.ts); nothing removes it silently.
ALTER TABLE "SessionCover" ADD CONSTRAINT "SessionCover_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SessionCover" ADD CONSTRAINT "SessionCover_classInstanceId_fkey" FOREIGN KEY ("classInstanceId") REFERENCES "ClassInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SessionCover" ADD CONSTRAINT "SessionCover_coverUserId_fkey" FOREIGN KEY ("coverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SessionCover" ADD CONSTRAINT "SessionCover_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security, same shape as every tenant table (rls_policies_foundation, mats, class categories).
ALTER TABLE "SessionCover" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SessionCover" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "SessionCover" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

COMMIT;
