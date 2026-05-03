-- RLS Foundation: tenant-isolation policies on every tenant-scoped table.
--
-- This migration ONLY CREATES POLICIES. It does NOT enable Row Level Security.
-- Policies are dormant until a follow-up migration runs ENABLE + FORCE
-- ROW LEVEL SECURITY on each table — which only happens after every API
-- handler has been migrated to use withTenantContext() from
-- lib/prisma-tenant.ts.
--
-- Each policy permits a row when EITHER:
--   * the connection has set app.bypass_rls = 'on' (system / migration / cron), OR
--   * the connection's app.current_tenant_id matches the row's tenantId.
--
-- Use SELECT set_config('app.current_tenant_id', '<tenant_cuid>', true) inside
-- a transaction to scope queries to one tenant. The third arg = true makes the
-- setting transaction-local — required for pgbouncer transaction-mode pooling.
--
-- Tables NOT covered (intentional):
--   * StripeEvent, RateLimitHit — global, no tenancy concept.
--   * GymApplication — public submission with no tenant association yet.

-- ─── Tenant: special policy (no tenantId column — uses id directly) ──────────

CREATE POLICY tenant_isolation ON "Tenant" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR id = current_setting('app.current_tenant_id', true)
  );

-- ─── Tables with a tenantId column ───────────────────────────────────────────

CREATE POLICY tenant_isolation ON "User" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "Member" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "RankSystem" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "RankRequirement" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "Class" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "AttendanceRecord" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "Notification" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "Announcement" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "AuditLog" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "SignedWaiver" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "MagicLinkToken" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "PasswordResetToken" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "Initiative" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "GoogleDriveConnection" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "IndexedDriveFile" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "ImportJob" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "ClassPack" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "MemberClassPack" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "EmailLog" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "Payment" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "Dispute" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "MonthlyReport" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "Order" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "Product" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE POLICY tenant_isolation ON "MembershipTier" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

-- ─── Join tables (no tenantId column — joined through parent) ───────────────

CREATE POLICY tenant_isolation ON "MemberRank" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "Member"
      WHERE "Member".id = "MemberRank"."memberId"
        AND "Member"."tenantId" = current_setting('app.current_tenant_id', true)
    )
  );

CREATE POLICY tenant_isolation ON "RankHistory" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "MemberRank"
      JOIN "Member" ON "Member".id = "MemberRank"."memberId"
      WHERE "MemberRank".id = "RankHistory"."memberRankId"
        AND "Member"."tenantId" = current_setting('app.current_tenant_id', true)
    )
  );

CREATE POLICY tenant_isolation ON "ClassSchedule" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "Class"
      WHERE "Class".id = "ClassSchedule"."classId"
        AND "Class"."tenantId" = current_setting('app.current_tenant_id', true)
    )
  );

CREATE POLICY tenant_isolation ON "ClassInstance" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "Class"
      WHERE "Class".id = "ClassInstance"."classId"
        AND "Class"."tenantId" = current_setting('app.current_tenant_id', true)
    )
  );

CREATE POLICY tenant_isolation ON "ClassSubscription" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "Member"
      WHERE "Member".id = "ClassSubscription"."memberId"
        AND "Member"."tenantId" = current_setting('app.current_tenant_id', true)
    )
  );

CREATE POLICY tenant_isolation ON "ClassWaitlist" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "Member"
      WHERE "Member".id = "ClassWaitlist"."memberId"
        AND "Member"."tenantId" = current_setting('app.current_tenant_id', true)
    )
  );

CREATE POLICY tenant_isolation ON "ClassPackRedemption" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "MemberClassPack"
      WHERE "MemberClassPack".id = "ClassPackRedemption"."memberPackId"
        AND "MemberClassPack"."tenantId" = current_setting('app.current_tenant_id', true)
    )
  );

CREATE POLICY tenant_isolation ON "PasswordHistory" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "User"
      WHERE "User".id = "PasswordHistory"."userId"
        AND "User"."tenantId" = current_setting('app.current_tenant_id', true)
    )
  );

CREATE POLICY tenant_isolation ON "InitiativeAttachment" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM "Initiative"
      WHERE "Initiative".id = "InitiativeAttachment"."initiativeId"
        AND "Initiative"."tenantId" = current_setting('app.current_tenant_id', true)
    )
  );
