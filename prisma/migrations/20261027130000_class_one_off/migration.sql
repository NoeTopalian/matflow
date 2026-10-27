-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- G4 (owner, 27 Oct 2026): "If they want to do another class, they'd have to
-- discuss with a coach, for example, and maybe that coach will include them on
-- a one-off session."
--
-- A coach's one-off: a staff user admits a named member to ONE session from
-- its register, with a reason. It is the record of who allowed it and why, tied
-- to the attendance row it admitted. Deleting that attendance row (an unmark,
-- an undo) deletes the one-off with it (ON DELETE CASCADE), so the member's
-- count recomputes from the rows that remain.
--
-- Expand-only. A new table nothing existing reads or writes: the previous
-- build ignores it, and its attendance deletes still succeed (the cascade is
-- the database's, not the application's).

CREATE TABLE "ClassOneOff" (
    "id"                 TEXT NOT NULL,
    "tenantId"           TEXT NOT NULL,
    "classInstanceId"    TEXT NOT NULL,
    "memberId"           TEXT NOT NULL,
    "attendanceRecordId" TEXT NOT NULL,
    "grantedById"        TEXT,
    "reason"             TEXT NOT NULL,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClassOneOff_pkey" PRIMARY KEY ("id"),
    -- The reason as typed (trimmed by the route): 3 to 200 characters.
    CONSTRAINT "ClassOneOff_reason_length" CHECK (char_length("reason") BETWEEN 3 AND 200)
);

CREATE UNIQUE INDEX "ClassOneOff_attendanceRecordId_key" ON "ClassOneOff"("attendanceRecordId");
CREATE INDEX "ClassOneOff_tenantId_memberId_idx" ON "ClassOneOff"("tenantId", "memberId");
CREATE INDEX "ClassOneOff_classInstanceId_idx" ON "ClassOneOff"("classInstanceId");
CREATE INDEX "ClassOneOff_grantedById_idx" ON "ClassOneOff"("grantedById");

-- Tenant RESTRICT (as ClassMembershipTier): the retention purge deletes these
-- rows before the tenant. The attendance row, the session and the member
-- CASCADE (a one-off means nothing without the visit it admitted); the staff
-- user who granted it SET NULL, as AttendanceRecord.checkedInById.
ALTER TABLE "ClassOneOff" ADD CONSTRAINT "ClassOneOff_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassOneOff" ADD CONSTRAINT "ClassOneOff_attendanceRecordId_fkey"
  FOREIGN KEY ("attendanceRecordId") REFERENCES "AttendanceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClassOneOff" ADD CONSTRAINT "ClassOneOff_classInstanceId_fkey"
  FOREIGN KEY ("classInstanceId") REFERENCES "ClassInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClassOneOff" ADD CONSTRAINT "ClassOneOff_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClassOneOff" ADD CONSTRAINT "ClassOneOff_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Row-level security, same shape as every tenant table (rls_policies_foundation).
ALTER TABLE "ClassOneOff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassOneOff" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ClassOneOff" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

COMMIT;
