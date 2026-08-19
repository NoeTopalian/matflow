-- Two hot-path indexes identified by the memory & storage audit
-- (.omc/specs/audit-memory-storage-2026-08-16.md, findings P1-3 and P1-5).
--
-- P1-3 — AttendanceRecord.classInstanceId: the check-in roster question
-- ("who is checked into this class?") had no index of its own. Five call
-- sites ask it, three of them hot (staff check-in page, kiosk member list,
-- coach register; plus the staff-home _count). Without this index Postgres
-- answers a ~20-row question by scanning the tenant's entire attendance
-- history through the (tenantId, checkInTime) prefix — cost grows with every
-- check-in ever recorded (~15k rows/club/year), the fastest-degrading read
-- in the app.
--
-- P1-5 — Payment.stripeChargeId: charge.refunded and charge.dispute.* webhook
-- handlers look up by stripeChargeId alone (no tenantId to lead on), so every
-- such event ran a cross-tenant sequential scan of Payment inside the webhook
-- response window.
--
-- Both are plain single-column b-trees on already-populated columns; index
-- inserts add ~5-15μs per write, reads drop 10-100x past ~1000 rows.

-- CreateIndex
CREATE INDEX "AttendanceRecord_classInstanceId_idx" ON "AttendanceRecord"("classInstanceId");

-- CreateIndex
CREATE INDEX "Payment_stripeChargeId_idx" ON "Payment"("stripeChargeId");
