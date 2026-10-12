# Release decision for Sean's owner-email correction through the admin hub — v2, 12 Oct 2026 01:10 UK

Supersedes v1 (`67666b5`, 00:40 UK) after the owner's corrections and a code-level reconciliation of the candidate in a dedicated checkout (`hub-release-2026-10-12/CR-REPORT.md`). Objective: Sean's owner login address corrected through the supported hub workflow, both records and their history preserved. Two approvals are kept separate: **(A) deployment** of one exact SHA, **(B) the account change**. Nothing here is executed by its existence: no reset, push, deploy, migration, production read beyond the ones cited, or message to Sean.

Status vocabulary: VERIFIED (read first-hand, source cited) · REPORTED (owner or provider said so; not read by the coordinator) · UNVERIFIED · PROPOSED (a recommendation awaiting the owner's decision).

## 1. Current state (refreshed 12 Oct 00:30 UK)

| Fact | Value | Status |
|---|---|---|
| Serving production source | `e8afb6adf782…` on `main`, deployment `lxxo23g4i` READY (created 11 Oct 17:00 UK) | VERIFIED (Vercel API `meta.githubCommitSha`) |
| `origin/main` | `e8afb6a` | VERIFIED (`git ls-remote`, 11 Oct 15:30 UK; refresh immediately before any push) |
| Deployed configuration | `DATABASE_URL` 7 h old, `RESEND_API_KEY` 9 h old (Production only), both older than the serving deployment, so the serving build reads the replaced values; `EMAIL_DELIVERY` 3 d (value not readable here; last read back as `off` on 9 Oct); `MATFLOW_ADMIN_SECRET` 53 d (not rotated); `OPERATOR_ALLOWED_IDS` absent; `CRON_SECRET` absent; `STRIPE_SECRET_KEY` 157 d | VERIFIED (names and ages only) |
| Provider-side retirement of the old Neon password and Resend key | Neon role "last updated minutes ago" and one Resend key "created today", 11 Oct 17:07 UK | REPORTED by Noe; not read by the coordinator; capture identifiers and timestamps only |
| Production runtime role | `neondb_owner`: BYPASSRLS, member of `neon_superuser`, direct host; no `matflow_app` role exists on production; RLS enabled and forced on every table with policies that trust unregistered session settings | VERIFIED 11 Oct 16:12 UK (`db-role-inspect.mjs`, read-only) — **this is existing exposure, not accepted risk**; see §3 |
| Hub candidate `2a6487e` / executable `c837e38` | 22 commits after production; 331 files; schema +56; six migrations | VERIFIED |
| Reviewed security executable `704ab579ed42cef497bc38136982502aca153b75` | 118 commits and 999 files after `2a6487e`; no further migration; hub files byte-identical to `c837e38` except three lines each way in the owner login-email route (`z.strictObject`, AH-G6) | VERIFIED (CR §1, §7) |
| Ancestry | `e8afb6a` → `2a6487e` → `704ab57` → `1ca92c0`, one line; fast-forward; no reset needed or proposed | VERIFIED |
| Production's applied migration set | **VERIFIED 12 Oct 01:33 UK** (`release-stage0-readonly.mjs .env ep-bold-wave-abt39t7x`, read-only, owner-approved in manual mode): 95 migrations applied, exactly the six below missing, 0 failed or in-progress rows, one skip marker (`.20260503200000_activate_rls_enforcement.skip`); `AuditLog` = 120 rows (index build is trivial); Operator `cmoudu55l0000qktgw0r0ve2t` role `super_admin`, authenticator secret present (a fresh challenged login is still required as proof). Previously: `e8afb6a`'s tree ends at `20261003180000_attendance_history_ledger`; whether every migration up to that one is applied on production needs `prisma migrate status` against production (read-only; Noe; Stage 0) | UNVERIFIED |
| Migrations the candidate adds | `20261006010000_operator_auth_hardening`, `20261006020000_tenant_lifecycle_safety`, `20261006040000_support_session_binding`, `20261006050000_operator_enrolment_ticket`, `20261007010000_login_email_provisional`, `20261009010000_audit_operator_request`: nullable columns without defaults, one index and one foreign key on `AuditLog`; no backfill, no NOT NULL, no drop or rename | VERIFIED (CR §7) |

## 2. `2a6487e` reconciled against the security findings

The ledger (136 rows) was opened against `2a6487e`. Commit ancestry is an **index**: 40 rows whose fix touches runtime code landed after `2a6487e`, 12 tooling rows likewise, 67 rows unfixed or operational. The eleven on the account-change path were then **read in the final code at `704ab57`** (CR §1):

| Finding | At `2a6487e` | At `704ab57` (code read) | Relevance to this correction |
|---|---|---|---|
| SF-01 / SF-44 revocation check fails open; DB fault | absent | PRESENT+PINNED: unknown/revoked/malformed states; DB fault → 503, cookie kept, 24 h revalidation bound | an operator or owner session revoked during a Neon fault stays valid at `2a6487e` |
| SF-37 TOTP verify routes skip revocation | absent | PRESENT+PINNED (`lib/auth-pending-gate.ts`); disown-login now needs a confirmed POST | second-factor completion on a revoked session |
| SF-05 subject-bound tokens | absent | PRESENT+PINNED **with a legacy branch**: links without a binding tag (every link production has issued so far) stay valid on the old address-only rule until expiry, up to 7 days for invitations | tokens minted for the old address survive the change until they expire or are retired by the workflow |
| SF-27 recovery-code race | absent | PRESENT+PINNED (single winner, conditional update) | owner/operator recovery |
| SF-54 / SF-91 release digests | absent | PRESENT+PINNED — **correction:** these feed the attendance import's identity rule; address *freedom* is decided only from live `User`/`Member` rows (`lib/login-email.ts:176-242`) | relevant to future imports matching Sean's old address, not to whether the address is free |
| SF-28 blob store pin | absent | PRESENT+PINNED, conditional on a well-formed token | token exposure from any deployed build; the token itself is unrotated (SF-16/69) |
| SF-30 CSP `unsafe-inline` | present | **PARTIAL**: the enforced policy still allows inline scripts; the nonce policy is report-only unless `MATFLOW_CSP_ENFORCE` is set | XSS amplifier on the hub pages remains at both candidates |
| SF-33 / 98 / 99 body parsing | absent | PRESENT+PINNED | robustness of routes the operator drives |
| SF-56 / 111 / 113 pool timeout, atomic lockout, rate limit | absent | PRESENT+PINNED (10 s pool timeout; one advisory-locked reservation transaction; batch-transaction rate limit) | login throttling during the release window |
| "the login-email route change in `ab5f928`" | — | **correction:** six lines, `z.object` → `z.strictObject` on the body variants; not subject binding | input strictness only |

Verdict on `2a6487e`: **unsuitable** for this release. Its 9 Oct approval was a feature review on a tree whose revocation, token, recovery and parsing paths were then fixed and reviewed. Historical approval is not current acceptance.

## 3. Candidate `704ab57`: assessment, not approval

What it has: the hub (files byte-identical to the rehearsed `c837e38` apart from the three-line strictness change), the fixes above, every library change independently reviewed (R2–R9), gates recorded (`docs/security/evidence/lead/gates-node24-704ab57.log`: lint 0, tsc 0, audit 0, build, unit 6533/6534). What it lacks: browser acceptance on this exact executable (none has run; the lanes were denied D-10/D-11), and the residuals below.

**Residuals — one recommendation each; the decision column is Noe's. None is pre-accepted.**

| Residual | What it is, precisely | Impact | Recommendation | Owner decision |
|---|---|---|---|---|
| SF-136 (present at `704ab57`; fixed only in unreviewed `1ca92c0`) | when Prisma gives up starting a transaction (`maxWait`), the pooled connection is returned still inside an open transaction; the **next unrelated plain write on that connection** is lost or committed late. Lockout reservations commit in their own transaction, so the per-address cap does not under-count; the only sign-in write found exposed is the refund, which over-counts (safe direction). Any other plain write in the app could be the victim under a saturated pool | a lost write during burst load, non-deterministic, not a lockout weakening; occurs only when the pool is saturated | **ACCEPT for this release** with monitoring (Sentry on the P2028 timer rejection) and the L1 fix reviewed in the next candidate; not shipping `1ca92c0` unreviewed | ☐ accept ☐ fix first ☐ block |
| SF-135 (same) | unhandled rejection from Prisma's timeout timer during bursts; logged, server keeps running; nobody is admitted; the real owner with the right password can be refused "Incorrect email or password" during a burst at their address | availability of sign-in under attack | **ACCEPT** (fails closed) | ☐ |
| SF-30 partial | `unsafe-inline` still enforced; nonce policy report-only | XSS amplification; unchanged from production today | **ACCEPT** for this release; enforce after the report-only window | ☐ |
| SF-05 legacy links | untagged links issued before the release remain valid until expiry (≤ 7 days) | a pre-release invite for the old address can still be used until retired; the workflow retires tokens for both addresses in this club (§6) | **ACCEPT** (retirement in the workflow covers Sean's club) | ☐ |
| Owner login-email route | does not refuse `@no-login.matflow.local` / `@deleted.invalid` as a new owner login; no in-route support-session check (the proxy refuses support sessions for it) | an operator could set a synthetic address by mistake; the proxy is the only support guard | **ACCEPT** with the operator checklist rule "never a synthetic domain"; fix in the next candidate | ☐ |
| SF-62 / 73 / 74 runtime role | production runs as the owner role; RLS is a backstop that the role bypasses; audit rows are editable by the runtime role (SF-57 unapplied) | application-level isolation only; audit not tamper-resistant; **unchanged by this release** | **ACCEPT as unchanged existing exposure for this release**, recorded as such; the SF-62 project and SF-57 remain separate | ☐ |
| SF-15 unprotected `main` | a push deploys and migrates; no ruleset | human error on push | **FIX FIRST** at zero cost: apply the proposed GitHub ruleset (`docs/security/evidence/E2/github-ruleset-main-proposed.json`) or at minimum require a PR for `main` before this release | ☐ |
| SF-19 / 77 recovery | no exported backup has ever succeeded; six-hour history; branch existence unverified | no demonstrated recovery | **BLOCK until §4 is done** | ☐ |
| `AuditLog` index in `20261009010000` | built without `CONCURRENTLY`, no lock timeout | locks `AuditLog` for the build duration; size on production unknown | **FIX-OR-MEASURE**: read the production `AuditLog` row count (Stage 0); if large, rehearse the migration timing on the production-derived branch (§4) before the push | ☐ |
| SF-131..134 | readiness-script hardening (denied lanes) | tooling only | **ACCEPT** | ☐ |
| Rehearsal spec gaps | the repository has no production-mode spec for the hub conflict journey, lost-response replay, allow-list refusal, support-session refusal of the operator plane, step-up expiry/replay, staff recovery-code redemption; the 9 Oct rehearsal used scratchpad drivers | acceptance depends on drivers outside the repo | **FIX in the rehearsal**: run the drivers per the hand-off (§7), record ledgers; promote them to repo specs in a later candidate | ☐ |

Not recommended: `1ca92c0` (unreviewed transaction changes) and anything from the payments branch (separate milestone; its seven migrations must not be expected by any checker run against this release).

## 4. Recovery and migrations — what exists and what is required

- **Six hours** is Neon's history retention on the Free plan, read by Noe from the branch overview on 11 Oct 16:55 UK. It is the point-in-time window, distinct from the lifetime of a retained branch.
- **Recovery branch:** Noe was asked on 11 Oct to create `backup-2026-10-11`; its existence, source branch, creation point and expiry settings are **UNVERIFIED** (never read back). Durability of a branch depends on the project's branch-expiry settings, which must be re-read.
- **Verified recovery** = `docs/runbooks/RESTORE-REHEARSAL-ISOLATED.md` executed on a fresh production-derived branch: §2 pre-checks, §3 branch, §4 integrity counts (per-table counts for a synthetic tenant; real-tenant totals; migration state), §5 isolated production build booted against the branch with every provider dark **at its delivery boundary** (not one flag), §6 RTO/RPO recorded; copied personal data and the branch credentials stay private. Never executed against production; the campaign's drills were in-memory TEST copies.
- **Migration rehearsal** = on that same production-derived branch, run the six migrations with `prisma migrate deploy` from the dedicated `704ab57` checkout against the branch URL (never production), timing each, then boot `e8afb6a`'s build against the migrated branch to show old code tolerates the new schema (additive, nullable), then boot the `704ab57` build. This is the AUTH-gated owner step that a retained branch does not replace.
- **Migrations before build:** the build script runs `prisma migrate deploy` before `next build` when `DATABASE_URL` is set (CR §7). If the build fails after the migrations applied, production's schema is changed while `e8afb6a` keeps serving. Because the six are additive and nullable, old code tolerates that state (to be proven in the rehearsal). The procedure for that state: do not re-push blindly; read `migrate status`; fix forward with a new build of the same SHA; never Instant Rollback or Promote.
- **Snapshot gap:** writes between the snapshot and a restore (attendance, account changes) would be discarded by a restore; define a short change window for the release (no imports, no account changes) and reconcile anything written after the snapshot if a restore is ever needed.

## 5. Deployment approval (A)

Conditions, each with evidence recorded, in order:
- [ ] Targeted rehearsal on `704ab57` PASSED (§7), both database roles, bypass off for the auth flows, ledgers counted for FAIL rows (the drivers do not fail their exit code).
- [ ] Residual decisions in §3 recorded.
- [ ] Stage 0 facts read on production, read-only: `prisma migrate status` applied set; `AuditLog` row count; operator table row for Noe (immutable `Operator.id`).
- [ ] Hub prerequisites: operator authenticator enrolled (secret present on production) **and proven by a fresh challenged login** (pending, Noe); recovery access prepared without sharing codes; `OPERATOR_ALLOWED_IDS` = `cmoudu55l0000qktgw0r0ve2t` **SET in Vercel Production 12 Oct 01:35 UK** (Sensitive; effective at the next deployment); `MATFLOW_ADMIN_SECRET` rotated (pending, Noe — a secret value, never through the agent); `EMAIL_DELIVERY=off` read back; `CRON_SECRET` absent; retention dry-run only if its read-only semantics are confirmed; note that a Vercel variable takes effect only on the next deployment.
- [ ] Provider-side retirement evidence for the old Neon password and Resend key captured (identifiers and timestamps).
- [ ] Recovery and migration rehearsal (§4) done and recorded.
- [x] `main` ruleset: **release-safe subset applied 12 Oct 01:36 UK** (GitHub ruleset id 24901063: no deletion, no force-push, active, no bypass). The proposed pull-request, linear-history and status-check rules are deferred: with no bypass actor they would force a merge commit or rebase, changing the deployed SHA; apply them after this release or with a bypass actor.
- [ ] Immediately before the push: `git fetch` and `git ls-remote origin main` still `e8afb6a`; `git merge-base --is-ancestor e8afb6a 704ab57` true; working tree clean; nothing else pushes.

Then, on Noe's explicit "deploy 704ab57" only: a fast-forward push of exactly `704ab579ed42cef497bc38136982502aca153b75` to `main` from a clean checkout of that SHA (no force; no reset). Watch the build log for the six migration names before `next build`. After READY: `release-verify.mjs --target production --sha 704ab579ed42cef497bc38136982502aca153b75 --expect-migrations local …` **run from the dedicated `704ab57` checkout** (the flag expects every migration in the checkout it runs from — all of them, not six — so a payments checkout would wrongly expect seven more); exact SHA; `/api/health` ok; migrations finished with no failed or in-progress rows; `emailDelivery: off`; legacy transports refused; authenticated operator request succeeds; then a manual console login with the authenticator. Stop before (B) if any check fails; fix forward only.

## 6. Account-change approval (B) — Sean's correction

All 9 Oct details are historical until re-read through the hub after deployment.

**Supported record classes (CR §3).** The member step moves a *member* record's address. It refuses, with a safe stop: staff holders, legacy duplicates (two rows on one address), managed records (AH-R1), and a holder in another club. For a member who can sign in it also signs them out everywhere; for one who cannot, it retires their invite/sign-in/reset links. Which of these Sean's conflicting row is must be read fresh.

**Replacement-address contract (CR §4, code-enforced):** lower-cased and trimmed; unique per club across `User` and `Member` login addresses (`Member.unverifiedEmail` is **not** checked for collisions); must not be the synthesised `@no-login.matflow.local` form for the member step. **Not enforced by code:** plus-aliases and dots are not folded (an alias of Sean's own address is accepted by code and was the 9 Oct plan); deliverability is never checked; "recorded as unverified" is **audit metadata only**, no column. So the rules the owner must apply: an address Sean explicitly accepts, that is not his intended login, not held by anyone in the club, and that he or the club can actually read if the member record ever needs an invite. An alias is permitted by the system; it is the owner's call whether it meets that last rule. Do not invent an address.

**Effects, precisely (CR §5).** Member step: `Member.email` changed; sign-in tokens for the **old and the new** address in this club retired (waiver links kept); if the member could sign in, `sessionVersion` bumped. Owner step: `User.email` changed, `loginEmailProvisionalSince` set, `sessionVersion` +1 exactly, every owner session signed out, tokens for the old address retired. Provisional means sign-in with the new address is allowed and the account is flagged until the owner's next successful sign-in confirms it; it does not prove control of the mailbox, and no verification mail is sent (`EMAIL_DELIVERY=off`). A changed address is a stored-address correction, not mailbox verification.

**Steps.**
1. Fresh facts, read-only: club slug and immutable club id; Sean's immutable `User.id` (`owner-account-state.mjs`, authorised for this step); the intended login address confirmed by voice on the number already held.
2. Hub → Check address: holder kind, name, status, can-sign-in, record id, same club. Another person, staff, duplicates or an unsupported class → stop.
3. Independent identity confirmation that the member row is Sean; a minimal reason, no unnecessary personal data.
4. Replacement address agreed with Sean under the contract above; checked free with Check address.
5. Baseline from the dedicated checkout: private expectations file outside the repository (ignored, deletion time set) and `owner-login-change-check.mjs baseline --tenant <slug> --owner-id <User.id> --member-id <Member.id> --expect-email-file <private> --expect-host ep-bold-wave-abt39t7x --env <env file>` → exit 0.
6. Preview to Noe: which record loses the address, which gains it, the sign-outs and token retirements above, what is preserved. **Approval B is given here, for these exact ids and addresses.**
7. Member step with reason, current version and a fresh action-bound step-up; confirm the persisted result in the panel.
8. Re-check availability; stop on any unexpected state.
9. Owner step with its own fresh step-up (wait for the next code if the authenticator interval has not rolled).
10. Verify: `owner-login-change-check.mjs verify … --path operator --operator-id <Operator.id>` → exit 0 (same ids; owner role; login equals target by keyed digest; provisional set and fresh; password hash, authenticator, recovery codes, `mustChangePassword`, password-history ids unchanged; `sessionVersion` baseline +1; member status, `externalRef`, links unchanged). **Two checks the script does not make** (CR §6), done by read-only SQL with ids only: (a) an `AuditLog` row `admin.login_email.checked` and one `admin.member.contact_email.changed` exist for this club with the operator's id and a `requestId`; (b) if the member could sign in, `Member.sessionVersion` increased by exactly one.
11. Tell Sean by voice to sign in with the new address, his own password and authenticator. Never request either.

**Partial completion:** member change rejected → no owner mutation, show cause, refresh. Member changed, owner unchanged → both states shown; resume the owner step with a fresh grant. Response lost → re-send the same confirmation ("already applied"); never a new unverified mutation. Owner changed, checker failed → changed-but-unverified; read the exact discrepancy before any corrective mutation. Another record takes the address → stop. Sean cannot sign in → diagnose through authorised support; never disable MFA or reset his password as a fix. No automatic reversal of the member step; any reversal is a new preflighted operation.

## 7. Targeted rehearsal — the hand-off

`hub-release-2026-10-12/REHEARSAL-704ab57.md`: build a `704ab57` worktree in production mode with the TEST env (copy of `prod-server.mjs` pointed at the worktree, `CRON_SECRET` blanked), start on a private port under each database role, run the 9 Oct drivers (flows 1–9 plus the lost-response replay) with `E2E_AUTH_BYPASS` unset for the auth flows and `EMAIL_DELIVERY=off`, plus one added step for staff recovery-code redemption; record SHA, build id, role, command, exit code **and the ledger FAIL count** per run; persisted-state checks by SQL on TEST; count-checked cleanup. Coverage table and GAPs are in the hand-off. Route: no supported mechanism exists in this auto-mode session to launch the browser lane (D-10/D-11); a prompting session can, or Noe runs the hand-off himself. Time is an estimate, not a criterion.

## 7a. Rehearsal in progress (supplementary evidence; read-only observation 12 Oct 01:40 UK)
Noe's other session is executing `REHEARSAL-704ab57.md`: dedicated worktree at `704ab57` (its own scratchpad), `npm ci` exit 0, production build exit 0, BUILD_ID `ybjN7xlWP1G5U_5CycljZ`, **Node v25.9.0** (the only Node visible to that session; `package.json` engines `>=24.18.1 <25`, EBADENGINE warnings), `.env.test` pooled TEST hosts, drivers copied from the 9 Oct lane-G set, mail-interceptor positive control PASS (4/0), engineering pass running with `EMAIL_DELIVERY=off`, `E2E_AUTH_BYPASS` blank, `CRON_SECRET` absent, `OPERATOR_ALLOWED_IDS` set to one id. Its run record is `hub-release-2026-10-12/REHEARSAL-704ab57-RUN-2026-10-12.md` (owned by that session; not edited here). Status: **SUPPLEMENTARY** — the required release verification is a fresh production build on the pinned Node 24 of the FINAL candidate (plan step D), with browser evidence matched to that build id. Until that session reports its end marker and cleanup counts, no burst, fault-injection or migration run starts here on the TEST branch.

## 7b. Protected release path (reassessed 12 Oct 01:40 UK)
Repository settings (read): merge commit, rebase and squash all allowed; the CI workflow runs on `pull_request` with the gating job `Typecheck + Lint + Vitest`; `main` carries ruleset 24901063 (no deletion, no force-push). Chosen path: **a pull request from a branch at the candidate, CI green, merged as a merge commit** (no linear-history rule, so the security and payments branches stay ancestors of `main`). The deployed executable is the merge commit; its identity is recorded and its tree must equal the candidate's (`git diff <merge> <candidate>` empty) before `release-verify --sha <merge>`. Tightening the ruleset to require the PR and the status check was refused in auto mode (D-14) and will be put to Noe as a manual-mode prompt with the release packet. No bypass actor; no force-push; nothing weakened.

## 8. Done / pending / blocked

| Item | State | Evidence | Owner |
|---|---|---|---|
| Serving source, ancestry, deltas, migrations content | DONE | §1; CR §7 | coordinator |
| Eleven path-relevant fixes read in final code | DONE, with four corrections | CR §1 | coordinator |
| SF-135/136 characterised precisely | DONE | CR §2 | coordinator |
| Residual recommendations | DONE, decisions PENDING | §3 | Noe |
| Deployed-configuration verification | DONE (names/ages) | §1 | coordinator |
| Provider-side retirement evidence | PENDING | — | Noe |
| Production applied-migration set, `AuditLog` size, `Operator.id` | DONE 12 Oct 01:33 UK (read-only, owner-approved) | §1 | coordinator |
| Recovery branch existence/expiry; verified recovery; migration rehearsal | PENDING | §4 | Noe |
| Targeted rehearsal on `704ab57` | BLOCKED here (no launch mechanism); hand-off ready | §7 | prompting session or Noe |
| Hub prerequisites (MFA proven, allow-list, admin secret, mail off) | PENDING | §5 | Noe |
| `main` ruleset | DONE (subset: deletion + non-fast-forward; PR/status rules deferred) | §5 | coordinator |
| Deployment approval A | NOT REQUESTED yet | §5 | Noe |
| Sean's fresh facts, replacement address, baseline, preview | PENDING (after deployment) | §6 | Noe + Sean |
| Account-change approval B | NOT REQUESTED yet | §6 | Noe |

**Verdicts.** Candidate: `704ab57` is the right candidate to assess; it is NOT approved. Deployment: NOT READY (rehearsal, recovery, prerequisites, residual decisions outstanding). Account correction: NOT READY (depends on deployment; workflow fully specified). Campaign: INCOMPLETE and unchanged by this milestone; isolation, audit protection, payment and operational risks stay recorded as open.

**Next owner action:** arrange the targeted rehearsal on `704ab57` (hand-off in §7) and return the §3 residual decisions. Not a push.
