# MatFlow — Operational Runbook

> Single source of truth for "production broke at 2am, what now." Pair with
> `docs/RELEASE-PLAN-2026-05-03.md` for release-readiness context.

---

## Quick reference

| Surface | URL / location |
|---|---|
| Production | https://matflow.studio |
| Vercel project | https://vercel.com/dashboard → MatFlow |
| Database (Neon) | https://console.neon.tech |
| Stripe dashboard | https://dashboard.stripe.com |
| Resend (email) | https://resend.com/emails |
| Sentry (errors) | https://sentry.io (after `SENTRY_DSN` is set) |
| GitHub repo | https://github.com/NoeTopalian/matflow |
| Health probe | https://matflow.studio/api/health |
| Stripe Connect health | https://matflow.studio/api/stripe/connect/health (owner-only) |

---

## Incident response — first 5 minutes

1. **Triage.** Hit `/api/health` first. If it returns `{status:"degraded"}`, DB is down. Otherwise app is up — narrow to a specific surface.
2. **Check Vercel deploys.** Did a deploy land in the last hour? If yes, that's your suspect — rollback (see below) before deeper investigation.
3. **Check Sentry.** What's the most recent error event? What route + user-agent + tenant? Use the `x-request-id` from response headers to correlate logs.
4. **Check Vercel logs.** Filter by route and look for `[rate-limit]`, `[env-guards]`, or `[auth]` warnings.
5. **Confirm scope.** Is it one tenant, all tenants, or just one user? Different scope = different fix.

---

## Common scenarios

### "Site is down — Vercel returns 500/503 from every route"

Likely causes (in order):
- **Recent deploy broke something.** Roll back: Vercel dashboard → Deployments → find last good deploy → ⋮ menu → Promote to Production.
- **DB is unreachable.** `/api/health` returns 503. Check Neon dashboard for incidents.
- **Required env var missing.** `instrumentation.ts` runs `runProductionEnvGuards()` at boot which throws if `RESEND_API_KEY` / `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_CLIENT_ID` / `MATFLOW_ADMIN_SECRET` is missing in production. Set the missing var in Vercel → Settings → Environment Variables → Save → no redeploy needed.

### "Owners can't log in"

- **TOTP gate misfiring?** Check `TESTING_MODE` in Vercel env. If `false`, mandatory 2FA is on; owners without enrolled TOTP get pinned to `/login/totp/setup`. If they've lost their authenticator, send them to `/login/totp/recover` with a recovery code.
- **Rate-limited?** `lib/rate-limit.ts` now logs every hit as `[rate-limit] bucket=login:... exceeded`. Search Vercel logs. Reset for a specific user: connect to DB, `DELETE FROM "RateLimitHit" WHERE bucket LIKE 'login:tenantSlug:user@email%';`.
- **Cookie/session corruption?** Tell the user to open an incognito tab. If that works, JWT was stale.

### "Members can't pay / subscriptions silently fail"

- **`/api/stripe/connect/health`** as owner — must return `ready: true`. If not, the `nextSteps` array tells you exactly which env var is missing or which Stripe account-status is blocking.
- **Webhook events not arriving?** Stripe dashboard → Developers → Webhooks → click the endpoint → "Webhook attempts" tab. If they're 401/307, fix the auth on the receiving route. The webhook is in `proxy.ts` `PUBLIC_PREFIXES`.
- **Webhook events arriving but signature rejected?** `STRIPE_WEBHOOK_SECRET` mismatch. Copy the current value from Stripe dashboard → Webhooks → click endpoint → "Signing secret" → reveal → paste into Vercel env.

### "Password resets / magic links not sending"

- `RESEND_API_KEY` not set in Vercel — `/api/auth/forgot-password` 503s explicitly per `lib/env-url.ts` pattern.
- Resend dashboard → Logs — confirm the email was at least attempted. If the email is in "delivered" state but the user reports nothing, check spam.
- Check Resend webhook is firing (we ingest delivery + bounce events).

### "Cross-tenant data leak suspected"

This is the worst-case for a multi-tenant SaaS. Stop, don't poke around — preserve evidence first.

1. **Confirm the leak.** Can a member of tenant A see data from tenant B in their UI or via direct API call?
2. **Snapshot the DB.** Run an ad-hoc backup (workflow_dispatch on `db-backup.yml`).
3. **Disable signups.** Set `MAINTENANCE_MODE=true` in Vercel env if needed (returns 503 from all but `/api/health` + `/api/auth` + `/login`).
4. **Find the bad query.** Check the API route the user was on. Look for missing `WHERE tenantId = X` or missing `withTenantContext()` wrapper. RLS policies (when activated — see release plan Phase 0.3) are the long-term backstop.
5. **Notify affected tenants** if data was actually viewed/modified. UK GDPR mandates notification of supervisory authority within 72 hours of becoming aware of a personal-data breach.

---

## Deploy / rollback

### Roll back to last known-good
Vercel dashboard → Deployments → last good deploy → ⋮ → Promote to Production. Takes ~30s.

### Roll forward (fix-forward)
```bash
git revert <bad-sha>
git push origin main
```
Vercel auto-deploys the revert commit. Faster than rollback if you're already mid-fix.

### Maintenance mode (planned downtime)
Vercel → Settings → Environment Variables → add `MAINTENANCE_MODE=true` → Save. Propagates within ~30s without redeploy. To exit, set it to `false` (or delete the var).

---

## Backups

Logical pg_dump runs **Sundays 03:00 UTC** via `.github/workflows/db-backup.yml` once these 4 secrets are set in GitHub repo settings:

- `DATABASE_URL_DIRECT` — non-pooled Postgres URL (pg_dump can't use pgbouncer)
- `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` — IAM user with `s3:PutObject` on the bucket
- `BACKUP_S3_BUCKET` — bucket name (e.g. `matflow-db-backups`)
- `BACKUP_S3_REGION` — region (e.g. `eu-west-2`)

Until those are set, the workflow's `validate-secrets` step fails loudly every Sunday — that's the intentional "you have no backups" signal. Add the secrets to silence it.

### Manual restore drill
```bash
# Pull dump from S3
aws s3 cp s3://matflow-db-backups/<stamp>/matflow-db.dump .

# Restore to a fresh Neon branch (NEVER restore over production)
pg_restore --no-owner --no-privileges --dbname=$NEON_BRANCH_URL matflow-db.dump

# Smoke test the restored DB by pointing a Vercel preview at it
```

Schedule a manual restore drill **once per quarter** to confirm backups actually work. Log results in `docs/RESTORE-DRILL.md`.

---

## Required production env vars

Hard-failed at boot by `lib/env-guards.ts` (instrumentation.ts):

| Var | Why required | Where to get it |
|---|---|---|
| `DATABASE_URL` | DB | Neon dashboard. Append `?pgbouncer=true&connection_limit=1` for serverless. |
| `NEXTAUTH_SECRET` | Auth signing | `openssl rand -base64 32` |
| `RESEND_API_KEY` | Email | resend.com → API Keys |
| `STRIPE_SECRET_KEY` | Stripe API | dashboard.stripe.com → API keys (sk_live_…) |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature | Stripe dashboard → Webhooks → click endpoint → reveal signing secret (whsec_…) |
| `STRIPE_CLIENT_ID` | Connect OAuth | Stripe dashboard → Connect → Settings → OAuth → Live client ID (ca_…) |
| `MATFLOW_ADMIN_SECRET` | Tenant bootstrap | `openssl rand -hex 32` |
| `NEXTAUTH_URL` | OAuth redirect base | Exactly `https://matflow.studio` (no trailing slash, no whitespace) |

Warn-but-allow at boot:

| Var | Effect if unset |
|---|---|
| `SENTRY_DSN` | Errors won't ship to Sentry; Vercel logs only |

Operational toggles:

| Var | Effect when `true` |
|---|---|
| `MAINTENANCE_MODE` | All routes return 503 except `/api/health`, `/api/auth`, `/login`, `/_next` |
| `TESTING_MODE` | Bypasses mandatory owner 2FA. **Do not leave on for paying customers.** |
| `DEMO_MODE` | Hard-blocked in production by `auth.ts` runtime guard. Throws at boot if set. |

---

## Monitoring setup checklist

Items needing your dashboard hands (not committable from code):

- [ ] **Sentry**: create project → copy DSN → set `SENTRY_DSN` in Vercel production env. Trigger a test error to confirm.
- [ ] **Uptime monitor** (UptimeRobot or BetterStack): poll `https://matflow.studio/api/health` once a minute, alert on 503 or non-200 response.
- [ ] **Vercel deploy notifications**: Project → Settings → Notifications → enable email/Slack on failed deploys.
- [ ] **Stripe webhook delivery alerts**: dashboard.stripe.com → Webhooks → endpoint → Notifications → email me on repeated failures.
- [ ] **Backup secrets in GitHub**: Settings → Secrets and variables → Actions → add the 4 backup secrets listed above.
- [ ] **Domain monitor**: confirm SSL cert auto-renews via Vercel (it does) and the matflow.studio domain doesn't lapse.

---

## Known operational gotchas

- **Sentry only captures if `SENTRY_DSN` is set.** No fallback. If errors stop showing up in Sentry, that var was deleted/rotated.
- **`/api/checkin` requires staff or member auth as of `5c12acd`.** External integrations relying on the old anonymous public access will break — tell them to use the documented webhook path instead.
- **TESTING_MODE=true defeats 2FA.** Production is currently in this state for the user's own login — flip off before onboarding additional gym owners.
- **RLS policies are deployed but not enforced** (as of 2026-05-06). Migrations `20260503100000_rls_policies_foundation` and `20260503200000_activate_rls_enforcement` are live, but `neondb_owner` still has the `BYPASSRLS` role privilege so policies are no-ops. Tenant isolation today relies on application-layer `WHERE tenantId =` filters + `withTenantContext()` wrappers (see Phase B). Revoke procedure: see "Kill switches" → "Belt-and-braces: enforce RLS" below.
- **`DATABASE_URL` without `?pgbouncer=true&connection_limit=1` will exhaust the Neon pool under burst.** Symptom: random 500s during traffic spikes, all "connection terminated unexpectedly."

---

## Kill switches (use when something is actively going wrong)

When you need to stop bleeding faster than fix-forward will allow:

### Suspend a single tenant
- `/admin/tenants/[id]` → Danger Zone → "Suspend gym"
- Or: API `POST /api/admin/customers/[id]/suspend` with `{ reason }`
- Effect: `Tenant.subscriptionStatus = "suspended"`. `auth.ts:155` rejects all logins immediately. No data is touched. Reversible via DELETE on the same route.
- Audit: `admin.tenant.suspended` with reason.

### Soft-delete a tenant (and its data goes invisible)
- `/admin/tenants/[id]` → Danger Zone → "Soft-delete gym" (requires typed gym name + 7-second cooldown)
- Effect: `Tenant.deletedAt = now`. `auth.ts:154` rejects all logins. Tenant disappears from active lists. Cron hard-deletes after 30 days.
- Audit: `admin.tenant.soft_deleted`.

### Force a single owner's password reset
- `/admin/tenants/[id]` → Danger Zone → "Force password reset"
- Effect: bcrypts a fresh temp password, clears `lockedUntil`, bumps `sessionVersion` (kicks all their JWTs). Returns the temp password ONCE — copy it and share via support channel.
- Audit: `admin.owner.force_password_reset`.

### Disable a compromised owner's TOTP (e.g. lost phone)
- `/admin/tenants/[id]` → Danger Zone → "Reset 2FA"
- Effect: clears `totpSecret`, sets `totpEnabled=false`, clears recovery codes, bumps `sessionVersion`. Owner forced to re-enrol on next login.
- Audit: `admin.owner.totp_reset`.

### Revoke all kiosk tokens for a tenant
- Tenant settings → Integrations → "Reset kiosk token". Old kiosks get logged out instantly. Generate a new token, redeploy kiosks.
- DB-level (if UI is broken): `UPDATE "Tenant" SET "kioskTokenHash" = NULL WHERE id = '<tenantId>';`. Members will see "kiosk inactive" until token is regenerated.

### Force-logout every session for one user
- `POST /api/auth/logout-all` (as that user) — bumps their `sessionVersion`, kills every JWT.
- DB-level: `UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1 WHERE id = '<userId>';`. JWT-level check in `auth.ts` rejects on next refresh.

### Stop accepting new applications
- Set `MAINTENANCE_MODE=true` in Vercel env, OR DB-level: `UPDATE "PlatformConfig" SET value = 'true' WHERE key = 'applications_paused';` (when feature ships).
- Quick-and-dirty: rate-limit `/api/apply` to 1/h temporarily by editing `RATE_LIMIT_MAX` in the route.

### Disable a Stripe webhook
- Stripe dashboard → Developers → Webhooks → click the endpoint → "Disable". Stops new event delivery. Existing events idempotent — safe to re-enable when fixed.
- Or rotate `STRIPE_WEBHOOK_SECRET` in Vercel env: every incoming event now fails signature verification (rejects with 400). Use this if the webhook receiver itself is compromised, not for normal incidents.

### Belt-and-braces: enforce RLS (revoke `BYPASSRLS`)
- **Stage on preview first.** Production-only run is risky.
- Connect to the target Neon DB via `psql` or a one-off script:
  ```sql
  ALTER ROLE neondb_owner NOBYPASSRLS;
  -- verify:
  SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'neondb_owner';
  -- expected: rolbypassrls = false
  ```
- After running, every uncontexted query against tenant-scoped tables will return zero rows. Verify by hitting a few `/dashboard/*` pages — if a page goes empty, it has a bare `prisma.X.find...` somewhere that needs to be wrapped in `withTenantContext()` (see Phase B).
- Rollback if needed: `ALTER ROLE neondb_owner BYPASSRLS;`.

---

## Secret rotation

Each entry: when to rotate, blast radius, exact procedure.

### `NEXTAUTH_SECRET` (was `AUTH_SECRET`) — JWT signing key
- **Rotate when**: suspected leak, scheduled annual rotation, departing engineer.
- **Blast radius**: every active session is invalidated. Every owner / member / staff is logged out and must sign in again. Magic-link tokens issued before the rotation become unusable. Disown / impersonation / kiosk HMAC tokens become unusable.
- **Procedure**:
  1. Generate: `openssl rand -base64 32`
  2. Vercel → Settings → Environment Variables → Production → set `NEXTAUTH_SECRET` to the new value.
  3. Trigger a redeploy (any commit, or "Redeploy" button on the latest deploy).
  4. Tell users to sign in again. Magic links + invite emails sent before the rotation will fail — owners need to resend.

### `MATFLOW_ADMIN_SECRET` — operator console gate
- **Rotate when**: you've shared it with someone you no longer trust, suspected leak, scheduled annual rotation.
- **Blast radius**: every browser holding the `matflow_admin` cookie loses admin access. You'll need to log back in to `/admin/login` with the new value. Only you are affected today (single operator).
- **Procedure**:
  1. Generate: `openssl rand -hex 32`
  2. Vercel → set `MATFLOW_ADMIN_SECRET` to the new value → no redeploy needed (read at request time via `lib/admin-auth.ts`).
  3. Browser: visit `/admin/login`, paste the new secret, get the cookie reissued.

### Stripe live keys (`STRIPE_SECRET_KEY`, `STRIPE_CLIENT_ID`)
- **Rotate when**: suspected leak, departing engineer, scheduled annual rotation.
- **Blast radius**: payment + Connect operations fail until both Vercel env and Stripe dashboard are in sync.
- **Procedure (key rotation)**:
  1. Stripe dashboard → Developers → API keys → "Roll" on `sk_live_...` (Stripe issues a new key, marks the old one for retirement in 24h).
  2. Vercel → set `STRIPE_SECRET_KEY` to the new value.
  3. Redeploy. Smoke-test by hitting `/api/stripe/connect/health` as owner.
  4. After the 24h retire window, the old key is dead.
- **Procedure (Connect client ID)**: this is on the Connect tab, not API keys. If you rotate this you must also re-onboard every existing Stripe-connected gym. Don't unless absolutely necessary — better to revoke individual connected accounts.

### `STRIPE_WEBHOOK_SECRET`
- **Rotate when**: suspected leak.
- **Blast radius**: webhooks reject incoming events with 400 until the new secret is in Vercel env. Stripe will retry events for ~3 days, so a brief mismatch is recoverable.
- **Procedure**:
  1. Stripe dashboard → Developers → Webhooks → click endpoint → "Roll secret".
  2. Reveal the new `whsec_...` value.
  3. Vercel → set `STRIPE_WEBHOOK_SECRET` → redeploy.

### Neon DB password (`DATABASE_URL`)
- **Rotate when**: connection string was logged somewhere it shouldn't be, departing engineer.
- **Blast radius**: every server-side DB query fails until Vercel env is updated.
- **Procedure**:
  1. Neon console → Project → Roles → `neondb_owner` → "Reset password". Copy the new connection string.
  2. Vercel → update `DATABASE_URL` (and `DATABASE_URL_DIRECT` for backups, if separate).
  3. Append `?pgbouncer=true&connection_limit=1` to the pooled URL. **Do not skip this** — without it the Neon pool will exhaust under burst (see operational gotchas).
  4. Redeploy. Smoke-test `/api/health`.

### `RESEND_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `SENTRY_DSN`, etc.
- Same shape: regenerate at the provider, paste into Vercel env, redeploy. None affect existing sessions.

---

## Migration rollback

Schema migrations live in `prisma/migrations/`. Each has a forward `migration.sql`. Rollback is **not** automatic — Prisma doesn't generate down-migrations. If a migration goes bad:

1. **First, don't panic.** Application-layer code expecting the new schema may fail, but the DB itself is consistent.
2. **Revert the Prisma client schema:**
   - `git revert <bad-migration-sha>` and push. Vercel auto-deploys the previous schema.
3. **Reverse the SQL by hand** if the change is destructive (e.g. dropped a column):
   - Restore from the most recent backup (Sundays 03:00 UTC), OR
   - Hand-write the inverse SQL: `ALTER TABLE ... ADD COLUMN ...`, etc.
4. **Mark the failed migration applied** so Prisma doesn't re-run it on the next deploy:
   - `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, ...) VALUES (...);` — copy the format from an adjacent successful row.

### Specific rollback recipes

**RLS activation (`20260503200000_activate_rls_enforcement`):**
```sql
-- Disable enforcement on every tenant-scoped table (policies remain in place)
ALTER TABLE "Tenant" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "Tenant" DISABLE ROW LEVEL SECURITY;
-- ...repeat for every table listed in the migration SQL
```
The policies themselves stay in place after this — re-activation is just `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on each table.

**`NOBYPASSRLS` revoke (operational, not a migration):**
```sql
ALTER ROLE neondb_owner BYPASSRLS;  -- restores the bypass
```

---

## Audit log — where to look when something looks wrong

- **Per-tenant**: `/dashboard/settings` → Audit tab (when shipped) or directly: `SELECT * FROM "AuditLog" WHERE "tenantId" = '<id>' ORDER BY "createdAt" DESC LIMIT 100;`.
- **Cross-tenant** (operator only): `/admin/activity` — filter by action prefix (`admin.*`, `auth.*`, `payment.*`, `attendance.*`).
- **Impersonation events**: filter `metadata->>'actingAs' = '__matflow_super_admin__'` or use the `(impersonated)` flag in the activity feed UI.
- **Failed admin logins**: not in the AuditLog table (no tenant context). Vercel logs only — search for `[admin/auth/login]`.
- **Rate-limit hits**: `RateLimitHit` table, plus `[rate-limit]` warnings in Vercel logs.
