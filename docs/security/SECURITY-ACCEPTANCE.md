# Security acceptance — campaign of 9 Oct 2026 (iteration 1 closed 17:30 UK)

Candidate under acceptance: `security/assurance-2026-10` at **`788d29a4388fdb86c5767bc2537e99eb9b44301d`** (plus
documentation-only commits after it). `main` still carries the admin-hub release candidate `2a6487e`; this branch is
merged by Noe's decision.

## Verdict: INCOMPLETE
Argued, not declared, against the brief's criteria (§2). Every CONFIRMED vulnerability in scope is fixed and
independently approved; the campaign stops short of SECURITY ACCEPTANCE MET because (a) production configuration is
unverified and two production-side findings are unresolved (SF-02, SF-14, SF-10), (b) six catalogue rows are NOT RUN
and three UNKNOWN, (c) one Medium design finding (SF-57 audit rows mutable by the app role) has a prepared but
unapplied fix, and (d) ASVS/WSTG/CWE mappings were not performed. READY WITH ACCEPTED RISKS would require Noe to
accept SF-44, SF-57, SF-62 and the NOT RUN rows explicitly; an agent cannot accept risks on his behalf.

### Iteration 2 (9–10 Oct 2026, candidate `03ef584`, docs through `a2bc56a`) — verdict stays INCOMPLETE
What changed: the campaign's three structural gaps are now DESIGNED, VALIDATED ON COPIES and PROPOSED, not applied — tenant isolation (SF-62 root cause established; per-transaction fix shipped and approved; enforced boundary P2 a migration proposal), audit protection (SF-57 v2 validated in a disposable Postgres 17.5, approved as a proposal, not applied) and recovery (first restore drills passed to an in-memory copy from both checkouts; seven more tamper classes caught; neutralisation drilled; nothing at Neon level). Credential-revocation evidence still does not exist (SF-14: the May-leak values are likely unrotated per Vercel metadata; the offline fingerprint check is now safe to run). Production remains unobserved (SF-02). The brief's four conditions for acceptance — runtime isolation, revocation evidence, required audit protection, tested recovery — therefore all remain unmet, and the verdict is INCOMPLETE by the brief's own rule, not by judgement. Every CONFIRMED finding in the iteration was fixed red-first and reviewed by someone who did not write it; the reviewers refused five lanes on first pass and found two Medium defects in the iteration's own fixes (SF-111 lockout burst, SF-112 sub-key leak), both closed by A4 and approved by R7 with residuals (SF-118–121, all Low). Standards mapping (ASVS 5.0.0 / WSTG / CWE) is done for all 96 rows with gaps listed; the NOT RUN / UNKNOWN rows are unchanged in count (6 / 4). Full argument: `ITERATION-2-REPORT.md`.

## Deployment readiness (separate field): PENDING
The runtime database role (SF-02), the rotation of the 7 May leaked credentials (SF-14), 63 old deployments holding
live credentials (SF-10), `CRON_SECRET` (SF-17), the GitHub ruleset / Vercel deploy check (SF-15) and the
Vercel/DNS settings (SF-16, SF-18) cannot be cleared from the repository.

## 1. Candidate and evidence environment
Final SHA `788d29a`. Browser evidence identity: the admin-hub rehearsal build `c837e38` / `xP9P9cHvx9xkgqHPXnOa9`
(no new browser rehearsal on the campaign build — Evidence limitations §6). Database evidence: Neon TEST branch
`ep-hidden-salad` under `neondb_owner` (BYPASSRLS) and `matflow_app` (RLS enforced) through the guarded runners.
Advisory check date: 9 Oct 2026 (ADVISORY-REGISTER.md). Production never written; never read by the lead.

## 2. Acceptance criteria (brief) — status
| Criterion | Status | Where |
|---|---|---|
| Every reachable asset and mandatory baseline requirement has a documented disposition | PARTIAL — 96/96 catalogue rows dispositioned (92 APPLICABLE, 3 NOT APPLICABLE WITH EVIDENCE, 1 UNKNOWN); ASVS 5.0.0 / WSTG / CWE / CAPEC IDs NOT mapped (stated, not invented) | COVERAGE-MATRIX.md |
| All applicable mandatory catalogue checks pass at the appropriate level | NOT MET — 54 PASS, 10 FIXED (independently approved), 13 FAIL/OPEN, 5 BLOCKED, 6 NOT RUN, 3 UNKNOWN, 2 partial/documented, 3 N/A | COVERAGE-MATRIX.md |
| No unresolved confirmed vulnerabilities in scope; no unexplained high-impact unknowns | PARTIAL — every CONFIRMED finding fixed and approved by R; high-impact UNKNOWNs remain on production configuration (SF-02, SF-14) and SF-62 (RLS bypass settable by the app role) is a design gap | FINDINGS.md |
| False-positive / not-applicable conclusions have evidence and independent review | PARTIAL — lanes A/B/C/D/F reviewed by R; lane E and the coordinator's own edits not independently reviewed | evidence/R |
| Session revocation on error; actual runtime authorization/RLS; identity reassignment/token safety; intended member-email workflow; ownership-transfer effects | Revocation FIXED+APPROVED (SF-01, with SF-44 accepted); RLS on TEST PASS both roles, production BLOCKED (SF-02); tokens FIXED+APPROVED (SF-05); member-email workflow PASS (SF-04); transfer FIXED+APPROVED (SF-23) | FINDINGS.md |
| Sensitive inputs cannot override authorization; stale credentials lose access | PASS — canary sweep 238 cases; strict owner body pinned; revoke-all built and approved; stale sessions refused | evidence/C, evidence/A |
| Import and family data integrity incl. ambiguous matches | FIXED+APPROVED through five passes (SF-06/51/54/67); residual = database-level write access only | evidence/D, evidence/R/REPORT-D5 |
| Known vulnerabilities across runtime, native and build deps fixed or safely removed | PASS for the lockfile (audit 0 after the mysql2 override); Node patch level on Vercel UNKNOWN; local Node EOL (pinned to 24) | ADVISORY-REGISTER.md |
| Audit, incident revocation, isolated restore, security-preserving rollback have meaningful evidence | PARTIAL — revoke-all control + runbook; restore verifier built and proved on TEST but NO restore run (BLOCKED); rollback documented only; SF-57 audit mutability unfixed (proposal) | evidence/F, INCIDENT-AND-RESTORE-RUNBOOK.md |
| No mandatory test skipped, timed out, unexecuted or zero-test green | PARTIAL — skip gate built (requires expected files); CI steps proposed, not applied (SF-58); both-roles results are local evidence | TEST-EVIDENCE.md |
| Lint, types, unit, required integration/browser and production build pass on the final candidate | Gates PASS on 788d29a (§5); both-role DB sweep: see §5; browser NOT RUN on the campaign build | §5 |
| A different agent reviews the final security-relevant changes and cross-boundary chains | PARTIAL — R reviewed A/B/C/D/F and chains C1–C9; E and coordinator edits unreviewed | evidence/R |
| Every claim tied to the final SHA/build, configuration and advisory-check date | Yes per row; configuration = TEST branch, production unknown | — |

## 3. Open vulnerabilities, unknowns, blockers
Blocked on Noe: SF-02, SF-10, SF-14, SF-15, SF-16, SF-17, SF-18, SF-19 (secrets + PITR rehearsal), SF-35, SF-36,
SF-43, SF-48, SF-57 (apply the migration), SF-58 (CI steps). Open for iteration 2: SF-30 (nonce CSP), SF-34, SF-37,
SF-40/53 (upload rate limit), SF-42, SF-49, SF-50, SF-55, SF-59, SF-60, SF-61, SF-62 (design), SF-63 (remaining
scripts/runners), SF-64, SF-65, AH-C2, the member recover race (SF-27). Not run: Stripe test mode, SEC-094–096
tabletop, browser checks on the campaign build, request smuggling on the edge, SEC-075 census.

## 4. Independent review outcome
R (wrote no fix): A/B/C 13/13 APPROVED at ab5f928; D APPROVED at 788d29a after five passes (two claims refuted on
the way, each closed); F approved except restore-verify and the skip gate (fixed by the lead at b871619, not
re-reviewed); SF-57 confirmed by R's own probe; SF-62 found by R. E and the coordinator's cross-owner edits:
not independently reviewed (stated).

## 5. Gates on the final candidate
`788d29a` (9 Oct 2026 17:10 UK; `scratchpad/security/gates-campaign-5.log`): `npm run lint` 0 errors / 68
pre-existing warnings, UI ratchets at baseline; `tsc --noEmit` 0; full unit suite 436 files / 5938 tests passed;
`npm run build` succeeded; `npm audit --omit=dev` 0 vulnerabilities. Both-role integration sweep of every security
database file (39 files × 2 roles, 16:55–17:40 UK) — **EVIDENCE REPAIRED (SF-76)**: the log's `exit=` column recorded the exit
status of `tr`, not vitest, so it supports nothing; the run also could not distinguish a zero-test run (a file whose every
cell skipped, or whose setup failed before any test) from a pass, because it only looked for a `Tests` line. What survives
from that sweep is the per-file `Tests N passed` text, which is vitest's own output; what does not survive is any claim that
the test PROCESS exited 0 or that every file ran at least one test. Affected claims, all withdrawn: "78/78 runs exit 0" here,
the matching line in TEST-EVIDENCE.md (iteration-1 sweep section) and in CAMPAIGN-REPORT.md's gates paragraph. Replacement
evidence: R6's sweep on `5259d3b` (54 files × 2 roles, exit codes captured directly per run, 108/108 after two setup-timeout
re-runs, with the four skipped-only files named as not evidence — `evidence/R6/sweep.txt`), R7's sweep of the 15 changed
files on `03ef584` (30/30), and the lead's re-run on `03ef584` with the corrected script `final-sweep-v2.sh` (captures
`$?` of the vitest process before any pipe, parses the `Tests` line, and marks a run NO-TESTS-RAN when 0 tests passed) —
recorded in `evidence/lead/sweep-03ef584.txt` when complete; `tenant-restore-purge-race` restricted-role setup failure of
iteration 1 is covered by F2's change that makes a setup failure show as failed cells (TEST-EVIDENCE.md).

### 5a. Iteration 2 — gates under the supported runtime (Node 24.21.0, npm 11.19.0; `evidence/lead/gates-node24-6043fed.log`)
On `6043fed` (= `788d29a` source + docs + the reconciliation script), 9 Oct 2026 18:30 UK: `npm run lint` 0 errors / 68
warnings; `tsc --noEmit` 0; full unit suite 436 files / 5938 tests; `npm run build` succeeded; `npm audit --omit=dev` 0;
`sharp` 0.35.5 / libvips 8.18.7 load under Node 24. The iteration-1 gates above ran under Node 25.9.0 (end-of-life
locally) and are superseded by this run for the same source. The Vercel build runtime is still to be confirmed (lane E2).

### 5b. Iteration 2 — gates on the candidate `5259d3b` (Node v24.21.0, npm 11.19.0; `evidence/lead/gates-node24-5259d3b.log`, 10 Oct 2026 02:41–02:59 UTC)
`npm run lint` exit 0 (eslint clean, UI-RULES ratchet at baseline); `tsc --noEmit` exit 0; full unit suite 462 files / 6405 tests passed
(exit 0); `npm audit --omit=dev` 0 vulnerabilities; `npm run build` exit 0 from an empty `.next`, BUILD_ID `CnN85vQ4c8v5zNeojjE5P`.
Two defects were found by these gates on the way and are fixed in the candidate: a tree secret-scan failure caused by literal
fixture strings in a new F3 test (34a7749) and a production-build failure caused by committed evidence records that Tailwind's
source scan parsed as a CSS escape (SF-110; a49925b + 83decf3, `@source not "../docs"`). The gates ran in the main tree
concurrently with reviewer R6's worktree run; R6's own gate results are recorded separately in `evidence/R6/`.
The both-role database sweep of the security files on the final candidate is R6's (`evidence/R6/sweep.txt`), run with real
vitest exit codes (the iteration-1 sweep's exit column was not — SF-76).

### 5c. Final candidate `a2bc56a` (code `03ef584`; `evidence/lead/gates-node24-a2bc56a.log`, 10 Oct 2026 06:00–06:08 UTC, Node v24.21.0)
`npm run lint` exit 0; `tsc --noEmit` exit 0; full unit suite 467 files / 6468 tests passed; `npm audit --omit=dev` 0 vulnerabilities;
`npm run build` exit 0 from an empty `.next`, BUILD_ID `HidgoSvinSIjTV6RbsjJ_`. Lanes A4 (`03ef584`) and C4 (`9f573ff`) are inside this
candidate. **Build reconciliation:** the candidate CODE is `03ef584`; `a2bc56a` and every later commit change only files
under `docs/` (`git diff --name-only 03ef584..HEAD` lists nothing outside `docs/`), and `docs/` is neither a Tailwind source
(`@source` allow-list, 9f573ff) nor shipped (`.vercelignore`), so the executable inputs of the `a2bc56a` build and of
`03ef584` are identical; BUILD_ID `HidgoSvinSIjTV6RbsjJ_` therefore belongs to the final executable inputs. R7 executed on
`03ef584` itself: lint exit 0, tsc exit 0, unit 6467/6468 with one 30 s import timeout under load that passed alone 426/426,
build exit 0 BUILD_ID `AAk3Mz2mm0dH7UYfSvAfh`, audit 0, and 30/30 both-role database runs (`evidence/R7/item5-gates.txt`,
`item5-sweep.txt`). Their independent review R7 (`evidence/R7/`) approved both with residuals: gates PASS, 30/30 both-role sweep, R7's own burst/refund/known-device/held-lock/saturation attacks held.

## 6. Evidence limitations
No browser rehearsal of the campaign build (unit + both-role database only); the TEST branch stands in for
production; both-roles results are local (CI runs as a superuser until SF-58 lands); the digest-based import rules
depend on the audit trail (SF-67 residual); ASVS/WSTG mappings absent by design.
