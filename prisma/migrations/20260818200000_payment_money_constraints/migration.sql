-- Money-ledger floor for Payment (audit lane 2, finding D-1).
--
-- Payment.amountPence and Payment.refundedAmountPence had NO database-level
-- constraint of any kind, while lesser tables in the same schema do:
-- Product.pricePence and Order.totalPence both carry `>= 0` CHECKs
-- (20260430000003_products, 20260430000005_orders). The actual money ledger was
-- the one table with no floor.
--
-- Until this session the refund route was a read-modify-write race, so two
-- concurrent refunds could each validate against the same stale cumulative and
-- push refundedAmountPence past amountPence with nothing to catch it. The
-- optimistic lock now prevents that in the application, but Payment rows are
-- also written by scripts/backfill-invoice-payment-ids.mjs and by any manual SQL
-- correction during an incident — neither goes through that validation.
--
-- NOT VALID is deliberate. It enforces on every INSERT and UPDATE from now on,
-- but does not scan history, so this cannot fail a deploy because of a row
-- written while the P0-1 bug was live. Run the VALIDATE statements at the bottom
-- as a follow-up once production is confirmed clean:
--
--   SELECT id, "amountPence", "refundedAmountPence" FROM "Payment"
--   WHERE "amountPence" < 0
--      OR "refundedAmountPence" < 0
--      OR "refundedAmountPence" > "amountPence";
--
-- Assuming that history is clean without checking would be exactly the kind of
-- unverified claim this audit exists to catch.

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amountPence_nonneg_check"
  CHECK ("amountPence" >= 0) NOT VALID;

ALTER TABLE "Payment" ADD CONSTRAINT "Payment_refundedAmountPence_valid_check"
  CHECK (
    "refundedAmountPence" IS NULL
    OR ("refundedAmountPence" >= 0 AND "refundedAmountPence" <= "amountPence")
  ) NOT VALID;

-- Follow-up, once the query above returns zero rows in production:
--   ALTER TABLE "Payment" VALIDATE CONSTRAINT "Payment_amountPence_nonneg_check";
--   ALTER TABLE "Payment" VALIDATE CONSTRAINT "Payment_refundedAmountPence_valid_check";
