-- Payments lane PD (11 Oct 2026): durable Stripe event store + reconcile runs.
-- Additive only. Existing StripeEvent rows were claimed in the same transaction
-- as their handler, so every one of them is a PROCESSED event: they are
-- backfilled as such (status processed, one attempt, first seen = processedAt).
BEGIN;


-- StripeEvent: new columns. status/attempts are added with the backfill value
-- as default, then the default is moved to the value new rows take.
ALTER TABLE "StripeEvent" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "created" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "livemode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "objectId" TEXT,
ADD COLUMN     "reconcileFoundAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'processed',
ADD COLUMN     "stripeAccountId" TEXT,
ADD COLUMN     "tenantId" TEXT;

UPDATE "StripeEvent" SET "firstSeenAt" = "processedAt", "lastAttemptAt" = "processedAt";

ALTER TABLE "StripeEvent" ALTER COLUMN "status" SET DEFAULT 'received';
ALTER TABLE "StripeEvent" ALTER COLUMN "attempts" SET DEFAULT 0;

ALTER TABLE "StripeEvent" ADD CONSTRAINT "StripeEvent_status_check"
  CHECK ("status" IN ('received', 'processed', 'failed', 'ignored_foreign', 'ignored_stale', 'replayed'));
ALTER TABLE "StripeEvent" ADD CONSTRAINT "StripeEvent_attempts_check" CHECK ("attempts" >= 0);

-- CreateTable
CREATE TABLE "StripeReconcileRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "trigger" TEXT NOT NULL DEFAULT 'cron',
    "windowStart" TIMESTAMP(3) NOT NULL,
    "tenantsChecked" INTEGER NOT NULL DEFAULT 0,
    "tenantsSkipped" INTEGER NOT NULL DEFAULT 0,
    "eventsScanned" INTEGER NOT NULL DEFAULT 0,
    "eventsMissing" INTEGER NOT NULL DEFAULT 0,
    "stateMismatches" JSONB,
    "skipped" JSONB,
    "errors" JSONB,

    CONSTRAINT "StripeReconcileRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StripeReconcileRun_status_check" CHECK ("status" IN ('running', 'ok', 'mismatches', 'errors', 'skipped')),
    CONSTRAINT "StripeReconcileRun_trigger_check" CHECK ("trigger" IN ('cron', 'manual'))
);

-- CreateIndex
CREATE INDEX "StripeReconcileRun_startedAt_idx" ON "StripeReconcileRun"("startedAt");

-- CreateIndex
CREATE INDEX "StripeEvent_tenantId_status_idx" ON "StripeEvent"("tenantId", "status");

-- CreateIndex
CREATE INDEX "StripeEvent_status_lastAttemptAt_idx" ON "StripeEvent"("status", "lastAttemptAt");

-- Row-level security. StripeEvent now carries a tenantId, so it takes the same
-- backstop as every club table (rls_policies_foundation shape). A row whose
-- club is not yet known (tenantId NULL) is visible only under the bypass, which
-- is how the webhook, replay and reconcile paths all reach it.
ALTER TABLE "StripeEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StripeEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "StripeEvent" AS PERMISSIVE FOR ALL
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant_id', true));

-- StripeReconcileRun holds no club's own data but spans every club: operator
-- and cron only, so readable and writable only under the bypass.
ALTER TABLE "StripeReconcileRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StripeReconcileRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON "StripeReconcileRun" AS PERMISSIVE FOR ALL
  USING (current_setting('app.bypass_rls', true) = 'on');

COMMIT;
