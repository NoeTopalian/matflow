# Lane C report (saved by lead from the agent's hand-back; agent's write was refused by a hook)

C1 restore vs purge — FIXED LOCALLY (atomic, not containment)
- lib/tenant-lifecycle.ts (new): conditional single-UPDATE transitions on Tenant row. Restore only if deletedAt set, ≤30 d, purgeStartedAt null; refusals classified in-tx: deletion-in-progress / recovery-window-expired / permanently-deleted / not-deleted (409), not-found (404). Claim sets purgeStartedAt when due+unclaimed; existing claim resumed. assertPurgeClaim = first statement of every destructive tx (row lock; abort if restored/re-claimed/gone). Final deleteMany must hit exactly 1 row; admin.tenant.hard_deleted evidence row in same tx. Partial state → cron 500.
- lib/tenant-purge.ts (new, rule g moved out of route), app/api/cron/retention/route.ts, app/api/admin/customers/[id]/soft-delete/route.ts (DELETE uses restoreSoftDeletedTenant; POST stamp conditional → 409 on race).
- Schema: Tenant.purgeStartedAt, suspendedPreviousStatus, suspensionBilling. Migration 20261006020000_tenant_lifecycle_safety (additive, nullable) — ALREADY APPLIED TO TEST BRANCH; do not edit SQL. Must deploy with/before code.
- tests/integration/tenant-restore-purge-race.test.ts (5): restore-wins, purge-wins (+ later permanently-deleted), deadline mid-purge resume, two concurrent duplicate runs, 30-day boundary. Barriers verified via pg_stat_activity lock wait. Normal role `Tests 5 passed (5)` (3 runs); restricted `Tests 5 passed (5)`.
- Unit lifecycle-constraints pins flipped; red check vs HEAD: 23 fail / 7 pass (shared behaviour). Targeted units `Test Files 8 passed (8)` / `Tests 271 passed (271)`. ESLint clean; tsc 0 in touched files. TEST branch cleaned (0 lanec-* rows).
- Cron auth confirmed: CRON_SECRET required (503 unset), constant-time, throttled 401/429; eligibility deletedAt < now-30d, oldest first, max 2/run.
- Residual: (a) clock-skew preflight double Stripe cancel request (no deletion); (b) claimed-but-untouched club not restorable (by design); (c) rollback to e8afb6a re-opens race — while rolled back do not restore soft-deleted clubs and read GET /api/cron/retention?dryRun=1 before 03:30 UTC; (d) production has the race today — Noe: read-only dry-run of retention cron in production, record wouldPurge list, before deploy; (e) cron-smoke integration not run (sweeps whole shared branch).

C2 suspension billing — FIXED LOCALLY
- Policy docs/runbooks/SUSPENSION-BILLING-POLICY.md: suspension does NOT touch member billing (clubs are Standard Connect merchants; suspension withdraws software, not trading). Soft-delete stops renewals; purge refuses while a subscription refuses to cancel. Unsuspend never clears cancel_at_period_end. Legacy suspensions: per-subscription review by club.
- suspend POST: no Stripe; one tx: inventory sub ids, conditional status flip (409 race), store suspendedPreviousStatus + suspensionBilling, bump sessions; audit has previous status/policy/ids. DELETE: 409 if not suspended; restores recorded status (trial stays trial); legacy falls back to audit row status then active flagged default; returns billingReview; never calls Stripe.
- Tests in lifecycle-constraints (Stripe mocked).
- Residual: no per-subscription reversal endpoint; clubs already suspended under old code keep cancel flags; webhook emails to suspended clubs (other finding).

Out-of-lane test edits (review): tests/unit/retention-cron.test.ts, tests/unit/retention-purge-covers-every-tenant-table.test.ts (now reads lib/tenant-purge.ts), tests/unit/review-lock.test.ts (regex stricter).
For D: wire step-up into soft-delete POST and restore DELETE. For UI: DangerZone could show deletion-in-progress and billingReview (optional).
