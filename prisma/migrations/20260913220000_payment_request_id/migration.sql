-- Payment.requestId — a caller-minted idempotency key for payments recorded BY HAND.
--
-- Stripe-backed payments already dedupe at Stripe via an idempotency key. A
-- manual payment (cash at the desk, bank transfer, comp) never touches Stripe,
-- so nothing stopped two staff on two tills recording the same £40 twice: the
-- client's in-flight guard cannot see the other till.
--
-- Additive and nullable, so the previous deployment keeps running against this
-- schema during promotion (expand/contract — the old bundle never writes it).
ALTER TABLE "Payment" ADD COLUMN "requestId" TEXT;

-- Tenant-scoped rather than global: two clubs minting the same UUID is
-- vanishingly unlikely, but it must not become a cross-tenant failure if it
-- ever happens.
--
-- No backfill is needed and none is wanted. Postgres does not treat NULLs as
-- equal in a unique index, so every historic row and every Stripe-backed row
-- keeps a NULL here and none of them collide.
CREATE UNIQUE INDEX "Payment_tenantId_requestId_key" ON "Payment"("tenantId", "requestId");
