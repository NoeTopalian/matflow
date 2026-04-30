-- Sprint 5 US-507: CHECK constraints for enum-like string fields.
--
-- Prisma doesn't natively model CHECK constraints, so we add them via raw SQL.
-- Pattern: ADD CONSTRAINT ... NOT VALID first, then VALIDATE in a second
-- statement so existing rows that may have drifted aren't blocked. The CHECK
-- is enforced from now on for INSERTs and UPDATEs.
--
-- Allowed values are documented in schema.prisma comments alongside each field
-- so the DB and the app stay in sync.

-- Member.accountType ∈ {adult, junior, kids}
ALTER TABLE "Member" ADD CONSTRAINT "Member_accountType_check"
  CHECK ("accountType" IN ('adult', 'junior', 'kids')) NOT VALID;
ALTER TABLE "Member" VALIDATE CONSTRAINT "Member_accountType_check";

-- Member.status ∈ {active, inactive, cancelled, taster}
ALTER TABLE "Member" ADD CONSTRAINT "Member_status_check"
  CHECK ("status" IN ('active', 'inactive', 'cancelled', 'taster')) NOT VALID;
ALTER TABLE "Member" VALIDATE CONSTRAINT "Member_status_check";

-- Member.paymentStatus ∈ {paid, overdue, paused, free, pending, cancelled}
ALTER TABLE "Member" ADD CONSTRAINT "Member_paymentStatus_check"
  CHECK ("paymentStatus" IN ('paid', 'overdue', 'paused', 'free', 'pending', 'cancelled')) NOT VALID;
ALTER TABLE "Member" VALIDATE CONSTRAINT "Member_paymentStatus_check";

-- User.role ∈ {owner, manager, coach, admin}
ALTER TABLE "User" ADD CONSTRAINT "User_role_check"
  CHECK ("role" IN ('owner', 'manager', 'coach', 'admin')) NOT VALID;
ALTER TABLE "User" VALIDATE CONSTRAINT "User_role_check";

-- Payment.status ∈ {succeeded, failed, refunded, disputed, pending}
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_status_check"
  CHECK ("status" IN ('succeeded', 'failed', 'refunded', 'disputed', 'pending')) NOT VALID;
ALTER TABLE "Payment" VALIDATE CONSTRAINT "Payment_status_check";

-- MembershipTier.billingCycle ∈ {monthly, annual, none}
ALTER TABLE "MembershipTier" ADD CONSTRAINT "MembershipTier_billingCycle_check"
  CHECK ("billingCycle" IN ('monthly', 'annual', 'none')) NOT VALID;
ALTER TABLE "MembershipTier" VALIDATE CONSTRAINT "MembershipTier_billingCycle_check";
