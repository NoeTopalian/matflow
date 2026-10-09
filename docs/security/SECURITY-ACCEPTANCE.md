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
database file (39 files × 2 roles, 16:55–17:40 UK): 78/78 runs exit 0; `sec-b-fixture-sweep-db` skipped by design (opt-in);
`tenant-restore-purge-race` under the restricted role failed to set up once (transient) and passed 5/5 on re-run; the three
files lane D changed mid-sweep re-run on the final tree: 23/23, 19/19, 7/7 under both roles (TEST-EVIDENCE.md).

### 5a. Iteration 2 — gates under the supported runtime (Node 24.21.0, npm 11.19.0; `evidence/lead/gates-node24-6043fed.log`)
On `6043fed` (= `788d29a` source + docs + the reconciliation script), 9 Oct 2026 18:30 UK: `npm run lint` 0 errors / 68
warnings; `tsc --noEmit` 0; full unit suite 436 files / 5938 tests; `npm run build` succeeded; `npm audit --omit=dev` 0;
`sharp` 0.35.5 / libvips 8.18.7 load under Node 24. The iteration-1 gates above ran under Node 25.9.0 (end-of-life
locally) and are superseded by this run for the same source. The Vercel build runtime is still to be confirmed (lane E2).

## 6. Evidence limitations
No browser rehearsal of the campaign build (unit + both-role database only); the TEST branch stands in for
production; both-roles results are local (CI runs as a superuser until SF-58 lands); the digest-based import rules
depend on the audit trail (SF-67 residual); ASVS/WSTG mappings absent by design.
