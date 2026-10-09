# Security campaign report — 9 Oct 2026 (iteration 1 of the bounded loop)

## Exact candidate / source / build / environment
Branch `security/assurance-2026-10`, final source SHA **`788d29a4388fdb86c5767bc2537e99eb9b44301d`** (documentation
commits follow it), built from the admin-hub candidate `2a6487e` (source build `c837e38`, BUILD_ID
`xP9P9cHvx9xkgqHPXnOa9` for the browser evidence). Local environment: Windows 11, Node 25.9.0 (end-of-life locally;
Vercel runs 24.x; `engines`/.nvmrc/CI now pin the 24 line), lockfile at the final SHA (`next` 16.3.8, `undici`
6.29.0, `sharp` 0.35.5, `mysql2` 3.24.5 via override). Database evidence: Neon TEST branch `ep-hidden-salad`
through the guarded runners under `neondb_owner` (BYPASSRLS) and `matflow_app` (RLS enforced). Production
(`e8afb6a`, `ep-bold-wave-abt39t7x`) was never written to and never read by the lead — the read-only inspection
was refused by the permission layer; the script is committed for Noe.

## What was reproduced and fixed (red-first; both database roles wherever a database is involved)
| Finding | Reproduced | Fixed in | Independent review (R) |
|---|---|---|---|
| AH-G7 revocation check fails open — a revoked token read the member list and wrote during an injected DB fault | yes | ab5f928 | APPROVED; regression R-1 (a DB fault now signs users out) accepted as an availability cost — SF-44, Noe may veto |
| AH-D2 a deleted person's reset code, invitation and login link worked for the next holder of the address | yes | ab5f928 (+ four invitation issuers) | APPROVED |
| SF-23 two concurrent ownership transfers left a club with two owners | yes | 2ec8d88 | APPROVED |
| SF-28 blob-image sent our Blob token to any store and served SVG from our domain | yes | ab5f928 | APPROVED |
| SF-29 payments CSV export cacheable; SF-32 CSRF on attachments DELETE; SF-33/47 body-shape and type 400s; AH-G6 strict owner body + pin | yes | ab5f928, ef97595 | APPROVED |
| SF-25 / SF-39 scripts resetting the totalbjj owner against production / sending mail regardless of EMAIL_DELIVERY | by reading | 2ec8d88, 1e68155 | APPROVED (deletions) |
| AH-D1 attendance import bound history to the wrong person — same name, accent, rename, zero-width, Cyrillic, released address, roster drift, unaudited release, key rotation, acquisition after the bookings, guardian adoption, old-format rows | yes, through the real route | 1e68155 → 35e031a → 3be9490 → 0964571 → 788d29a | APPROVED at 788d29a (23 cells both roles; no in-app evasion) |
| SF-56 pg pool waited forever when exhausted (and was billed) | yes | 2bdac83 | APPROVED |
| SF-26 harness defects (a security suite failing unnoticed; a restricted-role test seeing nothing) | yes | 2bdac83 | APPROVED |
| A-4 / SF-27 concurrent recovery-code redemptions; AH-G5 expiry label; SF-24 support backstop | yes | ab5f928, 2ec8d88 | APPROVED |
| SF-63 database-target guards bypassable (upper-case host, ?host=, ?options=endpoint); SF-58 skip gate passing an omitted file | yes | b871619 | — (lead; not re-reviewed) |
| SF-11 mysql2 in the build chain | yes | aa1621d (audit 0) | — |
| New controls: revoke-everything operator route (approved); per-call writer guard; release digests on every deletion path; API-wide no-store; CSP/Node/CI pins; shared DB-target guard; restore verifier; skip gate | — | various | revoke-access APPROVED; verifier and gate reviewed then fixed |

## Catalogue / standard coverage by status and test level
96 rows (COVERAGE-MATRIX.md): applicability 92 APPLICABLE, 3 NOT APPLICABLE WITH EVIDENCE (SEC-034/037/040, guard
tests), 1 UNKNOWN (SEC-005 Google OAuth). Verification: 54 PASS, 10 FIXED and independently approved, 13 FAIL/OPEN,
5 BLOCKED, 6 NOT RUN, 3 UNKNOWN, 2 partial/documented, 3 N/A. Levels: unit, database integration under both roles,
configuration/code review, bounded fuzz; browser only from the earlier admin-hub rehearsal; no load tests beyond
bounded probes; restore not run. ASVS 5.0.0 / WSTG / CWE / CAPEC IDs: NOT mapped — no lane looked them up.

## Open vulnerabilities, unknowns, blockers, evidence limitations
Open (iteration 2): SF-57 audit rows mutable by the app role — migration prepared, R-reviewed with four required
changes, NOT applied (refused to the lead); SF-62 the app role can switch the RLS bypass on for itself (RLS is a
backstop against filter mistakes, not a control against a compromised app); SF-30 inline-script CSP; SF-40/53 upload
rate limit (N concurrent uploads ≈ N × 125 MB); SF-59 lockout denial of service + SF-35 lockout oracle; SF-64 restore
fingerprint gaps; SF-63 remaining scripts and runners; SF-55 confusable letters; SF-37/50/60/61 lows; SF-67 residual
(database-level write access). Blocked on Noe: SF-02 production DB role; SF-14 May-leak rotation; SF-10 63 old
deployments with live credentials; SF-15 ruleset/deploy check; SF-16/17/18 Vercel + DNS; SF-19 backups + PITR
rehearsal; SF-36 Google rule; SF-43 Stripe test mode; SF-48 blob hosts count. Evidence limitations: no browser
rehearsal of the campaign build; TEST stands in for production; both-roles results are local until CI runs
`matflow_app` (SF-58); no ASVS mapping.

## Independent review outcome
R (wrote no fix): lanes A/B/C 13/13 APPROVED (ab5f928); lane D APPROVED at 788d29a after five passes — the first
two "never commits a false match" claims were refuted and each refutation closed; lane F approved except the restore
verifier and skip gate (fixed by the lead, not re-reviewed); R confirmed SF-57 by its own probe and found SF-62. Lane E
and the coordinator's cross-owner edits were not independently reviewed. Chains: C1, C2 (post-deploy tokens), C4
closed; C3 closed to database-level write access; C5 open (old deployments); C6 lane D tests only; C7 open on
production role; C8 partial; C9 open (rollback re-opens G7/D2/A-4/SF-23; old deployments live).

## Production configuration and historical-deployment status
Runtime DB role UNVERIFIED (script committed: `node scripts/readiness/db-role-inspect.mjs .env ep-bold-wave-abt39t7x`).
Known from read-only inventory: 64 production deployments, 63 old builds + 10 dangling branch aliases, every old build
holding the current DATABASE_URL, NEXTAUTH_SECRET, Stripe, Resend and Blob credentials with Vercel SSO as the only
barrier; `CRON_SECRET` unset (retention, Stripe reconciliation and purge crons answer 503); Blob token Non-sensitive
and scoped to Preview; production signing/payment secrets on Preview; TESTING_MODE in Production; no DMARC, no apex
SPF; `main` unprotected on a public repository, push deploys and migrates, `e8afb6a` shipped on failing CI; the 7 May
leak (Neon password, Resend key, CRON_SECRET, Stripe prefix) in public history with unverified rotation.

## Local changes versus actually deployed changes
Everything here is local to the branch (37 commits from `afc2288` to the final docs commit). Production runs
`e8afb6a` (4 Oct). Nothing was pushed, deployed, rotated, deleted or sent; no customer contacted.

## Next precise action and whether approval is required
1. Noe (no approval needed, read-only): run the DB role inspection and paste the output.
2. Noe: confirm rotation of the May-leaked credentials; set CRON_SECRET; Blob token Sensitive/Production-only;
   Preview secrets; remove TESTING_MODE; add DMARC + SPF; enable a ruleset on `main`.
3. Noe's decision (approval required — schema and CI): apply the SF-57 append-only audit migration (with R's four
   changes) and the SF-58 CI steps; both are prepared text.
4. Merge `security/assurance-2026-10` into `main` with the next release (approval required: it changes
   authentication, import matching, the lockfile and the lint/CI configuration), then re-run the admin-hub
   release-verify on production after deploy.

## Verdict
**INCOMPLETE** (see SECURITY-ACCEPTANCE.md for the criterion-by-criterion argument). **Deployment readiness: PENDING.**
