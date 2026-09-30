-- All-or-nothing: Prisma does not wrap a migration in a transaction (the 30 Sep
-- failure drill left a partial ALTER behind), so this one does it itself.
BEGIN;

-- ADR-001 D2 slice 2: a membership tier may be bound to one venue. NULL keeps
-- today's meaning (every venue), so nothing changes for any existing club.
ALTER TABLE "MembershipTier" ADD COLUMN "locationId" TEXT;
ALTER TABLE "MembershipTier" ADD CONSTRAINT "MembershipTier_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "MembershipTier_locationId_idx" ON "MembershipTier"("locationId");

COMMIT;
