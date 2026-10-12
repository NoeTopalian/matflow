# Release packet — hub release, candidate `512d5e8` (prepared 12 Oct 2026 09:20 UK)

Purpose: one reviewable packet for approval (A), the deployment of exactly one executable so that Noe can correct Sean's owner login email through the admin hub. Approval (B), the account change, is separate and comes after the post-deployment checks. Nothing in this packet is executed by its existence. Items marked **NOE** are not done and are his; the packet is not complete until every one of them has evidence.

## 1. Candidate identity and review

| Item | Value |
|---|---|
| Executable | `512d5e8d622f0a9cf514d1f5b5663e4e07c8939e` on `security/assurance-2026-10` |
| What it is | `704ab57` (hub + reviewed security fixes) + `1ca92c0` (L1 transaction bounds) + L2 fixes `3e6dd26`, `0bbf0a1`, `2c6bd4c`, `38f8295` + test commit `512d5e8` |
| Independent review | R10 pass 1 (static) and pass 2 (database, both roles) on `1ca92c0`: APPROVED WITH RESIDUALS, not releasable alone (R10-1); R10 review of the L2 delta at `512d5e8`: **APPROVED WITH RESIDUALS**, R10-1..R10-5 CLOSED; evidence `docs/security/evidence/R10/` |
| Gates on `512d5e8` | lint 0 · `npm audit --omit=dev` 0 · unit 481 files, 6599 passed, 1 skipped · tsc 0 · isolated build `XEFPlYyNsQ5F-CB6DKMKc` · tree secret scan 8 pre-existing candidates outside the delta (`docs/security/evidence/lead/gates-node24-512d5e8.log`) |
| Hub rehearsal on this executable | run 3, Node 24.21.0 (binary matches SHASUMS), fresh `npm ci` (pg 8.20.0, pg-pool 3.13.0 confirmed), build `-VI8m-f5fjlPib2_etBjA`, TEST branch, both roles: **every journey PASS** (`REHEARSAL-512d5e8-RUN3-NODE24-2026-10-12.md`, commit `8768afb`) |
| Earlier evidence retained | run 2 on `704ab57` (same hub code; `REHEARSAL-704ab57-RUN2-NODE24-2026-10-12.md`); the first attempt's failures classified (`CR-REPORT.md`, RD) |

## 2. Complete delta from the serving source

Serving: `e8afb6a` on `main` (Vercel deployment `lxxo23g4i`, VERIFIED by API). `e8afb6a..512d5e8`: the operator remediation (6–7 Oct), the admin-hub conflict workflow (9 Oct), security campaign iterations 1 and 2, the L1/L2 transaction work, and documentation. Counts to be printed at approval time from a clean checkout (`git rev-list --count e8afb6a..512d5e8`, `git diff --shortstat`). Runtime files beyond the hub and campaign: `package.json` now pins `pg` 8.20.0 exactly and overrides `pg-pool` 3.13.0 (lockfile root spec only).

## 3. Migrations (six, all absent from production; VERIFIED read-only 12 Oct 01:33 UK: 95 applied, these six missing, 0 failed/in-progress, one historic row named `.20260503200000_activate_rls_enforcement.skip` in `_prisma_migrations` (CORRECTED 12 Oct 11:25 UK: it is a ledger ROW with no matching folder in the checkout, counted inside the 95 — so 94 real migrations plus this row; its disposition: leave it, it is finished and not rolled back, and `prisma migrate deploy` ignores rows without a local folder; `migrate status` will list it as applied-but-missing-locally); checksum state of the applied set to be confirmed by `prisma migrate status` output in the rehearsal of §5)

`20261006010000_operator_auth_hardening` · `20261006020000_tenant_lifecycle_safety` · `20261006040000_support_session_binding` · `20261006050000_operator_enrolment_ticket` · `20261007010000_login_email_provisional` · `20261009010000_audit_operator_request`. Content (CR §7): nullable columns without defaults, one index and one foreign key on `AuditLog` (120 rows on production), no backfill, no NOT NULL, no drop or rename, each wrapped in BEGIN/COMMIT. They run inside the Vercel build before `next build` when `DATABASE_URL` is set. No campaign migration (SF-57, SF-62) and no payments-branch migration is included.

## 4. Configuration requirements and effective times

| Variable (Vercel Production) | Required state | Evidence / status |
|---|---|---|
| `DATABASE_URL` | rotated 11 Oct 16:58 UK; direct host | VERIFIED (age); serving build reads it |
| `RESEND_API_KEY` | rotated 11 Oct 15:40 UK, Production only | VERIFIED |
| `EMAIL_DELIVERY` | `off` | value last read back 9 Oct; **NOE** re-read before approval |
| `OPERATOR_ALLOWED_IDS` | `cmoudu55l0000qktgw0r0ve2t` | SET 12 Oct 01:35 UK; takes effect at the next deployment (this one) |
| `MATFLOW_ADMIN_SECRET` | rotated to a fresh value | **NOE** (53 days old); effective at the next deployment; old builds keep the old value until retired |
| `CRON_SECRET` | absent | VERIFIED absent; retention stays disabled; reconcile cron is not in this candidate's `vercel.json` |
| `STRIPE_SECRET_KEY` | hygiene roll prepared, optional for this release | not required; no live Stripe |
| Preview environment | no production secrets; no `DATABASE_URL` | Preview copies of shared secrets remain (containment step 8); see §7 on preview deployments |

## 5. Recovery and migration rehearsal (NOE; required before approval)

Facts: Neon Free plan, history retention **6 hours** (point-in-time window); no exported backup has ever succeeded; a branch is a durable restore point that outlives the window only if branch-expiry settings allow; the restore runbook has never been executed against production data.

**Two branches, two purposes (CORRECTED 12 Oct 11:25 UK).** The restore point must never be migrated or booted against, otherwise it stops being a copy of production. So: (i) **`rehearsal-hub-512`** — created from production for the rehearsal below, migrated, booted, then DELETED within 24 hours (it holds a copy of personal data and inherits production's role passwords: treat its connection string as a production secret); (ii) **`pre-hub-release`** — created from production immediately before the MERGE to `main` (the merge is what deploys and migrates production; pushing the release branch does not), left untouched as the restore point, kept until the release is verified and Sean's correction is complete. Wherever steps 1–4 below say `pre-hub-release`, read `rehearsal-hub-512`. Authorisation first (runbook §1, AUTH items): who runs it on which machine, the 24-hour deletion deadline, that the person holds the branch connection string, and that no production configuration changes. Side-effect protection (runbook §5): a fresh worktree with no `.env*`; every provider dark at its boundary (invalid Stripe and Resend keys, no Blob token, no Sentry DSN, no `CRON_SECRET`, `TESTING_MODE=false`); fresh `AUTH_SECRET`/`NEXTAUTH_SECRET` so no production token is valid; `MAINTENANCE_MODE=true` for the first boot; bound to `127.0.0.1`; a host guard refusing `ep-bold-wave` and `ep-hidden-salad` hosts; the branch URL outside the repository. Expected `migrate status` on the fresh branch: 94 applied plus the historic `.skip` row, and 6 pending.

Required, in order, with results pasted into this packet:
1. Neon → production branch → Branches → create `rehearsal-hub-512` (data as of now). (`pre-hub-release` is created later, just before the merge, and is never migrated or booted against.) Record creation time and the project's branch-expiry setting. If `backup-2026-10-11` exists, record it; it is from before the credential rotation and is not the release restore point.
2. Read-only on the branch: `docs/runbooks/RESTORE-REHEARSAL-ISOLATED.md` §2 and §4 (per-table counts for a synthetic tenant; real-tenant totals; `prisma migrate status` against the BRANCH URL from a `512d5e8` checkout — expect 95 applied + 6 pending; note any checksum warning).
3. Migration rehearsal on the branch: from the `512d5e8` checkout, `DATABASE_URL=<branch url> npx prisma migrate deploy` (branch only; never production), timing each of the six; then read `pg_stat_activity`/locks during the `AuditLog` index build if it takes longer than a second (120 rows: expected instant, but observe rather than assume).
4. Compatibility: boot `e8afb6a`'s build against the migrated branch (old code on new schema) and exercise sign-in, a member page and the operator console; then boot the `512d5e8` build against it (runbook §5, every provider dark at its boundary: `EMAIL_DELIVERY=off`, no Stripe live key, no `CRON_SECRET`, no blob token or a dummy one). Record both boots.
5. Record RTO (time from decision to a serving isolated build on the branch), RPO (snapshot time), and the reconciliation rule for writes made after the snapshot (attendance, account changes during the release window: define a 30-minute change window with no imports and no account changes).
6. Copied personal data and branch credentials stay in private files outside the repository; delete the branch connection string after the rehearsal; never paste it.

Failure state defined: if the production build fails after `prisma migrate deploy` succeeded, the schema carries the six additive, nullable changes while `e8afb6a` keeps serving; step 4 proves old code tolerates that; the response is fix-forward (a new build of the same SHA), never Instant Rollback or Promote (both restore retired secrets and old configuration).

## 6. Remaining risks and owner decisions (each needs a tick; none is pre-accepted)

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
| Runtime role `neondb_owner`, RLS as backstop only, audit rows editable (SF-62/73/74, SF-57) | NOT an acceptance: record as existing exposure unchanged by this release, with a dated remediation plan (the SF-62 restricted-role project and SF-57 audit protection); the owner sets the review date | ☐ |
| Environmental revocation-check `unknown` verdicts under load on TEST (P2028 earlier; connection timeouts now) | not a candidate defect; production has a different pool/latency profile; monitored via Sentry after release | ☐ |
| `main` PR + status-check protection not yet applied (D-14) | apply at approval time (manual mode) | ☐ |

**Rows added 12 Oct 11:25 UK (were missing from this table; found by the assurance lanes):**

| Risk | Recommendation | Decision |
|---|---|---|
| Owner login-email route does not refuse the synthetic `@no-login.matflow.local` / `@deleted.invalid` domains as a new owner login, and has no in-route support-session check (the proxy refuses support sessions on `/api/admin/*`, `proxy.ts:307-321`); version bound at code entry (SF-09) | ACCEPT with an operator checklist rule ("never a synthetic domain"; Sean asked not to change his own address during the window); fix in the next candidate. **Touches Sean's correction**: a typing error the code will not catch | ☐ |
| SF-118 / SF-119 / SF-59 burst availability: a burst at one address can refuse the real owner as "Incorrect email or password" after ~13 s; a saturated pool refuses other security buckets on that instance | ACCEPT (fails closed; nobody admitted); fix in a later candidate (stop holding a connection while waiting; correct the message) | ☐ |
| SF-90 member second-factor codes are not single-use | ACCEPT (existing; members only; needs interception); schedule the fix | ☐ |
| Old Vercel deployments with old secrets (SF-10, C5) still accept the legacy operator secret behind Vercel SSO | ACCEPT until release verification, then delete them through the separately authorised procedure | ☐ |
| SF-131..134 readiness-script hardening (lane denied, D-8) | ACCEPT (tooling only) | ☐ |
| Hub journeys proven by scratchpad drivers, not repository specs | ACCEPT for this release; promote the drivers to repository specs later | ☐ |

**Items that need evidence before you decide (not risks to accept):** provider-side revocation of the leaked Neon password and Resend key (section 9 of ITERATION-2-REPORT; ASSURANCE-Q01-13 Q6); the names of `ENABLE_GOOGLE_OAUTH`, `MATFLOW_CSP_ENFORCE`, `LOGIN_THROTTLE_ENABLED` in Production; whether the production demo club was seeded with the committed demo password (SF-109); production compute size and connection limit; one Sentry test event received from production.

## 7. Protected release procedure (executed only on Noe's explicit "deploy 512d5e8")

1. Manual mode on. Coordinator re-reads: `git ls-remote origin main` = `e8afb6a`; `git merge-base --is-ancestor e8afb6a 512d5e8` true; tree clean; every §4–§6 box ticked with evidence.
2. Vercel Git settings decision (**NOE**): pushing a release branch creates a **preview deployment** by default (no `DATABASE_URL` in Preview, so no migration; but a live URL of `512d5e8` with the Preview environment). Recommended: disable automatic preview deployments for this push (Vercel → Project → Git → Preview deployments off, or an "Ignored Build Step" for non-main), re-enable afterwards; alternative: accept the preview and delete it after the merge.
3. (Order corrected 12 Oct 13:10 UK: this step runs AFTER step 4's pull request shows CI green and BEFORE the merge.) Tighten ruleset 24901063 to require a pull request and the `Typecheck + Lint + Vitest` check (no linear-history rule; no bypass actor) — manual-mode prompt (D-14). Then create the `pre-hub-release` restore-point branch from production (section 5 (ii)) and open the 30-minute change window, then merge.
4. From a clean checkout: `git branch release/hub-512d5e8 512d5e8`; push that branch; open the PR to `main`; CI must be green; merge with **"Create a merge commit"**. Record the merge SHA `M`. Verify `git diff M 512d5e8` is empty (tree identity) — the deployed executable is `M` with `512d5e8`'s tree.
5. Vercel builds `main` at `M`: watch the build log for the six migration names before `next build`. If the build fails after migrations: §5 failure state; fix forward.
6. Post-deployment checks (all must pass before approval B): Vercel deployment `meta.githubCommitSha` = `M` and READY; `release-verify.mjs --target production --sha M --base-url https://matflow.studio --tenant totalbjj --env-file-for-migrations .env --expect-host ep-bold-wave-abt39t7x --expect-migrations local --expect-operator-login --operator-session-file <private>` run **from the `512d5e8` checkout** → exit 0 (health ok; every migration finished, none failed or in progress; `emailDelivery: off`; legacy transports refused with the app's 401/403 JSON; authenticated operator request succeeds); `release-stage0-readonly.mjs .env ep-bold-wave-abt39t7x` shows 0 missing, 0 problem rows; Noe signs in to `/admin/login` with his authenticator and opens Total BJJ in the hub; Sentry shows no new unhandled rejection class in the first 30 minutes. Stop before (B) on any failure.
7. Retire obsolete deployments only through the separately authorised procedure; credential revocation remains independent of deployment deletion.

## 8. Approval (B) — pointer

`HUB-RELEASE-DECISION-2026-10-12.md` §6: fresh facts through the hub, identity confirmation, the replacement contact address under the code contract (unique per club across User and Member; not the synthesised domain; aliases are permitted by code, the owner decides; deliverability unchecked; "unverified" is audit metadata), private baseline from the `512d5e8` checkout with `--baseline-dir`, preview of the two changes, then the two-step workflow with its own step-ups, `verify --path operator`, the two read-only SQL checks the script omits, and Sean's own sign-in.
