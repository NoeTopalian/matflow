-- US-6: align LoginEvent foreign keys with prisma/schema.prisma.
--
-- The original migration 20260504000000_login_events created the table but
-- never emitted the ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY statements,
-- even though schema.prisma declares both relations with onDelete: Cascade.
-- This is the "Lane 3" finding from the deep-dive trace at
-- `.omc/specs/deep-dive-trace-audit-the-entire-kids-account.md`.
--
-- The migration is idempotent: it drops any pre-existing FK first so it's
-- safe to run against databases where someone hot-fixed the constraints
-- outside the migration history. The DO blocks guard against the no-such-
-- constraint error path.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'LoginEvent'
      AND constraint_name = 'LoginEvent_userId_fkey'
  ) THEN
    ALTER TABLE "LoginEvent" DROP CONSTRAINT "LoginEvent_userId_fkey";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'LoginEvent'
      AND constraint_name = 'LoginEvent_memberId_fkey'
  ) THEN
    ALTER TABLE "LoginEvent" DROP CONSTRAINT "LoginEvent_memberId_fkey";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'LoginEvent'
      AND constraint_name = 'LoginEvent_tenantId_fkey'
  ) THEN
    ALTER TABLE "LoginEvent" DROP CONSTRAINT "LoginEvent_tenantId_fkey";
  END IF;
END $$;

ALTER TABLE "LoginEvent"
  ADD CONSTRAINT "LoginEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoginEvent"
  ADD CONSTRAINT "LoginEvent_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoginEvent"
  ADD CONSTRAINT "LoginEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
