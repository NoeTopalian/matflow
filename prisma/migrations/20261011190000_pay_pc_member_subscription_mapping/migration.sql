-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Payments lane PC (11 Oct 2026): the verified member <-> Stripe subscription
-- mapping. The webhook resolves subscription and invoice events through this
-- table instead of through the Stripe customer, so another platform's
-- subscription on the same customer (the TeamUp replace window) can never move
-- a member. Additive only: no existing row changes.

-- The backfill below reads "Member", which is under FORCE ROW LEVEL SECURITY.
-- Transaction-local (third argument true): it ends at COMMIT and cannot leak
-- through the pooler to another session.
SELECT set_config('app.bypass_rls', 'on', true);

-- CreateTable
CREATE TABLE "MemberSubscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "stripeAccountId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3),
    "lastEventCreated" INTEGER,
    "requiresActionInvoiceId" TEXT,
    "requiresActionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "MemberSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberSubscription_stripeSubscriptionId_key" ON "MemberSubscription"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "MemberSubscription_tenantId_memberId_idx" ON "MemberSubscription"("tenantId", "memberId");

-- AddForeignKey
ALTER TABLE "MemberSubscription" ADD CONSTRAINT "MemberSubscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberSubscription" ADD CONSTRAINT "MemberSubscription_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- source and status are closed sets in code; source is closed here too.
ALTER TABLE "MemberSubscription" ADD CONSTRAINT "MemberSubscription_source_check"
  CHECK ("source" IN ('app', 'migration', 'adopted'));

-- Backfill: every member that already points at a subscription gets a mapping
-- row on its club's connected account, source "adopted". The Stripe status is
-- not known to the database, so it is recorded as "unknown" and
-- lastEventCreated stays NULL: the first subscription event for it makes the
-- webhook retrieve the subscription fresh from Stripe before applying anything.
-- A member whose club holds no account id (disconnected in-app) cannot be
-- mapped and is left as it is; ON CONFLICT keeps the first member if two ever
-- pointed at one subscription.
INSERT INTO "MemberSubscription" ("id", "tenantId", "memberId", "stripeAccountId", "stripeSubscriptionId", "source", "status", "createdAt", "updatedAt")
SELECT 'msub_' || m."id", m."tenantId", m."id", t."stripeAccountId", m."stripeSubscriptionId", 'adopted', 'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Member" m
JOIN "Tenant" t ON t."id" = m."tenantId"
WHERE m."stripeSubscriptionId" IS NOT NULL
  AND t."stripeAccountId" IS NOT NULL
ORDER BY m."joinedAt", m."id"
ON CONFLICT ("stripeSubscriptionId") DO NOTHING;

-- Row-level security, same shape as every tenant table (rls_policies_foundation).
ALTER TABLE "MemberSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MemberSubscription" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MemberSubscription" AS PERMISSIVE FOR ALL
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant_id', true));

COMMIT;
