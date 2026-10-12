# Rehearsal of 704ab57, run 2 on pinned Node 24 — run record (lane RH, 12 Oct 2026, 01:52–03:20 UTC)

Second, targeted execution of the corrected `REHEARSAL-704ab57.md` (corrected in the same commit), TEST branch only (`ep-hidden-salad`), both database roles, `EMAIL_DELIVERY=off` for every role pass, `TESTING_MODE=false`, `E2E_AUTH_BYPASS` / `E2E_BYPASS_TOKEN` / `CRON_SECRET` blank in every server process. Production, Stripe, Vercel and Neon settings untouched; no migration run; nothing pushed; no application code changed. The first attempt's run record (`REHEARSAL-704ab57-RUN-2026-10-12.md`, another session's) is not touched by this lane. Evidence (ledgers, logs, masked screenshots) stays in the lane's scratchpad (`SP/hub/rh24/`, `SP/hub/rh24-e2e/`, `SP/hub/rh24-private/`); nothing from it is copied here. No address, password, code, token or secret appears in this file; ids are synthetic fixture ids.

**Verdict.** Every hub journey that matters for the release passed under both roles on the pinned runtime, including the two that had no evidence before: the owner-side lost-response replay (6b) and revocation (9, 9m), plus 7, 8 and 5x. Flow 6 was run on its own on fresh fixtures under both roles and passed. Every checker verify passed 38/38 against its own isolated baseline, and release-verify passed under both roles. **The rehearsal is still not clean.** In both roles the server log shows the session-revocation check failing with P2028 (2 per role pass, against an expected 0). In the restricted pass this produced one ledger FAIL: flow 7's owner sign-in landed on a bare `/login`, the same Flow-4 symptom as the first attempt (§5). That symptom is a confirmed contract deviation from SF-44. The session is not lost. It needs a ledger row (§5.4). Every other FAIL row is explained in §4 as a harness or helper artefact; each is kept, not erased.

## 1. Executable and runtime

| Item | Value |
|---|---|
| Commit (worktree HEAD) | `704ab579ed42cef497bc38136982502aca153b75` (detached worktree `SP/hub/rh24-wt`; `.env.test` copied from MAIN, git-ignored by `.env*`; `git status --porcelain` empty before and after the build) |
| Node | **v24.21.0**. `node.exe` SHA-256 `ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32` = the official `SHASUMS256.txt` entry for `win-x64/node.exe`; npm 11.19.0 |
| `npm ci` | under Node 24, exit 0, 01:56:53–01:58:50Z, 1,039 packages, **no EBADENGINE line**. npm listed 4 install scripts "not yet covered by allowScripts" (`@prisma/engines`, `@sentry/cli`, `prisma`, `unrs-resolver`); matflow's postinstall `prisma generate` ran. A first `npm ci` started under Node v25.9.0 because the PATH prefix was malformed for the shell. It was stopped before completion and its log is kept; the worktree was reinstalled clean by the Node 24 `npm ci`. |
| Build | `node node_modules/next/dist/bin/next build`, run by the Node 24 binary itself (launcher refuses any non-v24 runtime; no `npx`), with the TEST env in the process env; 01:59:51–02:04:19Z, exit 0, Next.js 16.3.8 (Turbopack), no warning or error lines. `scripts/maybe-migrate.mjs` not invoked; no migration attempted |
| BUILD_ID | `Gu1CVh2TYQ4xLa8FEpt8F` |
| Server | `next start -p 3981` from the same build for every pass; TLS proxy `https://localhost:3982` → `127.0.0.1:3981`; release-verify mail interceptor `127.0.0.1:4598`; all three under Node 24 |
| `MATFLOW_CSP_ENFORCE` | unset in every server env (report-only) |
| Database roles | owner role passes: `neondb_owner` (`rolbypassrls` true). Restricted passes: `matflow_app` via `RESTRICTED_DATABASE_URL` (start line `user=matflow_app`; `pg_stat_activity` showed a `matflow_app` session; `pg_roles`: `rolsuper` false, `rolbypassrls` false; 50 public tables with RLS enabled and forced) |
| Migrations | release-verify `migrations.applied` PASS (100 applied) in both roles |

## 2. Coordination record (Noe point 7)

- **Other session's processes left up and untouched** for the whole run: `next start` :3971 (pid 213220), TLS proxy :3972 (pid 213892), interceptor :4599 (pid 214680); still listening at the end. This lane used 3981/3982/4598 only; its `stop.ps1` refuses 3971/3972/4599.
- **Other session's fixtures — counted, left in place.** Counts by set (ids only), identical before (02:00Z) and after (03:18Z) this lane's run:
  - set `control`: tenants `cmv4i6xtq000044tgl3un105f`, `cmv4i6xvv000144tgcym68won`; owner `cmv4i6xyi000244tgckjyz66v`. Rows: 2 tenants, 4 users, 8 members, 1 audit row, 1 EmailLog row, 1 magic-link token, 0 reset tokens.
  - set `eng`: tenants `cmv4ihifd0000bgtgmkjpiiao`, `cmv4ihih10001bgtg34j0vgbd`; owner `cmv4ihil50002bgtgxg2hgxoi`. Rows: 2 tenants, 4 users, 7 members, 12 audit rows, 0 EmailLog rows, 2 magic-link tokens, 1 reset token.
  - operators `cmv4i6wcg0000l4tgkaduek6p`, `cmv4i6x3p0000i8tgnthpfegm`: 2 operator rows, 29 audit rows by operator, 3 refusal rows.

  Not torn down: their `g-setup.mjs teardown` works on the whole state file. It deletes every set in it **and both operators**, and the still-running :3971 server is allow-listed with those operators. So it cannot be shown to delete only one set's rows. The owning session's run record is also still open.
- **Lane RD's diagnostic sign-ins** (01:40–01:41Z, lane IPs 198.51.104.241/.242), recorded and not changed:
  - RateLimitHit `tenant-lookup` 3 rows (01:40:55 ×2, 01:41:19);
  - `login:ip` 2 rows (01:40:56, 01:41:20);
  - `totp` 2 rows (the two TOTP steps consumed);
  - lane RD's screenshots `rd/*.png` stay in its scratchpad.
- **Other session's rate-limit rows** (198.51.104.x, 198.51.100.x) were left in place; g-setup deletes no RateLimitHit rows. This lane used its own lane IPs (198.51.110.x control, .112.x owner role, .113.x restricted role).
- **Original failed evidence preserved.** Nothing under the other session's folder or lane RD's folder was modified. Their drivers were read and copied.
- **Hazard for the other session.** release-verify's interceptor answers `{id: "intercepted-<n>"}` and restarts at 1 per process (`release-verify.mjs:289`), and `EmailLog.resendId` is unique. Two interceptors running in parallel therefore collide (§4.1). If the other session sends again through :4599, its ids will clash with rows this lane created. Those rows are now deleted by this lane's teardown, so the clash is only against rows still present.

## 3. Driver and hand-off changes (all outside the repository except the hand-off)

Drivers were copied from the other session's `rh-e2e` (the 9 Oct lane-G drivers) to `SP/hub/rh24-e2e` and adapted by an exact-count patch script:

- **Paths and ports.** Ports 3981/3982/4598. `REPO` = the 704ab57 worktree, so the checker, release-verify, operator-access and node_modules are the executable's own.
- **Set names.** `n24c` control; `n24e` / `n24e6` owner role; `n24r` / `n24r6` restricted; `n24f` fault test. Slugs come from a fresh per-lane stamp, so they cannot collide with the other session's sets (none did).
- **Baseline isolation (point 2).** `checker()` passes the checker's supported `--baseline-dir <PRIV>/baselines/<set>-<tag>` (`owner-login-change-check.mjs:554-556`). Every scenario (f4, f6, f6b) has its own directory and its own private expectation file. **`--overwrite` is passed nowhere.** A failed baseline throws, which stops the scenario before its verify. No baseline failed: 6/6 baselines exit 0. Nothing was written under `%LOCALAPPDATA%\matflow-readiness`.
- **6 and 6b separated (point 1).** 6b has its own tag (`f6b`) and its ledger rows are under flow `6b`. The driver refuses a flow list that contains both 6 and 6b.
- **Masking (point 6).** `shot()` now does the following:
  - replaces every input value with asterisks;
  - replaces every address-shaped text node or attribute with `[address]`;
  - re-checks the page and refuses the capture if any address remains;
  - restores the page afterwards.

  This was verified before any pass on `n24c-maskcheck.png` (email field shows asterisks, an injected address shows `[address]`, the field value is restored). No capture was refused or failed. 41 screenshots (incl. the mask check), all masked, all in the scratchpad. None is in this commit.
- **Hand-off corrected** (`REHEARSAL-704ab57.md`): header note; §3 baseline-isolation and masking rules; §5 flow 6 in its own pass and the main sequence `1,2,3,4,5,6b,7,8,9,9m,5x` on fresh fixtures, with the wrong `--overwrite` sentence replaced; §6 table row; §9 baseline cleanup.
- **Helpers added.** `counts.mjs` (per-set read-only counts), `fault4.mjs` / `fault4b.mjs` (§5 fault test) and `sql-checks.mjs` (the other session's §8 checks).

## 4. Per-command record

Every exit code was read directly from the process (or from the `# end … exit N` line that `run-record.mjs` writes), never through a pipe. Ledger counts are mechanical.

| # | Command (cwd `SP/hub/rh24-e2e`) | Role / set | Exit | Ledger result |
|---|---|---|---|---|
| 1 | `release-verify.mjs mail-interceptor --port 4598` (detached, cwd worktree) | — | running | count 0 |
| 2 | `tls-proxy.mjs` (detached) | — | running | — |
| 3 | `g-setup.mjs operators` | owner / — | 0 | 2 operators created |
| 4 | `g-setup.mjs fixtures n24c` | owner / n24c | 0 | — |
| 5 | `launch.mjs on nobypass,isolated rh24-control-on` | owner | 0 | health 200; both synthetic operators allow-listed, `EMAIL_DELIVERY=on` |
| 6 | `g-control.mjs` (attempt 1) | owner / n24c | 0 | 3 PASS / **1 FAIL** `invite_reaches_transport` — §4.1 |
| 7 | `g-control.mjs` (attempt 2, same server) | owner / n24c | 0 | 2 PASS / 0 FAIL / 2 NOTE (already enrolled). **Positive control PASS**: interceptor 1→2, EmailLog `sent` with provider id |
| 8 | `stop.ps1 -Ports 3981`, then `g-setup.mjs fixtures n24e` | owner / n24e | 0 | — |
| 9 | `launch.mjs off nobypass,isolated rh24-eng-off` | `neondb_owner` | 0 | health 200; `OPERATOR_ALLOWED_IDS` = op-allowed only |
| 10 | `g-flows.mjs n24e 1,2,3,4,5,6b,7,8,9,9m,5x` | owner / n24e | **0** | **43 PASS / 0 FAIL / 2 NOTE**, no `run.aborted` (02:07:48–02:32:04Z) |
| 11 | `g-release.mjs n24e` (attempt 1) | owner / n24e | 0 | **FAIL**: release-verify exit 1, `mail.transport_untouched` "count 2 after the trigger" — §4.2 |
| 12 | interceptor restarted (count 0); `g-release.mjs n24e` (attempt 2) | owner / n24e | 0 | release-verify **exit 0 PASS** (every check: health, migrations 100, email_delivery_off, transport_untouched count 0, queue_empty, legacy header/cookie/login_post 403, operator.access; `vercel.production_sha` SKIPPED for a test target) |
| 13 | `sql-checks.mjs n24e <server log>` | owner / n24e | 0 | 6 PASS / **2 FAIL** (§4.3 operatorEmail; §5 server log: revocation REFUSED ×2) / 1 NOTE |
| 14 | `g-setup.mjs fixtures n24e6`; `g-flows.mjs n24e6 6` | owner / n24e6 | 0 / **0** | 7 PASS / 0 FAIL / 1 NOTE, no abort |
| 15 | `sql-checks.mjs n24e6 <log slice after the main pass>` | owner / n24e6 | 0 | 7 PASS / 1 FAIL (§4.4 helper artefact) / 1 NOTE; server-log slice clean |
| 16 | `stop.ps1 -Ports 3981`; `g-setup.mjs fixtures n24f`; `launch.mjs off nobypass,isolated rh24-fault-off` | owner / n24f | 0 | dedicated server instance for the fault test (§5.2) |
| 17 | `fault4.mjs n24f`; `fault4b.mjs n24f` (twice) | owner / n24f | 0 / 0 / 0 | see §5.2 |
| 18 | `stop.ps1 -Ports 3981`; `g-setup.mjs fixtures n24r`; `launch.mjs off nobypass,isolated,restricted rh24-res-off` | **`matflow_app`** | 0 | health 200; role confirmed (§1) |
| 19 | `g-flows.mjs n24r 1,2,3,4,5,6b,7,8,9,9m,5x` | matflow_app / n24r | **0** | **42 PASS / 1 FAIL** (`7.stale_409_partial_ui`, §5.1) / 2 NOTE, no abort (02:44:50–03:09:48Z) |
| 20 | `g-release.mjs n24r` (interceptor count 0) | matflow_app / n24r | 0 | release-verify **exit 0 PASS** (same checks as #12) |
| 21 | `sql-checks.mjs n24r <server log>` | matflow_app / n24r | 0 | 6 PASS / **2 FAIL** (operatorEmail; revocation REFUSED ×2) / 1 NOTE |
| 22 | `g-setup.mjs fixtures n24r6`; `g-flows.mjs n24r6 6` | matflow_app / n24r6 | 0 / **0** | 7 PASS / 0 FAIL / 1 NOTE, no abort |
| 23 | `sql-checks.mjs n24r6 <log slice>` | matflow_app / n24r6 | 0 | 7 PASS / 1 FAIL (§4.4 helper artefact) / 1 NOTE; server-log slice clean |
| 24 | `stop.ps1` on 3981, 3982 and 4598 (one at a time) | — | 0 | all three stopped; 3971/3972/4599 still listening (other session) |
| 25 | `g-setup.mjs teardown` | owner | 0 | §7 |

Full ledger tallies (rows by result, all files):

| Ledger | PASS | FAIL | NOTE | aborted |
|---|---|---|---|---|
| n24c | 5 | 1 (attempt 1, §4.1) | 2 | no |
| n24e | 50 | 3 (release attempt 1, operatorEmail, server-log count) | 3 | no |
| n24e6 | 14 | 1 (helper artefact) | 2 | no |
| n24r | 49 | 3 (flow 7, operatorEmail, server-log count) | 3 | no |
| n24r6 | 14 | 1 (helper artefact) | 2 | no |

The n24c PASS count includes the two enrolment rows from attempt 1. Each pass's g-flows command exited 0, and unhandledRejection / uncaughtException lines were 0 in every server log.

### 4.1 Control attempt 1 — harness collision, not a candidate defect

The interceptor counted the send (0→1), so the transport was reached. The app nevertheless recorded EmailLog `failed`, and the server log reads `Unique constraint failed on the fields: ("resendId")`. Cause: both interceptors issue `intercepted-1` first, and the other session's control row (tenant `cmv4i6xtq000044tgl3un105f`, 00:25:15Z) already holds `intercepted-1`. Attempt 2 on the same server received `intercepted-2` and PASSED. The attempt-1 ledger is kept (`ledger-n24c-attempt1-PRESERVED.json`).

### 4.2 Release-verify attempt 1 — hand-off error

`mail.transport_untouched` requires an **absolute** interceptor count of 0 (`release-verify.mjs:258`). The hand-off §5 keeps the control pass's interceptor, which still held the control's 2 sends. The trigger itself added 0, and `mail.queue_empty` passed. After a restart of the interceptor (count 0), attempt 2 PASSED. Both results are kept. **Hand-off follow-up:** restart the interceptor between the control pass and the mail-off passes.

### 4.3 `operatorEmail` in `admin.impersonate.start` — scope note, flagged

The helper's "no raw address in any admin.* metadata" check failed on the single `admin.impersonate.start` row in each role pass. Its metadata key `operatorEmail` holds the **operator's own** address. This is written on purpose at `app/api/admin/impersonate/route.ts:223` (also in the application approve/reject and create-tenant routes). The hand-off §8 rule covers the two change rows, and those hold no address in either role. Flagged to the coordinator, not classified here: an operator's address is stored in a club-tenant audit row.

### 4.4 Holder check in the flow-6-only passes — helper artefact

The helper requires every member target to have 0 member holders. That is true only when all four members were moved. In a flow-6-only pass, pat1/3/4 correctly still hold their own addresses. The real check holds in both roles: pat2's target has 1 holder, a User (the owner), and 0 Members.

## 5. Flow 4 — two separate observations (Noe point 4)

The first attempt was at 704ab57 under Node v25.9.0, other session, 00:30:26Z.

**(a) A connection-acquisition timeout occurred.** P2028 "Unable to start a transaction in the given time" occurred inside the session-revocation check, exactly 10.0 s (`maxWait`) after the new-address TOTP POST. **Its environmental cause is not established.** This run adds data without establishing it:

- P2028 revocation-check failures recurred under ordinary journey load on Node 24: 2 in the owner-role pass, 2 in the restricted pass, 1 in the fault test, 0 in the two flow-6-only passes.
- Each one was followed by "session kept for revalidation".
- One pg `DeprecationWarning: Calling client.query() when the client is already executing a query` appeared in each role pass. It is recorded, not diagnosed.

The runtime change (v25 → v24) did not remove the timeouts. A single production-mode process (pool `max` 5, `lib/prisma.ts:47-55`, no env override at 704ab57) against the remote branch remains the documented candidate. That is a hypothesis, not a finding.

**(b) The application redirected to a bare `/login` instead of the specified retryable response.** It did not serve the SF-44 503 page.

### 5.1 Recurrence in this run (restricted pass, flow 7)

The owner tab's sign-in ran at 02:59:01.808 (tenant-lookup), 02:59:02.232 (login) and 02:59:05.037 (totp), with no `authfail` row, so the password and code were accepted. It **ended on `/login`**. The **same tab** then made an authenticated `POST /api/account/password` (current password + TOTP), which answered **200**. The restricted server log has two P2028 revocation-check failures (subject `user`) with "session kept for revalidation". The log lines carry no timestamps, so their pairing with this sign-in is by pattern (the first attempt failed 10 s after TOTP), not by clock.

### 5.2 Targeted permitted fault test

Client-side load only, from one signed-in browser context, against this lane's own dedicated server instance (`n24f`). No session settings, no backend termination, no server setting changed. Bounded runs:

- `fault4.mjs`: 12/24/40 concurrent `GET /dashboard` (redirects not followed). All returned 200, each re-set the session cookie (none clearing), 0 P2028. `unknown` was not induced.
- `fault4b.mjs`, run 1: 6, then 12 concurrent tabs doing real `/dashboard` loads (with RSC prefetches; 1,187 responses).
  - **One revocation-check `unknown` was induced**: the log shows `session-revocation check failed — request REFUSED as unavailable … P2028`, then `session kept for revalidation`.
  - The browser saw **one 503** and **0 redirects to `/login`**. The proxy answered it; this matches the SF-44 path. The 503's body was not captured in run 1.
  - **0 session-clearing Set-Cookie** among 858 session Set-Cookie headers.
  - All 18 tabs ended on `/dashboard` 200. The cookie was still present and the next `/dashboard` returned 200.
  - The ledger row says `induced:false` because of an off-by-one in this lane's log-slice counter. The P2028 and kept-for-revalidation counts are correct; the counter was fixed for run 2.
- `fault4b.mjs`, run 2: 12 + 12 tabs (1,591 responses). Not induced; everything 200.

The layout path (bare `/login`) was **not reproduced by the fault test**. It was reproduced by the real journey (§5.1).

### 5.3 Code at 704ab57

- `proxy.ts:194-205`: "the revocation lookup failed, so auth.ts kept the token, marked it for revalidation and gave it no authority. Not "signed out" — nothing here clears the cookie … A page gets a small 503 page that retries itself, so the person lands back where they were once the database answers, still signed in."
- `auth.ts:1524-1527`: the no-argument `auth()` returns `usableSession(s)`, which is `null` for a session awaiting revalidation. Its comment says this "sets no cookie".
- `lib/authz.ts:35`: `if (!session?.user?.id) redirect("/login");`
- `app/dashboard/layout.tsx:26`: `const { session } = await requireStaff();`

So the proxy's own check can succeed while the layout's separate `auth()` check times out. When that happens, the page answers with `redirect("/login")` and drops `?club=`, and the person sees the club-code box with no message.

### 5.4 Assessment, handed to the coordinator for a ledger row

**Cookie intact. This is confusing navigation, not session loss.** The evidence:

- the restricted-pass tab made an authenticated 200 POST after landing on `/login`;
- the fault test saw 0 clearing cookies and a 200 `/dashboard` after the induced `unknown`;
- the code path sets no cookie.

**The documented contract is violated.** SF-44 promises a page gets the retryable 503 page "still signed in". On the layout/page `auth()` path it gets a bare `/login`. The defect is real at 704ab57, it recurs in normal journeys on Node 24, and it is **not closed by the fact that a retry works**.

Suggested ledger entry: severity LOW–MEDIUM (availability/UX; fails closed; no authority granted, no data exposed; but under database pressure a signed-in owner is told nothing and shown the club-code step). Scope: every page that calls `requireSession`/`requireStaff` after the proxy has admitted the request.

## 6. Per-journey result

| Journey | Owner role (n24e / n24e6) | Restricted role (n24r / n24r6) |
|---|---|---|
| Positive control (mail on: invite reaches transport) | PASS (attempt 2; attempt 1 harness collision §4.1) | — (runs once) |
| 1 Operator MFA, allow-list refusal, support-session refusal, club plane ignores operator cookie | PASS | PASS |
| 2 Legacy transports closed | PASS | PASS |
| 3 Holder panel, no-store, opaque self-service 409 | PASS | PASS |
| 4 Owner change with step-up, member/owner preserved, tokens retired, audit, old address refused / new reaches `/dashboard`, checker 38/38, zero sends | PASS | PASS |
| 5 Grants: wrong action, wrong change, code reuse, forced expiry, wrong session | PASS | PASS |
| 5x Natural expiry of the flow-5 grant | PASS | PASS |
| 6 Member-side lost response, double-click, replays; checker 38/38 (own pass, fresh fixtures) | PASS | PASS |
| 6b Member double-click + replays; **owner-side lost-response resend → 200 `alreadyApplied`, one row, sv +1**; checker 38/38 (own baseline) | PASS | PASS |
| 7 Stale 409 with grant unspent, UI partial, resume with fresh code, stale-then-usable via API | PASS | **FAIL** on one row: the owner tab's sign-in landed on `/login` (§5.1). Every hub assertion in the row held. The other two flow-7 rows PASS. |
| 8 Mass assignment 400, Origin/CSRF 403, cross-tenant 404 | PASS | PASS |
| 9 Owner daily use, invite refused while mail off, login page mail-off text | PASS | PASS |
| 9/9m **Revocation**: member self-change → `signInAgain`, next request 401, new address signs in; activity row has no Undo | PASS | PASS |
| Release-verify (`--target test`) | PASS (attempt 2; attempt 1 §4.2) | PASS |
| §8 persisted state (SQL): member sv iff password, holders, provisional set, checked rows carry operator, change rows by op-allowed with distinct request ids, no mail | PASS. The broader metadata check flagged `operatorEmail` (§4.3). | PASS, same flag |
| Server-log standard (0 revocation REFUSED, 0 unhandledRejection) | **FAIL**: revocation REFUSED ×2; unhandledRejection 0 | **FAIL**: revocation REFUSED ×2; unhandledRejection 0 |
| Owner recovery-code redemption (hand-off §6 optional step) | **NOT RUN**: no driver step exists. Still a GAP; covered only by integration tests. | NOT RUN |

## 7. Cleanup (count-checked, per set, both roles)

`g-setup.mjs teardown` (exit 0) on this lane's state file only:

- before: 12 tenants, 43 members;
- after: tenants 0, members 0, users 0, audit 0, EmailLog 0, operators 0, tokens 0 (`clean: true`);
- 6 refusal rows deleted; 0 audit rows still name a synthetic operator.

A per-set re-count afterwards found 0 tenants, users, members, audit rows, EmailLog rows, magic-link tokens, reset tokens, import jobs, classes, attendance records and imported memberships for every set (n24c, n24e, n24e6, n24f, n24r, n24r6), and 0 operator rows, operator audit rows and refusal rows.

Before teardown the per-set counts were, for example, n24e: 4 users, 7 members, 24 audit rows; n24r: 4 users, 7 members, 24 audit rows.

**Leftovers, reported rather than deleted:**

- RateLimitHit rows on this lane's IPs: 198.51.112.x 50 rows and 198.51.113.x 63 rows (families admin operator-login / totp-ip / tenant-action / impersonate, `login:ip`, `tenant-lookup`); 198.51.110.x 0 rows. They age out by window; g-setup deletes none.
- The other session's sets and rate-limit rows (§2) are unchanged.

Private files were deleted: the six per-scenario baselines, the private expectation files, `state.json` and the mail-trigger file. Server logs and checker stderr files (no addresses) remain in the scratchpad. Ports 3981/3982/4598 were stopped and confirmed not listening.

## 8. Kept separate

SF-135/136 and their independent review are not part of this run (Noe point 5). No sec-l1/sec-c3/sec-a4 burst suite was run. A clean browser journey does not disprove the known lost-write defect, and nothing here should be read as evidence about SF-135/136. The 0 unhandledRejection lines in these logs prove nothing either way about it.
