-- Per-tenant check-in window. Owners set these via /dashboard/settings.
-- Defaults match the prior hardcoded 30/30 so existing tenants unchanged.

ALTER TABLE "Tenant" ADD COLUMN "checkinWindowBeforeMin" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Tenant" ADD COLUMN "checkinWindowAfterMin"  INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_checkinWindowBeforeMin_check"
  CHECK ("checkinWindowBeforeMin" >= 0 AND "checkinWindowBeforeMin" <= 180);
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_checkinWindowAfterMin_check"
  CHECK ("checkinWindowAfterMin" >= 0 AND "checkinWindowAfterMin" <= 180);
