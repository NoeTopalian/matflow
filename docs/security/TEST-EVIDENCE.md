# Security test evidence (campaign of 9 Oct 2026)

Maintained by lane F (SEC-088). One table of every security-relevant test file in `tests/unit` and
`tests/integration`, its level, the database roles it ran under, its last result and how to re-run it. A green exit
code is not evidence that a test ran: read the "skipped" figures and §3.

Source tree: branch `security/assurance-2026-10`, HEAD `ab5f928` at lane start and `71cfe54` by the end, plus uncommitted lane work in the same working tree
(lanes A–F; lane D was still editing the attendance importer while these ran). Results are as of the run times below
and must be re-run on the final integrated candidate SHA before any acceptance claim (brief: "every claim tied to the
final SHA").

## 1. How the rows were produced
| Level | Run | Environment | Exit |
|---|---|---|---|
| U (unit, mocked I/O) | `DATABASE_URL= TEST_DATABASE_URL= npx vitest run --reporter=json` — the whole suite, second pass finished 9 Oct 2026 14:10 UTC on HEAD `71cfe54` + working tree (first pass finished 12:34 UTC on `ab5f928`: 1 failure, lane E's in-progress `sec-e-secret-scan`) | Node 25.9.0 local (CI uses 24), Windows 11, no database | 1 — 495 files, 6,380 tests: 5,915 passed, 33 failed, 432 skipped/todo. Failures: `unit/import-attendance-route.test.ts` 32 (lane D's attendance route at `71cfe54` + working tree answers 500 where the test expects 400/201) and `unit/sec-c-static-guards.test.ts` 1 (lane D's `lib/attendance-import.ts` is a new raw-SQL call site not on lane C's reviewed list). Neither touches a lane F file; both are for the lead to route. |
| U (lane F files) | `npx vitest run tests/unit/sec-f-parser-deadlines.test.ts tests/unit/sec-f-provider-outage.test.ts tests/integration/security.test.ts --reporter=json` | same | 0 (51/51; skip gate PASS with `--require-db`) |
| I (database) | per file, `timeout 300 bash <sp>/att/run-engine.sh <file>` (neondb_owner, BYPASSRLS) then `bash <sp>/q78/run-restricted.sh <file>` (matflow_app, NOBYPASSRLS, `RLS_ENFORCED=1`), 9 Oct 2026 13:20–14:06 UTC | Neon TEST branch `ep-hidden-salad` (pooled), Postgres 17; shared with other lanes running concurrently | per row |

`<sp>` is the session scratchpad holding the two guarded runners; both refuse any host but the TEST branch. The
runner scripts are reproduced in §4 so they survive the scratchpad.

Levels: U = unit with mocks (proves a rule in isolation, not the database); I = integration against real Postgres
(transactions, constraints, RLS, races); "Fuzz" and "L" are marked in the file name column where a file is a bounded
property/resource test. No browser (B) or restore (R) evidence exists in this table: see §3.

## 2. The table

### 2.1 Unit / mocked (U), whole-suite second pass plus lane F files
| File | Level | DB roles | Last result | Re-run |
|---|---|---|---|---|
| integration/cross-tenant-stats.test.ts | U | none (mocked) | PASS 3/3 | `npx vitest run tests/integration/cross-tenant-stats.test.ts` |
| integration/operator-member-totp-reset.test.ts | U | none (mocked) | PASS 8/8 | `npx vitest run tests/integration/operator-member-totp-reset.test.ts` |
| integration/security.test.ts | U | none (mocked) | PASS 13/13 | `npx vitest run tests/integration/security.test.ts` |
| integration/staff-cannot-clear-user-totp.test.ts | U | none (mocked) | PASS 2/2 | `npx vitest run tests/integration/staff-cannot-clear-user-totp.test.ts` |
| integration/tenant-isolation.test.ts | U | none (mocked) | PASS 2/2 | `npx vitest run tests/integration/tenant-isolation.test.ts` |
| integration/totp-login-paths.test.ts | U | none (mocked) | PASS 14/14 | `npx vitest run tests/integration/totp-login-paths.test.ts` |
| unit/account-lockout-counter.test.ts | U | none (mocked) | PASS 5/5 | `npx vitest run tests/unit/account-lockout-counter.test.ts` |
| unit/account-login-email.test.ts | U | none (mocked) | PASS 18/18 | `npx vitest run tests/unit/account-login-email.test.ts` |
| unit/account-password.test.ts | U | none (mocked) | PASS 33/33 | `npx vitest run tests/unit/account-password.test.ts` |
| unit/activation-verdict-operator-created.test.ts | U | none (mocked) | PASS 12/12 | `npx vitest run tests/unit/activation-verdict-operator-created.test.ts` |
| unit/activation-verdict-operator-reset.test.ts | U | none (mocked) | PASS 10/10 | `npx vitest run tests/unit/activation-verdict-operator-reset.test.ts` |
| unit/api-authz-mfa-gate.test.ts | U | none (mocked) | PASS 8/8 | `npx vitest run tests/unit/api-authz-mfa-gate.test.ts` |
| unit/api-authz-password-gate.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/api-authz-password-gate.test.ts` |
| unit/api-authz-totp-challenge.test.ts | U | none (mocked) | PASS 6/6 | `npx vitest run tests/unit/api-authz-totp-challenge.test.ts` |
| unit/apply-rate-limit.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/apply-rate-limit.test.ts` |
| unit/audit-actor-columns-immutability.test.ts | U | none (mocked) | PASS 10/10 | `npx vitest run tests/unit/audit-actor-columns-immutability.test.ts` |
| unit/audit-labels.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/audit-labels.test.ts` |
| unit/audit-log-fire-and-forget.test.ts | U | none (mocked) | PASS 6/6 | `npx vitest run tests/unit/audit-log-fire-and-forget.test.ts` |
| unit/audit-log-get.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/audit-log-get.test.ts` |
| unit/audit-log-impersonation.test.ts | U | none (mocked) | PASS 8/8 | `npx vitest run tests/unit/audit-log-impersonation.test.ts` |
| unit/audit-snapshot.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/audit-snapshot.test.ts` |
| unit/authorisation-agreements.test.ts | U | none (mocked) | PASS 10/10 | `npx vitest run tests/unit/authorisation-agreements.test.ts` |
| unit/avatar-uploader-chip-geometry.test.tsx | U | none (mocked) | PASS 2/2 | `npx vitest run tests/unit/avatar-uploader-chip-geometry.test.tsx` |
| unit/billed-elsewhere-guard.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/billed-elsewhere-guard.test.ts` |
| unit/card-charge-guards.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/card-charge-guards.test.ts` |
| unit/card-token-empty-secret.test.ts | U | none (mocked) | PASS 1/1 | `npx vitest run tests/unit/card-token-empty-secret.test.ts` |
| unit/card-token.test.ts | U | none (mocked) | PASS 20/20 | `npx vitest run tests/unit/card-token.test.ts` |
| unit/checkin-route-audit.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/checkin-route-audit.test.ts` |
| unit/checkin-undo-restores-pack-credit.test.ts | U | none (mocked) | PASS 6/6 | `npx vitest run tests/unit/checkin-undo-restores-pack-credit.test.ts` |
| unit/class-cross-tenant-refs.test.ts | U | none (mocked) | PASS 21/21 | `npx vitest run tests/unit/class-cross-tenant-refs.test.ts` |
| unit/class-instances-cron.test.ts | U | none (mocked) | PASS 16/16 | `npx vitest run tests/unit/class-instances-cron.test.ts` |
| unit/create-subscription-duplicate-guard.test.ts | U | none (mocked) | PASS 3/3 | `npx vitest run tests/unit/create-subscription-duplicate-guard.test.ts` |
| unit/create-tenant-temp-password.test.ts | U | none (mocked) | PASS 2/2 | `npx vitest run tests/unit/create-tenant-temp-password.test.ts` |
| unit/cron-auth-throttle.test.ts | U | none (mocked) | PASS 5/5 | `npx vitest run tests/unit/cron-auth-throttle.test.ts` |
| unit/cron-bearer-constant-time.test.ts | U | none (mocked) | PASS 6/6 | `npx vitest run tests/unit/cron-bearer-constant-time.test.ts` |
| unit/csrf-coverage.test.ts | U | none (mocked) | PASS 10/10 | `npx vitest run tests/unit/csrf-coverage.test.ts` |
| unit/csv-export-fidelity.test.ts | U | none (mocked) | PASS 19/19 | `npx vitest run tests/unit/csv-export-fidelity.test.ts` |
| unit/dsar-erase-audit-durability.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/dsar-erase-audit-durability.test.ts` |
| unit/dsar-erase-children-gate.test.ts | U | none (mocked) | PASS 8/8 | `npx vitest run tests/unit/dsar-erase-children-gate.test.ts` |
| unit/dsar-erase-completeness.test.ts | U | none (mocked) | PASS 20/20 | `npx vitest run tests/unit/dsar-erase-completeness.test.ts` |
| unit/dsar-export.test.ts | U | none (mocked) | PASS 20/20 | `npx vitest run tests/unit/dsar-export.test.ts` |
| unit/e2e-database-guard.test.ts | U | none (mocked) | PASS 9/9 | `npx vitest run tests/unit/e2e-database-guard.test.ts` |
| unit/e2e-stripe-key-guard.test.ts | U | none (mocked) | PASS 9/9 | `npx vitest run tests/unit/e2e-stripe-key-guard.test.ts` |
| unit/env-guards-email-delivery.test.ts | U | none (mocked) | PASS 6/6 | `npx vitest run tests/unit/env-guards-email-delivery.test.ts` |
| unit/family-guardian-review-filter.test.ts | U | none (mocked) | PASS 9/9 | `npx vitest run tests/unit/family-guardian-review-filter.test.ts` |
| unit/forgot-password-bootstrap-door.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/forgot-password-bootstrap-door.test.ts` |
| unit/guardian-confirm-route.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/guardian-confirm-route.test.ts` |
| unit/guardian-review-queue.test.tsx | U | none (mocked) | PASS 8/8 | `npx vitest run tests/unit/guardian-review-queue.test.tsx` |
| unit/guardianship-gate-scan.test.ts | U | none (mocked) | PASS 1/1 | `npx vitest run tests/unit/guardianship-gate-scan.test.ts` |
| unit/impersonate-stop-door.test.ts | U | none (mocked) | PASS 6/6 | `npx vitest run tests/unit/impersonate-stop-door.test.ts` |
| unit/impersonation-cannot-activate.test.ts | U | none (mocked) | PASS 18/18 | `npx vitest run tests/unit/impersonation-cannot-activate.test.ts` |
| unit/impersonation-jwt-claims.test.ts | U | none (mocked) | PASS 14/14 | `npx vitest run tests/unit/impersonation-jwt-claims.test.ts` |
| unit/import-panel-sniff.test.tsx | U | none (mocked) | PASS 8/8 | `npx vitest run tests/unit/import-panel-sniff.test.tsx` |
| unit/import-sniff.test.ts | U | none (mocked) | PASS 16/16 | `npx vitest run tests/unit/import-sniff.test.ts` |
| unit/import-upload-routes.test.ts | U | none (mocked) | PASS 9/9 | `npx vitest run tests/unit/import-upload-routes.test.ts` |
| unit/import-upload.test.ts | U | none (mocked) | PASS 15/15 | `npx vitest run tests/unit/import-upload.test.ts` |
| unit/login-identity-claim.test.ts | U | none (mocked) | PASS 12/12 | `npx vitest run tests/unit/login-identity-claim.test.ts` |
| unit/login-identity-writers.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/login-identity-writers.test.ts` |
| unit/logout-all-totp-pending.test.ts | U | none (mocked) | PASS 2/2 | `npx vitest run tests/unit/logout-all-totp-pending.test.ts` |
| unit/magic-link-bootstrap-doors.test.ts | U | none (mocked) | PASS 11/11 | `npx vitest run tests/unit/magic-link-bootstrap-doors.test.ts` |
| unit/magic-link-security.test.ts | U | none (mocked) | PASS 22/22 | `npx vitest run tests/unit/magic-link-security.test.ts` |
| unit/member-patch-audit-in-tx.test.ts | U | none (mocked) | PASS 3/3 | `npx vitest run tests/unit/member-patch-audit-in-tx.test.ts` |
| unit/member-subscribe-duplicate-guard.test.ts | U | none (mocked) | PASS 8/8 | `npx vitest run tests/unit/member-subscribe-duplicate-guard.test.ts` |
| unit/onboarding-defer-totp.test.tsx | U | none (mocked) | PASS 2/2 | `npx vitest run tests/unit/onboarding-defer-totp.test.tsx` |
| unit/operator-access-script-allowlist.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/operator-access-script-allowlist.test.ts` |
| unit/operator-access-script.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/operator-access-script.test.ts` |
| unit/operator-allowlist.test.ts | U | none (mocked) | PASS 89/89 | `npx vitest run tests/unit/operator-allowlist.test.ts` |
| unit/operator-audit-durability.test.ts | U | none (mocked) | PASS 17/17 | `npx vitest run tests/unit/operator-audit-durability.test.ts` |
| unit/operator-auth-hardening.test.ts | U | none (mocked) | PASS 38/38 | `npx vitest run tests/unit/operator-auth-hardening.test.ts` |
| unit/operator-auth.test.ts | U | none (mocked) | PASS 10/10 | `npx vitest run tests/unit/operator-auth.test.ts` |
| unit/operator-console-xss.test.tsx | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/operator-console-xss.test.tsx` |
| unit/operator-endpoint-authz-matrix.test.ts | U | none (mocked) | PASS 222/222 | `npx vitest run tests/unit/operator-endpoint-authz-matrix.test.ts` |
| unit/operator-hub-conflict-routes.test.ts | U | none (mocked) | PASS 62/62 | `npx vitest run tests/unit/operator-hub-conflict-routes.test.ts` |
| unit/operator-owner-login-email.test.ts | U | none (mocked) | PASS 21/21 | `npx vitest run tests/unit/operator-owner-login-email.test.ts` |
| unit/operator-owner-profile.test.ts | U | none (mocked) | PASS 24/24 | `npx vitest run tests/unit/operator-owner-profile.test.ts` |
| unit/operator-owner-totp-reset-effects.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/operator-owner-totp-reset-effects.test.ts` |
| unit/operator-step-up.test.ts | U | none (mocked) | PASS 72/72 | `npx vitest run tests/unit/operator-step-up.test.ts` |
| unit/overlay-close-guards.test.tsx | U | none (mocked) | PASS 11/11 | `npx vitest run tests/unit/overlay-close-guards.test.tsx` |
| unit/owner-family-guardian-suggestions.test.tsx | U | none (mocked) | PASS 6/6 | `npx vitest run tests/unit/owner-family-guardian-suggestions.test.tsx` |
| unit/password-policy-doors.test.ts | U | none (mocked) | PASS 20/20 | `npx vitest run tests/unit/password-policy-doors.test.ts` |
| unit/payments-export-audit.test.ts | U | none (mocked) | PASS 1/1 | `npx vitest run tests/unit/payments-export-audit.test.ts` |
| unit/payments-export-cap.test.ts | U | none (mocked) | PASS 6/6 | `npx vitest run tests/unit/payments-export-cap.test.ts` |
| unit/provisional-login-email-doors.test.ts | U | none (mocked) | PASS 18/18 | `npx vitest run tests/unit/provisional-login-email-doors.test.ts` |
| unit/resend-webhook.test.ts | U | none (mocked) | PASS 9/9 | `npx vitest run tests/unit/resend-webhook.test.ts` |
| unit/reset-password-session-invalidation.test.ts | U | none (mocked) | PASS 11/11 | `npx vitest run tests/unit/reset-password-session-invalidation.test.ts` |
| unit/retention-cron.test.ts | U | none (mocked) | PASS 35/35 | `npx vitest run tests/unit/retention-cron.test.ts` |
| unit/retention-purge-covers-every-tenant-table.test.ts | U | none (mocked) | PASS 18/18 | `npx vitest run tests/unit/retention-purge-covers-every-tenant-table.test.ts` |
| unit/sec-a-operator-gate-fail-closed.test.ts | U | none (mocked) | PASS 20/20 | `npx vitest run tests/unit/sec-a-operator-gate-fail-closed.test.ts` |
| unit/sec-a-revocation-fail-closed.test.ts | U | none (mocked) | PASS 47/47 | `npx vitest run tests/unit/sec-a-revocation-fail-closed.test.ts` |
| unit/sec-b-email-normalisation.test.ts | U | none (mocked) | PASS 3/3 | `npx vitest run tests/unit/sec-b-email-normalisation.test.ts` |
| unit/sec-b-support-backstop.test.ts | U | none (mocked) | PASS 2/2 | `npx vitest run tests/unit/sec-b-support-backstop.test.ts` |
| unit/sec-c-blob-store-pin.test.ts | U | none (mocked) | PASS 14/14 | `npx vitest run tests/unit/sec-c-blob-store-pin.test.ts` |
| unit/sec-c-body-canary-sweep.test.ts | U | none (mocked) | PASS 238/238 | `npx vitest run tests/unit/sec-c-body-canary-sweep.test.ts` |
| unit/sec-c-csrf-sweep.test.ts | U | none (mocked) | PASS 424/424 | `npx vitest run tests/unit/sec-c-csrf-sweep.test.ts` |
| unit/sec-c-email-template-escaping.test.ts | U | none (mocked) | PASS 25/25 | `npx vitest run tests/unit/sec-c-email-template-escaping.test.ts` |
| unit/sec-c-export-cache.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/sec-c-export-cache.test.ts` |
| unit/sec-c-origin-host.test.ts | U | none (mocked) | PASS 16/16 | `npx vitest run tests/unit/sec-c-origin-host.test.ts` |
| unit/sec-c-owner-login-email-body.test.ts | U | none (mocked) | PASS 23/23 | `npx vitest run tests/unit/sec-c-owner-login-email-body.test.ts` |
| unit/sec-c-prototype-keys.test.ts | U | none (mocked) | PASS 19/19 | `npx vitest run tests/unit/sec-c-prototype-keys.test.ts` |
| unit/sec-c-static-guards.test.ts | U | none (mocked) | FAIL 12/13 | `npx vitest run tests/unit/sec-c-static-guards.test.ts` |
| unit/sec-c-xss-sinks.test.tsx | U | none (mocked) | PASS 12/12 | `npx vitest run tests/unit/sec-c-xss-sinks.test.tsx` |
| unit/sec-d-attendance-ambiguity.test.ts | U | none (mocked) | PASS 18/18 | `npx vitest run tests/unit/sec-d-attendance-ambiguity.test.ts` |
| unit/sec-d-attendance-route-body-shape.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/sec-d-attendance-route-body-shape.test.ts` |
| unit/sec-d-csv-formula-injection.test.ts | U | none (mocked) | PASS 25/25 | `npx vitest run tests/unit/sec-d-csv-formula-injection.test.ts` |
| unit/sec-d-image-bounds.test.ts | U | none (mocked) | PASS 5/5 | `npx vitest run tests/unit/sec-d-image-bounds.test.ts` |
| unit/sec-d-import-security-state.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/sec-d-import-security-state.test.ts` |
| unit/sec-d-mail-holds.test.ts | U | none (mocked) | PASS 8/8 | `npx vitest run tests/unit/sec-d-mail-holds.test.ts` |
| unit/sec-d-stripe-webhook-signature.test.ts | U | none (mocked) | PASS 9/9 | `npx vitest run tests/unit/sec-d-stripe-webhook-signature.test.ts` |
| unit/sec-e-asset-inventory.test.ts | U | none (mocked) | PASS 8/8 | `npx vitest run tests/unit/sec-e-asset-inventory.test.ts` |
| unit/sec-e-secret-scan.test.ts | U | none (mocked) | PASS 18/18 | `npx vitest run tests/unit/sec-e-secret-scan.test.ts` |
| unit/sec-e-supply-chain.test.ts | U | none (mocked) | PASS 14/14 | `npx vitest run tests/unit/sec-e-supply-chain.test.ts` |
| unit/sec-f-parser-deadlines.test.ts | U | none (mocked) | PASS 32/32 | `npx vitest run tests/unit/sec-f-parser-deadlines.test.ts` |
| unit/sec-f-provider-outage.test.ts | U | none (mocked) | PASS 6/6 | `npx vitest run tests/unit/sec-f-provider-outage.test.ts` |
| unit/security-headers-config.test.ts | U | none (mocked) | PASS 16/16 | `npx vitest run tests/unit/security-headers-config.test.ts` |
| unit/sentry-scrub.test.ts | U | none (mocked) | PASS 17/17 | `npx vitest run tests/unit/sentry-scrub.test.ts` |
| unit/session-picker-preselect.test.ts | U | none (mocked) | PASS 5/5 | `npx vitest run tests/unit/session-picker-preselect.test.ts` |
| unit/session-revocation.test.ts | U | none (mocked) | PASS 15/15 | `npx vitest run tests/unit/session-revocation.test.ts` |
| unit/session-without-user-is-signed-out.test.ts | U | none (mocked) | PASS 9/9 | `npx vitest run tests/unit/session-without-user-is-signed-out.test.ts` |
| unit/set-password-route.test.ts | U | none (mocked) | PASS 9/9 | `npx vitest run tests/unit/set-password-route.test.ts` |
| unit/set-password-temp-expiry.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/set-password-temp-expiry.test.ts` |
| unit/staff-last-owner-guard.test.ts | U | none (mocked) | PASS 5/5 | `npx vitest run tests/unit/staff-last-owner-guard.test.ts` |
| unit/staff-temp-password-expiry.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/staff-temp-password-expiry.test.ts` |
| unit/staff-totp-reset.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/staff-totp-reset.test.ts` |
| unit/staff-totp-setup-recovery-single-use.test.ts | U | none (mocked) | PASS 8/8 | `npx vitest run tests/unit/staff-totp-setup-recovery-single-use.test.ts` |
| unit/staff-transfer-ownership.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/staff-transfer-ownership.test.ts` |
| unit/stripe-webhook-handlers.test.ts | U | none (mocked) | PASS 65/65 | `npx vitest run tests/unit/stripe-webhook-handlers.test.ts` |
| unit/support-carrier-jwt.test.ts | U | none (mocked) | PASS 12/12 | `npx vitest run tests/unit/support-carrier-jwt.test.ts` |
| unit/support-carrier-start.test.ts | U | none (mocked) | PASS 5/5 | `npx vitest run tests/unit/support-carrier-start.test.ts` |
| unit/support-cookie-clearing.test.ts | U | none (mocked) | PASS 5/5 | `npx vitest run tests/unit/support-cookie-clearing.test.ts` |
| unit/support-session-binding.test.ts | U | none (mocked) | PASS 19/19 | `npx vitest run tests/unit/support-session-binding.test.ts` |
| unit/support-session-fail-closed-proxy.test.ts | U | none (mocked) | PASS 6/6 | `npx vitest run tests/unit/support-session-fail-closed-proxy.test.ts` |
| unit/support-session-readonly.test.ts | U | none (mocked) | PASS 224/224 | `npx vitest run tests/unit/support-session-readonly.test.ts` |
| unit/support-session-routes.test.ts | U | none (mocked) | PASS 36/36 | `npx vitest run tests/unit/support-session-routes.test.ts` |
| unit/support-session-start.test.ts | U | none (mocked) | PASS 12/12 | `npx vitest run tests/unit/support-session-start.test.ts` |
| unit/support-swap-identity.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/support-swap-identity.test.ts` |
| unit/suspend-step-up-order.test.ts | U | none (mocked) | PASS 5/5 | `npx vitest run tests/unit/suspend-step-up-order.test.ts` |
| unit/temp-password-expired-wording.test.ts | U | none (mocked) | PASS 1/1 | `npx vitest run tests/unit/temp-password-expired-wording.test.ts` |
| unit/temp-password-expiry.test.ts | U | none (mocked) | PASS 11/11 | `npx vitest run tests/unit/temp-password-expiry.test.ts` |
| unit/tenant-slug-demo-guard.test.ts | U | none (mocked) | PASS 8/8 | `npx vitest run tests/unit/tenant-slug-demo-guard.test.ts` |
| unit/today-sessions.test.ts | U | none (mocked) | PASS 6/6 | `npx vitest run tests/unit/today-sessions.test.ts` |
| unit/token-hash.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/token-hash.test.ts` |
| unit/totp-challenge-follows-enrolment.test.ts | U | none (mocked) | PASS 8/8 | `npx vitest run tests/unit/totp-challenge-follows-enrolment.test.ts` |
| unit/totp-immutable-helper.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/totp-immutable-helper.test.ts` |
| unit/totp-mandatory-elevated.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/totp-mandatory-elevated.test.ts` |
| unit/totp-mandatory-owner.test.ts | U | none (mocked) | PASS 8/8 | `npx vitest run tests/unit/totp-mandatory-owner.test.ts` |
| unit/totp-member-optional.test.ts | U | none (mocked) | PASS 9/9 | `npx vitest run tests/unit/totp-member-optional.test.ts` |
| unit/totp-no-self-disable.test.ts | U | none (mocked) | PASS 3/3 | `npx vitest run tests/unit/totp-no-self-disable.test.ts` |
| unit/totp-recommend-banner.test.tsx | U | none (mocked) | PASS 6/6 | `npx vitest run tests/unit/totp-recommend-banner.test.tsx` |
| unit/totp-recovery-codes.test.ts | U | none (mocked) | PASS 14/14 | `npx vitest run tests/unit/totp-recovery-codes.test.ts` |
| unit/totp-setup-password-gate.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/totp-setup-password-gate.test.ts` |
| unit/totp-setup-recovery-codes.test.ts | U | none (mocked) | PASS 4/4 | `npx vitest run tests/unit/totp-setup-recovery-codes.test.ts` |
| unit/totp-verify-single-use.test.ts | U | none (mocked) | PASS 3/3 | `npx vitest run tests/unit/totp-verify-single-use.test.ts` |
| unit/undo-attendance-import-safe.test.ts | U | none (mocked) | PASS 6/6 | `npx vitest run tests/unit/undo-attendance-import-safe.test.ts` |
| unit/undo-batch.test.ts | U | none (mocked) | PASS 5/5 | `npx vitest run tests/unit/undo-batch.test.ts` |
| unit/undo-registry.test.ts | U | none (mocked) | PASS 34/34 | `npx vitest run tests/unit/undo-registry.test.ts` |
| unit/unlink-child-kids-guard.test.ts | U | none (mocked) | PASS 9/9 | `npx vitest run tests/unit/unlink-child-kids-guard.test.ts` |
| unit/upload-blob.test.ts | U | none (mocked) | PASS 19/19 | `npx vitest run tests/unit/upload-blob.test.ts` |
| unit/upload-call-sites-downscale.test.ts | U | none (mocked) | PASS 7/7 | `npx vitest run tests/unit/upload-call-sites-downscale.test.ts` |
| unit/waiver-signature-private.test.ts | U | none (mocked) | PASS 15/15 | `npx vitest run tests/unit/waiver-signature-private.test.ts` |

### 2.2 Database integration (I), TEST branch, both roles, per file (9 Oct 2026 13:20–14:06 UTC)
| File | Level | DB roles | Last result | Re-run |
|---|---|---|---|---|
| integration/account-editing-db.test.ts | I | owner / matflow_app | owner exit 0 — 14 passed (14) (55s); matflow_app exit 0 — 14 passed (14) (64s) | `bash <sp>/att/run-engine.sh tests/integration/account-editing-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/account-editing-db.test.ts` |
| integration/audit-durability-db.test.ts | I | owner / matflow_app | owner exit 0 — 4 passed (4) (14s); matflow_app exit 0 — 4 passed (4) (12s) | `bash <sp>/att/run-engine.sh tests/integration/audit-durability-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/audit-durability-db.test.ts` |
| integration/contact-email-change-imports-db.test.ts | I | owner / matflow_app | owner exit 0 — 7 passed (7) (76s); matflow_app exit 0 — 7 passed (7) (88s) | `bash <sp>/att/run-engine.sh tests/integration/contact-email-change-imports-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/contact-email-change-imports-db.test.ts` |
| integration/cross-tenant-authorisation-matrix.test.ts | I | owner / matflow_app | owner exit 0 — 54 passed (54) (91s); matflow_app exit 0 — 54 passed (54) (88s) | `bash <sp>/att/run-engine.sh tests/integration/cross-tenant-authorisation-matrix.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/cross-tenant-authorisation-matrix.test.ts` |
| integration/email-lowercase-invariant.test.ts | I | owner / matflow_app | owner exit 0 — 4 passed (4) (14s); matflow_app exit 0 — 4 passed (4) (14s) | `bash <sp>/att/run-engine.sh tests/integration/email-lowercase-invariant.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/email-lowercase-invariant.test.ts` |
| integration/login-email-change-db.test.ts | I | owner / matflow_app | owner exit 0 — 11 passed (11) (51s); matflow_app exit 0 — 11 passed (11) (43s) | `bash <sp>/att/run-engine.sh tests/integration/login-email-change-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/login-email-change-db.test.ts` |
| integration/login-identity-claims-db.test.ts | I | owner / matflow_app | owner exit 0 — 13 passed (13) (224s); matflow_app exit 0 — 13 passed (13) (146s) | `bash <sp>/att/run-engine.sh tests/integration/login-identity-claims-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/login-identity-claims-db.test.ts` |
| integration/login-identity-race-db.test.ts | I | owner / matflow_app | owner exit 0 — 7 passed (7) (132s); matflow_app exit 0 — 7 passed (7) (120s) | `bash <sp>/att/run-engine.sh tests/integration/login-identity-race-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/login-identity-race-db.test.ts` |
| integration/member-cascade-delete.test.ts | I | owner / matflow_app | owner exit 0 — 3 passed (3) (9s); matflow_app exit 0 — 3 passed (3) (9s) | `bash <sp>/att/run-engine.sh tests/integration/member-cascade-delete.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/member-cascade-delete.test.ts` |
| integration/operator-enrolment-ticket-db.test.ts | I | owner / matflow_app | owner exit 0 — 4 passed (4) (16s); matflow_app exit 0 — 4 passed (4) (13s) | `bash <sp>/att/run-engine.sh tests/integration/operator-enrolment-ticket-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/operator-enrolment-ticket-db.test.ts` |
| integration/operator-hub-conflict-db.test.ts | I | owner / matflow_app | owner exit 0 — 11 passed (11) (35s); matflow_app exit 0 — 11 passed (11) (37s) | `bash <sp>/att/run-engine.sh tests/integration/operator-hub-conflict-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/operator-hub-conflict-db.test.ts` |
| integration/operator-step-up-db.test.ts | I | owner / matflow_app | owner exit 0 — 10 passed (10) (25s); matflow_app exit 0 — 10 passed (10) (22s) | `bash <sp>/att/run-engine.sh tests/integration/operator-step-up-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/operator-step-up-db.test.ts` |
| integration/owner-recovery-revocation-db.test.ts | I | owner / matflow_app | owner exit 0 — 5 passed (5) (9s); matflow_app exit 0 — 5 passed (5) (10s) | `bash <sp>/att/run-engine.sh tests/integration/owner-recovery-revocation-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/owner-recovery-revocation-db.test.ts` |
| integration/parent-deletion-gateway.test.ts | I | owner / matflow_app | owner exit 0 — 8 passed (8) (25s); matflow_app exit 0 — 8 passed (8) (20s) | `bash <sp>/att/run-engine.sh tests/integration/parent-deletion-gateway.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/parent-deletion-gateway.test.ts` |
| integration/rls-coverage.test.ts | I | owner / matflow_app | owner exit 0 — 1 passed (1) (4s); matflow_app exit 0 — 1 passed (1) (6s) | `bash <sp>/att/run-engine.sh tests/integration/rls-coverage.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/rls-coverage.test.ts` |
| integration/rls-foundation.test.ts | I | owner / matflow_app | owner exit 0 — 3 passed (5s); matflow_app exit 0 — 9 passed (9) (8s) | `bash <sp>/att/run-engine.sh tests/integration/rls-foundation.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/rls-foundation.test.ts` |
| integration/roster-cross-tenant.test.ts | I | owner / matflow_app | owner exit 0 — 3 passed (3) (14s); matflow_app exit 0 — 3 passed (3) (12s) | `bash <sp>/att/run-engine.sh tests/integration/roster-cross-tenant.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/roster-cross-tenant.test.ts` |
| integration/sec-a-recovery-code-race-db.test.ts | I | owner / matflow_app | owner exit 0 — 4 passed (4) (25s); matflow_app exit 0 — 4 passed (4) (retry after network ETIMEDOUT) (22s) | `bash <sp>/att/run-engine.sh tests/integration/sec-a-recovery-code-race-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/sec-a-recovery-code-race-db.test.ts` |
| integration/sec-a-revocation-fail-closed-db.test.ts | I | owner / matflow_app | owner exit 0 — 6 passed (6) (retry after network ETIMEDOUT) (11s); matflow_app exit 0 — 6 passed (6) (retry after network ETIMEDOUT) (11s) | `bash <sp>/att/run-engine.sh tests/integration/sec-a-revocation-fail-closed-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/sec-a-revocation-fail-closed-db.test.ts` |
| integration/sec-a-revoke-access-db.test.ts | I | owner / matflow_app | owner exit 0 — 5 passed (5) (30s); matflow_app exit 0 — 5 passed (5) (35s) | `bash <sp>/att/run-engine.sh tests/integration/sec-a-revoke-access-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/sec-a-revoke-access-db.test.ts` |
| integration/sec-a-step-up-expiry-db.test.ts | I | owner / matflow_app | owner exit 0 — 6 passed (6) (10s); matflow_app exit 0 — 6 passed (6) (13s) | `bash <sp>/att/run-engine.sh tests/integration/sec-a-step-up-expiry-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/sec-a-step-up-expiry-db.test.ts` |
| integration/sec-a-token-subject-binding-db.test.ts | I | owner / matflow_app | owner exit 0 — 7 passed (7) (33s); matflow_app exit 0 — 7 passed (7) (31s) | `bash <sp>/att/run-engine.sh tests/integration/sec-a-token-subject-binding-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/sec-a-token-subject-binding-db.test.ts` |
| integration/sec-b-ownership-transfer-db.test.ts | I | owner / matflow_app | owner exit 0 — 9 passed (9) (51s); matflow_app exit 0 — 9 passed (9) (48s) | `bash <sp>/att/run-engine.sh tests/integration/sec-b-ownership-transfer-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/sec-b-ownership-transfer-db.test.ts` |
| integration/sec-b-rls-identity-db.test.ts | I | owner / matflow_app | owner exit 0 — 6 passed (6) (6s); matflow_app exit 0 — 6 passed (6) (8s) | `bash <sp>/att/run-engine.sh tests/integration/sec-b-rls-identity-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/sec-b-rls-identity-db.test.ts` |
| integration/sec-b-role-matrix-db.test.ts | I | owner / matflow_app | owner exit 0 — 59 passed (59) (61s); matflow_app exit 0 — 59 passed (59) (60s) | `bash <sp>/att/run-engine.sh tests/integration/sec-b-role-matrix-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/sec-b-role-matrix-db.test.ts` |
| integration/sec-b-sean-imported-cancelled-db.test.ts | I | owner / matflow_app | owner exit 0 — 6 passed (6) (37s); matflow_app exit 0 — 6 passed (6) (32s) | `bash <sp>/att/run-engine.sh tests/integration/sec-b-sean-imported-cancelled-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/sec-b-sean-imported-cancelled-db.test.ts` |
| integration/sec-b-version-at-check-db.test.ts | I | owner / matflow_app | owner exit 0 — 4 passed (4) (20s); matflow_app exit 0 — 4 passed (4) (20s) | `bash <sp>/att/run-engine.sh tests/integration/sec-b-version-at-check-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/sec-b-version-at-check-db.test.ts` |
| integration/sec-d-attendance-misbinding-db.test.ts | I | owner / matflow_app | owner exit 0 — 14 passed (14) (121s); matflow_app exit 0 — 14 passed (14) (133s) | `bash <sp>/att/run-engine.sh tests/integration/sec-d-attendance-misbinding-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/sec-d-attendance-misbinding-db.test.ts` |
| integration/sec-f-pool-exhaustion-db.test.ts | I | owner / matflow_app | owner exit 0 — 4 passed (4) (40s); matflow_app exit 0 — 4 passed (4) (40s) | `bash <sp>/att/run-engine.sh tests/integration/sec-f-pool-exhaustion-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/sec-f-pool-exhaustion-db.test.ts` |
| integration/staff-edit-email.test.ts | I | owner / matflow_app | owner exit 0 — 4 passed (4) (9s); matflow_app exit 0 — 4 passed (4) (10s) | `bash <sp>/att/run-engine.sh tests/integration/staff-edit-email.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/staff-edit-email.test.ts` |
| integration/support-session-binding-db.test.ts | I | owner / matflow_app | owner exit 0 — 5 passed (5) (9s); matflow_app exit 0 — 5 passed (5) (8s) | `bash <sp>/att/run-engine.sh tests/integration/support-session-binding-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/support-session-binding-db.test.ts` |
| integration/tenant-restore-purge-race.test.ts | I | owner / matflow_app | owner exit 0 — 5 passed (5) (108s); matflow_app exit 0 — 5 passed (5) (107s) | `bash <sp>/att/run-engine.sh tests/integration/tenant-restore-purge-race.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/tenant-restore-purge-race.test.ts` |
| integration/token-scoping-db.test.ts | I | owner / matflow_app | owner exit 0 — 7 passed (7) (24s); matflow_app exit 0 — 7 passed (7) (23s) | `bash <sp>/att/run-engine.sh tests/integration/token-scoping-db.test.ts` and `bash <sp>/q78/run-restricted.sh tests/integration/token-scoping-db.test.ts` |

## 3. What this table does NOT show (read before quoting a total)
- **No database file ran in a no-DB run.** In the whole-suite run 56 DB-backed files (421 tests) reported "skipped"
  and the run would have exited 0 but for one unrelated failure. Only the 33 files in §2.2 have database evidence
  from lane F; the other DB-backed security files below are NOT RUN by lane F (reasons given).
- **Not run by lane F:** `integration/cron-smoke.test.ts` (runs the real retention sweep on the shared TEST branch
  — global deletes would disturb other lanes' fixtures; run it in a quiet window), `integration/sec-b-fixture-sweep-db`
  (deletion sweep, only with `SEC_B_SWEEP=1`, lane B's), `integration/e2e-guard-real-database` and
  `integration/import-upload` (not security-assertion files; run in CI). The remaining DB-backed non-security files
  (children, packs, schedules, check-in, photos) were not run.
- **Transient network failures look like skips.** In the first pass three runs (`sec-a-recovery-code-race-db` under
  matflow_app; `sec-a-revocation-fail-closed-db` under both roles) failed to connect (ETIMEDOUT/ENETUNREACH to the
  Neon host) and vitest reported "N skipped" with exit 1. All three passed on retry; both passes are kept
  (`evidence/F/db-runs-first-pass-2026-10-09.txt`, `db-runs-final-2026-10-09.txt`). A dashboard that counted only
  "failed" would have shown these as clean.
- **`rls-foundation` under neondb_owner: 3 passed, 6 skipped by design** (the role has BYPASSRLS, so the six
  enforcement cells cannot run); under matflow_app with `RLS_ENFORCED=1` all 9 pass. The owner result is not RLS
  evidence.
- **CI proves one role.** `.github/workflows/ci.yml` runs every DB file as the `postgres` superuser and only
  `rls-foundation` under a NOBYPASSRLS role. Every "matflow_app" cell above is local evidence until CI runs the
  security DB set under the restricted role (proposal in `evidence/F/REPORT.md`). CI on `main` has been red for its
  last four pushes (E-05), so no CI result currently corroborates this table.
- **No browser (B), restore (R) or production evidence.** Browser checks for cookies/CSRF/redirects are lanes A/C;
  no restore has ever been executed (SEC-086 BLOCKED, `INCIDENT-AND-RESTORE-RUNBOOK.md` §2.4); production
  configuration is unknown (SF-02).
- **Mocked unit files prove rules, not systems.** `integration/security.test.ts` lives under `tests/integration` but
  mocks Prisma entirely; it is level U.
- Results are against a working tree, not a commit. Re-run on the integrated candidate.

## 4. How to re-run
Unit (any machine, no database): `DATABASE_URL= TEST_DATABASE_URL= npx vitest run <file>` — or the whole suite with
`--reporter=json --outputFile=v.json` followed by `node scripts/readiness/test-skip-gate.mjs v.json` (fails on any
failure, load error or zero-test file).

Database, both roles (TEST branch only). The two guarded runners, reproduced here because they live outside the repo:

```bash
# owner role (neondb_owner, BYPASSRLS) — <sp>/att/run-engine.sh
URL=$(grep -E '^TEST_DATABASE_URL=' .env.test | head -1 | cut -d= -f2- | tr -d '"' | tr -d '\r')
case "$URL" in *ep-hidden-salad*) ;; *) echo "REFUSED"; exit 2 ;; esac
case "$URL" in *ep-bold-wave*) echo "REFUSED: production"; exit 2 ;; esac
TEST_DATABASE_URL="$URL" DATABASE_URL="$URL" npx vitest run "$@"

# restricted role (matflow_app, RLS forced) — <sp>/q78/run-restricted.sh
URL=$(grep -E '^RESTRICTED_DATABASE_URL=' .env.test | head -1 | cut -d= -f2- | tr -d '"' | tr -d '\r')
# same two host guards
RLS_ENFORCED=1 TEST_DATABASE_URL="$URL" DATABASE_URL="$URL" npx vitest run "$@"
```
Run files one at a time with a ceiling (`timeout 300`); a single vitest process over all 56 DB files exceeded 40
minutes on the shared branch and was killed with no report (lane F, 9 Oct 2026 — use per-file runs). For a claim of
DB evidence add `--reporter=json --outputFile=x.json` and gate with `node scripts/readiness/test-skip-gate.mjs x.json
--require-db --allow=tests/integration/rls-foundation.test.ts` (the allowance is for the owner role only).

## Final both-role sweep (coordinator, 9 Oct 2026 16:55–17:40 UK) — `evidence/lead/final-sweep-2026-10-09.log`
39 security-relevant database files × 2 roles (owner runner `neondb_owner`; restricted runner `matflow_app`, RLS enforced), one file at a time with a 300 s ceiling, on the working tree at `e5f4daf` when the sweep started (lane D's fifth pass `788d29a` landed mid-sweep; the three files it touches — sec-d-attendance-misbinding-db, attendance-import-engine, contact-email-change-imports-db — were re-run afterwards on `788d29a`, see the targeted line below). Result: 78/78 runs exit 0. Not counted as passes: `sec-b-fixture-sweep-db` (opt-in with SEC_B_SWEEP=1; skipped by design under both roles) and `tenant-restore-purge-race` under the restricted role (file reported failed with its 5 tests skipped — cause recorded below; the owner-role run passed). Every other file reports its tests passed under both roles.
Targeted re-run on the final source tree (`788d29a`; working tree `6ff5c4e`, docs only after it; `evidence/lead/final-sweep-targeted-2026-10-09.log`): sec-d-attendance-misbinding-db 23/23, attendance-import-engine 19/19, contact-email-change-imports-db 7/7 — each under both roles, exit 0. `tenant-restore-purge-race` under the restricted role re-run alone: 5/5 passed — the sweep's "failed, 5 skipped" was a transient setup failure (the same class of network blip lanes D and F recorded), not a defect; both roles now green.

## Iteration 2 — lane F2 (9 Oct 2026, ~18:30–19:40 UK; every run on Node v24.21.0, the scratchpad `node24` binary)
Source: HEAD `daba6d7` (lane F2 started at `6043fed`; lanes B2/E2 and the lead committed meanwhile) + lane F2's
working-tree files. Evidence: `evidence/F2/` (`harness-2026-10-09.txt` has the exact commands' results).

**Correction to the final sweep above.** Its `exit=` column is not vitest's exit code: the script stored
`${PIPESTATUS[0]}` after `res=$(cmd | grep | tr)`, which is the status of the substitution (tr, always 0). The
`tenant-restore-purge-race` restricted row "exit=0, 1 failed, 5 skipped" was a setup failure (a throwing `beforeAll`
— vitest reports the file failed and every test skipped; vitest's own exit was 1). For gate evidence use the JSON
report and `test-skip-gate.mjs`, never a scraped exit code.

| Item | Level | Result (Node 24.21.0) |
|---|---|---|
| `tenant-restore-purge-race` setup failure now FAILS each test (was: 5 skipped) | U (unreachable DB 127.0.0.1:1) | HEAD: 5 skipped / file failed; F2: 5 failed, "setup failed (counted as a failure, not a skip)" |
| same, TEST branch | I owner / matflow_app | owner 5/5; matflow_app run 1: 3 lock-wait timeouts (30 s), then 5/5, 5/5 (F2 version) and 5/5 (HEAD version) — timing-dependent under shared-branch load |
| `test-skip-gate.mjs` v2 (setup failure never green; success:false; MAINTENANCE; BLOCKED with `--allow-blocked`) | U | sec-f2-skip-gate 7/7; sec-r-skip-gate-expected-files 3/3 |
| `sec-b-fixture-sweep-db` | decision | maintenance tool, NOT a required check — excluded from `--expect`, skip allowed, reason in the file and the gate |
| `sec-f2-auditlog-append-only-db` on TEST | I owner / matflow_app | 10/10 SKIPPED with the reason (migration absent) → gate FAIL (strict) / PASS-WITH-BLOCKED-COVERAGE (`--allow-blocked`) |
| same, in the isolated restore with the v2 SQL applied | I (PGlite 17.5, SET ROLE) | matflow_app 9 passed + 1 owner-only; owner 10/10; mutants stamp-noop, like-wildcard, delete-open each killed |
| `restore-verify` SF-64 | U + I (isolated restore) | sec-f2-restore-verify-compare 16/16 (incl. guard refusals); tamper controls 10/10 as expected |
| backup export → isolated restore → verify → revoke → verify | R (TEST → PGlite) | run 1 FAIL (JSON null lost — fixed); run 2 PASS, 9.6 s to verified, revoke compare PASS |
| `coverage-reconcile.mjs` | U + C | sec-f2-coverage-reconcile 9/9; real matrix: 96 rows, 0 UNPARSED, deterministic (3 identical runs); `--require-reviewed` counts FIXED as PASS only with a named approval |
| patches 0001–0003 (not applied to the repo) | U + tsc in a scratch worktree | tsc 0; retention-cron + sec-c-static-guards 51/51; migrations-are-atomic 22/22; red without the patch: 2 new retention cells, 1 new guard cell |

Gate the DB sweep with `--require-db --expect=tests/integration/*-db.test.ts --allow=tests/integration/rls-foundation.test.ts`
(owner role) and add `--allow-blocked` only while SF-57 is unapplied — the verdict then reads
PASS-WITH-BLOCKED-COVERAGE, never PASS.

## Iteration 2 — lane E3 (9 Oct 2026; every run on Node v24.21.0, the scratchpad `node24` binary)
Closes review R2 "Owed" 1–5 and the two coordinator residuals. Base HEAD `5f87b11` + lane E3 working-tree edits.
Exact red/green counts per item: `evidence/E3/runs-2026-10-09.txt`. No production access; one read-only TEST-branch
run (`ops-blob-host-count`, positive control). Commands (from the repo root, Node 24 first on PATH):

| Item | Command | Result |
|---|---|---|
| 1 ops-blob-host-count explicit config + duplicate/encoded sslmode refusal | `npx vitest run tests/unit/sec-e3-ops-guards.test.ts tests/unit/sec-e2-ops-scripts.test.ts` | red on HEAD 29 failed / 1 passed; green 42/42 |
| 1 positive control (TEST) | `node scripts/readiness/ops-blob-host-count.mjs .env.test ep-hidden-salad TEST_DATABASE_URL` | exit 0, 451 columns, 0 Blob URLs |
| 2 fingerprint CLI: no argument echo, dotenv parsing, `--from-env-file` | same two files | green 42/42 (window check: no 8-char substring of the value in the output) |
| 3 secret-scan new names + captured-value placeholder test | `npx vitest run tests/unit/sec-e-secret-scan.test.ts tests/unit/sec-e2-containment-redaction.test.ts` | red 13 failed / 28 passed; green 54/54 |
| 3 tree | `node scripts/readiness/secret-scan.mjs --tree` | 1982 files, 49 findings, 5 candidates = the two documented fixture fingerprints (before: 38 / 5), exit 1 as before |
| 3 history | `node scripts/readiness/secret-scan.mjs --history` | 6360 blobs, 134 findings, 12 candidates (before: 120 / 11); the new one is rule `secret-name-table-value` in `docs/SECURITY-AUDIT-2026-05-07.md` (the 7 May leak document, SF-14), not inspected further |
| 4 skip gate zero-match `--expect` glob | `npx vitest run tests/unit/sec-f2-skip-gate.test.ts tests/unit/sec-r-skip-gate-expected-files.test.ts` | HEAD CLI: expected 0, PASS, exit 0; red 1 failed / 7; green 11/11 |
| 5 `/api/upload` limitInputPixels pinned at the route | `npx vitest run tests/unit/sec-e3-upload-limit-input-pixels.test.ts tests/unit/sec-d-image-bounds.test.ts` | option removed: 3 failed (sec-d-image-bounds stays green); restored: 3/3 |
| 6 setup-test-db PG* refusal + lower-casing pinned | `npx vitest run tests/unit/sec-e3-setup-test-db-guard.test.ts` | red 3 failed / 3; green 6/6; toLowerCase mutant 2 failed |
| 6 db-target positive allowlist | `npx vitest run tests/unit/sec-r-db-target-guard.test.ts tests/unit/sec-b2-rls-test-target.test.ts tests/unit/sec-f2-restore-verify-compare.test.ts` | red 1 failed (sibling `ep-hidden-salad-*` endpoint accepted); green |
