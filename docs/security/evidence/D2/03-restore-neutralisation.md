# D2-03 — Restored-copy neutralisation (SF-80), drilled on a private PGlite restore

Code: `neutraliseRestoredCopy(client)` and `neutralisationCheck(client)` in scripts/readiness/backup-post-restore.mjs,
in a separate block after lane F2's functions (F2's `restoredHazards` / `revokeAllAfterRestore` unchanged); CLI mode
`neutralise --i-confirm-this-is-a-restored-copy` behind F2's existing refusals (production and the shared TEST branch
refused). One transaction, one audit row `admin.restore.neutralise`, idempotent.

What it does: every soft-deleted club gets `deletedAt = now()` (a fresh 30-day grace; originals kept in the audit row);
kiosk AND leaderboard (display) token hashes revoked; Stripe connected-account ids detached with
`stripeConnected = false` (originals in the audit row for a deliberate re-attach); TOTP secrets kept — proven by an
md5 digest over every (id, secret) of User, Member and Operator before and after, and refused (rolled back) if it
changes. Runbook order: restore → F2 `revoke` → D2 `neutralise` → `restore-verify compare --expect-revoked` → only then
attach anything.

## Drill (9 Oct 2026, Node v24.21.0)

1. `node scripts/readiness/backup-export.mjs .env.test ep-hidden-salad TEST_DATABASE_URL <scratchpad>/security/D2/export-1`
   → EXPORTED, recovery point 2026-10-09T19:15:20.227Z, 53 tables, 115,820 rows, 31.3 s (exit 0).
2. `node scripts/readiness/backup-restore.mjs <export> --no-revoke --serve-seconds=480 --port=55472` → RESTORED-AND-VERIFIED
   (compare PASS, 100 migrations, 12.9 s to verified; exit 0).
3. `node docs/security/evidence/D2/restore-neutralise-drill.mjs <export> 55472` → 11/11 cells, exit 0
   (restore-neutralise-drill-2026-10-09.txt).
4. Export and restore output deleted (row data never entered the repository).

| cell | result |
|---|---|
| before: copy would act | 7 clubs past purge grace (8 soft-deleted), 28 kiosk tokens, **5 leaderboard tokens**, 5 Stripe accounts, 47 stored TOTP secrets (17 users + 3 members enabled) |
| negative control: kiosk-only neutralisation (rolled back) | reported not ok (7 / 5 remain) |
| TOTP guard: a trigger changes a secret mid-run | "REFUSED: TOTP secrets changed during neutralisation", rolled back, state unchanged |
| neutralise | 8 clocks reset, 28 kiosk + 5 display revoked, 5 Stripe detached, 47 secrets kept, 10 ms |
| after | check ok (0/0/0/0) |
| retention purge predicate (deletedAt < now() − 30 days, lib/tenant-purge.ts) | selects 0 clubs |
| soft-deleted clubs still soft-deleted | 8 = 8 |
| TOTP digest and count unchanged | yes, 47 |
| one audit row, originals arrays match counts | yes |
| idempotent second run | 0 new revocations/detachments, still ok |

Differences from F2's inventory (17:49Z): 7 rather than 6 clubs past grace (one more crossed the line or was
created by tests since), and leaderboard display tokens — a second check-in-adjacent credential F2's hazard list did
not count — are now covered.

Not covered: Neon restore branch (no credential; F2's BLOCKED stands); a production restore (refused by design);
Member.stripeCustomerId / subscription ids (inert without the connected account id; listed for the runbook);
Google Drive tokens and push subscriptions (0 in this copy; F2 inventories them).
