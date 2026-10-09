# Security acceptance — campaign of 9 Oct 2026 (DRAFT; finalised at the end of iteration 1)

Candidate under acceptance: `security/assurance-2026-10` at the final SHA named in the "Candidate" section below
(the branch is reviewed and gated as a whole; `main` still carries the admin-hub release candidate `2a6487e`).

## Verdict
**INCOMPLETE** (filled in when lane F and the lane D review land — see §4). The acceptance status the brief allows
(SECURITY ACCEPTANCE MET FOR THIS CANDIDATE / READY WITH ACCEPTED RISKS / INCOMPLETE / BLOCKED) is argued, not
declared: every "met" criterion below cites the ledger row and the evidence file.

## Deployment readiness (separate field)
**PENDING** — production configuration is unverified: the runtime database role (SF-02; production read refused
to the lead, script ready for Noe), rotation of the 7 May leaked credentials (SF-14), 63 old deployments retaining
live credentials (SF-10), `CRON_SECRET` unset (SF-17), the GitHub ruleset / Vercel deploy check (SF-15). None of
these can be cleared from the repository.

## 1. Candidate
Final SHA: _(filled at the end)_. Source build identity for the browser evidence: `c837e38` / BUILD_ID
`xP9P9cHvx9xkgqHPXnOa9` (admin-hub rehearsal); the campaign's own changes are covered by unit/integration tests
and the final gate run, not by a new browser rehearsal (see Evidence limitations).

## 2. Acceptance criteria (brief) — status
| Criterion | Status | Where |
|---|---|---|
| Every reachable asset and mandatory baseline requirement has a documented disposition | PARTIAL — 96 catalogue rows dispositioned; ASVS 5.0.0 / WSTG / CWE IDs NOT mapped (no lane looked them up; stated, not invented) | COVERAGE-MATRIX.md |
| All applicable mandatory catalogue checks pass at the appropriate level | NOT MET — rows at code-review level, NOT RUN or BLOCKED remain (listed in §3) | COVERAGE-MATRIX.md |
| No unresolved confirmed vulnerabilities in scope; no unexplained high-impact unknowns | PARTIAL — every CONFIRMED finding is fixed and independently approved; high-impact UNKNOWNs remain on production configuration (SF-02, SF-14) | FINDINGS.md |
| False-positive / not-applicable conclusions have evidence and independent review | PARTIAL — lanes A/B/C reviewed by R; D under review; E/F not independently reviewed | evidence/R |
| Session revocation on error; actual runtime authorization/RLS; identity reassignment/token safety; intended member-email workflow; ownership-transfer effects | Revocation FIXED+APPROVED (SF-01); RLS on TEST both roles PASS, production BLOCKED (SF-02); tokens FIXED+APPROVED (SF-05); member-email workflow PASS (SF-04); transfer FIXED+APPROVED (SF-23) | FINDINGS.md |
| Sensitive inputs cannot override authorization; stale credentials lose access | PASS — canary sweep 238 cases; strict owner body pinned; revoke-all built; stale sessions refused (SEC-013) | evidence/C, evidence/A |
| Import and family data integrity incl. ambiguous matches | FIXED (SF-06) — review pending (R on lane D) | evidence/D |
| Known vulnerabilities across runtime, native and build deps fixed or safely removed | PARTIAL — runtime clean; mysql2 build-chain override queued; Node patch level on Vercel UNKNOWN | ADVISORY-REGISTER.md |
| Audit, incident revocation, isolated restore, security-preserving rollback have meaningful evidence | PENDING lane F | evidence/F |
| No mandatory test skipped, timed out, unexecuted or zero-test green | PENDING lane F (SEC-088; SF-26 harness defects) | TEST-EVIDENCE.md |
| Lint, types, unit, required integration/browser and production build pass on the final candidate | PENDING final gate run | §5 |
| A different agent reviews the final security-relevant changes and cross-boundary chains | PARTIAL — R reviewed A/B/C and chains C1–C9; D in progress; E/F/coordinator edits not yet | evidence/R |
| Every claim tied to the final SHA/build, configuration and advisory-check date | Advisory check date 9 Oct 2026 (evidence/E); SHA per row | — |

## 3. Open vulnerabilities, unknowns, blockers (summary — full rows in FINDINGS.md)
Blocked on Noe: SF-02, SF-10, SF-14, SF-15, SF-16, SF-17, SF-18, SF-19 (secrets), SF-35, SF-36, SF-48.
Open for the next iteration: SF-30 (nonce CSP), SF-34, SF-37, SF-40 (upload rate limit), SF-42, SF-49, SF-50,
AH-C2, writer-guard DB trigger (SF-07), member recover race (SF-27).
Not run: Stripe test-mode (SF-43), SEC-094–096 tabletop, browser checks for SEC-009/011/016/041 on the campaign
build, request smuggling on the edge.

## 4. Independent review outcome
Lanes A/B/C: 13/13 fixes APPROVED at `ab5f928` by R (evidence/R/REPORT.md), with R-1…R-6 actioned or recorded.
Lane D: _(pending)_. Lanes E and F and the coordinator's cross-owner edits: NOT independently reviewed in this
iteration (stated).

## 5. Gates on the final candidate
As of `788d29a` (9 Oct 2026 17:10 UK; `scratchpad/security/gates-campaign-5.log`): `npm run lint` 0 errors / 68
pre-existing warnings, UI ratchets at baseline; `tsc --noEmit` 0; full unit suite 436 files / 5938 tests passed; `npm run
build` succeeded; `npm audit --omit=dev` 0 vulnerabilities (mysql2 overridden to 3.24.5). Both-role integration sweep of
every security database file on the final SHA: _(run after the last review lands; recorded in TEST-EVIDENCE.md)_.

## 6. Evidence limitations
The campaign's code changes were verified by unit and database-integration tests under both roles; no new
production-mode browser rehearsal was run on the campaign branch (the admin-hub rehearsal certified `c837e38`).
The TEST branch stands in for production; the production role and configuration are unverified. ASVS/WSTG
mappings are absent by design rather than invented.
