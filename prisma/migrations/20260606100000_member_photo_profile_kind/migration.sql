-- feat/member-profile-pictures Track A Phase A2: add 'profile' to MemberPhoto.kind
-- and enforce at-most-one-profile-picture-per-member with a partial unique index.
--
-- Why partial unique (not full unique on memberId): MemberPhoto already stores
-- evidence/milestone/promotion rows that are deliberately many-per-member.
-- A full unique would break the kid-evidence and rank-promotion features
-- shipped earlier. The partial index targets only kind='profile' rows.
--
-- PUT /api/members/[id]/profile-picture uses upsert(): when a member uploads
-- a replacement, the same row updates in place; the partial unique guarantees
-- a stale extra row can never get created by a racing request.
--
-- Idempotent: drop-then-add on the CHECK so re-running on a test branch is safe.

ALTER TABLE "MemberPhoto" DROP CONSTRAINT IF EXISTS "MemberPhoto_kind_check";
ALTER TABLE "MemberPhoto" ADD CONSTRAINT "MemberPhoto_kind_check"
  CHECK ("kind" IN ('evidence','milestone','promotion','profile'));

DROP INDEX IF EXISTS "MemberPhoto_member_profile_unique";
CREATE UNIQUE INDEX "MemberPhoto_member_profile_unique"
  ON "MemberPhoto" ("memberId")
  WHERE "kind" = 'profile';
