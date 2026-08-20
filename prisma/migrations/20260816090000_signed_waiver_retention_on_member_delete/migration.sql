-- Signed waivers must survive the member they belong to.
--
-- A SignedWaiver row is the club's liability evidence: the exact waiver text
-- the person accepted, who signed it, when, from which IP, and the signature
-- image. `app/legal/privacy/page.tsx` publicly promises members that waivers
-- are retained for 6 years after they leave, and `docs/spec.md` requires the
-- same.
--
-- The original FK (20260426162644_phase1_security_hardening) was
-- ON DELETE RESTRICT, which made a hard member delete impossible while any
-- waiver existed. `lib/member-delete.ts` worked around that by running an
-- explicit `signedWaiver.deleteMany` before dropping the Member row — so
-- every hard delete silently destroyed the evidence instead of preserving
-- it. That path is reachable from the staff DELETE endpoint AND from
-- parent self-serve child deletion, meaning a parent could delete their
-- kid's profile the day before an injury claim and leave the club with no
-- signed waiver at all. Contrast Payment / Order / Notification, which
-- already use ON DELETE SET NULL precisely so the record outlives the
-- member. (Audit P0-2, audit-memory-storage-2026-08-16.)
--
-- Fix: make `memberId` nullable and switch the FK to ON DELETE SET NULL, so
-- Postgres detaches the waiver instead of blocking (or forcing) its
-- destruction. The waiver row survives under legal hold with its snapshot
-- columns intact; only the link back to the (now non-existent) member is
-- cleared. The existing indexes on `memberId` need no change — Postgres
-- B-tree indexes store NULLs fine, and every lookup filters on a concrete
-- memberId or on tenantId.

-- AlterTable
ALTER TABLE "SignedWaiver" ALTER COLUMN "memberId" DROP NOT NULL;

-- DropForeignKey
ALTER TABLE "SignedWaiver" DROP CONSTRAINT "SignedWaiver_memberId_fkey";

-- AddForeignKey
ALTER TABLE "SignedWaiver" ADD CONSTRAINT "SignedWaiver_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
