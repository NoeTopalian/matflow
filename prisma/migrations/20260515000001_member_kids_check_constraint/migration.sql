-- Hard-enforce invariant I1 from docs/KIDS-PARENT-LINKAGE-ASSESSMENT-2026-05-15.md:
--
--   accountType = 'kids' IMPLIES parentMemberId IS NOT NULL
--
-- Until now this was application-layer-only. A direct DB write (one-off
-- script, ad-hoc psql session, or a faulty backfill) could create an
-- orphan kid row that no UI would handle correctly.
--
-- NOT VALID + VALIDATE CONSTRAINT is the two-step pattern that lets us
-- roll out the constraint without a single long table lock:
--
--   1. ADD CONSTRAINT ... NOT VALID  -- accepts new rows, doesn't re-check existing
--   2. VALIDATE CONSTRAINT            -- scans existing rows and either passes or throws
--
-- If step 2 throws, scripts/find-orphan-kids.mjs lists every offending
-- row so a human can resolve them before retrying. Safer than a single
-- ADD CONSTRAINT that locks + scans the whole table while blocking writes.
--
-- Orphan-on-parent-delete (onDelete: SetNull): the deletion gateway in
-- lib/member-delete.ts forces orphaned kids to flip accountType to
-- 'junior' as part of the orphan branch, so this constraint stays
-- satisfied when a parent is removed without an explicit reassignment.

ALTER TABLE "Member" DROP CONSTRAINT IF EXISTS "Member_kids_must_have_parent";
ALTER TABLE "Member"
  ADD CONSTRAINT "Member_kids_must_have_parent"
  CHECK ("accountType" <> 'kids' OR "parentMemberId" IS NOT NULL)
  NOT VALID;
ALTER TABLE "Member" VALIDATE CONSTRAINT "Member_kids_must_have_parent";
