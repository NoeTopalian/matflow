-- M1 attribution + M4 leaderboard: additive columns, one new tenant-scoped
-- table, plus the two invariants Prisma cannot express (a polymorphic XOR and a
-- reason enum) and RLS for the new table. Everything here is additive and
-- nullable/defaulted — safe on a populated table.

-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "creditedToLabel" TEXT,
ADD COLUMN     "creditedToMemberId" TEXT,
ADD COLUMN     "creditedToUserId" TEXT,
ADD COLUMN     "leaderboardOptOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trialRunById" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "displayTokenHash" TEXT,
ADD COLUMN     "displayTokenIssuedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MemberStatusEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "changedById" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberStatusEvent_tenantId_memberId_occurredAt_idx" ON "MemberStatusEvent"("tenantId", "memberId", "occurredAt");

-- CreateIndex
CREATE INDEX "MemberStatusEvent_tenantId_occurredAt_idx" ON "MemberStatusEvent"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "MemberStatusEvent_changedById_idx" ON "MemberStatusEvent"("changedById");

-- CreateIndex
CREATE INDEX "Member_tenantId_trialRunById_idx" ON "Member"("tenantId", "trialRunById");

-- CreateIndex
CREATE INDEX "Member_tenantId_creditedToUserId_idx" ON "Member"("tenantId", "creditedToUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_displayTokenHash_key" ON "Tenant"("displayTokenHash");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_trialRunById_fkey" FOREIGN KEY ("trialRunById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_creditedToUserId_fkey" FOREIGN KEY ("creditedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_creditedToMemberId_fkey" FOREIGN KEY ("creditedToMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberStatusEvent" ADD CONSTRAINT "MemberStatusEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberStatusEvent" ADD CONSTRAINT "MemberStatusEvent_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberStatusEvent" ADD CONSTRAINT "MemberStatusEvent_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Invariant: sign-up credit is POLYMORPHIC — at most one of the two FKs may be
-- set (a staff User, or another Member who "brought a friend"). Mirrors
-- Task_assignee_xor_check. Neither-set is allowed (unknown / free-text label).
ALTER TABLE "Member" ADD CONSTRAINT "Member_credited_to_xor_check"
  CHECK (NOT ("creditedToUserId" IS NOT NULL AND "creditedToMemberId" IS NOT NULL));

-- Invariant: the funnel only counts known transition reasons; import events are
-- excluded from conversion math at query time, but the column itself is closed.
ALTER TABLE "MemberStatusEvent" ADD CONSTRAINT "MemberStatusEvent_reason_check"
  CHECK ("reason" IN ('staff_edit', 'stripe_webhook', 'import', 'self_signup'));

-- RLS for the new tenant-scoped table (mirrors the MemberPhoto migration): every
-- row is invisible unless the connection's app.current_tenant_id matches, or
-- app.bypass_rls is 'on'. FORCE so even the table owner is subject to it.
ALTER TABLE "MemberStatusEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MemberStatusEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MemberStatusEvent" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );
