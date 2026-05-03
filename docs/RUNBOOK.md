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
- **No RLS in production yet** (as of 2026-05-03). Tenant isolation relies entirely on application-layer `WHERE tenantId =` filters. Keep eyes on PR review until RLS migration ships.
- **`DATABASE_URL` without `?pgbouncer=true&connection_limit=1` will exhaust the Neon pool under burst.** Symptom: random 500s during traffic spikes, all "connection terminated unexpectedly."
