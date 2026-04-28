-- Add unique constraint to MonthlyReport for cron + manual collision dedup
CREATE UNIQUE INDEX "MonthlyReport_tenantId_periodStart_generationType_key"
  ON "MonthlyReport" ("tenantId", "periodStart", "generationType");
