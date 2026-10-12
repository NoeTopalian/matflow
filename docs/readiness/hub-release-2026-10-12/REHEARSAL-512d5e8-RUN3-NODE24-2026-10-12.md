# Rehearsal of 512d5e8, run 3 on pinned Node 24 — run record (lane RH, 12 Oct 2026, 06:50–08:15 UTC)

This run uses the same method as run 2 (`REHEARSAL-704ab57-RUN2-NODE24-2026-10-12.md`) and the corrected hand-off `REHEARSAL-704ab57.md`, applied to the moved candidate. Scope: TEST branch only (`ep-hidden-salad`), both database roles, `EMAIL_DELIVERY=off` for every role pass. In every server process `TESTING_MODE=false` and `E2E_AUTH_BYPASS`, `E2E_BYPASS_TOKEN` and `CRON_SECRET` were blank. Production, Stripe, Vercel and Neon settings were untouched, no migration ran, nothing was pushed, and no application code was changed. No sec-l1/sec-c3/sec-a4 burst suite was run. Evidence stays in the lane scratchpad (`SP/hub/rh512/`, `SP/hub/rh512-e2e/`, `SP/hub/rh512-private/`). This file contains no address, password, code, token or secret.

**Verdict.**
- **Journeys:** every journey passed under both roles on the pinned runtime. The main sequence `1,2,3,4,5,6b,7,8,9,9m,5x` gave 43 PASS and 0 FAIL in each role. Flow 6, run in its own pass on fresh fixtures, gave 7 PASS and 0 FAIL in each role.
- **Checker and release-verify:** all 6 checker baselines exited 0, each in its own directory with no `--overwrite`, and all 6 verifies passed 38/38. Release-verify passed under both roles. The positive control passed.
- **SF-137 (the bare `/login` landing) did not recur.** No sign-in in any pass landed on `/login`, and the fault test saw 0 redirects to `/login`.
- **SF-137 is not fixed, though.** Its code path is byte-identical between 704ab57 and 512d5e8: `auth.ts`, `proxy.ts`, `lib/authz.ts`, `app/dashboard/layout.tsx` and `lib/session-revocation.ts` are unchanged.
- **Revocation-check verdict `unknown` still occurs**, but less often, and its error changed. There was no P2028 in any pass. Instead there were 3 occurrences of `Connection terminated due to connection timeout`:
  - 0 in the owner-role main pass;
  - 1 in the restricted main pass, with no driver row affected;
  - 2 in the dedicated fault-test server, with no visible effect.

  So the server-log standard (0 "session-revocation check failed" lines) fails for the restricted main pass only.

## 1. Executable and runtime

| Item | Value |
|---|---|
| Commit (worktree HEAD) | `512d5e8d622f0a9cf514d1f5b5663e4e07c8939e` (= 704ab57 + 1ca92c0 + 3e6dd26, 0bbf0a1, 2c6bd4c, 38f8295 + 512d5e8). Detached worktree `SP/hub/rh512-wt`; `.env.test` copied (git-ignored); `git status --porcelain` empty after the build |
| Node | v24.21.0 (same binary as run 2, SHA-256 `ba4e6d11…6c32` = official `SHASUMS256.txt` `win-x64/node.exe`); npm 11.19.0 |
| `npm ci` | Node 24, exit 0, 06:51:19–06:52:48Z, 1,039 packages, **no EBADENGINE line** |
| `npm ls pg pg-pool` | exit 0. `pg@8.20.0` at top level and deduped under `@prisma/adapter-pg@7.4.2`; `pg-pool@3.13.0` under `pg@8.20.0` (the package.json pin and the override took effect) |
| Build | `node node_modules/next/dist/bin/next build` run by the Node 24 binary (the launcher refuses non-v24), TEST env, 06:53:41–06:57:19Z, exit 0, 0 warning/error lines, no migration step |
| BUILD_ID | `-VI8m-f5fjlPib2_etBjA`. A fresh build of the same commit, so it differs from the gate's isolated build `XEFPlYyNsQ5F-CB6DKMKc` |
| Server / proxy / interceptor | `next start -p 3981`; TLS proxy `https://localhost:3982` → `127.0.0.1:3981`; interceptor `127.0.0.1:4598`; all under Node 24 |
| `MATFLOW_CSP_ENFORCE` | unset (report-only) |
| Roles | Owner passes ran as `neondb_owner`. Restricted passes ran as `matflow_app`: the server start line read `user=matflow_app` and `pg_stat_activity` showed a `matflow_app` session. `matflow_app` has `rolsuper` false and `rolbypassrls` false, and 50 public tables have RLS enabled and forced |
| Migrations | release-verify `migrations.applied` PASS (100 applied) under both roles |
| Pool | `lib/prisma.ts` at 512d5e8: production `max` 5, no env override |

## 2. Coordination

- **Other session left untouched.** Its idle server on :3971, proxy on :3972 and interceptor on :4599 were left running and were still listening at the end.
- **Its fixtures are unchanged.** The control and eng sets plus 2 operators show the same per-set counts as at 02:00Z (run 2 §2).
- **This lane's own resources.** It used ports 3981/3982/4598, fresh fixture sets `r512c/r512e/r512e6/r512f/r512r/r512r6` (fresh slug stamp, no collisions), and lane IPs 198.51.114.x (control), .116.x (owner role) and .117.x (restricted).
- **Interceptor id collision avoided.** EmailLog still holds `resendId` `intercepted-1` (the other session's control row). Before `g-control`, one dummy `POST /emails` with an empty JSON body (not an email) moved this lane's control interceptor to count 1. The control invite therefore received `intercepted-2`, and the control delta is measured from count 1.
- **Interceptor restarted.** After the control pass the interceptor was stopped and started again at count 0 for the mail-off passes. This is the run-2 §4.2 follow-up, and `mail.transport_untouched` passed in both roles.

## 3. Per-command record

Every exit code was read directly from the process, or from the `# end … exit N` line that `run-record.mjs` writes. Ledger counts are mechanical.

| # | Command (cwd `SP/hub/rh512-e2e`) | Role / set | Exit | Result |
|---|---|---|---|---|
| 1 | interceptor :4598 (control), `tls-proxy.mjs` :3982 (detached) | — | running | count 0 |
| 2 | `g-setup.mjs operators` | owner | 0 | 2 operators |
| 3 | `g-setup.mjs fixtures r512c`; `launch.mjs on nobypass,isolated rh512-control-on` | owner / r512c | 0 / 0 | health 200; `EMAIL_DELIVERY=on`, both operators allow-listed |
| 4 | `mask-check.mjs` | owner / r512c | 0 | capture masked (email field asterisks, injected address `[address]`), value restored — viewed |
| 5 | `g-control.mjs` | owner / r512c | **0** | **4 PASS / 0 FAIL**: enrol ×2, owner sign-in → `/dashboard`, invite reaches transport (1→2, EmailLog `sent` with provider id) |
| 6 | stop :3981 and :4598; fresh interceptor :4598 (count 0); `g-setup.mjs fixtures r512e`; `launch.mjs off nobypass,isolated rh512-eng-off` | `neondb_owner` / r512e | 0 | health 200; `OPERATOR_ALLOWED_IDS` = op-allowed only |
| 7 | `g-flows.mjs r512e 1,2,3,4,5,6b,7,8,9,9m,5x` | owner / r512e | **0** | **43 PASS / 0 FAIL / 2 NOTE**, no abort (07:00–07:24:28Z) |
| 8 | `g-release.mjs r512e` | owner / r512e | 0 | release-verify **exit 0 PASS** |
| 9 | `sql-checks.mjs r512e <server log>` | owner / r512e | 0 | 7 PASS / 1 FAIL (`operatorEmail`, SF-138) / 1 NOTE; **server-log counts PASS** (revocation REFUSED 0, unhandledRejection 0) |
| 10 | `g-setup.mjs fixtures r512e6`; `g-flows.mjs r512e6 6` | owner / r512e6 | 0 / **0** | **7 PASS / 0 FAIL / 1 NOTE**, no abort |
| 11 | `sql-checks.mjs r512e6 <log slice>` | owner / r512e6 | 0 | 7 PASS / 1 FAIL (holder-helper artefact, run 2 §4.4) / 1 NOTE; log slice clean |
| 12 | stop :3981; `g-setup.mjs fixtures r512f`; `launch.mjs off nobypass,isolated rh512-fault-off` | owner / r512f | 0 | dedicated server for the fault test |
| 13 | `fault4.mjs r512f`; `fault4b.mjs r512f … 6,12` | owner / r512f | 0 / 0 | §4.2 |
| 14 | stop :3981; `g-setup.mjs fixtures r512r`; `launch.mjs off nobypass,isolated,restricted rh512-res-off` | **`matflow_app`** / r512r | 0 | health 200; role confirmed |
| 15 | `g-flows.mjs r512r 1,2,3,4,5,6b,7,8,9,9m,5x` | matflow_app / r512r | **0** | **43 PASS / 0 FAIL / 2 NOTE**, no abort (07:35:02–08:02:30Z) |
| 16 | `g-release.mjs r512r` | matflow_app / r512r | 0 | release-verify **exit 0 PASS** |
| 17 | `sql-checks.mjs r512r <server log>` | matflow_app / r512r | 0 | 6 PASS / **2 FAIL** (`operatorEmail` SF-138; server-log count: revocation REFUSED 1) / 1 NOTE |
| 18 | `g-setup.mjs fixtures r512r6`; `g-flows.mjs r512r6 6` | matflow_app / r512r6 | 0 / **0** | **7 PASS / 0 FAIL / 1 NOTE**, no abort |
| 19 | `sql-checks.mjs r512r6 <log slice>` | matflow_app / r512r6 | 0 | 7 PASS / 1 FAIL (holder-helper artefact) / 1 NOTE; log slice clean |
| 20 | `stop.ps1` on 3981, 3982, 4598 | — | 0 | all stopped; 3971/3972/4599 untouched |
| 21 | `g-setup.mjs teardown` | owner | 0 | §6 |

Ledger totals (all rows):

| Ledger | PASS | FAIL | NOTE | aborted |
|---|---|---|---|---|
| r512c | 4 | 0 | 0 | no |
| r512e | 51 | 1 (SF-138 scope check) | 3 | no |
| r512e6 | 14 | 1 (helper artefact) | 2 | no |
| r512r | 50 | 2 (SF-138 scope check; server-log revocation REFUSED 1) | 3 | no |
| r512r6 | 14 | 1 (helper artefact) | 2 | no |
| r512f-fault4 | 4 | 0 | 7 | no |

There are no driver FAIL rows in any flow pass. unhandledRejection and uncaughtException lines numbered 0 in every server log.

## 4. Flow 4 / SF-137, re-recorded on this build

### 4.1 Revocation-check `unknown` verdicts per pass (server log)

| Pass | P2028 | `Connection terminated due to connection timeout` | "session kept for revalidation" | Bare `/login` after a successful sign-in | pg "already executing a query" DeprecationWarning |
|---|---|---|---|---|---|
| r512c control | 0 | 0 | 0 | none (owner → `/dashboard`) | 0 |
| r512e owner main | 0 | 0 | 0 | none (flow 4 new address → `/dashboard`; flow 7 owner tab → `/dashboard`; flow 9 → `/dashboard`) | 1 |
| r512e6 owner flow 6 | 0 | 0 | 0 | none | 0 |
| r512f fault test | 0 | 2 | 2 | none | 0 |
| r512r restricted main | 0 | 1 | 1 | none (flow 4 → `/dashboard`, flow 7 → `/dashboard`, flow 9 → `/dashboard`) | 1 |
| r512r6 restricted flow 6 | 0 | 0 | 0 | none | 0 |

For comparison, run 2 at 704ab57 had P2028 ×2 in each role pass and one bare `/login` (restricted flow 7). Now the failure surfaces as the pg pool's own `connectionTimeoutMillis` error (`code` undefined) rather than Prisma's P2028. That fits 512d5e8's transaction-budget changes, but this is not established.

### 4.2 Targeted permitted fault test

Client-side load only, from one signed-in browser context, against this lane's own dedicated server (`r512f`). No session settings and no backend termination.

- **`fault4.mjs`** sent 12, 24 and 40 concurrent `GET /dashboard` requests:
  - all returned 200, and every response re-set the session cookie (0 cookies cleared);
  - the cookie was still present afterwards, and the next `/dashboard` returned 200;
  - during the 24-request burst the server logged **2 `unknown` verdicts** (connection timeout), each with "session kept for revalidation";
  - no response in that round was a 503, a redirect, or an in-stream `/login` redirect.

  This lane cannot tell from these bodies which `auth()` call received the refusal. It may be one whose null result is not a page gate; that is not established.
- **`fault4b.mjs`** loaded `/dashboard` in 6 then 12 concurrent tabs, each with its RSC prefetches (1,189 responses):
  - no `unknown` verdict, everything 200;
  - 0 cookies cleared, 0 redirects to `/login`.

### 4.3 Assessment

The code that routes a page-level `unknown` to `redirect("/login")` is unchanged (run 2 §5.3):

- `auth.ts:1524-1527` returns null from the no-argument `auth()`;
- `lib/authz.ts:35` then runs `redirect("/login")`;
- that call fires from `app/dashboard/layout.tsx:26`.

The behaviour the SF-44 comment at `proxy.ts:194-205` promises is still not guaranteed on that path. The navigation defect is therefore **not fixed**. On 512d5e8 it was **not observed**, because `unknown` verdicts were rarer and none of them reached a page gate in a way the drivers saw. SF-137 should stay OPEN; nothing here closes it.

## 5. Per-journey result

| Journey | Owner role (r512e / r512e6) | Restricted role (r512r / r512r6) |
|---|---|---|
| Positive control (mail on) | PASS | — (runs once) |
| 1 Operator MFA, allow-list refusal, support-session refusal, club plane ignores operator cookie | PASS | PASS |
| 2 Legacy transports closed | PASS | PASS |
| 3 Holder panel, no-store, opaque self-service 409 | PASS | PASS |
| 4 Owner change with step-up, preservation, token retirement, audit, old address refused / new address `/dashboard`, checker 38/38, zero sends | PASS | PASS |
| 5 Grant refusals (wrong action, wrong change, reuse, forced expiry, wrong session) | PASS | PASS |
| 5x Natural expiry | PASS | PASS |
| 6 Member-side lost response, double-click, replays, checker 38/38 (own pass, fresh fixtures) | PASS | PASS |
| 6b Owner-side lost-response resend → 200 `alreadyApplied`, one row, sv +1; member double-click and replays; checker 38/38 (own baseline) | PASS | PASS |
| 7 Stale 409 with grant unspent, partial UI, resume with a fresh code, stale-then-usable | PASS | PASS |
| 8 Mass assignment 400, Origin/CSRF 403, cross-tenant 404 | PASS | PASS |
| 9 Owner daily use, invite refused while mail is off, login page mail-off text | PASS | PASS |
| 9/9m Revocation: member self-change → next request 401, new address signs in; activity row has no Undo | PASS | PASS |
| Release-verify `--target test` | PASS | PASS |
| §8 persisted state (SQL) | PASS. Only the broader metadata check flags the operator's own address in `admin.impersonate.start` (SF-138) | PASS, same SF-138 flag |
| Server-log standard (0 revocation REFUSED, 0 unhandledRejection) | PASS | **FAIL**: revocation REFUSED 1 (connection timeout); unhandledRejection 0 |
| Owner recovery-code redemption | NOT RUN — no driver step; still a GAP | NOT RUN |

## 6. Cleanup (count-checked per set, both roles)

`g-setup.mjs teardown` on this lane's state file: exit 0, 12 tenants and 43 members before, everything 0 after (`clean: true`). 6 refusal rows were deleted, and 0 audit rows still name a synthetic operator.

Per set (before → after):

| Set | Before | After |
|---|---|---|
| r512c | 2 tenants, 4 users, 8 members, 1 audit row, 1 EmailLog, 1 magic token | all 0 |
| r512e | 2 tenants, 4 users, 7 members, 24 audit rows, 2 magic tokens, 1 reset token | all 0 |
| r512e6 | 2 tenants, 4 users, 7 members, 4 audit rows | all 0 |
| r512f | 2 tenants, 4 users, 7 members, 0 audit rows | all 0 |
| r512r | 2 tenants, 4 users, 7 members, 24 audit rows, 2 magic tokens, 1 reset token | all 0 |
| r512r6 | 2 tenants, 4 users, 7 members, 4 audit rows | all 0 |
| operators | 2 rows, 100 audit rows, 6 refusal rows | all 0 |

Every set also had 1 import job, 1–2 classes, 4–5 attendance records and 8 imported memberships before teardown; all are 0 after.

**Leftovers, reported rather than deleted:**
- RateLimitHit rows on this lane's IPs: 198.51.116.x 56 rows and 198.51.117.x 63 rows; 198.51.114.x 0 rows. g-setup deletes no RateLimitHit rows.
- The other session's sets are unchanged.

**Other cleanup:**
- The six per-scenario baseline directories, the private expectation files, `state.json` and the mail-trigger file were deleted.
- Nothing was ever written under `%LOCALAPPDATA%\matflow-readiness`.
- Ports 3981, 3982 and 4598 were stopped.
- The worktree `rh512-wt` was removed and pruned.
- 41 screenshots remain in the scratchpad, all masked. None was refused or failed, and none is committed.
