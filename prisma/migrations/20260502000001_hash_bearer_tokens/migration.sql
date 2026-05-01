-- Hash bearer tokens at rest (Fix 1, post-launch hardening).
--
-- ChatGPT-2 finding #2: raw `String @unique` tokens in MagicLinkToken /
-- PasswordResetToken would leak account-takeover material to anyone with
-- DB read access (snapshot, support export, monitoring query log).
--
-- After this migration, the column stores HMAC-SHA256(raw, AUTH_SECRET)
-- instead. The raw token is sent to the user via email and re-hashed at
-- consume time for the @unique lookup. See lib/token-hash.ts.
--
-- Live magic-link / reset tokens in users' inboxes will become invalid
-- (the raw token won't match the hashed column). Members must re-request.
-- This is the documented trade-off — both token types are short-lived
-- (15-30 min) so the user-visible impact is minimal.
--
-- Lock posture: RENAME COLUMN holds an ACCESS EXCLUSIVE lock briefly
-- (catalog-only, no table rewrite). The DELETE on expired rows scans the
-- expiresAt index — for tables with up to ~1M stale rows, expected lock
-- duration is <15s. Run during low-traffic window if in doubt.

-- 1. Purge stale MagicLinkToken rows BEFORE the rename so the index scan
--    on the renamed column is small from the start.
DELETE FROM "MagicLinkToken" WHERE "expiresAt" < NOW();

-- 2. Purge stale PasswordResetToken rows for the same reason.
DELETE FROM "PasswordResetToken" WHERE "expiresAt" < NOW();

-- 3. Rename the columns. The @unique index moves with the column on
--    PostgreSQL — no separate index drop / re-create needed.
ALTER TABLE "MagicLinkToken" RENAME COLUMN "token" TO "tokenHash";
ALTER TABLE "PasswordResetToken" RENAME COLUMN "token" TO "tokenHash";
