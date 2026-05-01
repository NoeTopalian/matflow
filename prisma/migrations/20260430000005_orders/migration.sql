-- LB-001 (audit C9) — Pay-at-desk shop checkout used to console.log silently;
-- now it persists an Order so revenue is actually trackable. The same table
-- backs Stripe checkout sessions (paymentMethod='stripe') for parity.

CREATE TABLE "Order" (
  "id"              TEXT PRIMARY KEY,
  "tenantId"        TEXT NOT NULL,
  "memberId"        TEXT,
  "orderRef"        TEXT NOT NULL,
  "items"           JSONB NOT NULL,
  "totalPence"      INTEGER NOT NULL,
  "currency"        TEXT NOT NULL DEFAULT 'GBP',
  "status"          TEXT NOT NULL DEFAULT 'pending',
  "paymentMethod"   TEXT NOT NULL,
  "paidAt"          TIMESTAMP(3),
  "paidByUserId"    TEXT,
  "stripeSessionId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Order_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Order_orderRef_key"        ON "Order" ("orderRef");
CREATE UNIQUE INDEX "Order_stripeSessionId_key" ON "Order" ("stripeSessionId");
CREATE INDEX "Order_tenantId_status_idx"        ON "Order" ("tenantId", "status");
CREATE INDEX "Order_tenantId_createdAt_idx"     ON "Order" ("tenantId", "createdAt");
CREATE INDEX "Order_memberId_idx"               ON "Order" ("memberId");

-- NOT VALID + VALIDATE pattern matches 20260430000001_schema_check_constraints
ALTER TABLE "Order" ADD CONSTRAINT "Order_status_check"
  CHECK ("status" IN ('pending', 'paid', 'cancelled')) NOT VALID;
ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_status_check";

ALTER TABLE "Order" ADD CONSTRAINT "Order_paymentMethod_check"
  CHECK ("paymentMethod" IN ('pay_at_desk', 'stripe')) NOT VALID;
ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_paymentMethod_check";

ALTER TABLE "Order" ADD CONSTRAINT "Order_totalPence_nonneg_check"
  CHECK ("totalPence" >= 0) NOT VALID;
ALTER TABLE "Order" VALIDATE CONSTRAINT "Order_totalPence_nonneg_check";
