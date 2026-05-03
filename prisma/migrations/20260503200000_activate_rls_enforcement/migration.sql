-- RLS Activation: turn on the dormant policies created in 20260503100000.
--
-- After this migration:
--   * Every Prisma query against a tenant-scoped table MUST run inside
--     `withTenantContext(tenantId, ...)` or `withRlsBypass(...)`.
--   * Queries through the bare `prisma` client without a context will
--     return zero rows (for SELECT) or fail (for write paths) because
--     the GUC `app.current_tenant_id` is NULL.
--
-- Pre-flight checklist before deploying this migration:
--   1. All app code uses `withTenantContext` / `withRlsBypass` (verified by
--      `grep -rn "import.*prisma.*from.*lib/prisma" app/api lib` returning
--      only lib/rate-limit.ts, app/api/settings/route.ts (type-only),
--      app/api/health/route.ts).
--   2. `tests/integration/rls-foundation.test.ts` passes against the
--      target database.
--   3. `prisma migrate deploy` is part of `npm run build` — this migration
--      will auto-apply on the next deploy. Stage it first (Vercel preview)
--      and smoke-test before promoting.
--
-- Rollback (run by hand if something breaks):
--   ALTER TABLE "Tenant" NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE "Tenant" DISABLE ROW LEVEL SECURITY;
--   -- … repeat for every table below
--
-- The policies remain in place after rollback, so re-activation is just the
-- ENABLE + FORCE pair again.

-- ─── Tenant (special: policy uses id, not tenantId) ──────────────────────────

ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tenant" FORCE ROW LEVEL SECURITY;

-- ─── Tables with a tenantId column ───────────────────────────────────────────

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "User" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Member" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Member" FORCE ROW LEVEL SECURITY;

ALTER TABLE "RankSystem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RankSystem" FORCE ROW LEVEL SECURITY;

ALTER TABLE "RankRequirement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RankRequirement" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Class" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Class" FORCE ROW LEVEL SECURITY;

ALTER TABLE "AttendanceRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceRecord" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Announcement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Announcement" FORCE ROW LEVEL SECURITY;

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;

ALTER TABLE "SignedWaiver" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SignedWaiver" FORCE ROW LEVEL SECURITY;

ALTER TABLE "MagicLinkToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MagicLinkToken" FORCE ROW LEVEL SECURITY;

ALTER TABLE "PasswordResetToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PasswordResetToken" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Initiative" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Initiative" FORCE ROW LEVEL SECURITY;

ALTER TABLE "GoogleDriveConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GoogleDriveConnection" FORCE ROW LEVEL SECURITY;

ALTER TABLE "IndexedDriveFile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IndexedDriveFile" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ImportJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ImportJob" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ClassPack" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassPack" FORCE ROW LEVEL SECURITY;

ALTER TABLE "MemberClassPack" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MemberClassPack" FORCE ROW LEVEL SECURITY;

ALTER TABLE "EmailLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailLog" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Payment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Payment" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Dispute" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Dispute" FORCE ROW LEVEL SECURITY;

ALTER TABLE "MonthlyReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MonthlyReport" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;

ALTER TABLE "Product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Product" FORCE ROW LEVEL SECURITY;

ALTER TABLE "MembershipTier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MembershipTier" FORCE ROW LEVEL SECURITY;

-- ─── Join tables (no tenantId column — joined through parent) ───────────────

ALTER TABLE "MemberRank" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MemberRank" FORCE ROW LEVEL SECURITY;

ALTER TABLE "RankHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RankHistory" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ClassSchedule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassSchedule" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ClassInstance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassInstance" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ClassSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassSubscription" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ClassWaitlist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassWaitlist" FORCE ROW LEVEL SECURITY;

ALTER TABLE "ClassPackRedemption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ClassPackRedemption" FORCE ROW LEVEL SECURITY;

ALTER TABLE "PasswordHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PasswordHistory" FORCE ROW LEVEL SECURITY;

ALTER TABLE "InitiativeAttachment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InitiativeAttachment" FORCE ROW LEVEL SECURITY;
