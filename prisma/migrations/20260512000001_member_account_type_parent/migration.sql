-- Extend Member.accountType to include 'parent'.
--
-- A parent who never trains themselves but manages 1+ kid accounts now has
-- a first-class account type. They go through a shortened onboarding flow
-- (no belt / style / heard-about-us steps) and land on a kids-focused
-- dashboard instead of one populated with their own (empty) attendance.
--
-- Schema source in prisma/schema.prisma is updated alongside this migration
-- to keep the documented allowed values in sync.

ALTER TABLE "Member" DROP CONSTRAINT IF EXISTS "Member_accountType_check";
ALTER TABLE "Member" ADD CONSTRAINT "Member_accountType_check"
  CHECK ("accountType" IN ('adult', 'junior', 'kids', 'parent')) NOT VALID;
ALTER TABLE "Member" VALIDATE CONSTRAINT "Member_accountType_check";
