# Release evidence — candidate `d2adaee` (readiness spec v3 §11–§12)

Prepared 30 Sep 2026. **Nothing here is deployed.** 117 local commits ahead of `origin/main` (`ac2fcb8`); production still runs the old build (last known `90868eb`; no route exposes the deployed SHA).

## Environment of every result below
Neon **test** branch `ep-hidden-salad` only. Production build = `next build` + `next start` on :3949 under the restricted database role `matflow_app` (no BYPASSRLS), behind a local TLS proxy on :3950; test-mode Stripe; the mail key deliberately invalid (nothing leaves). End-to-end suite = the dev server on :3847 via the guarded launcher (test branch only). The production database was never touched.

## Gates on `d2adaee`
| Gate | Result | Verdict |
|---|---|---|
| Typecheck | clean | PASS |
| Lint + UI-rule ratchets | eslint clean; every ratchet at or below baseline (hex literals 724, lowered from 725) | PASS |
| Unit + integration (Vitest) | 290 files passed, 28 skipped; **2669 tests passed, 0 failed**, 122 skipped, 15 todo | PASS |
| Production build | exit 0 | PASS |
| RLS enforced under the restricted role | 10 / 10 after migrations `20260930140000` and `20260930160000` | PASS |
| Full 29-file end-to-end suite (assess) | {{ASSESS}} | {{ASSESS_VERDICT}} |

Earlier freezes, for comparison: `9eed314` 636 / 644 (the 8 explained and fixed); `794197b` 635 / 643 (4 database-connection errors under load — each file passed alone — plus an intended key change and a flaky wizard step, passed alone); `efc2889` 574 passed, 8 failed, 7 not run (intended role changes and connection errors; every file re-run alone passed except where a test followed an intended change, now updated).

## Pending migrations (9), all additive and each wrapped in `BEGIN … COMMIT`
`20260923220000_billing_cycle_weekly` (CHECK widened) · `20260924120000_member_hold_until` · `20260925000000_locations` (new table, RLS) · `20260925090000_tier_location` · `20260926130000_user_must_change_password` · `20260930100000_import_provenance_review_lock` · `20260930120000_request_ids` (two nullable columns + unique indexes) · `20260930140000_member_billing_source` (three columns + CHECK; ImportJob.mode + CHECK — the CHECKs scan small tables) · `20260930160000_class_is_kids` (constant default, metadata-only). Atomicity pinned by `tests/unit/migrations-are-atomic.test.ts`; mid-sequence failure drill PASS 86/86 on the first six; the last three are additive and not separately drilled. Recovery is forward (fix + re-run `migrate deploy`); a code rollback does not reverse schema. The old build keeps working on the new schema (nullable/defaulted columns, widened checks).

## Authentication with every bypass off
8 / 8 over https on a production build: password sign-in, owner TOTP set-up and challenge, wrong codes, recovery-code single use, reset with session revocation, the throttle. Forced own password after an owner- or operator-set password: confirmed by the functional reviewer on `efc2889`.

## Blocked, with owner
| Item | Owner |
|---|---|
| Independent security/data review (never ran — classifier) | Noe: go |
| Production runtime role (BYPASSRLS?) | Noe: one query |
| Point-in-time restore rehearsal | Noe: Neon console |
| `RESEND_FROM` + DMARC; `CRON_SECRET` only after the retention preview; `BLOB_READ_WRITE_TOKEN` confirmed | Noe |
| Disable the operator shared-secret door in production | Noe (config) |

## Deploy
Runbook `docs/runbooks/DEPLOY-2026-10.md` (not executed): env vars → push → watch `maybe-migrate` → smoke (health, `/login?club=`, apply, operator login, a dashboard read, kiosk 404) → Sentry and cron checks → recovery by redeploying the previous build (schema forward-fix). A push needs Noe's word.
