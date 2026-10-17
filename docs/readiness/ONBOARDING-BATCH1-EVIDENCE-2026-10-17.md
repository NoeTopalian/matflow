# Owner onboarding — batch 1 evidence (16–17 Oct 2026)

Branch `fix/onboarding-batch1`, base `main` at `1796d9d`. Draft PR #35. Not merged, not deployed; no migration; no
production data touched. Every browser and database check below ran against the Neon **test** branch with synthetic clubs
that were removed afterwards. Raw browser ledger: [`evidence/onboarding-batch1-browser-ledger-2026-10-17.md`](evidence/onboarding-batch1-browser-ledger-2026-10-17.md).

## 1. What changed, in four parts

### 1.1 Onboarding state preservation, navigation and error handling
- Only what the owner changed is saved: the club name is compared with the club's saved name; the device time zone is
  applied only to a club still in first setup whose stored zone differs (and the screen says so); logo size only when
  changed; the questionnaire is prefilled from saved answers and saved only on change. A failed read of the club on
  `/onboarding` fails closed (treated as set up; the zone is never moved; questionnaire answers are not overwritten).
- Every save is checked. A failure keeps the owner on the step with the entered values. Messages name the cause: signed
  out (401), the server's own reason (403, 400/422), or a connection problem. The message is shown beside the step's
  buttons (role="alert", with Dismiss) until the next attempt, a step change or dismissal; a toast also fires.
- Completion ("Your gym is ready") is shown only after the completion write succeeds.
- Double clicks move one step (busy guard plus a 400 ms step-change guard); one progress label and one Skip per step;
  Back and Skip are disabled while a save is in flight.
- Removal or change of an item already saved in this run (classes, belt systems/ranks) is reported on Continue and Skip.
- Setup-banner links go to `/dashboard/settings?tab=revenue` and `?tab=import`, not back into the wizard
  (`getSetupGaps` moved to `lib/setup-gaps.ts`).

### 1.2 CSV hand-off deduplication and replay (`app/api/onboarding/csv-handoff/route.ts`)
- The wizard sends one random 32-hex `clientRef` per chosen file (kept for the tab, with the file's name/size/modified
  time, until setup finishes). The route stores the file under `.../handoff-<ref>-<suffix>.csv` and records the content's
  sha256 on the job (`ImportJob.fileHash`).
- Before storing, and again under a per-reference advisory lock inside the job transaction, the route looks for a job of
  this tenant, this owner, status `pending_white_glove`, whose stored URL carries the reference. Found with the same
  content → it answers with that job and does nothing else (no second file, job, notification or rate-limit spend). Found
  with different content → 409 `handoff_ref_mismatch` (the wizard forgets the reference; the next press is a new upload).
- The reply to a replay says what the first attempt recorded in its (durable) audit row: notification sent, not sent
  (mail off), or unknown; and whether changed notes were dropped.
- A file stored when the job transaction then fails is deleted unless a job points at it. A stored URL without the
  reference marker is logged.
- Copy: no turnaround or delivery promise ("within 1 business day" and "we'll email you" removed from the replies and the
  wizard card).

### 1.3 Class-save recovery (step 4)
- No class is sent until the club's class list has been read (the "before" baseline). If it can't be read, nothing is sent
  and the owner is told.
- A save with no answer (network) or a 5xx is remembered by what was sent. On the next Save or Skip it is settled against
  the class list: exactly one new class matching everything sent (name, coach, location, capacity, duration, days, times)
  against complete lists is adopted; a complete list without a match means it wasn't made (Save sends it again; Skip says
  so); two matches, a cut-short list (the route returns one page of 100), or an earlier save whose id couldn't be read is
  **uncertain** — reported by name with what to do on the Timetable page, never adopted or re-sent on a guess.
- `GET /api/classes?strict=1` answers a read failure as 503 instead of an empty list (other callers unchanged).

### 1.4 Two test-loading corrections
- `tests/unit/csv-export-fidelity.test.ts`: `ReportsView` imported at module level instead of inside the test body.
- `tests/unit/sec-c2-upload-controls.test.ts`: route graphs warmed in `beforeAll` (hook timeout 60 s).
No assertion changed and no timeout was raised. See §6.

## 2. Exact boundaries of each "no duplicates" claim

| Item | Holds for | Does not hold for | Backed by |
|---|---|---|---|
| Club settings (name, zone, logo size, answers, completion) | any retry | — (a repeat write is idempotent) | application (PATCH of absolute values) |
| Ranks | any retry, reload, tab or sign-in | — | **database**: unique (tenantId, discipline, order) → 409 |
| Classes | one page session: Back/Continue, double clicks, partial failure then retry, a lost response then retry when the list identifies the class unambiguously | after a reload, new tab or sign-in (re-adding creates a second class, E22); when a single class created by someone else in the window matches everything sent (it is adopted as "saved after all") | application only; no server uniqueness on classes |
| Class sessions | any retry | — | database: `skipDuplicates` on instance generation |
| Logo upload | one page session, same chosen file | a lost upload response then retry stores a second copy (not visible to the owner) | application |
| CSV hand-off | same tab, same file (name/size/modified time and content), until Finish, while the job is `pending_white_glove`: retries, reload, overlapping requests | a new tab or sign-in, blocked storage, a different file chosen in between (one reference slot), once the job leaves `pending_white_glove` (nothing in today's workflow moves it) | application + Postgres advisory lock; provider shape unverified (§3) |

## 3. CSV hand-off: what establishes each guarantee

| Guarantee | Database constraint | Application logic | Verified on real Postgres (both roles) | Provider-dependent, not verified |
|---|---|---|---|---|
| One job per reference, incl. overlapping requests | none (no unique index) | lookup before store + `pg_advisory_xact_lock(ns, hashtext(tenant:ref))` + lookup in the job transaction | yes — forced overlap: 1 job, 1 notification call, the losing copy's `del` called | that the real Vercel Blob URL keeps `/handoff-<ref>` with `addRandomSuffix` (mock reproduces the shape; a mismatch is logged) |
| Replay only of the same bytes | `ImportJob.fileHash` stored (not unique) | sha256 compared on both paths → 409 | yes (same ref, different content → 409, still 1 job) | — |
| Tenant/owner isolation of replays | RLS policies (backstop) | every lookup filters tenantId + createdById + status + marker, inside `withTenantContext`; the reply carries only this owner's job id and a message | yes (restricted `matflow_app` role) | — |
| Losing copy / orphaned file removed | — | `del` on the overlap path; `del` in the catch when no job points at the file | `del` called (mocked) | real `del` on private blobs |
| "Notification was sent" | — | `teamNotified` = the email provider accepted the send (`sendEmail` ok) | no (email mocked) | delivery to the inbox |
| Replay answer about the notification and notes | — | read from the durable audit row; missing row → "can't confirm" | no (`logAudit` mocked in the DB test; unit tests only) | — |

Browser runs had no blob store (test environment), so the hand-off **success** path was not exercised in a browser;
the failure path (503 "uploads unavailable") was.

## 4. Checks and the commits they ran on

The last code commit is `0ba770ee` (`0ba770ee7b568b25a27db79ae694760425adca88`). The commit after it adds only this
document and the ledger, so the checks below apply to the code as it stands at the PR head. Gate results on the PR head
itself (local lint, test and production build, and GitHub CI) are in the PR description.

- **Full suite** at `0ba770ee` (local, no `DATABASE_URL`): 498 files passed / 84 skipped; 6947 tests passed, 0 failed,
  616 skipped, 3 todo (§7).
- **Mutation checks** at `0ba770ee` (clean tree): 42 deliberate regressions, each caught by a test, including two on the real
  database under both roles (the advisory lock and the content check). Baseline: the real-database test passes unmutated.
- **Real-database test** (`tests/integration/csv-handoff-clientref-db.test.ts`) on the Neon test branch: 4/4 as the owner
  role and 4/4 as the restricted `matflow_app` role. Email, the audit write and the blob store are mocked in it (§3).
- **Browser** on the production build of `0ba770ee` (BUILD_ID `wJJLvN0cBcbq_JUYo-hMI`), test branch, two synthetic clubs
  (empty; configured), six scenarios (empty, csvref, lost, configured, mobile 390 px, step 9 mobile + keyboard), one
  uninterrupted run: 47 PASS, 8 NOTE, 0 FAIL. Fixtures torn down afterwards (0 left). Ledger and NOTE rows:
  [`evidence/onboarding-batch1-browser-ledger-2026-10-17.md`](evidence/onboarding-batch1-browser-ledger-2026-10-17.md).
  Harness limits: step 9's retry sub-check waits for the alert (cannot tell "cleared and returned" from "never cleared");
  the keyboard check that the failure is "announced" checks visible text, not a live region; mobile checks are horizontal
  bounds only.
- **Not demonstrated end-to-end** (unit tests only): the reload-then-replay of a confirmed CSV upload; the CSV reference
  being forgotten at Finish; the replay's reading of the audit row; class settling beyond the lost-response case (L2);
  the content-mismatch reply in a browser.

## 5. Skipped tests

The suite skips database suites when `DATABASE_URL` is unset, and suites written for the Neon test branch on any other
database; plus 3 `todo` tests. The full list of skipped files with their counts and reasons is in §7.

## 6. Reports CSV timeout — supported, not conclusively isolated

One full run (before the fix) failed with `csv-export-fidelity.test.ts` "Reports CSV…" timing out at 30 000 ms. The test
imported `ReportsView` inside its body, so the module's cold transform counted against the 30 s test timeout. Single,
uncontrolled timings: cold, alone — 23.7 s on this branch, 11.9 s on the base worktree; warm, alone — 1.2–1.55 s on both.
`ReportsView`'s import graph contains none of the files this branch changes. **No comparable full-load run of the base was
performed**, so the cause is supported by the measurements and the import graph but not conclusively isolated. The fix
moves the import to module level (assertions unchanged, no timeout raised); the same pattern was fixed in
`sec-c2-upload-controls` (31 s in a 4-file run, 0.6 s alone). 771 in-test `await import(` calls across 207 unit files remain
a suite-wide risk.

## 7. Skipped files (full list)

From the full-suite JSON report at `0ba770ee` (local run, no `DATABASE_URL`): 6947 passed, 0 failed, 616 skipped, 3 todo, in 85 files with skips. Skipped tests are not run in this configuration. CI's "Typecheck + Lint + Vitest" job sets a database for its own Postgres service, so general database suites run there; suites written for the Neon test branch (including the new `csv-handoff-clientref-db.test.ts`) skip on a local or CI database by design (`tests/integration/helpers/db-target.ts`). That suite was run separately against the Neon test branch under both roles (§4).

| File | Skipped | Todo | Why | First suite |
|---|---:|---:|---|---|
| `tests/integration/account-editing-db.test.ts` | 14 | 0 | whole file skipped (needs a database or environment not present in this run) | account editing on real rows |
| `tests/integration/attendance-import-engine.test.ts` | 19 | 0 | needs a database (DATABASE_URL unset in this run) | attendance-import engine on the test database [skipped: no DATABASE_URL] |
| `tests/integration/audit-durability-db.test.ts` | 4 | 0 | whole file skipped (needs a database or environment not present in this run) | durable audit writes on the database |
| `tests/integration/campaign-db-helper.test.ts` | 5 | 0 | whole file skipped (needs a database or environment not present in this run) | campaign db helper |
| `tests/integration/checkin-pack-race.test.ts` | 1 | 0 | whole file skipped (needs a database or environment not present in this run) | Check-in pack-credit race (kiosk path) |
| `tests/integration/checkin-window-config.test.ts` | 1 | 0 | whole file skipped (needs a database or environment not present in this run) | Per-tenant check-in window |
| `tests/integration/class-instance-uniqueness.test.ts` | 4 | 0 | whole file skipped (needs a database or environment not present in this run) | ClassInstance (classId, date, startTime) is unique |
| `tests/integration/class-schedule-edit.test.ts` | 5 | 0 | whole file skipped (needs a database or environment not present in this run) | PATCH /api/classes/[id] — schedule edit reconciliation |
| `tests/integration/contact-email-change-imports-db.test.ts` | 7 | 0 | whole file skipped (needs a database or environment not present in this run) | contact-email change → imports keep the person (AH-05) |
| `tests/integration/cron-smoke.test.ts` | 18 | 0 | whole file skipped (needs a database or environment not present in this run) | Vercel cron entrypoints |
| `tests/integration/cross-tenant-authorisation-matrix.test.ts` | 54 | 0 | whole file skipped (needs a database or environment not present in this run) | Cross-tenant authorisation matrix › Member |
| `tests/integration/csv-handoff-clientref-db.test.ts` | 4 | 0 | needs a database (DATABASE_URL unset in this run) | csv hand-off clientRef on the database no DATABASE_URL |
| `tests/integration/e2e-guard-real-database.test.ts` | 3 | 0 | whole file skipped (needs a database or environment not present in this run) | the e2e guard against the real test database |
| `tests/integration/email-lowercase-invariant.test.ts` | 4 | 0 | whole file skipped (needs a database or environment not present in this run) | email is stored lowercase whatever writes it |
| `tests/integration/import-reconciliation-live.test.ts` | 1 | 0 | needs a database (DATABASE_URL unset in this run) | import reconciliation — live queries on the test branch |
| `tests/integration/import-upload.test.ts` | 1 | 0 | whole file skipped (needs a database or environment not present in this run) | chunked import upload — real database |
| `tests/integration/login-email-change-db.test.ts` | 11 | 0 | whole file skipped (needs a database or environment not present in this run) | login-email change + rollback on real rows |
| `tests/integration/login-identity-claims-db.test.ts` | 13 | 0 | whole file skipped (needs a database or environment not present in this run) | login identity claims on real rows |
| `tests/integration/login-identity-race-db.test.ts` | 7 | 0 | whole file skipped (needs a database or environment not present in this run) | login identity: concurrent claims across User and Member |
| `tests/integration/member-cascade-delete.test.ts` | 3 | 0 | whole file skipped (needs a database or environment not present in this run) | Staff Member.DELETE cascade |
| `tests/integration/member-children-lifecycle.test.ts` | 10 | 0 | whole file skipped (needs a database or environment not present in this run) | Parent/kid lifecycle |
| `tests/integration/member-children-photos.test.ts` | 5 | 0 | whole file skipped (needs a database or environment not present in this run) | US-5 — kid photo evidence |
| `tests/integration/member-children-stats.test.ts` | 2 | 0 | whole file skipped (needs a database or environment not present in this run) | US-4 rich kid stats parity |
| `tests/integration/member-self-pay.test.ts` | 6 | 0 | whole file skipped (needs a database or environment not present in this run) | F2 member self-subscribe |
| `tests/integration/operator-enrolment-ticket-db.test.ts` | 4 | 0 | whole file skipped (needs a database or environment not present in this run) | operator enrolment ticket on the database |
| `tests/integration/operator-hub-conflict-db.test.ts` | 11 | 0 | whole file skipped (needs a database or environment not present in this run) | hub conflict workflow on the database (AH-04) |
| `tests/integration/operator-step-up-db.test.ts` | 10 | 0 | whole file skipped (needs a database or environment not present in this run) | operator single-use controls on the database |
| `tests/integration/owner-recovery-revocation-db.test.ts` | 5 | 0 | whole file skipped (needs a database or environment not present in this run) | owner recovery codes, operator 2FA reset, revocation (real rows) |
| `tests/integration/parent-checkin-kid.test.ts` | 4 | 0 | whole file skipped (needs a database or environment not present in this run) | Parent-of-kid check-in |
| `tests/integration/parent-deletion-gateway.test.ts` | 8 | 0 | whole file skipped (needs a database or environment not present in this run) | Parent-deletion gateway (F5) |
| `tests/integration/parent-no-membership.test.ts` | 4 | 0 | whole file skipped (needs a database or environment not present in this run) | Parent with no membership + kid with membership |
| `tests/integration/parent-pays-for-kid.test.ts` | 7 | 0 | whole file skipped (needs a database or environment not present in this run) | F3 parent pays for kid |
| `tests/integration/promote-with-photo.test.ts` | 1 | 0 | whole file skipped (needs a database or environment not present in this run) | Promote with photo |
| `tests/integration/push-subscribe.test.ts` | 1 | 0 | whole file skipped (needs a database or environment not present in this run) | POST /api/push/subscribe |
| `tests/integration/ranksystem-soft-delete.test.ts` | 0 | 3 | whole file skipped (needs a database or environment not present in this run) | RankSystem soft-delete |
| `tests/integration/rls-coverage.test.ts` | 1 | 0 | whole file skipped (needs a database or environment not present in this run) | RLS covers every club table |
| `tests/integration/rls-foundation.test.ts` | 9 | 0 | whole file skipped (needs a database or environment not present in this run) | RLS foundation › Member |
| `tests/integration/roster-cross-tenant.test.ts` | 3 | 0 | whole file skipped (needs a database or environment not present in this run) | Roster cross-tenant rejection (integration) |
| `tests/integration/sec-a-recovery-code-race-db.test.ts` | 4 | 0 | whole file skipped (needs a database or environment not present in this run) | recovery codes are single-use under concurrency (SEC-007) |
| `tests/integration/sec-a-revocation-fail-closed-db.test.ts` | 6 | 0 | whole file skipped (needs a database or environment not present in this run) | SEC-012 on Postgres: an uncheckable session is refused, never admitted |
| `tests/integration/sec-a-revoke-access-db.test.ts` | 5 | 0 | whole file skipped (needs a database or environment not present in this run) | operator revoke-all on Postgres (AH-R7 / SEC-013) |
| `tests/integration/sec-a-step-up-expiry-db.test.ts` | 6 | 0 | whole file skipped (needs a database or environment not present in this run) | step-up grant expiry and spend labels on Postgres (AH-G5) |
| `tests/integration/sec-a-token-subject-binding-db.test.ts` | 7 | 0 | whole file skipped (needs a database or environment not present in this run) | sign-in credentials are bound to the person they were minted for (AH-D2) |
| `tests/integration/sec-a2-lockout-oracle-db.test.ts` | 5 | 0 | whole file skipped (needs a database or environment not present in this run) | lockout v2 on Postgres: no existence oracle, no targeted lockout |
| `tests/integration/sec-a2-member-recovery-race-db.test.ts` | 4 | 0 | whole file skipped (needs a database or environment not present in this run) | member recovery codes are single-use under concurrency (SF-27 residual) |
| `tests/integration/sec-a2-outage-handlers-db.test.ts` | 6 | 0 | whole file skipped (needs a database or environment not present in this run) | SF-44 on Postgres, route handlers: unknown refuses via auth() = null with the cookie kept |
| `tests/integration/sec-a2-outage-proxy-db.test.ts` | 6 | 0 | whole file skipped (needs a database or environment not present in this run) | SF-44 on Postgres through the real proxy: unknown → retryable 503, cookie kept; revoked →  |
| `tests/integration/sec-a2-verify-disown-db.test.ts` | 8 | 0 | whole file skipped (needs a database or environment not present in this run) | SF-37 on Postgres: verify routes check revocation; disown needs a confirmed POST |
| `tests/integration/sec-a3-lockout-oracle-db.test.ts` | 2 | 0 | whole file skipped (needs a database or environment not present in this run) | SF-35 / R3-2 on Postgres: a row-locked account answers like any other address |
| `tests/integration/sec-a4-lockout-burst-db.test.ts` | 5 | 0 | whole file skipped (needs a database or environment not present in this run) | R6-N1: the address-wide failure cap holds under a concurrent burst |
| `tests/integration/sec-b-fixture-sweep-db.test.ts` | 1 | 0 | whole file skipped (needs a database or environment not present in this run) | lane B fixture sweep (prefix secb- only) |
| `tests/integration/sec-b-ownership-transfer-db.test.ts` | 9 | 0 | whole file skipped (needs a database or environment not present in this run) | ownership transfer on the database (owner role) |
| `tests/integration/sec-b-rls-identity-db.test.ts` | 6 | 0 | whole file skipped (needs a database or environment not present in this run) | RLS on identity tables |
| `tests/integration/sec-b-role-matrix-db.test.ts` | 59 | 0 | whole file skipped (needs a database or environment not present in this run) | role-by-route matrix, lane B routes (owner role) |
| `tests/integration/sec-b-sean-imported-cancelled-db.test.ts` | 6 | 0 | whole file skipped (needs a database or environment not present in this run) | Sean's scenario: imported, cancelled, passwordless holder of the owner's address (owner ro |
| `tests/integration/sec-b-version-at-check-db.test.ts` | 4 | 0 | whole file skipped (needs a database or environment not present in this run) | AH-C2 version binding on the database (owner role) |
| `tests/integration/sec-b2-public-boundary-proposal.test.ts` | 6 | 0 | whole file skipped (needs a database or environment not present in this run) | SF-62 proposal applied: the runtime role cannot cross tenants by setting a GUC |
| `tests/integration/sec-b2-signed-context-db.test.ts` | 1 | 0 | whole file skipped (needs a database or environment not present in this run) | signed tenant context: app MAC == SQL recomputation |
| `tests/integration/sec-b2-stale-bypass-db.test.ts` | 6 | 0 | whole file skipped (needs a database or environment not present in this run) | SF-62: stale or leaked session context on a reused connection |
| `tests/integration/sec-c3-rate-limit-atomic-db.test.ts` | 6 | 0 | whole file skipped (needs a database or environment not present in this run) | checkRateLimit on a real database is exact under concurrency (owner) |
| `tests/integration/sec-c4-rate-limit-saturation-db.test.ts` | 5 | 0 | whole file skipped (needs a database or environment not present in this run) | SF-40 / R6-N3: rate limit when the burst saturates the production-size pool (owner) |
| `tests/integration/sec-d-attendance-misbinding-db.test.ts` | 23 | 0 | whole file skipped (needs a database or environment not present in this run) | SEC-053 / AH-D1 — attendance identity binding is never silently wrong (REAL route, TEST DB |
| `tests/integration/sec-d2-deletion-provenance-db.test.ts` | 16 | 0 | whole file skipped (needs a database or environment not present in this run) | SF-54 / SF-74 — every release path records the release in the same transaction (REAL route |
| `tests/integration/sec-d2-import-attacker-model-db.test.ts` | 18 | 0 | whole file skipped (needs a database or environment not present in this run) | SF-74 / SEC-053 — attendance import under an explicit attacker model (REAL route, TEST DB) |
| `tests/integration/sec-d3-deletion-race-db.test.ts` | 8 | 0 | whole file skipped (needs a database or environment not present in this run) | D3 — the release digest is of the address actually released (REAL routes, two connections, |
| `tests/integration/sec-d3-provenance-forgery-db.test.ts` | 17 | 0 | whole file skipped (needs a database or environment not present in this run) | D3 — the mapping-provenance proof is bound to its row, club and chain (REAL route, TEST DB |
| `tests/integration/sec-f-pool-exhaustion-db.test.ts` | 4 | 0 | whole file skipped (needs a database or environment not present in this run) | SEC-076 — a saturated pool fails fast instead of hanging |
| `tests/integration/sec-f2-auditlog-append-only-db.test.ts` | 10 | 0 | needs a database (DATABASE_URL unset in this run) | SF-57 append-only AuditLog as ? (not the owner) — SKIPPED: no DATABASE_URL (database tests |
| `tests/integration/sec-f3-signing-secret-db.test.ts` | 2 | 0 | whole file skipped (needs a database or environment not present in this run) | database test runs sign with a non-empty key (SF-102) |
| `tests/integration/sec-l1-connection-drop-db.test.ts` | 12 | 0 | whole file skipped (needs a database or environment not present in this run) | SF-135: a dropped connection under a pending transaction is a refusal, handled where it is |
| `tests/integration/sec-l1-drop-probe-db.test.ts` | 6 | 0 | whole file skipped (needs a database or environment not present in this run) | L1 probe: connection lifecycle under the c3 burst (owner) |
| `tests/integration/sec-l1-leftovers-db.test.ts` | 1 | 0 | whole file skipped (needs a database or environment not present in this run) | L1 leftovers on TEST |
| `tests/integration/sec-l1-server-settings-db.test.ts` | 1 | 0 | whole file skipped (needs a database or environment not present in this run) | L1 server settings (owner) |
| `tests/integration/sec-l1-start-timeout-db.test.ts` | 4 | 0 | whole file skipped (needs a database or environment not present in this run) | SF-136: a start that times out never leaves a client inside a BEGIN (owner) |
| `tests/integration/sec-l2-tenant-bounds-db.test.ts` | 6 | 0 | whole file skipped (needs a database or environment not present in this run) | L2: tenant transaction bounds on Postgres (owner) |
| `tests/integration/sec-m1-demo-rotate-db.test.ts` | 6 | 0 | needs a database (DATABASE_URL unset in this run) | SF-109 demo-account rotation tool on TEST (owner) [skipped: no DATABASE_URL] |
| `tests/integration/staff-edit-email.test.ts` | 4 | 0 | whole file skipped (needs a database or environment not present in this run) | PATCH /api/staff/[id] — editable email |
| `tests/integration/staff-photo-viewer.test.ts` | 3 | 0 | whole file skipped (needs a database or environment not present in this run) | GET /api/members/[id]/photos (staff) |
| `tests/integration/support-edit-field-policy-db.test.ts` | 5 | 0 | whole file skipped (needs a database or environment not present in this run) | edit-session field policy on the database |
| `tests/integration/support-session-binding-db.test.ts` | 5 | 0 | whole file skipped (needs a database or environment not present in this run) | support session binding on the database |
| `tests/integration/teamup-rehearsal.test.ts` | 5 | 0 | whole file skipped (needs a database or environment not present in this run) | TeamUp migration rehearsal on the catalogue-shaped export |
| `tests/integration/tenant-restore-purge-race.test.ts` | 5 | 0 | whole file skipped (needs a database or environment not present in this run) | restore vs purge on the authoritative Tenant row |
| `tests/integration/token-scoping-db.test.ts` | 7 | 0 | whole file skipped (needs a database or environment not present in this run) | contact-email change retires the club's sign-in tokens, and only those (AH-08) |
| `tests/integration/waiver-blob-fallback.test.ts` | 4 | 0 | whole file skipped (needs a database or environment not present in this run) | Waiver signing — data: URL fallback when Blob unavailable |
| `tests/unit/sec-m2-demo-rotate-hardening.test.ts` | 1 | 0 | individual tests skipped by condition | SF-129 (a): the env file can never be .env |

## 8. Known limits an owner can hit

- After a reload, re-adding the same class creates a second one.
- A class created by someone else during the window that matches everything sent is adopted as "saved after all".
- In clubs with 100 or more classes, an unanswered class save is reported as uncertain rather than settled.
- A retried logo upload after a lost response stores a second copy of the image.
- CSV reference: one per tab until Finish; lost on a new tab, sign-in or blocked storage; some mobile pickers re-stamp the
  modified time.
- Toasts auto-dismiss; the inline note remains until resolved or dismissed. Header Back is 32 px wide on mobile.
- The landing and application pages still promise a reply "within 1 business day" for applications (not onboarding;
  out of scope). The internal hand-off email template still carries an internal SLA line for the team.
