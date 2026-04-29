ALTER TABLE "Tenant" ADD COLUMN "memberSelfBilling" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tenant" ADD COLUMN "billingContactEmail" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "billingContactUrl" TEXT;
