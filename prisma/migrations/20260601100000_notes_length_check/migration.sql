-- feat/member-tickable-notes Phase 1d: DB-level length backstop for every
-- notes column written through the application.
--
-- The Zod sanitiser in lib/schemas/notes-sanitiser.ts already enforces these
-- limits and strips control characters at the request boundary. These CHECK
-- constraints defend against:
--   1. New code paths that forget to validate (e.g. raw `tx.member.update(...)`
--      inside an importer that bypasses the API layer).
--   2. Direct DB writes — operator console / one-off scripts / prisma studio.
--   3. A regression that removes the Zod gate without removing the column.
--
-- Limits match the Zod schemas:
--   - Member.notes              → 2000 chars  (staff-only "Internal Notes")
--   - RankHistory.notes         →  500 chars  (per-promotion context)
--   - GymApplication.notes      → 2000 chars  (public apply funnel message)
--
-- Idempotent: drop-then-add so re-applying on a test branch is safe.

ALTER TABLE "Member" DROP CONSTRAINT IF EXISTS "Member_notes_length_check";
ALTER TABLE "Member" ADD CONSTRAINT "Member_notes_length_check"
  CHECK ("notes" IS NULL OR char_length("notes") <= 2000);

ALTER TABLE "RankHistory" DROP CONSTRAINT IF EXISTS "RankHistory_notes_length_check";
ALTER TABLE "RankHistory" ADD CONSTRAINT "RankHistory_notes_length_check"
  CHECK ("notes" IS NULL OR char_length("notes") <= 500);

ALTER TABLE "GymApplication" DROP CONSTRAINT IF EXISTS "GymApplication_notes_length_check";
ALTER TABLE "GymApplication" ADD CONSTRAINT "GymApplication_notes_length_check"
  CHECK ("notes" IS NULL OR char_length("notes") <= 2000);
