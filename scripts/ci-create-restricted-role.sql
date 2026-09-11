-- Creates the non-BYPASSRLS application role used to PROVE row-level security
-- in CI. Mirrors scripts/create-restricted-role.ts, which is deliberately
-- host-guarded to the Neon test branch and therefore cannot run here.
--
-- Why this exists: the six RLS enforcement assertions in
-- tests/integration/rls-foundation.test.ts self-skip whenever the connected
-- role holds BYPASSRLS. CI connects as the stock `postgres` superuser, so for
-- the life of this project those assertions skipped and CI reported green over
-- the gap they exist to close. Running them as this role makes them real.
--
-- Safe by construction: this file is only ever applied to the ephemeral
-- Postgres service container in .github/workflows/ci.yml. It is never run
-- against Neon — production or test branch.
DO $role_create$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'matflow_app') THEN
    -- CREATE ROLE defaults to NOBYPASSRLS NOSUPERUSER, which is the point.
    CREATE ROLE matflow_app LOGIN PASSWORD 'ci_only_not_a_secret';
  END IF;
END
$role_create$;

GRANT USAGE ON SCHEMA public TO matflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO matflow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO matflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO matflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO matflow_app;

-- Fail loudly if the role could ever bypass the policies it is meant to prove.
DO $verify$
DECLARE bypass boolean; super boolean;
BEGIN
  SELECT rolbypassrls, rolsuper INTO bypass, super FROM pg_roles WHERE rolname = 'matflow_app';
  IF bypass OR super THEN
    RAISE EXCEPTION 'matflow_app must be NOBYPASSRLS and NOSUPERUSER (got bypass=%, super=%)', bypass, super;
  END IF;
END
$verify$;
