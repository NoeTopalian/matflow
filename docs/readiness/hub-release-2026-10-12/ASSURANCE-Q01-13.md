# Assurance answers Q1–Q13: hub release, candidate `512d5e8` (lane AQ1, 12 Oct 2026)

This lane only read things. It ran no tests, used no database or provider, changed no production setting and did not touch Sean's account. Sources: repository `security/assurance-2026-10` (docs head `e5636dc`), with the code read at `512d5e8d622f0a9cf514d1f5b5663e4e07c8939e` through `git show`. Coordinator-verified facts are cited as "coordinator, <time> UK". Owner-reported facts are marked REPORTED. This file contains no secret, connection string, session value or e-mail address. Decision columns are left empty, and no risk is accepted here on the owner's behalf.

Status line vocabulary: PASS / FAIL / BLOCKED / NOT RUN / NOT APPLICABLE, with a qualifier where one word would mislead.

**Short abbreviations:**
- *Packet* = `RELEASE-PACKET-512d5e8.md`
- *Decision* = `docs/readiness/HUB-RELEASE-DECISION-2026-10-12.md` (v2)
- *CR* = `CR-REPORT.md`
- *Run 2* / *Run 3* = the Node 24 rehearsal records for `704ab57` and `512d5e8`
- *Ledger* = `docs/security/FINDINGS.md`

---

## Q1. What exactly am I accepting?

**Status: BLOCKED.** All eleven decision boxes in packet §6 are empty. Four further residuals that the decision document carries are not in §6 at all (listed at the end of this section). Nothing can be called accepted yet.

### §6 decision table, verbatim (the decision column stays empty)

| Risk | Recommendation | Decision |
|---|---|---|
| SF-137 bare `/login` on an unknown revocation verdict (did not recur in run 3; code unchanged; cookie intact) | ACCEPT for this release as Low–Medium UX under database pressure, fix in the next candidate — or FIX FIRST (small change in `lib/authz.ts`) | ☐ |
| SF-138 operator address in tenant audit metadata | ACCEPT (Low); fix next candidate | ☐ |
| SF-139 budget cut classified as busy (purge reporting) | ACCEPT (Low) | ☐ |
| SF-140 misleading guard log | ACCEPT (Info) | ☐ |
| Stripe webhook in-transaction P2002 catches now answer 500 (duplicates never acknowledged; endpoint could be flagged) | ACCEPT on the condition that no live Stripe endpoint is created before the payments branch lands | ☐ |
| Owner recovery-code redemption not browser-rehearsed (no driver; integration tests only) | ACCEPT with the integration-test evidence; add a driver step later | ☐ |
| SF-30 partial CSP (`unsafe-inline` still enforced) | ACCEPT (unchanged from production) | ☐ |
| SF-05 legacy untagged links valid until expiry (≤ 7 days) | ACCEPT (the workflow retires tokens for both addresses in the club) | ☐ |
| Runtime role `neondb_owner`, RLS as backstop only, audit rows editable (SF-62/73/74, SF-57) | ACCEPT as unchanged existing exposure; separate projects | ☐ |
| Environmental revocation-check `unknown` verdicts under load on TEST (P2028 earlier; connection timeouts now) | not a candidate defect; production has a different pool/latency profile; monitored via Sentry after release | ☐ noted |
| `main` PR + status-check protection not yet applied (D-14) | apply at approval time (manual mode) | ☐ |

### Each residual in detail

**1. SF-137: bare `/login` after a successful sign-in**

- **Failure and who is affected.** The proxy admits a signed-in request. The page's own `auth()` call then gets an `unknown` revocation verdict because the database did not answer in time. `requireSession` / `requireStaff` respond with `redirect("/login")` and drop `?club=` (`lib/authz.ts:35`, `auth.ts:1524-1527`, `app/dashboard/layout.tsx:26`). The signed-in user (staff, owner, or a member on a page gated this way) sees the club-code box with no message.
  - The cookie is kept, and nothing is granted or exposed. In run 2 §5.1 the same tab made an authenticated 200 POST afterwards, and the fault test saw 0 clearing cookies.
  - The SF-44 contract (a retrying 503 page, "still signed in") is broken on this path.
- **Trigger.** The revocation lookup fails during the page render but not during the proxy check. That happens on a pool-acquisition or connection timeout under database pressure.
- **Observed frequency:**
  - Twice in real journeys: the first attempt, flow 4 (Node 25); and run 2, restricted pass, flow 7.
  - Run 3: 0 of 100 journey rows. There were 3 `unknown` verdicts, but none reached a page gate.
  - The production frequency is unknown, and there is no baseline.
- **Recommendation: ACCEPT for this release, with the fix in the next candidate.**
  - It fails closed, keeps the session, and recovers on reload.
  - FIX FIRST changes the executable. That means a new review, gates and a browser rehearsal (an R10 + RH cycle) for a navigation defect that grants nothing.
- **Mitigation (procedural, no code):**
  - In the account-change procedure, tell Sean that if he lands on the club-code page after entering a correct password and code, he should open the dashboard again. Nobody should act on it as a failed sign-in.
  - The operator diagnoses from records before any mutation (Q12).
  - Revocation-check failures are logged and sent to Sentry (CR §1, `lib/session-revocation.ts:134-147`).
- **Affects Sean's correction?** Yes, potentially at Sean's first sign-in and in daily use. It does not affect the operator's steps, which use the operator plane.
- **What supports the severity:** see Q4.

**2. SF-138: operator address in tenant audit metadata**

- **Failure.** `admin.impersonate.start` stores the operator's own address in `operatorEmail` inside a club's audit metadata (`app/api/admin/impersonate/route.ts:223`). So do the application approve/reject and create-tenant routes. A club's audit export or a DSAR could then show the operator's address.
- **Trigger.** An operator starts a support session into a club, decides an application, or creates a club.
- **Recommendation: ACCEPT (Low).** The exposed data is the operator's own address, not member data. Attribution is already carried by `operatorId`.
- **Mitigation.** Do not start a support session into Total BJJ during this release; the correction needs none.
- **Evidence.** Run 3 §3 rows 9 and 17: the SQL check flags it in both roles.
- **Affects Sean's correction?** No, unless a support session is used.

**3. SF-139: budget cut classified as "busy"**

- **Failure.** A persistently slow (not locked) statement inside a tenant transaction hits the 15 s / 60 s budget. It is then classified as busy:
  - a club restore answers 503 "a deletion step is running";
  - the purge cron logs "skipped busy" instead of a failure.
  - Nothing is written either way.
- **Trigger.** Restoring or purging a soft-deleted club while one of its statements runs slowly. The retention cron cannot run in production today, because `CRON_SECRET` is absent (coordinator, 00:30 UK).
- **Recommendation: ACCEPT (Low).** It affects reporting only, and it is the same classification as at `704ab57`.
- **Evidence.** R10 DELTA-HANDBACK line 10 (probes B4a/B4b, both roles).
- **Affects Sean's correction?** No.

**4. SF-140: misleading guard log**

- **Failure.** `guardPoolRelease` logs "released inside a transaction (status=T)" for a client whose connection had already died. Ending that client is harmless; the log line misleads anyone diagnosing an incident.
- **Recommendation: ACCEPT (Info).**
- **Mitigation.** Q10 incident handling treats that log line as "connection dead or in a transaction", not as proof of a transaction leak.
- **Evidence.** DELTA-HANDBACK line 11.
- **Affects Sean's correction?** No.

**5. Stripe webhook P2002 → 500**

- **Failure.** In `app/api/stripe/webhook/route.ts` at `512d5e8`, a duplicate-key error caught inside the transaction (`:529`, `:588`) now answers 500 "Processing failed".
  - Stripe then retries for about 3 days. A genuine duplicate is never acknowledged, and sustained failures can make Stripe disable the endpoint, which stops every webhook.
  - Before L2, the same case could commit nothing yet answer 200, losing the event without trace. The new behaviour is louder but not lossy.
- **Trigger.** A live Stripe webhook endpoint pointed at production, plus an event whose processing hits a unique violation (for example a redelivered or concurrent duplicate).
- **Recommendation: ACCEPT, on the stated condition** that no live endpoint is created before the payments branch lands.
- **Mitigation and evidence:**
  - DELTA-HANDBACK line 12.
  - Decision §3a says no live Stripe exists in production, with no connected account and no live endpoint. This lane did not re-read that. The condition needs one owner check: Stripe dashboard → Developers → Webhooks shows no live endpoint for the production domain.
- **Affects Sean's correction?** No.

**6. Owner recovery-code redemption not browser-rehearsed**

- **Failure.** The recovery route is database-tested, but its screen path has never been driven in a browser.
- **Trigger.** An owner (Sean, for example) loses the authenticator and uses a recovery code.
- **Recommendation: ACCEPT, on one condition.** The three recovery database files have not run at `512d5e8`; the condition is that they are re-run once at `512d5e8` under both roles (Q4).
- **Affects Sean's correction?** Only as Sean's fallback. The correction leaves his recovery codes untouched, and the checker verifies their fingerprint and count (CR §6).

**7. SF-30: CSP partial**

- **Failure.** The enforced policy still allows inline scripts: `script-src 'self' 'unsafe-inline'` (`next.config.ts:11`, applied at `:100`). The nonce policy without `unsafe-inline` is report-only unless `MATFLOW_CSP_ENFORCE` is set (`lib/csp.ts:74-81`; CR §1). If any injection point existed, inline script would run in the victim's session, including an operator's.
- **Trigger.** An XSS vector. None is known; this is an amplifier, not a vector.
- **Recommendation: ACCEPT.** It is unchanged from production today. Enforcement follows a preview check.
- **Mitigation.** The Ledger SF-30 row records R5 evidence: 0 inline handlers, injection blocked when enforced. Request bodies on the hub routes are strict (CR §1, SF-33/98/99).
- **Affects Sean's correction?** Yes, as an environment risk: the hub runs in the operator's browser. There is no known vector.

**8. SF-05: legacy untagged links**

- **Failure.** Links issued before the release (every link production has minted so far) carry no subject tag. They stay valid on the old address-only rule until they expire: about 30 minutes for login links, up to 7 days for invitations (CR §1). If an address passes to a different person in that window, an old link can act for the new holder.
- **Trigger.** An untagged link is still outstanding when the release deploys, and its address is reassigned within the link's life.
- **Recommendation: ACCEPT.** The window is at most 7 days. The ledger fix is to remove the legacy branch 7 days after deploy.
- **Mitigation.** The hub workflow retires reset, login and first-time-signup tokens for **both** the old and the new address in this club (CR §5; `lib/login-email.ts:293,:302-329`).
- **Affects Sean's correction?** Covered for Sean's two addresses in Total BJJ. Other clubs and addresses are not covered.

**9. Runtime role `neondb_owner`, RLS as backstop only, editable audit rows**

- **Failure.** Production connects as `neondb_owner`. That role has BYPASSRLS, is a member of `neon_superuser`, and uses the direct host. Anyone holding that credential, or exploiting a SQL injection, can:
  - read and write every club;
  - rewrite, back-date or delete audit rows (SF-57);
  - alter the migrations ledger and operator rows (SF-73/74).

  RLS policies trust session settings that any role can set (SF-62). Isolation is enforced by the application only.
- **Trigger.** Runtime credential compromise, or SQL injection. The previously leaked password's revocation is REPORTED but not evidenced (Q6).
- **Recommendation: ACCEPT for this release only, as existing exposure the release does not change, with a review date.**
  - Expiry and remediation: the SF-62 project (estimated 13–19 agent-days, Ledger SF-62 row) and SF-57 adoption, both with the owner.
  - This is not "accepted because it already exists". It is a decision the owner must take explicitly.
- **Mitigation evidence.** Run 3 passed every journey under the restricted `matflow_app` role on TEST. So the candidate code does not depend on the owner role, but production has no such role.
- **Affects Sean's correction?** Yes. The correction's own audit rows are editable by the runtime role, so the record is not tamper-evident.

**10. Revocation-check `unknown` verdicts under load**

- **Failure.** Under pool or connection pressure the revocation check cannot answer. The proxy then serves the retrying 503 page, which is correct. On the page path SF-137 applies instead. Nothing is ever admitted.
- **Trigger.** Database latency or pool saturation. The pool is `max` 5 per instance (`lib/prisma.ts`), on the direct host.
- **Recommendation: NOTED.** This is a monitoring item, not an acceptance. There is no production baseline, and AQ2 §24 covers thresholds.
- **Evidence.** Run 2 §5 (P2028 ×2 per role pass); run 3 §4.1 (0 P2028, 3 connection timeouts).
- **Affects Sean's correction?** Possibly during Sean's sign-in, as a 503 retry page or SF-137.

**11. `main` not protected by a required PR and CI check (D-14)**

- **Failure.** A direct push to `main` deploys **and** migrates production with no CI gate (Ledger SF-15).
- **Recommendation: FIX FIRST.** Apply it before the merge, with no bypass actor (Q3). It costs nothing.
- **Affects Sean's correction?** Indirectly: it controls what code reaches production.

### Residuals present at `512d5e8` but missing from §6 (no hidden items)

**a. Owner login-email route: no synthetic-domain refusal and no in-route support-session check** (Decision §3 row; CR §1 note, §4).
- The route does not refuse `@no-login.matflow.local` or `@deleted.invalid` as a new owner login, and has no support-session check of its own. The route is unchanged from `704ab57` to `512d5e8` (verified by `git diff --stat`).
- The proxy refuses `/api/admin/*` to support sessions (`proxy.ts:307-321`).
- Recommendation: ACCEPT, with the operator checklist rule "never a synthetic domain"; fix in the next candidate.
- Affects Sean's correction: **yes**. It is a typing error the code will not catch.

**b. SF-118 / SF-119: burst availability** (Ledger rows 137–138, OPEN, Low).
- Under a burst against one address, a correct password can be refused as "Incorrect email or password" after about 13 s.
- A saturated pool refuses every other security bucket on that instance (Retry-After ≤ 30 s).
- Recommendation: ACCEPT (fails closed). Affects Sean only if his address is under attack during his sign-in.

**c. SF-131..134: readiness-script hardening** (Decision §3 row).
- Recommendation: ACCEPT (tooling only).

**d. Rehearsal instrument**
- The hub journeys were proven by scratchpad drivers, not by repository specs (Decision §3; CR gap 9).
- Recommendation: promote the drivers to repository specs in a later candidate. The evidence for this release is the run records.

---

## Q2. What is the exact release candidate?

**Status: PASS, with limitations stated below.**

| Item | Value | Evidence |
|---|---|---|
| Full SHA | `512d5e8d622f0a9cf514d1f5b5663e4e07c8939e` | `git rev-parse 512d5e8` |
| Source tree hash | `182be72fb7a623d0cd1c12b6e14b3eb987e88f48` | `git rev-parse 512d5e8^{tree}`. This is the identity the merge commit must reproduce (Q3) |
| Branch | `security/assurance-2026-10` (local only; there is no remote-tracking ref for it, so the 187 commits since `e8afb6a` are not yet on GitHub) | `git branch -r`; `git rev-list --count e8afb6a..512d5e8` = 187 |
| Node (local evidence) | v24.21.0, binary checked against `SHASUMS256.txt`; npm 11.19.0 | Run 3 §1; `evidence/lead/gates-node24-512d5e8.log` line 1 |
| Node (production build) | Vercel project setting Node 24.x / `nodejs24.x` (observed on the serving build, 9 Oct); `package.json` engines `>=24.18.1 <25`. The exact minor version Vercel uses is printed in the build log and must be recorded at deployment | `CONTAINMENT-CHECKLIST.md` O3 |
| Build IDs | gates (isolated, TEST env): `XEFPlYyNsQ5F-CB6DKMKc`. Rehearsal run 3: `-VI8m-f5fjlPib2_etBjA`. `next.config.ts` has no `generateBuildId`, so each build gets a new random ID. **The production build will have a third ID.** Candidate identity is the git tree, not a build ID | gates log; Run 3 §1 |
| Independent review | R10 review of the L2 delta **at `512d5e8`**: APPROVED WITH RESIDUALS, R10-1..R10-5 CLOSED under both roles, 58 runs, gates on a clean worktree (`docs/security/evidence/R10/DELTA-HANDBACK.md`, saved 07:48 UK). Earlier R10 phases were at `1ca92c0` (PHASE1/PHASE2-HANDBACK). Ledger SF-135/136 rows read "FIXED — APPROVED WITH RESIDUALS by R10 at 512d5e8" | R10 files; Ledger rows 154–155 |
| Gates at `512d5e8` | lint 0 · `npm audit --omit=dev` 0 · unit 481 files, 6599 passed / 1 skipped · tsc 0 · build exit 0 · tree secret scan 8 candidates | gates log |

**Does `512d5e8` contain the reviewed SF-135/136 fixes?** Yes. `512d5e8` = `704ab57` + `1ca92c0` (L1) + `3e6dd26`, `0bbf0a1`, `2c6bd4c`, `38f8295` (L2 fixes) + `512d5e8` (test). R10 reviewed that delta at exactly `512d5e8`.

**Does it contain every source change the final browser rehearsal exercised?** Yes, by construction. Run 3 was built from a detached worktree whose HEAD was `512d5e8`, with an empty `git status --porcelain` after the build (Run 3 §1).

**Anything changed after those checks?**
- `git diff --name-only 512d5e8 HEAD` lists only files under `docs/`: four commits `665bc68`, `fc42f96`, `8768afb`, `e5636dc`.
- No code, configuration, migration or test changed after the review, the gates or the rehearsal.

**Limitations:**
1. The last full both-role sweep of every database test file was at `03ef584` (`evidence/lead/sweep-03ef584.txt`, 10 Oct), 77 commits before `512d5e8`. Since then the shared transaction libraries changed: `lib/prisma.ts`, `lib/prisma-tenant.ts`, `lib/rate-limit.ts` (`git diff --stat 03ef584 512d5e8`). At `512d5e8`, the database evidence is:
   - R10's transaction-focused suites and probes;
   - the rehearsal journeys;
   - the PR's CI job, which runs the full suite, integration tests included, against a fresh Postgres 16 (Q3) and becomes the full run on the final tree.
2. The R10 hand-backs were saved by the coordinator because the reviewer's Write was refused. R10 is a separate agent lane, not a human; AQ2 §25 covers independence.
3. Vercel installs with its own install command, not the `npm ci` used locally (Ledger SF-15). The pinned `pg` 8.20.0 / `pg-pool` 3.13.0 should be confirmed in the Vercel build log.

---

## Q3. How will the pull-request release preserve the verified source?

**Status: NOT RUN.** The procedure is defined. The ruleset tightening is pending (D-14 in auto mode; it needs Noe's manual-mode approval or the GitHub UI).

| Item | Value |
|---|---|
| Current production SHA | `e8afb6a` (`e8afb6adf782…`), deployment `lxxo23g4i` READY (coordinator, Vercel API `meta.githubCommitSha`, 12 Oct 00:15 UK). Local `origin/main` = `e8afb6adf782b7b613899250dbe9164d9c71343c` (refresh with `git ls-remote` immediately before) |
| Release branch | `release/hub-512d5e8`, created at `512d5e8` from a clean checkout (packet §7.4) |
| Target | `main` |
| Merge method | GitHub "Create a merge commit". The repository allows merge, squash and rebase (Decision §7b). Squash and rebase would rewrite commits, so they are not used |
| Required CI | the job `Typecheck + Lint + Vitest` (`.github/workflows/ci.yml` at `512d5e8`, `on: pull_request`) |

**What that CI job runs:**
1. `npm ci` on Node 24 (pinned action SHAs);
2. `prisma migrate deploy` and the seed on a Postgres 16 service;
3. tsc;
4. lint;
5. Semgrep ratchet;
6. the full Vitest suite;
7. an RLS proof under a NOBYPASSRLS role.

No production secret is in its environment; it uses test-only values.

**Will merging create a new commit?** Yes. GitHub's merge-commit button always creates a merge commit, even when a fast-forward is possible. Call it `M`; its parents will be `e8afb6a` and `512d5e8`. Because `main` has nothing that `512d5e8` lacks (`e8afb6a` is an ancestor), `M`'s tree equals `512d5e8`'s tree.

**Establishing that `M` is the reviewed executable (all read-only, after the merge):**
1. `git fetch`, then `git rev-list --parents -n 1 M` → exactly `e8afb6a` and `512d5e8`.
2. `git rev-parse M^{tree}` must equal `182be72fb7a623d0cd1c12b6e14b3eb987e88f48`. One hash comparison proves the source is byte-identical. `git diff M 512d5e8` empty (packet §7.4) is equivalent.
3. Vercel deployment `meta.githubCommitSha` = `M`, READY (release-verify `vercel.production_sha`).

**Checks that must run on the final result:**
- **PR CI.** It runs on the PR's merge ref, which has the same tree as `M`.
- **CI on the push to `main` at `M`.** `ci.yml` has `on: push: branches: [main]`. It runs after the merge in parallel with Vercel. It is informative and does not gate the deploy.
- **The Vercel build log.** It must show the six migration names before `next build`.
- **Packet §7.6:** `release-verify --sha M` and `release-stage0-readonly`.

Vercel deploys `main` on push whatever the CI result says (Ledger SF-15), so the gate has to sit at the merge. That is what the ruleset change provides.

**Ruleset change:**
- Ruleset 24901063 today: active, deletion + non-fast-forward only, no bypass actor (coordinator, 01:36 UK).
- Proposed change (D-14):
  - require a pull request (0 approvals; a solo maintainer cannot approve his own PR);
  - require the status check `Typecheck + Lint + Vitest`;
  - keep no-deletion and no-force-push;
  - **no** linear-history rule, which would forbid the merge commit;
  - **no bypass actor**. No bypass is requested.

**Recommended order (one change to the packet).** The containment checklist §6 warns that if CI is red after the ruleset is applied, nothing can merge. So:
1. Settle the preview setting (Q5 step 4).
2. Push the branch and open the PR.
3. Wait for CI to go green.
4. Tighten the ruleset.
5. Merge.

If CI is red, stop. Any fix is a new candidate with its own review.

**Limitations:**
- CI has never run on this branch. `ci.yml` triggers only on PRs and on `main`, and production `e8afb6a` once shipped with CI failing (Ledger SF-15). A red result for environmental reasons (Semgrep registry fetch, Postgres 16 versus production 17) is possible and must be classified, not bypassed.
- Pushing the branch publishes 187 commits, including the security ledger and evidence, to a **public** repository (`CONTAINMENT-CHECKLIST.md` O7). AQ2 §19/§21 assess what that discloses. The owner should take that decision knowingly.

---

## Q4. What remains unverified in authentication?

**Status:**
- Owner recovery-code redemption in a browser: **NOT RUN**.
- Integration tests: **PASS at `03ef584`** (both roles).
- Integration tests at `512d5e8`: **NOT RUN**.
- SF-137: **OPEN**. The severity is evidenced; the cause is not resolved.

### Tests that cover recovery-code redemption

Found with `git grep -l recover 512d5e8 -- tests/`. The relevant ones:

| Test (at `512d5e8`) | What it covers | Last run, SHA, roles |
|---|---|---|
| `tests/integration/owner-recovery-revocation-db.test.ts` (5 cells; real route `app/api/auth/totp/recover`, real revocation check; `role: "owner"` row with 8 codes, `sessionVersion` 4) | a valid code clears the factor and secret, consumes exactly one code (8 → 7) and bumps `sessionVersion` 4 → 5, so a token at version 4 is `revoked` (**session effect**). Password hash and `mustChangePassword` survive. **Single use:** the same code again answers the opaque 200 and changes nothing (7 codes, version 5). Also covers the operator 2FA reset | `03ef584`, **both** roles (owner = `neondb_owner`, restricted = `matflow_app` with `RLS_ENFORCED=1`): 5/5 each (`evidence/lead/sweep-03ef584.txt` lines 20–21). Also 9 Oct both roles (`evidence/F/db-runs-final-2026-10-09.txt` lines 25–26) |
| `tests/integration/sec-a-recovery-code-race-db.test.ts` (4 cells; same staff route; the test row is a `coach`, and the route has no role branch, so owners take the same path) | **Concurrent redemption:** two different codes at once → exactly one recovery, version +1 once, no consumed code comes back. The same code twice at once → one recovery. With no second factor nothing is spent. Positive control | `03ef584` both roles 4/4 (lines 22–23). Red-then-green history in `evidence/A/LOG.md:136` |
| `tests/integration/sec-a2-member-recovery-race-db.test.ts` (member route, same four cells) | Member concurrency and single use | `03ef584` restricted 4/4. The owner role exited 1 with 4 skipped (`sweep-03ef584.txt:34`), then re-ran 4/4 (`sweep-03ef584-reruns.txt` line 3) |
| `tests/unit/totp-recovery-codes.test.ts`, `staff-totp-setup-recovery-single-use.test.ts`, `reset-password-session-invalidation.test.ts` and others (mocked Prisma) | Helper single use, opaque responses (no enumeration), `sessionVersion: { increment: 1 }` on success, regeneration's step-up code spent once | `512d5e8` unit gate, 6599 passed (gates log) |
| `tests/integration/totp-login-paths.test.ts` (14 cells) | **Subsequent login:** after recovery `totpEnabled` is false, so an owner's next sign-in carries `requireTotpSetup` and is forced to `/login/totp/setup`. API routes get a JSON 403; the enrolment page and `/set-password` are reachable | `03ef584` both roles 14/14 (`sweep-03ef584.txt:112-113`) |

**Gaps:**
1. **No test chains** redemption → a fresh sign-in at the account → forced enrolment. Each half is pinned separately.
2. **No test redeems a recovery code after a login-address change** (the lookup is by club + current address).
3. **No browser driver exists** for the recovery screen (Run 3 §5; Decision §7 had asked for "one added step for staff recovery-code redemption").
4. **The database tests have not run at `512d5e8`.** The route files are byte-identical from `03ef584` to `512d5e8`. The transaction libraries they call (`withRlsBypass`/`withTenantContext` in `lib/prisma-tenant.ts`, `checkRateLimit` in `lib/rate-limit.ts`, the pool guard in `lib/prisma.ts`) did change: +283/−17 lines. R10's runs (`evidence/R10/runs.txt`, `b/runs.txt`) contain no recovery file.

**Does the missing browser journey leave a release requirement unmet?**
- Yes, one requirement the Decision set itself: §7, the "added step for staff recovery-code redemption". The packet turned it into an owner risk row (§6 row 6) instead of satisfying it.
- It is not on Sean's correction path. The correction redeems no code, and the checker verifies his recovery codes are unchanged.

**Recommendation.**
- Before deployment approval, the coordinator runs the three recovery database files once at `512d5e8`, under both roles, on TEST: about 1 minute each, with the guarded runner pattern of `evidence/lead/final-sweep-v2.sh.txt`, only while TEST is not in use by another lane. The result goes into the packet.
- With that evidence, ACCEPT the missing browser step for this release, and add the driver step to the repository specs later.
- Reason: the route's logic is proven against a real database under both roles, and the only change since then is in libraries that R10 reviewed. One targeted run closes that gap cheaply. A browser driver costs a rehearsal cycle and covers a screen Sean's correction does not use.

### What supports SF-137's severity ("did not recur" is not resolution)

- **Defect reproduced twice in real journeys:**
  - first attempt, flow 4, Node 25 (Decision §7a);
  - run 2 restricted pass flow 7 at 02:59Z: sign-in accepted, ended on `/login`, followed by two P2028 "kept for revalidation" log lines (Run 2 §5.1).
- **Mechanism read in code.** `auth()` returns null for a session awaiting revalidation, and `lib/authz.ts:35` redirects (Run 2 §5.3).
- **Code unchanged at `512d5e8`.** `auth.ts`, `proxy.ts`, `lib/authz.ts`, `app/dashboard/layout.tsx` and `lib/session-revocation.ts` are byte-identical to `704ab57` (Run 3 opening). The trigger, an `unknown` verdict, still occurred in run 3: 3 connection timeouts (Run 3 §4.1). So the behaviour is present and was simply not hit.
- **Bounded at Low–Medium by evidence that it grants nothing and loses nothing:**
  - the cookie was kept and the same tab made an authenticated 200 POST;
  - 0 clearing Set-Cookie headers among 858 (fault test);
  - no data or authority is involved (Run 2 §5.4).
- **Not established:**
  - its production frequency (no baseline; production pool `max` 5 on the direct host);
  - whether every `unknown` on a page path produces it (Run 3 §4.2: "This lane cannot tell … which `auth()` call received the refusal").
- **Closure condition.** The ledger fix: a typed unavailable path mapped to a 503 that preserves `?club=`, a unit test on `lib/authz.ts`, and a browser cell. Retries passing do not close it.

---

## Q5. What exactly must I do in Vercel?

**Status: BLOCKED.** These are owner dashboard actions, not yet done.

Facts the steps rest on, all read at `512d5e8`:
- Vercel applies a variable change only to deployments created **after** it (`OPERATOR-ACCESS-RECOVERY.md`; `RELEASE-PACKAGE.md` §2.4). The serving `e8afb6a` deployment keeps what it was built with.
- `e8afb6a` has **no `EMAIL_DELIVERY` switch at all** (`lib/email-delivery.ts` is absent there and was added in `aff6682` on 7 Oct). **Production can send mail today** through the fresh Resend key. `EMAIL_DELIVERY=off` takes effect only with the `512d5e8` deployment.
- The value `off` must be exact. Unset means **on**; any other value is treated as off with a warning (`lib/email-delivery.ts:4-7,:40-51`; `lib/env-guards.ts:90`).
- At `512d5e8`, `MATFLOW_ADMIN_SECRET` authenticates nothing on any process with `NODE_ENV=production`, `VERCEL_ENV=production` or the production database (`lib/admin-auth.ts` `sharedAdminSecretPermitted`; `app/api/admin/auth/login/route.ts:24-29` refuses with 403 before reading the body; the `proxy.ts:343` edge copy).
- `e8afb6a` accepts the secret by header and by cookie (`lib/admin-auth.ts` at `e8afb6a`, `adminSecretHeaderAllowed` defaults to allowed).
- `OPERATOR_ALLOWED_IDS` on a production process: unset or empty admits **nobody** (`lib/operator-auth.ts` `isOperatorAllowed`). `e8afb6a` ignores it.

### Minimal ordered steps

**0. Preserve working operator access first** (`OPERATOR-ACCESS-RECOVERY.md` "Rollout", items 1–2).
- On the **current** site, sign in at `/admin/login` with your operator password **and** authenticator code, and confirm the console loads.
- This is the "fresh challenged login" the Decision §5 still lists as pending. Stage 0 showed the authenticator secret is present on Operator `cmoudu55l0000qktgw0r0ve2t` (coordinator, 01:33 UK), but presence is not proof.
- Keep your operator recovery material where you can reach it, without sharing it. If this sign-in fails, stop: enrol on the current build before going further.

**1. `EMAIL_DELIVERY`**
- Vercel → project → Settings → Environment Variables → filter **Production** → `EMAIL_DELIVERY`.
- It was stored non-sensitive and read back as `off` on 9 Oct (`RELEASE-PACKAGE.md` §2.3), so the value should be viewable. It must read exactly `off`.
- If it is not readable or not `off`: Edit → `off` → Save.
- Record the "updated" time.
- Effective at the `512d5e8` deployment; it has no effect on `e8afb6a`.

**2. `MATFLOW_ADMIN_SECRET`**
- Production → Edit → paste a value generated on your machine with `openssl rand -hex 32`. Do not keep it anywhere; nobody needs it. Mark it Sensitive. Save.
- Delete the **Preview** copy (it is Production + Preview, containment step 8).
- Do **not** delete the Production entry before the release: `e8afb6a`'s boot guard still requires it, so a rebuild of that commit would fail without it.
- Why rotate when `512d5e8` ignores it? So that any fresh build or rollback of old code cannot be opened with a value anyone knows (`OPERATOR-ACCESS-RECOVERY.md` rollback note; `RELEASE-PACKAGE.md` §2.4).
- **Impact on current access: none.** The serving build keeps its old value until it is replaced, and after the deploy the secret is dead in production code.

**3. `OPERATOR_ALLOWED_IDS`**
- Production → confirm the variable exists. It was set 12 Oct 01:35 UK and is Sensitive, so the value cannot be read back.
- If you have any doubt about what was typed, Edit and re-enter exactly `cmoudu55l0000qktgw0r0ve2t`: one id, no spaces, no quotes.
- Do not add it to Preview.
- Effective at the `512d5e8` deployment; `e8afb6a` ignores it.

**4. Preview deployments**
- The decision is yours. **Recommendation:** Settings → Git (on some dashboard versions, Build and Deployment) → **Ignored Build Step** → custom command `[ "$VERCEL_ENV" != "production" ]`. It exits 0, meaning "skip", for every non-production build, and 1, meaning "build", for `main`. [NEEDS VERIFICATION of the control's location and label on the day.]
- Keep it in place until Preview has its own secrets (containment step 8), not just for this push.
- Effective for the next Git-triggered build: the release-branch push.

### When each takes effect, and the impact on operator access

Steps 1–3 take effect only at the `512d5e8` deployment. At that moment:
- every existing operator session is invalidated, because the session signature changed;
- you sign in again with password + code;
- the shared-secret door closes on the production domain;
- only the allow-listed id is admitted.

If you are refused after the deploy, the allowlist value is wrong or was not picked up. Fix it and redeploy (runbook "Rollout" D). There is no other door, and the shared secret must not be re-opened.

Legacy access on **old deployment URLs** stays open with the **old** secret until those deployments are deleted. They sit behind Vercel Authentication (`all_except_custom_domains`; CONTAINMENT O6). Rotating does not close them; retiring them does (packet §7.7, after verification).

### How the release verifies effective values without exposing secrets

| Setting | What proves the effective value | Evidence |
|---|---|---|
| `EMAIL_DELIVERY` | `release-verify` `tenant.email_delivery_off`: public `GET /api/tenant/<slug>` must report `emailDelivery: "off"` from the running deployment | `release-verify.mjs:116-123` |
| `MATFLOW_ADMIN_SECRET` | `legacy.header`, `legacy.cookie`, `legacy.login_post`: a **random** well-formed value must get the application's own 401/403 JSON; a redirect, 5xx or 429 counts as a failure. Together with the code, the real value is irrelevant in production. Rotation itself is shown only by the Vercel "updated" time (names and ages only) | `release-verify.mjs:17-31,:393-394` |
| `OPERATOR_ALLOWED_IDS` | `operator.access` (required on production): an authenticated operator request with your private session file → 200 JSON; then your challenged sign-in. That a **non-listed** operator is refused was proven on TEST (Run 3 flow 1), not on production. `release-stage0-readonly` lists the operator ids; if any row other than yours exists, it must be absent from the list | `release-verify.mjs:147-151,:396`; Run 3 §5 |
| Stored versus effective, in general | A variable whose "updated" time is earlier than the deployment's creation time is in that deployment (the method used 11 Oct) | `ITERATION-2-REPORT.md` row "Revocation of the 7 May leaked credentials" |

---

## Q6. What credential-containment evidence already exists?

**Status: BLOCKED.** Provider-side revocation is not evidenced for either credential. Replacement and deployment are evidenced.

| Stage | Neon (password of `neondb_owner` in `DATABASE_URL`) | Resend (`RESEND_API_KEY`) |
|---|---|---|
| Replacement created | **REPORTED** by Noe, 11 Oct 17:07 UK: Roles page shows `neondb_owner` "last updated minutes ago". The coordinator has not read it | **REPORTED** by Noe, 11 Oct 17:07 UK: exactly one API key, "created today". The coordinator has not read it |
| Stored configuration updated | **VERIFIED:** removed and re-added Production-only, Sensitive, 11 Oct 16:58 UK; age 7 h at 12 Oct 00:30 UK (coordinator). Still the **direct** host (pooled required by CLAUDE.md; a later change) | **VERIFIED:** removed from Production + Preview 16:37 Italy, re-added Production-only, Sensitive, 15:40 UK; age 9 h at 00:30 UK (coordinator) |
| Serving deployment updated | **VERIFIED:** `lxxo23g4i` (commit `e8afb6a`) READY 17:00 UK, after 16:58; health 200, db ok, 17:02 (`ITERATION-2-REPORT.md` revocation row) | **VERIFIED:** redeploy `ibeca0u39` (16:33 UK), then `lxxo23g4i` (17:00 UK), both after 15:40 |
| Exposed credential revoked | **NOT EVIDENCED** | **NOT EVIDENCED** |

**What does not count as revocation:**
- A new key's creation date.
- A local fingerprint non-match. `ops-credential-fingerprint.mjs` exit 0 only shows the laptop copy differs from the leaked value (`ITERATION-2-REPORT.md` row: "no match" for both).
- A Roles page saying "updated". That cannot tell a reset from a re-copied password, as the ledger itself notes.

**Exact missing evidence you must provide (values never shown):**

1. **Neon, negative test.** Use the leaked password from your own old copy. The leaked string is in public history (commit `fa3c460`); do not paste it anywhere. Connect once to `ep-bold-wave-abt39t7x` → expect `password authentication failed`. Record the date, time and outcome only. This is containment step 4's required evidence.
2. **Neon, role identity.** Confirm that the role named in the **leaked** string is `neondb_owner`: read the role name only. If it names a different role, that role's password must be reset and tested too.
   - Also note the Roles page's absolute "last updated" timestamp for every role (a screenshot with no values).
3. **Resend.** API Keys page screenshot showing name, permission, created date and last used, for every key. No key may be created on or before 2026-05-07 14:17 UTC (containment step 3). Record the new key's permission level ("sending access" restricted to the domain is the target).
4. **Resend logs (optional; strengthens 3).** For the available window, no request authenticated by a deleted key.

**Same leak, outside this release:**
- The Stripe restricted live key: its prefix matched the leak, and it has been deployed since 7 May.
- `CRON_SECRET`: it matches the leak in full, but exists only in the local `.env`.

Both remain open (`ITERATION-2-REPORT.md`; containment steps 5 and 7).

---

## Q7. What is the precise recovery procedure?

**Status: NOT RUN.** The restore runbook has never been executed against production data (Decision §4; `RESTORE-REHEARSAL-ISOLATED.md` §0).

**One correction to packet §5 first.** Packet §5 creates `pre-hub-release` and then runs the migrations **on the same branch**. Once migrated, it is no longer a pre-release restore point. Use two branches:

- **`rr-<yyyymmdd>`: the rehearsal branch.** Created now from production, migrated, booted, then **deleted within 24 hours**, because it carries about 922 members' personal data and the production password (runbook §1, §7).
- **`pre-hub-release`: the restore point.** Created from production **immediately before the merge** and left untouched until the post-release observation ends. A branch outlives the 6-hour history window only if the project's branch-expiry settings allow, so read and record them. Delete it only by a separate decision.

### Creating the rehearsal branch and checking its source point

**Approval first.** Record the four [AUTH] items of runbook §1 in the run record:
- one branch with a 24-hour deletion deadline;
- who runs it, on which machine;
- that person holding the branch connection string, which is a production secret because Neon branches inherit the parent's roles and passwords;
- confirmation that no production configuration changes.

**Pre-checks** (runbook §2): plan; history window (`history_retention_seconds`; recorded as 6 hours on Free, 11 Oct 16:55 UK, REPORTED); earliest restorable time; root branch id (`br-ancient-bird-ab1fz41d`, commit `105079a`); branch quota; Postgres version.

**Create it** (runbook §3): Neon → Branches → Create branch → parent = the production root branch → current data (or a point in time inside the window) → name → create with a compute. Record T0 and T1.
- **Source point:** the branch page's parent and "created from" time.
- **Expiry:** any expiry or auto-delete setting offered [NEEDS VERIFICATION of the label].
- **Cross-check the source point with data.** Production real-tenant totals (runbook §4.2, read-only on production) must equal the branch totals at the snapshot. `prisma migrate status` against the branch URL from a `512d5e8` checkout must show 94 applied plus the historic extra row, and 6 pending (Q8).

**Protect it from side effects** (runbook §5):
- a fresh worktree with **no** `.env*` file;
- every provider dark at its boundary (the table in runbook §5.2): invalid Stripe and Resend keys, no Blob token, no Sentry DSN, no `CRON_SECRET`, `TESTING_MODE=false`;
- fresh `AUTH_SECRET`/`NEXTAUTH_SECRET`, so no production token is valid;
- `MAINTENANCE_MODE=true` for the first boot;
- bound to `127.0.0.1`;
- a host guard: not `ep-bold-wave`, not `ep-hidden-salad`;
- the branch URL kept outside the repository, never in `.env`.

### What the rehearsal proves, and what it does not

**It proves:**
- **Data integrity of a branch copy:** per-table counts for a synthetic tenant and real-tenant totals equal production at the snapshot (§4.1, §4.2).
- **The six migrations apply to production-shaped data,** with timings, and locks observed if any step exceeds a second (packet §5.3).
- **Old code tolerates the new schema:** `e8afb6a`'s build boots and serves sign-in, a member page and the operator console on the migrated branch (packet §5.4).
- **The new code boots.** `512d5e8`'s build passes health, maintenance holds, and the synthetic Iron Path owner can sign in (runbook §5.3–§5.4). Never a Total BJJ account, never Sean's.
- **RTO excluding cut-over**, and data age (§6).

**It does not prove:**
- cutting production over to a restored branch (runbook "Not covered": that needs a `DATABASE_URL` change and a redeploy);
- Blob recovery (there is no Blob backup);
- recoverability beyond the history window unless `pre-hub-release`'s expiry is confirmed.

### Data-loss window, and writes after the branch

- **RPO** = the branch's creation moment, or any point within the 6-hour window by point-in-time restore.
- A restore discards every write after that point: attendance, sign-ins and audit rows, Sean's correction, imports.
- **Rule:**
  1. Declare a 30-minute change window from `pre-hub-release` to the end of post-release checks: no imports, no account changes except approval B, no club configuration.
  2. If a restore were ever needed, export the post-snapshot rows that matter (audit rows, attendance) from production before switching, as counts and ids in private files.
  3. Re-apply Sean's correction through the hub workflow, never by SQL.
  4. Reconcile attendance from its source.
- **The preferred response to any post-deploy fault is fix-forward** (Q8). A restore is for data damage, not for a failed build.

**Who executes, and what approval is needed:**
- Noe executes the Neon console steps and holds the branch URL. The agent's production reads stay refused in auto mode (DENIALS D-1).
- The coordinator may run individual commands only in manual mode with each call approved.
- Each [AUTH] gate needs Noe's recorded approval.
- Branch deletion is mandatory within 24 hours, and the name is checked twice.

---

## Q8. What happens during the six migrations?

**Status: NOT RUN** for the production-derived rehearsal. **PASS** for content review (CR §7). **NOT RUN** for the tested fix-forward path.

**The migrations,** in order: `20261006010000_operator_auth_hardening` · `20261006020000_tenant_lifecycle_safety` · `20261006040000_support_session_binding` · `20261006050000_operator_enrolment_ticket` · `20261007010000_login_email_provisional` · `20261009010000_audit_operator_request`.

- `git ls-tree -d` counts 94 migration directories at `e8afb6a` and 100 at `512d5e8`. The difference is exactly these six (CR §6).
- No payments migration and no proposal migration (SF-57, SF-62) is included: the proposals are files under `docs/security/evidence/` and not under `prisma/migrations/`. The payments branch's seven migrations are not ancestors of `512d5e8`.

**Rehearsal results.** None yet; packet §5 steps 2–4 are outstanding. On TEST, release-verify reported 100 applied under both roles (Run 3 §1). That is a test branch, not production-shaped data.

**Locking, data transformation and compatibility (CR §7 table):**
- Every change is `ADD COLUMN`, nullable, with no default, each migration in its own `BEGIN … COMMIT`.
- No NOT NULL, rename, drop or backfill; no new table.
- Each `ADD COLUMN` takes a brief ACCESS EXCLUSIVE lock on User / Operator / Tenant / AuditLog.
- `20261009010000` builds `AuditLog_tenantId_requestId_idx` without `CONCURRENTLY`, and validates a foreign key to `Operator` (SHARE / SHARE ROW EXCLUSIVE locks). With 120 `AuditLog` rows (coordinator, 01:33 UK) this is expected to be instant.
- No `lock_timeout` is set, so a long-running transaction on those tables at deploy time would make the migration, and the queries behind it, wait.
  - The production server reports `statement_timeout` 15 s (`b82ca48`, db-role-inspect). If that applies to the migration session, a lock wait over 15 s fails the migration cleanly rather than hanging. That is not established.
  - Run in a quiet period, inside the change window.
- `e8afb6a` ignores the new columns. It does not honour `loginEmailProvisionalSince` and writes no operator or request ids (CR §7).

**The extra historical migration row.**
- `release-stage0-readonly.mjs` counts `applied` from `_prisma_migrations` rows and reports "extra" rows (`:59-65`). Production showed 95 applied against the 94 of `e8afb6a`'s tree, and the extra is `.20260503200000_activate_rls_enforcement.skip`.
- So it is **a row in `_prisma_migrations`**, not a file. The packet's wording "a marker file, not a migration row" should be corrected. The 18 Sep plan archive calls the same name "the orphan … row" on the test branch (`docs/superpowers/plans/2026-09-18-matflow-plan-archive.md:3517`).
- **Disposition: leave it untouched in this release.**
  - Every production build since May has run `prisma migrate deploy` successfully with it present (the serving deployment is READY).
  - `release-verify --expect-migrations local` does not look for extra rows (CR §6).
  - After deployment, stage 0 from the `512d5e8` checkout will still show `extra_on_db=1`. That is expected and is not a stop condition.
  - The branch rehearsal (Q7) should record whether `migrate deploy` prints any warning about it.

**If the migrations succeed but the build or deployment fails** (packet §5; CR §7):
- `package.json:7` runs `maybe-migrate.mjs && next build`, so a build failure happens after the schema changed.
- Production keeps serving `e8afb6a` on the migrated schema, which it tolerates (to be proven in Q7's compatibility boot).
- **Response: fix forward.**
  1. Do not re-push blindly.
  2. Read `migrate status`.
  3. Build the same commit `M` again. Noe does this from Vercel, because the coordinator's production redeploy is refused (D-12).
  4. **Never** Instant Rollback or Promote: they restore retired secrets and old configuration.

**If a migration fails partway** (CR §7):
- That migration rolls itself back; earlier ones stay applied.
- Prisma records the failure, the build stops, and later deploys refuse until the row is resolved with `prisma migrate resolve --rolled-back <name>`, which is a production write by Noe.

**Tested recovery or fix-forward path:** none yet.
- The fix-forward redeploy of the same SHA has not been rehearsed.
- The old-code-on-new-schema boot (packet §5.4) is the test that makes it safe, and it is outstanding.
- `migrate resolve` has never been exercised.

---

## Q9. What does disabling preview deployment change?

**Status: BLOCKED.** The owner decision is pending.

**Packet §7 step 2, verbatim:**
> 2. Vercel Git settings decision (**NOE**): pushing a release branch creates a **preview deployment** by default (no `DATABASE_URL` in Preview, so no migration; but a live URL of `512d5e8` with the Preview environment). Recommended: disable automatic preview deployments for this push (Vercel → Project → Git → Preview deployments off, or an "Ignored Build Step" for non-main), re-enable afterwards; alternative: accept the preview and delete it after the merge.

**Recommendation.** Use the Ignored Build Step (Q5 step 4), and keep it until Preview has separate secrets (containment step 8), rather than re-enabling it right after the release. A preview build of `512d5e8` would receive every Preview-scoped copy of production secrets for no release benefit.

| Does it affect… | Answer |
|---|---|
| CI | No. CI is GitHub Actions (`ci.yml` on `pull_request`), independent of Vercel |
| Browser verification | No. The browser evidence is the local production-mode rehearsal on TEST (Run 3). No preview was used, and the post-release checks run against production |
| Production secrets | It prevents a new preview runtime from holding the Preview copies. It does not remove the copies themselves |
| Automatic production deployment | No, if the command lets `VERCEL_ENV=production` build. If it were mistyped and skipped production, `release-verify` `vercel.production_sha` would FAIL: a stop condition, with no partial state beyond the migrations not having run |

**Preview access to production credentials that remains.** These are Preview-scoped copies, found in variable metadata from 9 and 12 Oct; equality of values is UNKNOWN unless stated:
- `BLOB_READ_WRITE_TOKEN`: Production, Preview **and Development**, non-sensitive; the production private store (coordinator, 00:30 UK; CONTAINMENT C5).
- `STRIPE_SECRET_KEY`: Production + Preview; the live restricted key, deployed since 7 May (CONTAINMENT C4).
- `STRIPE_WEBHOOK_SECRET`: Production (+ Preview) (C8).
- `NEXTAUTH_SECRET`: Production + Preview; whether the values are equal is unknown (C6). If they are equal, a preview runtime could sign sessions the production domain accepts.
- `MATFLOW_ADMIN_SECRET`: Production + Preview until Q5 step 2 deletes the Preview copy.
- `TESTING_MODE`: Production + Preview (161 days). At `512d5e8` it is ignored when `VERCEL_ENV=production` (`lib/testing-mode.ts`); on Preview it is honoured if `"true"`.
- No `DATABASE_URL` and no `RESEND_API_KEY` on Preview (coordinator).

**Existing deployments are not retired by this setting:**
- As of 9 Oct: 64 production deployments (0 previews) and 10 dangling branch aliases (CONTAINMENT O1/O2).
- Since then: `ibeca0u39`, one failed 16:46 build, and `lxxo23g4i`.
- Older builds hold the old Neon password and Resend key (dead only if Q6 revocation is proven) and the old `MATFLOW_ADMIN_SECRET`, with the legacy door open.
- All of them predate the `EMAIL_DELIVERY` switch.
- They sit behind Vercel Authentication on `*.vercel.app` and expire under the 30-day retention.
- Retirement is the separately authorised step: packet §7.7, containment step 9, D-3. Deletion is not credential revocation.

---

## Q10. What will prove deployment succeeded?

**Status: NOT RUN.** The checks are defined and run only after deployment. `release-verify` has passed against TEST in both roles (Run 3 §3 rows 8 and 16) but has never run with `--target production`.

All of these run **from the `512d5e8` checkout**, so `--expect-migrations local` derives exactly its 100 names (CR §6). Each must pass, in this order:

| # | Check | Expected | Stop if |
|---|---|---|---|
| 1 | Vercel build log of `M` | the six migration names, then `next build` exit 0; Node 24.x; `pg` 8.20.0 | a migration error, or a build failure → Q8 failure state |
| 2 | `release-verify --target production --sha M --base-url https://matflow.studio --tenant totalbjj --env-file-for-migrations .env --expect-host ep-bold-wave-abt39t7x --expect-migrations local --expect-operator-login --operator-session-file <private>` | exit 0 and every row PASS: `vercel.production_sha` (= `M`, READY) · `health` (200, `status ok`, `db ok`) · `migrations.applied` (all 100 finished, none failed or rolled back) · `tenant.email_delivery_off` · `legacy.header` / `legacy.cookie` / `legacy.login_post` (the app's own 401/403 JSON) · `operator.access` (200 JSON) | any FAIL or INCONCLUSIVE, or exit 1 or 2 |
| 3 | Tree identity | `git rev-parse M^{tree}` = `182be72fb7a6…` (Q3) | mismatch |
| 4 | `release-stage0-readonly.mjs .env ep-bold-wave-abt39t7x` | `missing_on_db=0`, `failed_or_in_progress=0`; `extra_on_db=1` (the historic `.skip` row; expected); the operator list shows only the allow-listed id | anything missing or failed; an unexpected operator row |
| 5 | You sign in at `/admin/login` with password + authenticator and open Total BJJ | the console loads, no "Bootstrap" tab, no new `admin.operator.refused` row for you | refused or no challenge |
| 6 | Sentry, first 30 minutes | no new unhandled-rejection class; no burst of revocation-check failures | a new error class on the auth or admin paths. **There is no baseline** (AQ2 §24), so any new class stops approval B |

**Notes:**
- The operator session file is a live bearer credential. Keep it outside the repository and delete it after check 2.
- The `.env` file used for migrations holds the production URL and is read only inside a read-only transaction with a host guard (CR §6).
- Agent reads of production need manual-mode approval (D-1); otherwise Noe runs them.

**Which failures prohibit Sean's account change:** every row above. Approval B is not requested until all six pass. In particular:
- a SHA, tree or migration mismatch means the running code is not the reviewed code;
- email delivery not reported `off` means the correction could be accompanied by mail;
- a legacy credential not refused means the old door is open;
- an operator access failure means the hub cannot be used, or the allowlist is wrong.

**What happens next if one fails:**
1. Stop all account mutations.
2. Preserve the JSON outputs and the build log (no secrets).
3. Classify the failure: configuration, build or code.
   - **Configuration** (allowlist, `EMAIL_DELIVERY`): fix the variable and redeploy the same `M` (Noe).
   - **Transient build or infrastructure:** rebuild `M`.
   - **Code defect:** a new candidate with its own review and rehearsal. `e8afb6a`-era behaviour must not come back through Instant Rollback or Promote.
4. If the console locks you out, follow `OPERATOR-ACCESS-RECOVERY.md` (allowlist fix and redeploy; `operator-access.mjs recover` against production only after the migrations ran).

---

## Q11. What will I actually click to change Sean's email?

**Status: NOT RUN** on production. The same sequence PASSED on TEST in both roles: Run 3 flows 4, 6, 6b and 7; checker 38/38.

**Inputs.** Use the existing private details recorded on 9 Oct: Sean's intended login address, and the previously agreed replacement address for the conflicting member record. They are not repeated here, and you are not asked for them again unless the fresh hub check below shows a different holder or state from the one recorded then.
- Under the code, the agreed replacement is permitted if it is a valid ASCII address, at most 120 characters, not used by any `User` or `Member` in Total BJJ, different from the member's current address, and not a synthesised `@no-login.matflow.local` or `@deleted.invalid` address.
- **Plus-aliases and dots are not folded**, so an alias of Sean's own address is accepted by the code (CR §4). Whether an alias satisfies the human rules (Sean accepts it, he or the club can read it, it is not his login) is your decision.

### Sequence

Labels are from `app/admin/tenants/[id]/LoginEmailCard.tsx` and `components/admin/ConflictPanel.tsx` at `512d5e8`; the order is from `OWNER-LOGIN-EMAIL-CHANGE.md` "Resolving a conflict" and Decision §6.

**A. Fresh facts, read-only, before the console:**
1. Club slug and immutable club id.
2. Sean's immutable `User.id` (`owner-account-state.mjs`, authorised for this step).
3. Sean confirms the intended login address by voice, on the number already held.

**B. Operator sign-in.**
4. Private browser window → `https://matflow.studio/admin/login` → operator e-mail and password → authenticator code → the console loads.

**C. Check.**
5. Open the Total BJJ tenant page. Confirm the club id matches A.1.
6. **Login email** card → **Change login email** → **New login email** = the intended address → **Check address**.
   - "Free in this club": no member step; go to step 12.
   - **Resolve conflict** panel: Club, Owner, **Held by** (kind, name, status, "Can sign in" / "Can activate (live invite or reset)" / "Cannot sign in", **Open record**, id).
   - **Stop** if the holder is a "Staff account", if only a count is shown (a legacy duplicate), if the holder is not the member recorded on 9 Oct, or if the club is wrong.

**D. Identity.**
7. Confirm independently that the member row is Sean, by call-back on the number held (`SUPPORT-IDENTITY-VERIFICATION.md`). Tick **"I verified the relationship independently"** and write how, with no unnecessary personal data.

**E. Baseline and approval B.**
8. Re-check the replacement with **Check address**: it must be free.
9. From the `512d5e8` checkout: `owner-login-change-check.mjs baseline --tenant totalbjj --owner-id <User.id> --member-id <Member.id> --expect-email-file <private file outside the repository> --expect-host ep-bold-wave-abt39t7x --env <env file> --baseline-dir <private dir>` → exit 0. Exit 1 means an identity mismatch: stop.
10. The coordinator shows you the preview: which record loses the address, which gains it, the sign-outs and token retirements, what is preserved.
    - **Approval B is given here, for these exact ids.**
    - **Declare the change window** (Q7).

**F. Member step.**
11. **Change this member's contact address** → **The member's new contact address** = the replacement → reason (10–500 characters) → **A new authenticator code** → **Change contact address**.
    - Read the result line: "They were signed out everywhere and sign in with the new address." or "They had no password: outstanding invite, sign-in and reset links were retired."
    - The panel then re-checks automatically. "Address re-checked — free in this club." means continue; anything else means stop.

**G. Owner step.**
12. "Your authenticator code works once. Wait for the next code before the second step." Once the next code appears: **Change the owner's login address** → code → **Change login address** → **Conflict resolved**.
    - If the network drops after you press a button, use **Re-send the same confirmation** only (Q12).

**H. Verify.** Run the checks in Q12, then tell Sean by voice to sign in with the new address, his own password and authenticator.

### Confirmations

- **How fresh identities and address ownership are checked:**
  - Club and owner: immutable ids read fresh (A.1–A.2); the baseline FAILS (exit 1) if the current addresses are not the expected originals (CR §6).
  - Member holder: kind, name, status, id and club from the check route under the per-club advisory lock (`lib/login-email.ts:176-242`), confirmed by a human call-back.
  - Address ownership: the code verifies nothing about who reads an address. The voice confirmation and the reason text are the only record (CR §4).
- **Member-record eligibility (code-enforced refusals, CR §3):**
  - cross-origin → 403;
  - not an allow-listed MFA operator → 403;
  - support-session cookie → 403;
  - more than 20 requests per operator+IP per hour → 429;
  - a body other than exactly `{newEmail, reason, version}`, or a bad address, reason or version → 400;
  - club or member not found, or member in another club → 404;
  - the member's current address synthesised or an erasure sentinel → 409 `managed`;
  - the new address synthesised → 400;
  - the new address equal to the current one → 400;
  - the new address held by anyone in the club (including a legacy duplicate) → 409 `taken`;
  - the member changed since the check (a version digest over id, `sessionVersion`, email, `externalRef`, password-present) → 409 `stale`;
  - a grant missing, invalid, expired, or bound to another session, action, target or change → 403;
  - the conditional write matching nothing → 409;
  - a unique violation → 409;
  - anything else → 500, with nothing changed.

  **Not refused:** a member with a password, live tokens, any status, TeamUp billing, a child with a real address, or `unverifiedEmail` set.
- **Effects of each mutation (CR §3, §5):**
  - **Member step.** One transaction: `Member.email` only changes.
    - Reset, login and first-time-signup tokens are retired for the **old and new** address in Total BJJ; waiver links are kept.
    - `Member.sessionVersion` +1 **only if** the member has a password at that moment (they are signed out everywhere).
    - Audit `admin.member.contact_email.changed` with keyed digests, `canSignIn`, `unverified`, `sessionsRevoked`, `sessionVersionAfter`, operator id and request id.
    - "Unverified" is audit metadata only. `Member.unverifiedEmail` is not written.
  - **Owner step.** One transaction:
    - `User.email` changed; `loginEmailProvisionalSince` = now; `User.sessionVersion` exactly +1, so every owner session is signed out.
    - Reset, login and first-time-signup tokens for the old **and** new address are retired.
    - Audit `admin.owner.login_email.changed`.
    - Provisional means password + authenticator sign-in works. Forgot-password, magic links and Google sign-in are refused, and outbound mail to the address is refused (fail-closed). It does not prove mailbox control.
    - Sean's member session, if any, is unaffected by the owner step.
- **Is any e-mail sent?** No.
  - `EMAIL_DELIVERY=off` at `512d5e8`, confirmed by the post-release check.
  - Neither route sends mail.
  - Mail to a provisional address is refused even with delivery on (`lib/email.ts:410-426`).
  - The rehearsal recorded zero sends (Run 3 §5, flow 4).
- **Fields and relationships that must stay unchanged** (checker `verify`, CR §6):
  - **Owner:** id, club, role, password hash, authenticator secret and state, recovery codes (fingerprint and count), `mustChangePassword`, password-history ids, lockout.
  - **Member:** id, club, status, `externalRef` (import identity), credentials, memberships, attendance, guardian links (parent, confirmation, children).
  - **Two items the checker does not compare** are covered in Q12.

---

## Q12. How do we verify and recover from partial completion?

**Status: NOT RUN.** The procedure is defined, and the two queries are drafted here.

**The two checks the readiness script omits** (CR §6; Decision §6 step 10):
- **(a)** the `admin.login_email.checked` audit row. The checker's audit query reads only rows whose entity is the owner or the member; this row's entity is the Tenant.
- **(b)** the member's `sessionVersion` change. The checker's member comparison has no version check, although the baseline records it.

**How the final procedure covers them.** After `owner-login-change-check.mjs verify --path operator --operator-id cmoudu55l0000qktgw0r0ve2t` exits 0, run these two read-only queries:
- **Who runs them:** Noe, in the Neon SQL Editor on the production branch. That is the existing practice for read-only production queries (containment step 2), and agent production reads are refused (D-1).
- **Inputs:** ids only. The baseline's `takenAt` and member values are read from the private baseline file.

```sql
BEGIN READ ONLY;
-- (a) the hub's own audit trail for this change, ids and flags only
SELECT action, "entityType", "entityId",
       ("operatorId" = '<operator id>') AS operator_matches,
       ("requestId" IS NOT NULL)        AS has_request_id,
       "createdAt"
FROM "AuditLog"
WHERE "tenantId" = '<club id>'
  AND action IN ('admin.login_email.checked',
                 'admin.member.contact_email.changed',
                 'admin.owner.login_email.changed')
  AND "createdAt" >= '<baseline takenAt>'
ORDER BY "createdAt";
-- (b) the member's session version against the audit row's own record
SELECT m."sessionVersion",
       (a.metadata->>'sessionsRevoked')     AS sessions_revoked,
       (a.metadata->>'sessionVersionAfter') AS version_after
FROM "Member" m
JOIN "AuditLog" a ON a."entityId" = m.id AND a.action = 'admin.member.contact_email.changed'
WHERE m.id = '<member id>' AND m."tenantId" = '<club id>'
  AND a."createdAt" >= '<baseline takenAt>';
ROLLBACK;
```

**Expected results:**
- **(a):** at least one `admin.login_email.checked` row (every Check address, including the automatic re-check, writes one), with entity `Tenant` / the club id. Exactly one `admin.member.contact_email.changed` (entity = member id) and exactly one `admin.owner.login_email.changed`. Every row has `operator_matches = true` and `has_request_id = true`. The check route writes `operatorId` and a durable request id (`check/route.ts:142-157`; `lib/audit-log.ts:169-171`).
- **(b):** `sessionVersion` = `version_after`. It equals the baseline member `sessionVersion` + 1 if `sessions_revoked` is true, and is unchanged otherwise.
- Any deviation means "changed but unverified". Read it; do not fix it.

**Untested.** The query text has not been run anywhere. Its column and action names come from `prisma/schema.prisma` (model `AuditLog`) and the route code at `512d5e8`. A dry run against TEST, using a rehearsal fixture's ids, is a coordinator task that can be done now.

### Each partial-completion case

There are no blind retries, no automatic reversal, no direct SQL writes, and no password or MFA resets in any of these.

**1. The member change succeeds but the owner change fails.**
- The panel says "Step 1 done, step 2 not done" and offers to resume. A page reload resumes at the owner step after a fresh check (runbook "Half-done").
- Read the refusal:
  - `stale`, or a refused grant: wait for a fresh code and resume once (Run 3 flow 7 PASS, "stale-then-usable").
  - `taken`: case 3.
  - 500: nothing changed in that step. Stop and read the server-side cause before any further attempt.
- The member step is **not** reversed automatically. A reversal is a new, separately preflighted operation, and is possible only while the old address is free.

**2. A response is lost.**
- Press **Re-send the same confirmation**. The route recognises its own spent grant and answers `alreadyApplied` from the record. Nothing is applied twice, and a spent grant is never accepted for a new change.
- Owner route: `:123-131,:150-157`. Member route: `:174-179,:198-199`. Lost-response handling passed on TEST: member side flow 6 and owner side flow 6b, both roles (Run 3 §5).
- Never start a new mutation to "try again".

**3. Another record acquires the address between steps.**
- The owner change refuses with 409 under the advisory lock (`lib/login-email.ts`; owner route `:206-207,:253-263`), and nothing changes.
- **Stop.** Run Check address to see the holder, review it with the club, and get a fresh approval B for whatever follows.

**4. Verification fails after the mutation.**
- State is "changed but unverified". Read the exact failing check rows from the checker's JSON, which carry names, statuses and counts only, and the Q12 queries.
- Make no corrective mutation until the discrepancy is understood and a new preflight and approval exist.
- Freeze further account changes for the club.

**5. Sean cannot sign in.**
- Diagnose through authorised support (`SUPPORT-IDENTITY-VERIFICATION.md`) in this order:
  1. Is he using the **new** address exactly as recorded? The baseline's keyed digest is compared by the checker.
  2. Did he land on the club-code page after a correct password and code? That is SF-137 (Q1): open the dashboard again.
  3. A 503 "retrying" page means the database is unavailable. Wait.
  4. "Too many attempts" means the address lockout (10 failures per hour from unknown networks). Wait out the window.
  5. "Incorrect email or password" under load can be SF-118. Retry after a pause.
- **Never** disable MFA, reset his password or edit rows as a "fix". The operator recovery actions (force password reset, reset owner 2FA) are separate, audited, step-up mutations that need their own approval and identity verification.
- Rolling the address back is the same workflow in reverse, with a new approval (runbook "Rollback").

---

## Q13. What is still blocked, and what is the shortest remaining path?

**Status: BLOCKED.** Deployment approval (A) must not be requested yet.

### Work the coordinator can complete now (no production, no owner permission beyond normal TEST use)

| Task | Dependency | Evidence produced |
|---|---|---|
| Run the three recovery database files at `512d5e8`, both roles, on TEST (Q4) | TEST free of other lanes | exit codes and counts per role, recorded in the packet |
| Dry-run the two Q12 queries on TEST against a disposable fixture | TEST free | query output shape (ids and flags) |
| Correct packet §3 (".skip" is a `_prisma_migrations` row) and §5 (separate restore-point and rehearsal branches; Q7) | none | packet commit |
| Fold the Q1 "missing from §6" residuals (a–d) into the §6 table, decision column empty | none | packet commit |
| Update the DENIALS register: D-9 and D-11's outcomes were obtained later under manual mode (R10 at `1ca92c0` and `512d5e8`; RH runs 2–3). The register's status column still says "In force" / "remain to be put", so it is stale | none | DENIALS commit |
| Draft the private expectations file template for the baseline (fields only, no addresses) | none | private file outside the repository |

### Dashboard actions only Noe can perform

| Action | Dependency | Permission | Evidence needed |
|---|---|---|---|
| Fresh challenged operator sign-in on the current site (Q5 step 0) | none | Noe | yes/no, time |
| Neon: negative test of the leaked password, role identity, Roles timestamps (Q6) | none | Noe | outcome text, timestamps, no values |
| Resend: API Keys screenshot, permissions (Q6) | none | Noe | dates and permissions only |
| Stripe: Webhooks page shows no live endpoint for production (Q1 row 5) | none | Noe | yes/no |
| Vercel: `EMAIL_DELIVERY` read back as `off`; rotate `MATFLOW_ADMIN_SECRET` and delete its Preview copy; confirm `OPERATOR_ALLOWED_IDS`; Ignored Build Step (Q5) | operator sign-in proven first | Noe | variable names, "updated" times |
| Neon: rehearsal branch, restore rehearsal §2/§4/§5, migration rehearsal with timings, `e8afb6a` and `512d5e8` boots, RTO/RPO, branch deleted within 24 h (Q7, Q8) | [AUTH] approvals recorded | Noe (holds the branch URL); coordinator commands only in manual mode, per call | counts, timings, boot results, deletion time |
| GitHub: approve the ruleset tightening (D-14), after CI is green on the PR (Q3) | PR open, CI green | Noe (manual-mode prompt or GitHub UI) | ruleset JSON read back |
| Neon: create `pre-hub-release` immediately before the merge; record expiry | everything above done | Noe | creation time, expiry setting |

### Explicit risk decisions (Noe)

- The eleven §6 rows (Q1).
- The four residuals missing from §6 (Q1 a–d).
- The publication of the branch's history to the public repository (Q3).

### Deployment approval (A)

Requested only after every row above has evidence. Then Noe's explicit "deploy 512d5e8" starts packet §7 steps 4–6.

### Sean's account-change confirmation (B)

After all Q10 checks pass:
- Sean confirms the intended login address by voice.
- Agreement on the replacement address.
- Independent identity confirmation.
- The preview, then approval B for exact ids (Q11 steps 1–10).

### Tool denials

- **Still active in this auto-mode session:**
  - D-1: agent production database reads.
  - D-3: bulk deployment deletion.
  - D-12: agent production redeploy. Not re-requested; Noe deploys by merging and redeploys himself.
  - D-14: ruleset tightening. To be put to Noe.
- **Proposals only, not part of this release:** D-2 (SF-57 migration), D-4 to D-8.
- **Outcome later obtained under manual mode, but the register is not updated:** D-9 and D-11.
- Under manual mode each sensitive call is approved individually. **Manual mode is not blanket approval** (DENIALS, Noe's standing instruction of 10 Oct and the 12 Oct resolution note).

### Your actions, in dependency order

1. **First action:** sign in to the current operator console with password + authenticator, and confirm it works (Q5 step 0). Nothing else is safe to change if this fails, and it takes two minutes.
2. Return the decisions on the §6 rows and the four added residuals (Q1). If SF-137 is "fix first", the candidate changes, and steps 6 and 8 onwards wait for a new reviewed candidate.
3. Provide the Neon and Resend revocation evidence (Q6) and the Stripe webhook check (Q1 row 5).
4. In Vercel: `EMAIL_DELIVERY` = `off` read back; rotate `MATFLOW_ADMIN_SECRET` and delete its Preview copy; confirm `OPERATOR_ALLOWED_IDS`; set the Ignored Build Step (Q5 steps 1–4).
5. Approve the [AUTH] items and run the Neon rehearsal branch: restore checks, the migration rehearsal, both boots, RTO/RPO, then delete it within 24 h (Q7, Q8).
6. Let the coordinator push `release/hub-512d5e8` and open the PR. Wait for CI to go green (Q3).
7. Approve the ruleset tightening (D-14) with no bypass actor.
8. Create the `pre-hub-release` restore-point branch and declare the 30-minute change window.
9. Give deployment approval A: "deploy 512d5e8" (merge as a merge commit).
10. Post-release checks (Q10), including your own challenged sign-in. Stop on any failure.
11. Sean: voice confirmation, replacement agreed, identity confirmed, preview, approval B, then the two-step change, verification and Sean's own sign-in (Q11, Q12).
12. Afterwards: retire old deployments (packet §7.7), and remove the SF-05 legacy branch 7 days after the deploy.
