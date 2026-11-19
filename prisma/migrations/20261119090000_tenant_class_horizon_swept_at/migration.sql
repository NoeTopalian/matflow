-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts). ADD COLUMN of a nullable column with no default is
-- a catalogue change only (no table rewrite), but it takes a brief ACCESS EXCLUSIVE lock on "Tenant"; with these
-- bounds it gives up instead of queueing live requests behind it. Transaction-local.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Closure phase (19 Nov 2026): the nightly class-instances sweep (app/api/cron/class-instances) read the clubs in no
-- order and restarted from the same club every night, so a sweep that ran out of its time budget skipped the SAME
-- clubs every night. This records when the sweep last ATTEMPTED each club; the sweep now takes the least recently
-- attempted clubs first (never attempted first of all).
-- Additive: one nullable column and nothing else. Apply it BEFORE the code that uses it (the deploy does: the build
-- migrates first). Older application code never reads the column, so the migration alone changes nothing; the NEW
-- code on a database without it fails, because the Prisma client selects every Tenant column.
ALTER TABLE "Tenant" ADD COLUMN "classHorizonSweptAt" TIMESTAMP(3);

COMMIT;
