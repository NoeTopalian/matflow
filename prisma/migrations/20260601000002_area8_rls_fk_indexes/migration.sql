-- Audit iter-1-database Batch A + Batch B combined migration:
--   A8I1-S-1 / V-1 [Critical]: ClassRoster ENABLE+FORCE RLS + tenant_isolation policy
--   A8I1-V-2 [Critical]: Task.createdById + Task.assignedToId ON DELETE SET NULL
--   A8I1-V-4 [High]: PasswordHistory.userId ON DELETE CASCADE
--   A8I1-V-3 / P-3 [High, closes A7I1-P-4]: EmailLog composite index for bounce-check
--   A8I1-S-4 / S-9 [High]: Member partial unique on (tenantId, stripeCustomerId)
--   A8I1-P-9 + P-12 [Medium]: ClassWaitlist + ClassSubscription indexes
--
-- All ALTER TABLE FK changes are idempotent via DROP CONSTRAINT IF EXISTS.
-- CREATE INDEX IF NOT EXISTS guards against test-branch divergence.

-- ─────────────────────────────────────────────────────────────────────────
-- A8I1-S-1 / V-1: ClassRoster RLS
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "ClassRoster" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassRoster" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ClassRoster";
CREATE POLICY tenant_isolation ON "ClassRoster" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

-- ─────────────────────────────────────────────────────────────────────────
-- A8I1-V-2: Task FK SET NULL
-- Note: schema declares both columns as required; this migration makes them
-- nullable in the DB to support SET NULL semantics. The schema change in the
-- same audit batch matches this column nullability.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "Task" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "Task" ALTER COLUMN "assignedToId" DROP NOT NULL;
ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_createdById_fkey";
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_assignedToId_fkey";
ALTER TABLE "Task" ADD CONSTRAINT "Task_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- A8I1-V-4: PasswordHistory.userId ON DELETE CASCADE
-- Password history has no meaning without the user; cascade.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "PasswordHistory" DROP CONSTRAINT IF EXISTS "PasswordHistory_userId_fkey";
ALTER TABLE "PasswordHistory" ADD CONSTRAINT "PasswordHistory_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- A8I1-V-3 / P-3 (closes deferred A7I1-P-4): EmailLog bounce-check composite
-- Backs lib/email.ts findFirst on (tenantId, recipient, status, createdAt).
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "EmailLog_tenantId_recipient_status_createdAt_idx"
  ON "EmailLog"("tenantId", "recipient", "status", "createdAt");

-- ─────────────────────────────────────────────────────────────────────────
-- A8I1-S-4 / S-9: Member partial unique on (tenantId, stripeCustomerId)
-- Prevents the cross-tenant collision that S-4 weaponises in the Stripe
-- webhook's no-tenant fallback. WHERE clause skips NULL customer IDs.
-- ─────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "Member_tenantId_stripeCustomerId_unique"
  ON "Member"("tenantId", "stripeCustomerId")
  WHERE "stripeCustomerId" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- A8I1-P-9: ClassWaitlist composite indexes
-- Coach register view + waitlist promotion logic both scan by classInstanceId.
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "ClassWaitlist_classInstanceId_idx"
  ON "ClassWaitlist"("classInstanceId");
CREATE INDEX IF NOT EXISTS "ClassWaitlist_classInstanceId_status_idx"
  ON "ClassWaitlist"("classInstanceId", "status");

-- ─────────────────────────────────────────────────────────────────────────
-- A8I1-P-12: ClassSubscription standalone classId index
-- Notification fan-out on class cancellation must fetch all subscribers by
-- classId. The unique (memberId, classId) doesn't serve a classId-only filter.
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "ClassSubscription_classId_idx"
  ON "ClassSubscription"("classId");
