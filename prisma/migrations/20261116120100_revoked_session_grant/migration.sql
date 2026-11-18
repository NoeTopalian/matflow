-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts). Transaction-local.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Round 8 (16 Nov 2026), independent review finding 1. Every request's revocation check now reads "RevokedSession",
-- so the runtime role must be able to read it from the moment the code that reads it runs. The repo normally relies
-- on ALTER DEFAULT PRIVILEGES for new tables (docs/runbooks/RUNTIME-DB-ROLE-CHECK.md); this table is on the hot path,
-- where a missing grant would refuse every signed-in request, so the grant is also made explicitly here. Guarded:
-- a database without the restricted role (a fresh local one) is unaffected. RLS still admits only the bypass helper.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'matflow_app') THEN
    GRANT SELECT, INSERT, DELETE ON "RevokedSession" TO matflow_app;
  END IF;
END $$;

COMMIT;
