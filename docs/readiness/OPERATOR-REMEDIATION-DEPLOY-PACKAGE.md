# Operator remediation — deployment and rollback package (6 Oct 2026)

**Status: prepared, NOT deployed, NOT authorised.** Production is `e8afb6a` (Vercel Production, 4 Oct). Nothing in this
package has been run against production. Deploying it is Noe's decision; this file is what that decision needs.

Findings register and evidence: `docs/readiness/OPERATOR-ADMIN-SECURITY-2026-10-05.md` §Remediation register.

## 1. What ships

| Item | Detail |
|---|---|
| Commits | `64c2657`, `8fb151a`, `d92435a` (already local) + the remediation commit(s) listed in §9 |
| Migrations (auto-applied by the build — `scripts/maybe-migrate.mjs`) | `20261006010000_operator_auth_hardening`, `20261006020000_tenant_lifecycle_safety`, `20261006040000_support_session_binding`, `20261006050000_operator_enrolment_ticket` — all **additive, nullable columns, no defaults, no backfill**; safe on a live database and tolerated by the old code |
| Required env changes to deploy | **None.** `MATFLOW_ADMIN_SECRET` is no longer required at boot. `ALLOW_ADMIN_SECRET_HEADER=0` (added 5 Oct) becomes irrelevant. |
| Behaviour that changes on deploy | every operator is signed out (new session format); every live support session ends; the shared secret grants nothing; operators must have an authenticator (a new or recovered operator enrols only with a one-time ticket from `scripts/operator-access.mjs`); Danger Zone actions (reset, 2FA reset, transfer, soft-delete, suspend) and support start need a fresh authenticator code; support ("View as … (read-only)") is read-only for 30 min; suspension no longer touches member billing; restore/purge are serialised; high-impact audit rows commit with the change; sign-in records are written for every sign-in (not only when the notification flag is on) and kept 12 months; new temporary passwords expire after 72 h |

## 2. Decisions Noe must make before deploying

1. **Legacy temporary-password deadline: 20 Oct 2026 23:59 UTC** (`lib/temp-password.ts` `LEGACY_TEMP_PASSWORD_DEADLINE`). It
   applies to Sean's outstanding bootstrap password. If Sean has not signed in by then, the operator issues a new one
   (Reset password, step-up code). Change the date in code if you want a different one. Recommendation: keep it.
2. **Suspension no longer cancels member subscriptions** (`docs/runbooks/SUSPENSION-BILLING-POLICY.md`). Recommendation: keep.
3. **Audit retention: operator, support-session and erasure records kept 6 years** — the privacy page §6 says "Audit logs —
   twelve months". Either update the page (recommended) or change `auditLogRetentionWhere`.
4. **Restore needs no step-up** (non-destructive, recovery path). Recommendation: keep.
5. **Privacy page: sign-in records.** Sign-in records (approximate IP, browser/device summary, first/last seen) are now
   written for every sign-in and kept 12 months after the device was last used. The page does not mention them. Proposed
   wording — §1: "Sign-in records: for each device you sign in from, an approximate IP address, a browser and device
   summary, and when it was first and last used. We keep them to protect accounts and to confirm that an account was
   activated by its owner." §6: "Sign-in records — deleted twelve months after the device was last used."
6. **How Sean's activation will read.** Because his account was created and reset by an operator, the readiness script
   will say "ACTIVATED AFTER OPERATOR RESET — confirm with the owner" even after he activates himself. That is deliberate:
   close it by asking Sean on a channel you verified yourself (phone or in person) whether he chose his own password and
   scanned the QR code on his own phone, and record who confirmed, how and when.

## 3. Before the deploy (read-only, in this order)

- [ ] **Operator access exists.** On the CURRENT production build, sign in at `/admin/login` → *Account* tab with your operator
      email + password. If it asks for an authenticator code, you are enrolled — good. If it does not, enrol now at
      `/admin/security` (the current build allows it without a ticket). Sign out and back in with the code to prove it.
      **Without this, the deploy locks you out** until you run `operator-access.mjs recover` against production.
- [ ] **Old deployments still carry the old secret — close them first.** Vercel keeps every earlier deployment reachable
      at its own `*.vercel.app` URL with the environment it was BUILT with, so every pre-remediation deployment accepts
      the current `MATFLOW_ADMIN_SECRET` against the production database, today and after this deploy. Rotating the
      variable does not reach them. Do both:
      1. Vercel → Settings → **Deployment Protection**: Vercel Authentication on, scope **Standard Protection** (all
         deployment URLs except the production domain). Record the setting.
      2. Vercel → Deployments: delete the older production deployments you will never roll back to (keep `e8afb6a`'s only
         if you want it as a reference — it is protected by step 1).
- [ ] **Rotate `MATFLOW_ADMIN_SECRET`** in Vercel Production to a fresh random value nobody knows (do not store it). Reason:
      any NEW build of old code (see §6) then reads a secret nobody holds.
- [ ] **Retention dry-run** (restore-vs-purge race is live today): `GET https://matflow.studio/api/cron/retention?dryRun=1`
      with `Authorization: Bearer <CRON_SECRET>`. Record `wouldPurge`. If any club is listed, deploy before 03:30 UTC or do
      not restore that club until deployed.
- [ ] Optional, recorded for the register: runtime DB role (`docs/runbooks/RUNTIME-DB-ROLE-CHECK.md` §1) and the E-2
      cross-club class-link detection SQL (§4).

## 4. Deploy

`git push origin main` → Vercel builds, applies the four migrations, deploys. Watch the build log for
`[build] DATABASE_URL set — running prisma migrate deploy` and four applied migrations.

## 5. Smoke checks after deploy (production, no customer data touched)

| # | Check | Expected |
|---|---|---|
| 1 | `GET /api/health` | 200 |
| 2 | `/admin/login` → password + authenticator code | console loads |
| 3 | `/admin/login` has no *Bootstrap* tab | absent |
| 4 | `curl -X POST /api/admin/auth/login` (any body) | 403 |
| 5 | `curl /api/admin/activity -H "x-admin-secret: <old value>"` | refused (401 or 403), no data |
| 6 | Iron Path (demo) → Danger Zone → *Suspend*: open the dialog, check it asks for a code, then **cancel** | code field present |
| 7 | `node scripts/readiness/owner-account-state.mjs` for Total BJJ (read-only, as before) | still PENDING; not ACTIVATED |
| 8 | Vercel → Deployments → the new deployment's SHA matches the pushed HEAD | match |
| 9 | An OLD deployment URL (`https://<old>.vercel.app/api/admin/activity`), no Vercel login, with `x-admin-secret: <old value>` | Vercel login wall (401/redirect), never JSON data |

Do **not** reset, impersonate, suspend or delete anything on Total BJJ as a smoke test.

## 6. Rollback

**Never use Vercel Instant Rollback or "Promote" to an old deployment.** A promoted deployment keeps the environment it was
built with — the OLD, known `MATFLOW_ADMIN_SECRET` and no `ALLOW_ADMIN_SECRET_HEADER` — so it silently reopens the
shared-secret door.

**Preferred fallback: fix forward.** Every finding here was fixed in small, separately tested changes; a problem in one
area is cheaper to correct than a rollback that reopens all of them.

**If you must run the old code:** build it fresh so it reads the CURRENT (rotated, unknown) secret —
`git revert --no-edit <remediation commits>` and push, or deploy a checkout of `e8afb6a` with `vercel deploy --prod`.
Migrations stay: rehearsed on the test branch 6 Oct — `e8afb6a`'s `prisma migrate deploy` with the four new migrations
already applied exits 0 ("No pending migrations to apply", "Database schema is up to date").

While the old code runs, these are reopened; operate around them until you deploy forward again:

| Reopened | Operational fallback |
|---|---|
| Shared secret | Closed only if §3 rotation was done AND the old code was rebuilt (not promoted). |
| Optional operator MFA; password-only enrolment | Do not create or recover operators; keep using your enrolled operator. |
| No step-up; unrestricted impersonation ("Login as owner" can write) | Do not use Danger Zone actions or "Login as owner". |
| Best-effort audit | If a Danger Zone action is unavoidable, record it manually (who, what, when, why). |
| Restore-vs-purge race | Do not restore any soft-deleted club; read the retention dry-run before 03:30 UTC. |
| Cross-club leaks in classes (dry-run subscriber ids, foreign belt/coach links) and the belt-holder count | Accept for the window; any club owner could read another club's subscriber ids via the dry-run API. Keep the window short. |
| Temporary passwords do not expire (incl. the 20 Oct legacy deadline) | Note any reset you issue; re-issue after re-deploying forward. |
| Operator TOTP setup CSRF; support fail-open on DB error | Do not use support access. |
| Sign-in records gated by the notification flag | The activation verdict cannot read ACTIVATED for sign-ins during the window; confirm with the owner directly. |

After any change of code version, operators sign in again (the session formats differ).

## 7. Still open after this deploy (not fixed by it)

- **BACKUP UNVERIFIED.** `db-backup.yml` fixed (PostgreSQL 17 client, integrity check) but never run; 0/5 secrets set.
  `docs/runbooks/BACKUP-SECRETS-SETUP.md`. Neon point-in-time window unverified. No isolated restore executed
  (`docs/runbooks/RESTORE-REHEARSAL-ISOLATED.md`). The system is not "fully ready" until a backup and an isolated restore exist.
- **Runtime DB role unknown** (very likely `neondb_owner`, BYPASSRLS → RLS inert). Switch plan in RUNTIME-DB-ROLE-CHECK.md.
- Repo Playwright specs still assume the shared secret / 60-min writable impersonation (register #31). The behaviour itself
  was verified with a dedicated production-mode browser run (both database roles); the old specs will fail until updated.
- No owner notification on reset / 2FA reset / support start (Medium, not in this remediation).
- Stripe webhooks still email members of suspended clubs; tenant status only re-checked at sign-in (Low).

## 8. Evidence index

Committed with this package: `docs/readiness/operator-remediation-2026-10-06/` — the working register (every finding with
lane, evidence and next action), the support-access inventory (174 handlers), every independent review verdict and the
browser E2E ledger summaries. Raw browser ledgers and screenshots stayed in the session scratchpad (they contain synthetic
fixtures only, but are bulky); their summaries are committed.

## 9. Commits and tested builds

| What | Identity |
|---|---|
| Deployed production | `e8afb6a` (4 Oct 2026) |
| Already local before this work | `64c2657`, `8fb151a`, `d92435a` |
| Remediation | `2203087` + the documentation/evidence commit that adds this section |
| Unit (379 files / 4,160 tests), typecheck, lint, production build | run on the tree committed as `2203087` |
| Browser E2E, flows 1, 2, 5, 7, 8 | build of d92435a + uncommitted diff `cc380295…` (post lane H), `e2e/final` |
| Browser E2E, flows 3, 4, 6 (all variants), 9, suspend-on-deleted | build of d92435a + uncommitted diff `6751164e…` (post lane J, 119 files), `e2e/final3` |
| Never run in a browser | the last lead edits: magic-link sign-in record, approve-route log line, LoginEvent retention comment (unit-tested only) |
