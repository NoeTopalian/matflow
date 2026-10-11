# Release decision for Sean's owner-email correction through the admin hub — prepared 12 Oct 2026 00:40 UK

Objective: Sean's owner login address corrected through the supported hub workflow, both records and their history preserved. Two approvals are kept separate: **(A) deployment approval** for the release that puts the hub in production, and **(B) account-change approval** for the correction itself. Nothing in this document is executed by its existence. No reset, push, deploy, migration or production change was made in preparing it.

## 1. Verified facts (read-only, 12 Oct 00:15–00:35 UK)

| Fact | Value | How verified |
|---|---|---|
| Serving production source | commit `e8afb6adf782…` (`e8afb6a`), ref `main`, deployment `lxxo23g4i` READY, created 11 Oct 17:00 UK (the redeploy for the rotated Neon password) | Vercel API `/v13/deployments/<url>` → `meta.githubCommitSha`, `meta.githubCommitRef`, `readyState` |
| `origin/main` | `e8afb6a` | `git ls-remote` |
| Hub candidate | `2a6487e` (docs commit, 9 Oct 10:28 UK) on executable `c837e38` (9 Oct 09:30 UK); 22 commits ahead of production; 331 files; schema +56 lines; **six migrations** | `git rev-list`, `git diff --stat`, `git diff --name-only -- prisma/migrations` |
| Last fully reviewed security executable | `704ab57` (10 Oct 23:05 UK): 118 commits and 999 files after `2a6487e`, **no further migrations**; 112 runtime and tooling files changed (55 `app/` routes, 20 `lib/`, `auth.ts`, `proxy.ts`, `next.config.ts`, `package.json`, workflows, readiness scripts) | same |
| Frozen candidate | `1ca92c0` = `704ab57` + lane L1's transaction changes, independent review BLOCKED (D-9) | ITERATION-2-REPORT §11 |
| Ancestry | `e8afb6a` → `2a6487e` → `704ab57` → `1ca92c0` in one line: either candidate is a **fast-forward** of `main`; no reset is needed or proposed | `git merge-base --is-ancestor` |
| Ref that would be pushed | `git push origin <candidate-sha>:main` from this checkout; the push triggers the Vercel build, whose first step runs `prisma migrate deploy` with the production `DATABASE_URL`, then `next build` | RELEASE-PACKAGE §3, `package.json` build script |

The six migrations (all absent from production, all applied on the TEST branch, all additive, in deploy order): `20261006010000_operator_auth_hardening`, `20261006020000_tenant_lifecycle_safety`, `20261006040000_support_session_binding`, `20261006050000_operator_enrolment_ticket`, `20261007010000_login_email_provisional`, `20261009010000_audit_operator_request`. The campaign's own migrations (SF-57 v2, SF-62 phases) are proposals and are **not** in either candidate; the payments branch's seven migrations are on a separate branch and are **not** part of this release.

## 2. The hub candidate `2a6487e` reconciled against the security findings

`2a6487e` is the exact tree the security campaign audited from 9 Oct: the ledger `docs/security/FINDINGS.md` (136 rows) was opened against it. Classification by commit ancestry (script output in the session evidence): **40 findings whose fix touches runtime code landed after `2a6487e` and are in `704ab57`**; 12 more tooling/test fixes likewise; 67 rows are unfixed or operational and apply equally to every candidate; 17 are fixed without a locatable SHA.

Known defects present in `2a6487e` that are **relevant to an operator-driven account change** (all FIXED and independently reviewed in `704ab57`):

| Finding | Defect in `2a6487e` | Why it matters for this release | Containment while it stands |
|---|---|---|---|
| SF-01 | session-revocation check fails OPEN on a database error | an operator or owner session revoked during a Neon blip stays valid | none |
| SF-05 | reset/magic-link/invite tokens not subject-bound | a token minted for one address can act for another after a change | none |
| SF-37 | both TOTP verify routes skip the revocation check | a revoked session can finish second-factor sign-in | none |
| SF-27 | two concurrent recovery-code redemptions both succeed | recovery-code race on owner/operator accounts | none |
| SF-54, SF-91 | released-address rule depends on the audit trail; member/staff DELETE wrote the release digest **after** the delete committed | these are the very rules the login-email workflow relies on to decide whether an address is free | none |
| SF-44 | fail-closed revocation signs the browser out on a DB fault (reviewed trade-off, with the proxy fix) | behaviour of the operator session under faults | — |
| SF-28 | `/api/blob-image` forwarded the Blob token to any Vercel store carrying the tenant prefix | token exposure from any deployed build | partial: the token is stored Non-sensitive and unrotated (SF-16/69), so containment does not exist until rotation |
| SF-30 | CSP still allows `unsafe-inline` scripts | XSS amplifier on every page including the hub | none |
| SF-33, SF-98, SF-99 | 500 on null/array/string bodies; hold route wrote an open-ended hold on an unparsable body | robustness of routes the operator will drive | none |
| SF-56, SF-111, SF-113 | pool `connectionTimeoutMillis` 0; lockout cap not atomic; rate limit fails under pool saturation | availability and login throttling during the release window | `LOGIN_THROTTLE_ENABLED` is set on production with an unreadable value (SF-68) |
| SF-112, SF-120, SF-127 | HMAC sub-key derivation collision class; e-mail addresses in rate-limit warning logs; one `CRON_SECRET` for every cron with no retention gate | secrets hygiene and the first cron activation | `CRON_SECRET` is unset in production (crons answer 503), which contains SF-127 for now |
| SF-25 | `setup-test-accounts.mjs` reset the totalbjj owner's address and password against whatever `.env` loads | a script in the candidate can damage the very account being corrected | discipline only |

Findings that remain **unfixed in every candidate** and matter to the release gate: SF-15 (public repo, unprotected `main`, a push deploys **and** migrates; no ruleset — containment: nobody but Noe pushes; the ruleset proposal `evidence/E2/github-ruleset-main-proposed.json` is still unapplied), SF-19/SF-77 (no exported backup has ever succeeded; recovery = Neon history + branches), SF-17 (crons dark: acceptable for this release), SF-62/SF-73/SF-74 (production runs as `neondb_owner`; RLS policies trust unregistered settings; accepted as the existing production state, not changed by this release), SF-90 (member TOTP codes not single-use), SF-135/SF-136 (lockout reservation race under bursts: present in `704ab57` in the reviewed form, present in `2a6487e` in the older, worse form of SF-111/113).

**Verdict on `2a6487e`:** unsuitable. Its 9 Oct approval was a review of the hub feature on a tree whose security posture was then audited and found wanting in 40 runtime places, 11 of them on the session, token, revocation and address-release paths that this correction exercises. Historical approval is not current acceptance.

## 3. The smallest defensible alternative: `704ab57`

What it is: the last executable in which **every library change has an independent reviewer's approval** (R2–R9), with gates recorded: lint 0, tsc 0, audit 0, build, unit 6533 passed / 1 skipped (`docs/security/evidence/lead/gates-node24-704ab57.log`). It contains the hub (`2a6487e` is its ancestor), all 40 runtime fixes above, and no extra migration.

What it lacks: L1's SF-135/136 transaction bounds (unreviewed, deliberately excluded) and the SF-131..134 tooling fixes (denied lanes). Both are accepted residuals for this release: SF-135/136 are burst-load lockout imperfections that also exist in `2a6487e`; SF-131..134 are readiness-script hardening.

The review gap specific to `704ab57`: the hub workflow was browser-verified on `c837e38`; after that, `auth.ts` (+562/−), `proxy.ts`, `lib/session-revocation.ts`, `lib/operator-step-up.ts`, `lib/key-contexts.ts` and the login-email route itself (six lines, SF-05 subject-binding in `ab5f928`) changed. No browser journey has run on `704ab57` (the acceptance-matrix and browser-QA lanes were denied, D-10/D-11). **Required review before deployment approval, narrowly scoped, not an audit:** on the production build of `704ab57` against the TEST branch, both database roles, with `EMAIL_DELIVERY=off`: the admin-hub conflict journey end to end (check → member contact change with step-up → re-check → owner login change with a fresh step-up → readiness `verify` exit 0 → lost-response re-send answers "already applied"); operator login with authenticator, allow-list refusal, support-session refusal, step-up expiry and replay; owner login, revocation, recovery; the reviewer records PASS/FAIL per journey with the persisted-state checks. This is the admin-hub FINAL-REPORT "production-mode browser rehearsal" procedure re-run on the new executable. It needs a session that can launch the browser-QA lane (a prompting session, not this auto-mode one) or Noe following the FINAL-REPORT procedure himself. Half a day.

Not recommended: `1ca92c0` (unreviewed transaction changes on the login path), or anything from the payments branch (a different milestone).

## 4. Recovery: what exists, what the six-hour figure is, and what a verified recovery means

- **Source of "six hours":** Neon project `shiny-glade-83111426`, production branch `br-ancient-bird-ab1fz41d`, Free plan, **"History retention: 6 hours"**, read by Noe in the Neon branch overview on 11 Oct 16:55 UK (ITERATION-2-REPORT §9). That is the point-in-time window: after six hours a state can no longer be recovered from history.
- **A fresh branch** (Neon → Branches → Create from `production`, data as of now) is a durable point-in-time **copy** that does not expire with the window. Noe was asked to create `backup-2026-10-11` on 11 Oct 17:13 UK; its existence is **unverified** (never read back). A branch is a restore **point**, not a recovery.
- **A verified recovery** is the runbook `docs/runbooks/RESTORE-REHEARSAL-ISOLATED.md` executed: §2 read-only pre-checks, §3 the point-in-time branch, §4 integrity counts against it (per-table counts for a synthetic tenant; real-tenant totals; migrations), §5 an isolated production build pointed at the branch with every external provider dark, §6 RTO/RPO recorded. It has **never been executed against production**; the campaign's drills were export → restore → verify on TEST copies in memory (F2, R3, F3, R6) and the weekly dump job has failed on all 22 runs.
- **Requirement for deployment approval:** immediately before the push, create `pre-hub-release-2026-10-xx` from `production`, then run runbook §4 against it and §5 locally (both AUTH-gated, Noe), and record the counts and the RTO/RPO. If §5 cannot be completed, the release waits: a six-migration release with a six-hour history window and no exercised restore has no recovery.
- **Rollback constraints** (RELEASE-PACKAGE §7): never Instant Rollback or Promote; fix forward or rebuild older code fresh; the migrations are additive and stay; while older code runs, no Danger Zone actions, no support sessions, no restores of soft-deleted clubs.

## 5. Deployment approval (A) — conditions, then the exact actions

Conditions, all recorded before the push:
- [ ] §3 review on `704ab57` PASSED (hub conflict journey and the auth journeys, both roles).
- [ ] Hub prerequisites (RELEASE-PACKAGE §2): operator authenticator enrolled **and proven** on the current site; `OPERATOR_ALLOWED_IDS` = Noe's `Operator.id` in Vercel Production; `EMAIL_DELIVERY=off` confirmed; `MATFLOW_ADMIN_SECRET` rotated; retention dry-run 0; deployment inventory noted.
- [ ] Recovery (§4): branch created, §4 counts and §5 isolated boot recorded.
- [ ] Containment state unchanged: Neon password and Resend key rotated (done 11 Oct); Stripe key roll optional (hygiene); `CRON_SECRET` stays unset.
- [ ] `git status` clean; `git rev-parse 704ab57` matches `704ab579ed42…`; `git merge-base --is-ancestor e8afb6a 704ab57` true.

Actions (Noe runs; coordinator verifies read-only):
1. `git push origin 704ab57:main` — fast-forward; the build log must show the six migration names before `next build`.
2. `node scripts/readiness/release-verify.mjs --target production --sha <40-hex of 704ab57> --base-url https://matflow.studio --tenant totalbjj --env-file-for-migrations .env --expect-host ep-bold-wave-abt39t7x --expect-migrations local --expect-operator-login --operator-session-file <private>` → exit 0 (exact SHA; health; migrations finished; `emailDelivery: off`; legacy transports closed; authenticated operator request succeeds).
3. Smoke the operator console as the allow-listed operator with the authenticator.
4. Only then (B).

## 6. Account-change approval (B) — Sean's correction, the supported workflow

Historical details (9 Oct: the intended address held by a cancelled imported member row in the same club) are **unverified** until re-read through the hub after deployment.

1. **Facts, fresh and read-only:** club slug and Sean's immutable owner `User.id` (`scripts/readiness/owner-account-state.mjs`, production, read-only, authorised for this step); the intended login address, confirmed with Sean by voice; in the hub, **Check address** → the current holder (kind, name, status, can-sign-in, record id). If the holder is a legacy duplicate (count only), stop. If the holder is staff, it is not this workflow.
2. **Identity verification, independent:** call Sean on the number already held; establish that the member row is him; record how, in the tick-box note (it becomes the audit reason).
3. **Replacement contact address for the member row:** a real, separate mailbox Sean has explicitly accepted, not an alias assumed to be safe for every authentication path; nothing else on the row changes.
4. **Baseline:** private expectations file **outside** the repository (`runSecret` ≥ 32 chars, owner original/target, member original/target); `node scripts/readiness/owner-login-change-check.mjs baseline --tenant <slug> --owner-id <User.id> --member-id <Member.id> --expect-email-file <private> --expect-host ep-bold-wave-abt39t7x --env <env file>` → exit 0 (refuses if the current addresses are not the recorded originals).
5. **Step 1 — member contact change** (hub dialog: new address, reason, authenticator code; route `POST /api/admin/customers/[id]/members/[memberId]/contact-email` with the step-up grant bound to `<club>/<member>/change` and the exact new address, version checked). Effects: `Member.email` only; outstanding invite, sign-in and reset links for old and new address in this club retired (waiver link kept); if the member could sign in, signed out everywhere and the address recorded unverified. Preserved: `externalRef`, status, password, authenticator, recovery codes, memberships, family links, attendance and payment history.
6. **Re-check** (automatic). If still held, stop.
7. **Step 2 — owner login change** with a **separate, fresh** authenticator code (the ordinary operator change): `loginEmailProvisionalSince` set, `sessionVersion` +1 exactly, every session signed out, tokens for the old address retired.
8. **Verify:** `owner-login-change-check.mjs verify … --path operator --operator-id <Operator.id>` → exit 0: same ids; owner role; login equals target (keyed digest); provisional set and freshly stamped; password hash, authenticator flag and secret, recovery codes, `mustChangePassword`, password-history ids unchanged; `sessionVersion` baseline +1; member keeps status, `externalRef`, links; audit rows `admin.login_email.checked` and `admin.member.contact_email.changed` attributed to the operator with `requestId`.
9. **Partial failure:** step 1 done and step 2 not: the panel says "Step 1 done, step 2 not done" and offers resume; reload resumes at step 2 with a fresh check; a lost response is answered by **re-sending the same confirmation** ("already applied"; a spent grant is never accepted twice); nothing is retried automatically; undoing step 1 is a new, separately authorised member change back to the old address. No account is deleted, merged or recreated.
10. **Sean's confirmation:** he signs in once with the new address, his own password and authenticator; nobody asks him for either. Notification e-mail is off (`EMAIL_DELIVERY=off`); tell him by voice.

Approvals requested, separately: (A) "deploy 704ab57" once every §5 condition is ticked; (B) "correct Sean's address" once §6 steps 1–4 are recorded and Sean has given the replacement address.
