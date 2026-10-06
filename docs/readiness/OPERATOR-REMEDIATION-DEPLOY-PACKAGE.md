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
- [ ] **Rotate `MATFLOW_ADMIN_SECRET`** in Vercel Production to a fresh random value nobody knows (do not store it). Reason:
      an application rollback to `e8afb6a` would reopen the shared-secret door; a secret nobody holds keeps it shut.
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

Do **not** reset, impersonate, suspend or delete anything on Total BJJ as a smoke test.

## 6. Rollback

Vercel → Deployments → promote the previous production deployment (`e8afb6a`). Migrations stay (additive; the old code
ignores the new columns). While rolled back, the old code reopens four doors — operate around them until re-deployed:

| Reopened | Operational fallback |
|---|---|
| Shared secret | Closed in practice if §3 rotation was done (nobody knows the value). If it was not done, rotate now. |
| Restore-vs-purge race | Do not restore any soft-deleted club; read the retention dry-run before 03:30 UTC. |
| Unrestricted impersonation | Do not use "Login as owner". |
| Best-effort audit | Avoid Danger Zone actions; if one is essential, record it manually. |

After a rollback, operators sign in again (the old code does not accept the new session format).

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

Scratchpad (local, not in repo): lane reports, independent reviews (C, E+F, A+B+D, H), browser E2E evidence.
Repo tests added in this remediation are listed in the security document's register.

## 9. Commits

Filled in at commit time.
