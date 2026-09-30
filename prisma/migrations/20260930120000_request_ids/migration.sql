-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- Idempotency keys for two writes a lost response could duplicate: Add member
-- (a member with no email has nothing else unique) and a waiver signature.
-- Nullable and additive; the unique indexes ignore NULLs.
ALTER TABLE "Member" ADD COLUMN "createRequestId" TEXT;
CREATE UNIQUE INDEX "Member_tenantId_createRequestId_key" ON "Member"("tenantId", "createRequestId");

ALTER TABLE "SignedWaiver" ADD COLUMN "requestId" TEXT;
CREATE UNIQUE INDEX "SignedWaiver_tenantId_requestId_key" ON "SignedWaiver"("tenantId", "requestId");

COMMIT;
