# Remediation register — operator audit (6 Oct 2026)

Severity rationale: High = anonymous or cross-tenant power, data loss, or a false activation verdict; Medium = privileged action without a required control, or a functional break of an approved path; Low = defence in depth / attribution / wording. Tested SHA: 2203087 (unit, tsc, lint, build); browser builds per deploy package §9. "Lane" = the agent workstream; evidence files are the reports and reviews in this folder.

Identities (6 Oct 2026 ~01:00 Italy):
- Deployed production: `e8afb6a` — `git rev-parse origin/main` = e8afb6adf782…; `vercel ls --prod` newest Production deployment
  Ready, 2 days old (matches the 4 Oct push).
- Candidate base: local `d92435a` (3 ahead: 64c2657, 8fb151a, d92435a). Remediation commits will follow.
- Production config: `ALLOW_ADMIN_SECRET_HEADER` added (Production, Sensitive, value unreadable) on 5 Oct; not live until next deploy.

| # | Finding | Sev | Status | Lane | Evidence / next |
|---|---|---|---|---|---|
| 1 | Shared secret = anonymous full operator power in production | High | INDEPENDENTLY VERIFIED (review A+B+D, gaps closed in H) | A | production refuses header/cookie/login regardless of flag; matrix 143 |
| 2 | Named-operator MFA optional | Med→High (privileged) | INDEPENDENTLY VERIFIED (review A+B+D, gaps closed in H) | A | MFA-only session key; enrolment cookie scoped; single-use codes |
| 3 | Operator TOTP setup lacks same-origin check | Low (trace) | FIXED LOCALLY | A | + login/totp/step-up/logout |
| 4 | No step-up for resets/transfer/deletion | Med | FIXED LOCALLY (5 routes incl soft-delete; restore deliberately none) | A, D | single-use grant bound to op/action/target, DB race 5→1 |
| 5 | Temporary password never expires | Med→High (gate) | FIXED LOCALLY (operator + staff temp passwords) | A, B | 72 h; null = legacy rows unaffected |
| 6 | Impersonation unrestricted (credentials, staff, exports, destructive) | High | INDEPENDENTLY VERIFIED (review A+B+D, gaps closed in H) | B | read-only support; proxy + in-route; 174 handlers inventoried |
| 7 | Impersonation can fake owner activation; readiness script fooled | High | INDEPENDENTLY VERIFIED (review A+B+D, gaps closed in H) | B | activation-verdict needs LoginEvent + no actingAs |
| 8 | Impersonation ignores tenant status; cookie not bound to operator session | Low–Med | INDEPENDENTLY VERIFIED (review A+B+D, gaps closed in H) | B | v2 cookie bound to op session + nonce + tsv + admission; 30 min |
| 9 | Restore-versus-purge race | Med→High (data loss) | INDEPENDENTLY VERIFIED (architect replay, both roles); low follow-ups D1-D6 with lane D | C | race test 5/5 both roles; prod still racy until deploy — Noe dry-runs retention cron first |
| 10 | Unsuspend: status forced active; cancellations not reconciled | Med | INDEPENDENTLY VERIFIED | C | policy: suspension no longer touches member billing (Noe may veto) |
| 11 | Failed Stripe cancel does not stop suspension | Low | FIXED LOCALLY (moot: no Stripe call) | C | |
| 12 | Audit best-effort; DSAR erase guard unreachable | High | INDEPENDENTLY VERIFIED (review A+B+D, gaps closed in H) | D | in-tx/durable audit; erase guard proven by injected failure |
| 13 | TOTP enrolment writes no audit row; cookie path lacks `via` | Med/Low | FIXED LOCALLY | D | auth.totp.enrolled + admin.operator.totp_enrolled |
| 14 | Retention deletes admin/erase evidence | Policy | FIXED LOCALLY (6 y) — privacy page §6 says 12 months: Noe/legal decision | D | |
| 15 | No owner notification on reset/2FA reset/impersonation | Med | CONFIRMED | — | not in lanes yet; decide |
| 16 | Waiver signed under impersonation attributed to owner | Med | FIXED LOCALLY (refused) | B | |
| 17 | XSS verdict over-claimed | wording | FIXED (doc) | D | |
| 18 | Runtime DB role unknown | High (if BYPASSRLS) | UNVERIFIED/BLOCKED | E | Vercel returns [SENSITIVE]; read-only prod query denied by classifier — Noe runs scratchpad/remediation/prod-roles.mjs or checks Neon console |
| 19 | 12 todo cross-tenant cases | gap | INDEPENDENTLY VERIFIED (12 real tests) | E | matrix 41 passed + 4 expected fail; roster 3/3; rls-foundation restricted 9/9 |
| 20 | Backups failing, 0/5 secrets, PITR unverified, no restore rehearsal | High | CONFIRMED | E | |
| 21 | Webhook emails to suspended clubs; status only checked at sign-in | Low | CONFIRMED | — | backlog |
| 22 | E-1 classes dryRun leaks other gym subscriber ids (new) | High (cross-tenant data) | INDEPENDENTLY VERIFIED (matrix 54/54 both roles) | F | report-E-isolation.md |
| 23 | E-2 class can link other gym belt/coach; name leak (new) | Med | INDEPENDENTLY VERIFIED; prod detection SQL for Noe | F | |
| 24 | E-3 belt-holder count not tenant-filtered (new) | Low | INDEPENDENTLY VERIFIED | F | |
| 25 | db-backup.yml installs pg client 16 vs server 17 (would fail even with secrets) (new) | High (recovery) | CHANGED, NEVER RUN — BACKUP UNVERIFIED | F | |
| 26 | migrate-memberships unit tests expired on 6 Oct 2026 (fixtures hard-code date; createOne uses real clock) (new) | test hygiene | FIXED LOCALLY (lead) | — | Date pinned in apply-create describe; 38/38 |
| 27 | env-guards required MATFLOW_ADMIN_SECRET at boot though it now grants nothing (new) | Low | FIXED LOCALLY (lead) | — | removal from Vercel can follow deploy |
| 28 | push.ts used RLS bypass keyed on caller memberId (review EF D1) | Low | FIXED LOCALLY (lead) | — | tenant-scoped; push-tenant-scope 6/6 |
| 29 | MIGRATION_DATABASE_URL / DATABASE_URL endpoint mismatch unchecked (review EF D3) | Low | FIXED LOCALLY (lead) | — | maybe-migrate-url 5/5 |
| 30 | Support banner missing on onboarding / set-password / TOTP setup (lane B finding) | Low | FIXED LOCALLY (lead) | — | |
| 31 | Repo Playwright e2e specs assume dev secret / 60-min v1 cookie / impersonated writes | test debt | OPEN | — | lg-1, lg-2, a0-5, lb-3, operator-csrf, la-1, admin/impersonation-cookie |
| 32 | Review D1: support session fail-open on resolver DB error | Medium | INDEPENDENTLY VERIFIED (replay + mutants) | H | fail-closed; proxy test |
| 33 | Review D2: legacy temp passwords (incl. Sean's) never expire | Medium (gate) | INDEPENDENTLY VERIFIED — deadline 2026-10-20 is NOE'S DECISION | H | |
| 34 | Review D3: unenrolled operator enrols with password alone | Medium | INDEPENDENTLY VERIFIED (replay + mutants) | H | |
| 35 | Review D4: owner TOTP setup ignores password-change gate | Low-Med | INDEPENDENTLY VERIFIED (replay + mutants) | H | |
| 36 | Review D5: operator enrol/step-up/sign-in audit best-effort or missing | Low | INDEPENDENTLY VERIFIED (replay + mutants) | H | |
| 37 | Review D6-D8 + suspend step-up | Low | INDEPENDENTLY VERIFIED (replay + mutants) | H | |
| 38 | Review N1: enrolment ticket / passwords could reach Sentry (body + MatFlow headers unscrubbed) | Low | FIXED LOCALLY (lead) | — | sentry-scrub drops request.data + 2 headers; tests |
| 39 | Review N3: legacy impersonatedBy token stashed in swap branch | Info | FIXED LOCALLY (lead; mutation red→green) | — | |
| 40 | Review N2: enrolment where-clause ticket mutant survives (near-equivalent; ticket verified just before) | test gap | ACCEPTED | — | |
| 41 | E2E flow 6: support cannot start in a clean operator browser (no Auth.js carrier token) | Functional (gate: approved support works) | INDEPENDENTLY VERIFIED (review + browser E2E final3 both roles) | I | |
| 42 | E2E flow 9: LoginEvent only recorded when NEXT_PUBLIC_ENABLE_LOGIN_NOTIFICATIONS=true (unset in prod) → genuine activation never reads ACTIVATED | High for the activation verdict | INDEPENDENTLY VERIFIED (E2E flow 9 positive + negative) | I | affects verifying Sean |
| 43 | Suspend API accepts soft-deleted club | Low | FIXED LOCALLY (lane I) | I | |
| 44 | operator-access revoke may not clear support nonce | Low | NOT A DEFECT (pinned by test) | I | |
| 45 | Review I D-I2: create-tenant operator-chosen owner password counts as activation | Medium | INDEPENDENTLY VERIFIED (replay, 13 mutants killed) | J | |
| 46 | Review I D-I1: __Secure- session cookie not cleared on support stop (delete without Secure) | Low-Med | INDEPENDENTLY VERIFIED (E2E: no session cookie after stop) | J | |
| 47 | LoginEvent fire-and-forget; no retention purge; privacy page silent on sign-in records | Low + policy | FIXED LOCALLY (after(), 12-month purge); privacy wording = Noe | J | |
| 48 | Support swap never sets target name/email → dashboard 500 in clean browser; previously the prior user's name leaked into the support view | Medium (functional + wrong identity shown) | INDEPENDENTLY VERIFIED (E2E: target name in topbar) | J | |
| 49 | Approve route logged a live owner sign-in link when mail unset (incl. production) | Low-Med | FIXED LOCALLY (lead; source test) | — | |
| 50 | Review J R2: magic-link sign-ins wrote no LoginEvent | Low | FIXED LOCALLY (lead; test) | — | |
| 51 | Review J R1: LoginEvent retention comment overclaimed | Low | FIXED (comment) | — | |
| 52 | Review J R3: support stash from before the name/email fix restores no name (30-min window across deploy) | Low | ACCEPTED | — | |
| 53 | Review J R4: legacy admin.tenant.create rows (no owner named) mark every owner "ACTIVATED AFTER OPERATOR RESET" permanently | Low (conservative) | ACCEPTED — cleared only by confirming with the owner | — | |
| 54 | Rollback via Vercel promote/Instant Rollback (and every retained old deployment URL) keeps the OLD shared secret (sign-off #1) | High (procedure) | ADDRESSED IN PACKAGE — Deployment Protection + delete old deployments + never promote; e8afb6a migrate-on-new-schema rehearsed exit 0 | lead | Noe executes §3 |
| 55 | XSS breadth beyond the operator console (imports, errors, dashboard, cache controls) | coverage | OPEN | — | |
| 56 | Multi-instance expiry/throttling/invalid-token behaviour | coverage | UNVERIFIED (DB-backed by design; single instance tested) | — | |
| 57 | Cache keys / support grants isolation | coverage | UNCHECKED beyond source review | — | |
| 15 | (see above) Owner notification on reset/2FA reset/support start | Medium | OPEN — not a brief gate | — | |
