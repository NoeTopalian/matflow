-- Backfill: store email addresses lowercase, to match how every recovery path
-- already READS them.
--
-- `magic-link/request`, `auth/forgot-password` and `auth/reset-password` all
-- look up `lower(trim(email))`. The create paths did not normalise, so a row
-- stored as "Noe@example.com" could be signed into with that exact spelling and
-- could never be recovered — and because both recovery routes answer a
-- deliberate 200 to avoid enumerating addresses, the member saw "if that
-- address exists we've sent a link" and nothing ever arrived.
--
-- DELIBERATELY COLLISION-SAFE, and this is the important part. A naive
-- `UPDATE ... SET email = lower(email)` can violate @@unique([tenantId, email]),
-- and a failed migration does not fail one deploy — it leaves a row in
-- _prisma_migrations with a null finished_at, which aborts EVERY later
-- `migrate deploy`, including the one that would revert it. The only unblocking
-- command must be run against production from a laptop, which this repo forbids.
--
-- So: a row is normalised only when no OTHER row in the same tenant already
-- normalises to the same address. That covers both shapes — an existing
-- lowercase twin, and two mixed-case rows that would collide with each other.
-- Anything left is a genuine duplicate account needing a human decision, not
-- something a migration should silently merge. scripts/report-email-collisions
-- lists them.

UPDATE "User" u
SET "email" = lower(btrim(u."email"))
WHERE u."email" <> lower(btrim(u."email"))
  AND NOT EXISTS (
    SELECT 1 FROM "User" o
    WHERE o."tenantId" = u."tenantId"
      AND o."id" <> u."id"
      AND lower(btrim(o."email")) = lower(btrim(u."email"))
  );

UPDATE "Member" m
SET "email" = lower(btrim(m."email"))
WHERE m."email" IS NOT NULL
  AND m."email" <> lower(btrim(m."email"))
  AND NOT EXISTS (
    SELECT 1 FROM "Member" o
    WHERE o."tenantId" = m."tenantId"
      AND o."id" <> m."id"
      AND lower(btrim(o."email")) = lower(btrim(m."email"))
  );
