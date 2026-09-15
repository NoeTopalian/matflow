-- Email addresses are stored lowercase, GUARANTEED — not merely by convention.
--
-- 20260913230000_lowercase_emails was a one-off UPDATE. It healed the rows that
-- existed and left nothing behind to keep the invariant true, and that turned a
-- recoverable bug into an unrecoverable one:
--
--   * BEFORE that migration, auth.ts looked the address up with the RAW string.
--     A member stored as "Noe@example.com" could sign in with that exact
--     spelling. They could never RECOVER the account (magic link, forgot
--     password and reset all search lowercased), but they could get in.
--
--   * AFTER it, auth.ts parses the submitted address through emailField(),
--     which lowercases. Member.email is plain TEXT and Postgres `=` on TEXT is
--     case-sensitive, so a mixed-case row now matches NOTHING. Not the mixed
--     spelling, not the lower one. The member is locked out entirely.
--
-- The backfill only covered rows present on 13 Sep. Any route that writes an
-- address without going through emailField() — CSV import, accept-invite, the
-- children route, admin create-tenant — recreates the condition, and the
-- resulting account cannot log in and cannot be recovered. Silently.
--
-- A trigger holds the invariant whatever route writes, including routes not yet
-- written. It cannot fail a write, so nothing 500s in front of a customer, and
-- it heals a stale row on its next update.
--
-- A CHECK constraint was considered and deliberately rejected: it is more honest
-- (a bad write errors rather than silently creating an unrecoverable account),
-- but it 500s on any path not found first — and not knowing which paths write
-- raw addresses is precisely the uncertainty that caused this. Revisit once the
-- trigger has made the invariant true and the writers are enumerated.

CREATE OR REPLACE FUNCTION matflow_lowercase_email() RETURNS trigger AS $$
BEGIN
  IF NEW."email" IS NOT NULL THEN
    NEW."email" := lower(btrim(NEW."email"));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Every table whose email is a SIGN-IN IDENTITY or a recovery lookup key.
-- GymApplication is deliberately excluded: it is a prospect record, nothing
-- authenticates against it, and leaving it alone keeps the blast radius small.
DROP TRIGGER IF EXISTS "User_email_lowercase" ON "User";
CREATE TRIGGER "User_email_lowercase"
  BEFORE INSERT OR UPDATE OF "email" ON "User"
  FOR EACH ROW EXECUTE FUNCTION matflow_lowercase_email();

DROP TRIGGER IF EXISTS "Member_email_lowercase" ON "Member";
CREATE TRIGGER "Member_email_lowercase"
  BEFORE INSERT OR UPDATE OF "email" ON "Member"
  FOR EACH ROW EXECUTE FUNCTION matflow_lowercase_email();

-- lib/operator-auth.ts:184 looks the operator up with lower(trim(email)), so an
-- operator row written with capitals has the same total lockout — on the plane
-- that administers every club.
DROP TRIGGER IF EXISTS "Operator_email_lowercase" ON "Operator";
CREATE TRIGGER "Operator_email_lowercase"
  BEFORE INSERT OR UPDATE OF "email" ON "Operator"
  FOR EACH ROW EXECUTE FUNCTION matflow_lowercase_email();

-- The two recovery-token tables are looked up by email. Their routes already
-- normalise on both write and read; the trigger means a future route cannot
-- mint a token nobody can redeem.
DROP TRIGGER IF EXISTS "MagicLinkToken_email_lowercase" ON "MagicLinkToken";
CREATE TRIGGER "MagicLinkToken_email_lowercase"
  BEFORE INSERT OR UPDATE OF "email" ON "MagicLinkToken"
  FOR EACH ROW EXECUTE FUNCTION matflow_lowercase_email();

DROP TRIGGER IF EXISTS "PasswordResetToken_email_lowercase" ON "PasswordResetToken";
CREATE TRIGGER "PasswordResetToken_email_lowercase"
  BEFORE INSERT OR UPDATE OF "email" ON "PasswordResetToken"
  FOR EACH ROW EXECUTE FUNCTION matflow_lowercase_email();

-- Heal anything the 13 Sep backfill did not cover, collision-safe exactly as it
-- was: a row is only normalised where no OTHER row in the same tenant already
-- normalises to the same address. A failed migration does not fail one deploy,
-- it aborts every later one.
UPDATE "Operator" o
SET "email" = lower(btrim(o."email"))
WHERE o."email" <> lower(btrim(o."email"))
  AND NOT EXISTS (
    SELECT 1 FROM "Operator" x
    WHERE x."id" <> o."id" AND lower(btrim(x."email")) = lower(btrim(o."email"))
  );
