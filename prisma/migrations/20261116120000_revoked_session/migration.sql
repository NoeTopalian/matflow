-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts). This file only creates a new table, so it waits
-- on no existing lock; the bounds are here so it can never queue live requests behind it. Transaction-local.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Round 8 (16 Nov 2026): "Sign out" ends this session on the server, not only in this browser.
-- Additive: a new table and nothing else. Older application code never reads it, so this migration is safe to apply
-- before or after the code that uses it.

CREATE TABLE "RevokedSession" (
    "sid" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevokedSession_pkey" PRIMARY KEY ("sid")
);

CREATE INDEX "RevokedSession_expiresAt_idx" ON "RevokedSession"("expiresAt");

-- Access model. The table holds no club data (an opaque id and two timestamps), so there is no tenant to isolate by.
-- Instead every row is visible ONLY through the RLS-bypass helper (lib/prisma-tenant.ts withRlsBypass), which the
-- sign-out route and the per-request revocation check use: the runtime role (matflow_app), granted DML on every table
-- by default privileges, can neither read nor write a row any other way. FORCE so the owner role is held to it too.
ALTER TABLE "RevokedSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RevokedSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY bypass_only ON "RevokedSession" AS PERMISSIVE FOR ALL
  USING (current_setting('app.bypass_rls', true) = 'on')
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on');

COMMIT;
