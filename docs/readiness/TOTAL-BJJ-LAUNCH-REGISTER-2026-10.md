# Total BJJ launch register — October 2026

Prepared 30 Sep 2026 (Italy time) under the brief of the same day. Every row carries a verdict (PASS · FAIL · BLOCKED · NOT RUN · N/A) and a state (implemented · tested locally · verified staging · verified production). Nothing in this register was pushed, deployed, imported from real data, sent to a customer, or switched in billing.

## 1. Candidate

| Item | Value |
|---|---|
| Candidate commit | `9eed314` on `main` (local) |
| Unpushed | {{UNPUSHED}} commits ahead of `origin/main` (`ac2fcb8`) |
| Production today | old build; `/api/health` 200 at 30 Sep 00:06 UTC; deployed SHA not exposed by any route (last known `90868eb`) |
| Environment used | Neon **test** branch `ep-hidden-salad` only; production database never touched by a script |
| Production-build harness | `next build` + `next start` on :3949 under the restricted role `matflow_app` (no BYPASSRLS), behind a local TLS proxy on :3950; test-mode Stripe; mail key deliberately invalid (nothing leaves) |

### Gates on the candidate

| Gate | Result | Verdict |
|---|---|---|
| Typecheck (`tsc --noEmit`) | 0 errors | PASS |
| Lint + UI-rule ratchets | eslint clean; every ratchet at or below baseline | PASS |
| Unit + integration (local) | {{UNIT}} | PASS |
| Production build | exit 0 | PASS |
| RLS enforcement under the restricted role | 10 / 10 after migration `20260930120000` | PASS |
| RLS coverage of every tenant table | `tests/integration/rls-coverage.test.ts` (commit `e605918`) | PASS |
| Full 24-lane assess on the candidate | {{ASSESS}} | {{ASSESS_VERDICT}} |

## 2. Customer-simulation findings F-1 … F-21

| # | Finding | State | Evidence |
|---|---|---|---|
| F-1 | apply confirmation copy | tested locally | unit + Wave 1 re-drive |
| F-2 | hyphenated club code | tested locally (screen) | Harbour Judo retest; Cedar V1 |
| F-3 | owner sets own password after operator reset | tested locally (screen) | Cedar V1; force reset now writes password history (`2d5e9eb`) |
| F-4 | staff dialog copy | tested locally (screen) | Harbour |
| F-5 | one-time invite link | tested locally (screen + wire) | Cedar V3/V4; verifier lane 1 |
| F-6 | false check-in success | tested locally (register, kiosk, portal) | Wave 1; verifier lanes 2 and 3 |
| F-7 | medical `[]` | tested locally | Wave 1 (`a505063`: "None of the above" is no condition) |
| F-8 | capacity / over-capacity / on-hold | tested locally | Wave 1 on-hold confirm; verifier lane 3 register sweep |
| F-9 | role notice | tested locally (screen) | Harbour |
| F-10 | expired-session save | tested locally | verifier lane 7 (owner and member sides) |
| F-11 | dropped payment request | tested locally incl. response-lost-after-success | Wave 1 (`a505063`); verifier lane 4 |
| F-12 | kiosk waiver copy | tested locally (screen) | verifier lanes 2 and 3 |
| F-13 | class times | tested locally | verifier lane 3 (end time now reaches sessions, `405594e`) |
| F-14 | wizard resume | tested locally | Wave 1 re-drive |
| F-15 | device links shown once | N/A — deferred by design | tokens are stored hashed; named limitation |
| F-16 | "No plan" pill | tested locally (screen) | Harbour |
| F-17 | field-named validation | tested locally | now sentences, not code names (`a41a1a3`, `9eed314`) |
| F-18 | payments export | tested locally (screen) | Harbour; CSV "Paid on" / "Recorded at" (`e71756b`) |
| F-19 | operator reset label + login link | tested locally (screen) | Harbour |
| F-20 | child-waiver refusal copy | tested locally | verifier lane 2 |
| F-21 | member inline waiver had no emergency-contact fields | tested locally (screen + rows) | `b24713c`; red on revert; Cedar re-drive |

## 3. Release safety (G1 evidence)

| Item | Result | Verdict | Artefact |
|---|---|---|---|
| Migration review (7 pending: `20260923220000` … `20260930120000`) | all additive: nullable columns, new tables, a widened CHECK, unique indexes on nullable keys; old build compatible with the new schema | PASS | `docs/runbooks/DEPLOY-2026-10.md` |
| Blocker found in review | retention cron did not purge `Location` rows of a hard-deleted club | fixed `92a24c3`, proven on the test branch | `tests/unit/retention-purge-covers-every-tenant-table.test.ts` |
| Mid-sequence failure drill | Prisma does not wrap a migration in a transaction; a failure left half-applied SQL. Every pending migration is now wrapped in `BEGIN … COMMIT` (`d403f30`), pinned by `tests/unit/migrations-are-atomic.test.ts`; drill PASS 86 / 86 on the first six | PASS | `scratchpad/ralph/migration-drill-tx.mjs` |
| Seventh migration (`20260930120000_request_ids`, added after the drill) | wrapped, additive (two nullable columns, two unique indexes); applied to the test branch; atomicity test covers it | PASS (not re-drilled) | migration file |
| Migration history replay from an empty database | fails at `20260513000002` (pre-existing history) | FAIL — finding, does not affect deploying onto the existing database | see §7 |
| Restricted role (`matflow_app`) | full DML 48 / 48; RLS 10 / 10; the production build ran every verifier lane under it | PASS | |
| Normal sign-in with every bypass off, on a production build | 8 / 8 over https (password, owner TOTP setup and challenge, wrong codes, recovery-code single use, reset + session revocation, throttle). Over plain http the TOTP cookie name differs — an artefact of the test set-up, not the product | PASS | `scratchpad/ralph/auth-bypass-off.mjs` |
| Retention cron preview (`?dryRun=1`) | counts captured per table; nothing deleted | PASS | `scratchpad/ralph/retention-dryrun.out` |
| Point-in-time restore rehearsal | needs the Neon console | BLOCKED — Noe | |
| Production runtime role (is it `BYPASSRLS`?) | needs a query on production | BLOCKED — Noe | ADR-001 D8 |
| Deploy runbook | written, not executed | PASS (document) | `docs/runbooks/DEPLOY-2026-10.md` |

## 4. Data in (G2 evidence, synthetic only)

| Item | Result | Verdict |
|---|---|---|
| Member import: file hash, source date, mapping version, manifest, created-row list | built (`0f8c2b1`, `0c97206`) | PASS |
| Same file twice | refused with the earlier run named | PASS |
| Interrupted import re-run | no duplicate rows | PASS |
| Roll back | removes only rows the run created and nobody has touched since; says what it kept and why | PASS |
| Reconciliation | exact to the synthetic source's totals; rehearsal 19 / 19 | PASS |
| Attendance import | parser + commit + rollback on a synthetic export; 8 / 8 on the wire; no credits, charges, mail or waiver changes | PASS (synthetic) |
| Attendance import against Total BJJ's real export format | the export is not in hand | BLOCKED — Sean |
| TeamUp error lines | now cite the real file line (`a8a54c2`) | PASS |
| Real Total BJJ import | not authorised | NOT RUN — needs Noe's go |

## 5. Sean's room (review mode)

| Item | Result | Verdict |
|---|---|---|
| Operator switch (`Tenant.reviewLockedAt`) and banner (snapshot date, "TeamUp remains responsible for existing billing") | built `0f8c2b1` | PASS |
| Server-side refusals while locked (subscriptions, bulk invites, erase, soft-delete, migration apply …) | 423 `review_locked`, unit-pinned; on the wire RL1–RL3 PASS | PASS |
| Assisted access path (operator approve → owner sets own password → TOTP) | rehearsed on a synthetic club | PASS |

## 6. Billing cutover preparation (G4)

| Item | Result | Verdict |
|---|---|---|
| Cutover manifest template + generator | `d3bb1e2`: one row per membership — beneficiary, payer, who ends what, when | PASS |
| Test-mode rehearsals (DB failure after provider success, duplicate / out-of-order webhooks, changed source, failed first renewal) | recorded as owed in the template | NOT RUN |
| Standard Connect onboarding on production | needs G1 and Sean's Stripe sign-in | BLOCKED — G1, Sean |

## 7. Seven independent verifier lanes

Each lane ran against the production build under the restricted role, on its own throwaway club, reporting on screen and in the database. A lane is WORKING only when its last round found nothing left.

| Lane | Scope | Rounds | Defects found → fixed | Final verdict |
|---|---|---|---|---|
| 1 | Sign-in, roles, sessions, passwords | 1 + nit fixes | unlock controls, club-code chaining, force-reset history, invite wording, promotions role, password strength (`2d5e9eb`, `4108d69`, `a41a1a3`) | WORKING |
| 2 | Member portal, waivers, families (375 px) | 3 | 8 portal defects (`4de3368`, `6426e88`, `e6610c4`, `c1d5393`); two waiver-retry defects (`d5473ab`) | WORKING |
| 3 | The desk: members, register, kiosk, timetable | 2 | 6 defects (`405594e`, `baca43b`) | WORKING |
| 4 | Money | 1 + nit fixes | wording of route sentences, paid date rule (`a41a1a3`) | WORKING |
| 5 | Import, attendance history, review mode, retention | 3 | D1–D7, N1–N2 (`d978533`, `df66008`, `1ec7d88`), upload size and line numbers (`212995c`, `a8a54c2`) | WORKING |
| 6 | Isolation between clubs (hostile) | 0 | — | **BLOCKED** — the agent dispatch was refused by the safety classifier; not worked around. Existing evidence: RLS 10 / 10 under the restricted role, RLS coverage of every tenant table, the 25 Sep two-club loop, lb-2 cross-tenant cells. Needs Noe's go to run. |
| 7 | Mistakes and errors everywhere | 3 | 13 defects: retries duplicating members and waivers, stale save, silent failures, raw schema text, price and payment caps, date-of-birth floor, name-limit lock-out (`0bb44d6`, `86f0c9b`, `9eed314`) | WORKING |

## 8. Findings not fixed

| Finding | Impact | Owner / next action |
|---|---|---|
| Migration history does not replay from an empty database (fails at `20260513000002`) | a brand-new environment cannot be built from migrations alone; deploying onto the existing production database is unaffected | Lead: squash or repair before a second environment is needed |
| F-15 device links shown once | an owner who loses a kiosk or leaderboard link must regenerate it | by design |
| Lane 3 not covered: manager/coach roles at the desk, phone-width desk screens, card scanning, hold ending on its own date, belt-/roster-/venue-limited classes | untested, not known broken | next verifier round |

## 9. Dependencies

| Owner | Action |
|---|---|
| Noe | the production role query (ADR-001 D8) |
| Noe | one point-in-time restore rehearsal in the Neon console |
| Noe | confirm `BLOB_READ_WRITE_TOKEN` on Vercel production; set `CRON_SECRET` only after reading the retention preview |
| Noe | `RESEND_FROM` + SPF/DKIM/DMARC on matflow.studio (`docs/EMAIL-SETUP-RUNBOOK.md`, about 75 min) |
| Noe | go for verifier lane 6 (isolation) |
| Sean | the fresh TeamUp memberships export, the attendance export, and the time each was taken |
| Sean | a Stripe sign-in on production, after G1 |

## 10. Verdicts

| Gate | Verdict | Why |
|---|---|---|
| **G1 Deploy** | {{G1}} | |
| **G2 Sean's review access** | **BLOCKED** | code, import rehearsal and review mode PASS; the real import needs Sean's export and Noe's go, after G1 |
| **G3 Member access + comms** | **BLOCKED** | mail cannot be delivered until `RESEND_FROM` and DMARC are set (Noe); no member is messaged before Sean signs off |
| **G4 Billing cutover** | **BLOCKED** | manifest ready; rehearsals NOT RUN; Standard Connect onboarding waits for G1 and Sean's sign-in |

## 11. Closing lines

- **All currently unblocked work completed:** {{CLOSING_DONE}}
- **What Sean can safely do next:** send the TeamUp memberships export and the attendance export, with the time each was taken. Nothing in his TeamUp or Stripe changes.
- **The next specific authorisation needed:** {{NEXT_AUTH}}
- **What has not been pushed, deployed, imported or switched:** all of it. {{UNPUSHED}} commits and seven migrations are local only; production runs the old build; no real member data has been imported; no customer has been messaged; no subscription has been created, changed or ended; no TeamUp membership has been touched.
