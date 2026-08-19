-- D1: cancellation-time attribution for churn/net-new analytics.
--
-- Reporting (lib/reports.ts churn + net-new chart, app/api/dashboard/stats)
-- previously dated a cancellation by Member.updatedAt. Any later edit to a
-- cancelled member (a notes change, a TOTP reset, etc.) bumped updatedAt and
-- re-bucketed them into the current month — inflating that month's churn and
-- mis-placing them on the net-new chart. cancelledAt is stamped once, at the
-- moment status flips to "cancelled", and never moved by unrelated edits.
ALTER TABLE "Member" ADD COLUMN "cancelledAt" TIMESTAMP(3);

-- Backfill existing cancelled members so historical churn/net-new keeps its
-- shape. updatedAt is the best available approximation of when they cancelled
-- (it's what the old queries used); going forward cancelledAt is exact.
UPDATE "Member" SET "cancelledAt" = "updatedAt" WHERE "status" = 'cancelled' AND "cancelledAt" IS NULL;
