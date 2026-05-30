-- Audit iteration 1 fixes for the Task table:
--   C-2: enable Row Level Security with tenant_isolation policy (mirror existing
--        pattern from PushSubscription, MemberPhoto, LoginEvent migrations).
--        Without this, the application-layer withTenantContext filter is the
--        ONLY tenant boundary on Task — every other tenant-scoped table has
--        a DB-level backstop.
--   H-6: add the missing composite index on (tenantId, status, createdById).
--        The GET /api/tasks query filters on (assignedToId = me OR
--        createdById = me); the existing (tenantId, status, assignedToId)
--        index covers the first arm, but the createdById arm fell back to
--        a sequential scan.

ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Task" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Task" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

CREATE INDEX "Task_tenantId_status_createdById_idx"
  ON "Task"("tenantId", "status", "createdById");
