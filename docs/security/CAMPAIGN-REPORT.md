# Security campaign report — 9 Oct 2026 (iteration 1 of the bounded loop) — DRAFT, finalised at the end

## Exact candidate / source / build / environment
Branch `security/assurance-2026-10`, final SHA _(filled at the end)_, built from the admin-hub candidate `2a6487e`
(source build `c837e38`, BUILD_ID `xP9P9cHvx9xkgqHPXnOa9` for the browser evidence). Local environment: Windows 11,
Node 25.9.0 (end-of-life locally — Vercel runs 24.x; `engines` now pins the 24 line), npm lockfile at the final SHA.
Database evidence: Neon TEST branch `ep-hidden-salad` through the guarded runners under both roles — `neondb_owner`
(BYPASSRLS) and `matflow_app` (RLS enforced). Production (`e8afb6a`, `ep-bold-wave-abt39t7x`) was never written to
and never read by the lead (the read was refused by the permission layer; the inspection script is committed for Noe).

## What was reproduced and fixed (all red-first, both database roles where a database is involved)
| Finding | Reproduced | Fixed in | Independent review |
|---|---|---|---|
| AH-G7 revocation check fails open: a revoked token read and wrote during an injected DB fault | yes | ab5f928 | APPROVED (R) — regression R-1 accepted as availability cost (SF-44) |
| AH-D2 a deleted person's reset code / invitation / login link worked for the next holder of the address | yes | ab5f928 | APPROVED |
| SF-23 two concurrent ownership transfers left a club with two owners | yes | 2ec8d88 | APPROVED |
| SF-28 blob-image sent our Blob token to any store and served SVG from our domain | yes | ab5f928 | APPROVED |
| SF-29 payments CSV export cacheable | yes | ab5f928 | APPROVED |
| SF-25 / SF-39 scripts that reset the totalbjj owner against production / sent mail ignoring EMAIL_DELIVERY | by reading | 2ec8d88, 1e68155 | APPROVED |
| AH-D1 / SF-06 / SF-51 / SF-54 / SF-67 attendance import bound history to the wrong person (same name, accent, rename, zero-width, Cyrillic, released address, roster drift, unaudited release, key rotation, acquisition after the bookings) | yes, through the real route | 1e68155 → 35e031a → 3be9490 → 0964571 → _(fifth pass)_ | three rounds; final round _(pending)_ |
| SF-56 pg pool waited forever when exhausted (billed) | yes | 2bdac83 | APPROVED |
| SF-26 two harness defects (a security suite failing unnoticed; a restricted-role test seeing nothing) | yes | 2bdac83 | APPROVED |
| A-4 / SF-27 concurrent recovery-code redemptions | yes | ab5f928 | APPROVED |
| AH-G5 expiry label; SF-24 support backstop; SF-32 CSRF on attachments DELETE; SF-33/47 body-shape and type 400s; AH-G6 strict owner body + pin | yes / hardening | ab5f928, ef97595 | APPROVED |
| SF-63 database-target guards bypassable (upper-case host, ?host=, ?options=endpoint) | yes | b871619 | — (lead) |
| SF-11 mysql2 in the build chain | yes | aa1621d (override; audit 0) | — |
| New controls: revoke-everything operator route; per-call writer guard; release digests on every deletion path; CSP/API cache rules; Node/CI pins | — | various | revoke-access APPROVED |

## Catalogue / standard coverage by status and test level
96 rows in COVERAGE-MATRIX.md. _(final counts filled at the end: PASS / FIXED-APPROVED / FIXED-AWAITING / FAIL /
OPEN / NOT APPLICABLE WITH EVIDENCE / UNKNOWN / BLOCKED / NOT RUN.)_ ASVS 5.0.0, WSTG, CWE and CAPEC IDs are NOT
mapped — no lane looked them up; stated rather than invented.

## Open vulnerabilities, unknowns, blockers, evidence limitations
See FINDINGS.md. Headline open items: SF-57 audit rows mutable by the app role (migration proposed, not applied — refused
to the lead); SF-62 the app role can switch the RLS bypass on for itself (design); SF-30 inline-script CSP; SF-40/53
upload rate limit; SF-59 lockout denial of service; SF-64 restore fingerprint gaps; SF-67 residual (unaudited takeover).
Blocked on Noe: SF-02 production DB role; SF-14 May-leak rotation; SF-10 old deployments; SF-15 ruleset / deploy check;
SF-16/17/18 Vercel + DNS settings; SF-19 backups; SF-35/36 decisions; SF-48 blob hosts count; SF-43 Stripe test mode.
Evidence limitations: no browser rehearsal of the campaign build (unit + both-role DB only); the TEST branch stands
in for production; both-roles results are local (CI still runs as a superuser — SF-58).

## Independent review outcome
R (did not write any fix): lanes A/B/C 13/13 APPROVED at ab5f928; lane F approved except restore-verify and the skip
gate (both fixed by the lead at b871619, not re-reviewed); lane D approved three times with a narrower residual each
round; fourth-pass verdict NOT APPROVED narrowly (guardian adoption) → fifth pass _(pending)_. Lane E and the
coordinator's own edits were not independently reviewed (stated).

## Production configuration and historical-deployment status
Unverified: runtime DB role (script committed for Noe). Known: 63 old deployments retain live credentials behind Vercel
SSO only; `CRON_SECRET` unset (retention and reconciliation crons do nothing); Blob token Non-sensitive and on Preview;
TESTING_MODE in Production; no DMARC / apex SPF; `main` unprotected on a public repository with push-to-deploy; the
7 May leak sits in public history with unverified rotation.

## Local changes versus actually deployed changes
Everything in this report is local to the branch; production still runs `e8afb6a` (4 Oct). Nothing was pushed,
deployed, rotated, deleted or sent.

## Next precise action and whether approval is required
1. Noe: run `node scripts/readiness/db-role-inspect.mjs .env ep-bold-wave-abt39t7x` and paste the output (read-only).
2. Noe: confirm rotation of the May-leaked credentials; set CRON_SECRET; fix the Blob/Preview/TESTING_MODE settings;
   add DMARC + SPF; enable a ruleset on `main`.
3. Noe's decision: apply the append-only audit migration (SF-57) and the CI assurance steps (SF-58) — both prepared.
4. Then merge `security/assurance-2026-10` into `main` as part of the next release (approval required: it changes
   authentication, import matching and the lockfile).

## Verdict
_(one of BLOCKED / INCOMPLETE / SECURITY ACCEPTANCE MET FOR THIS CANDIDATE / READY WITH ACCEPTED RISKS — filled at
the end.)_ **Deployment readiness (separate field): PENDING** — production configuration unverified.
