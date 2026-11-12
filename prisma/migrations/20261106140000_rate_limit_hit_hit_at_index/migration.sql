-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;
-- Bounded waits (see tests/unit/migrations-bounded-waits.test.ts): a lock this file needs that another session
-- holds fails the deploy after 5 s (55P03) instead of queueing every later request on the table behind it; no
-- statement runs past 15 s. Transaction-local: COMMIT or ROLLBACK resets both.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- Speed quick win 2h (6 Nov 2026). lib/rate-limit.ts prunes the store with
-- `DELETE … WHERE "hitAt" < now() - 1 hour` and no bucket. The only index was
-- ("bucket", "hitAt"), which a range on "hitAt" alone cannot use, so every
-- prune scanned the whole table. Every other read names its bucket and is
-- already served by that index.
--
-- The table is pruned to about an hour of hits, so the build takes
-- milliseconds. If it cannot get its lock within 5 s the deploy fails with
-- nothing applied and is retried.
CREATE INDEX "RateLimitHit_hitAt_idx" ON "RateLimitHit"("hitAt");

COMMIT;
