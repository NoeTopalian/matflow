# Database restore runbook

## TL;DR

If production data is lost or corrupted:

1. **Don't panic, don't truncate.** Stop writes first by flipping the kill switch (P1.1) or pausing the Vercel deployment.
2. **Identify the recovery point** — last good timestamp.
3. **Restore via Neon PITR** (preferred) OR **pg_restore** from the most recent S3 dump.
4. **Cut the app over** to the restored database.
5. **Post-mortem within 48 hours.**

## Backup inventory

| Layer | Source | Window | RPO | Notes |
|---|---|---|---|---|
| Neon PITR | Neon platform | 7 days (Free) / 30 days (Launch) / 365 days (Scale) | < 1 minute | Always-on; restores to a new branch |
| Logical dump | `.github/workflows/db-backup.yml` → S3 | 30 days | 7 days (weekly) | Manual fallback; survives Neon outage |

## Recovery options

### Option A — Neon PITR (RTO ~5 min)

Use when the issue is recent (within PITR window) and Neon itself is healthy.

1. Open the Neon console → project → **Branches** tab.
2. Click **Create branch** → choose **From a specific point in time** → select target timestamp.
3. Confirm. Neon creates a new branch (e.g. `restore-2026-05-03-1530`).
4. Copy the connection string from the new branch.
5. Set `DATABASE_URL` for the production deployment to the new branch's pooled URL (keep `?pgbouncer=true&connection_limit=1`).
6. Redeploy from Vercel dashboard (Settings → Environment Variables → save → Redeploy).
7. Verify: log in, hit `/api/health` (once P1.3 lands), spot-check member count and recent attendances.
8. Once stable: promote the branch to primary in Neon (Branches → ⋯ → **Set as primary**).

**Caveat:** changes between the recovery point and now are lost. Communicate to affected gyms.

### Option B — Restore from S3 dump (RTO ~30 min)

Use when Neon is unavailable or the corruption predates the PITR window.

```bash
# 1. Pick the most recent dump
aws s3 ls s3://matflow-db-backups/ --recursive | sort | tail -5

# 2. Download
aws s3 cp s3://matflow-db-backups/<date>/matflow-db.dump ./matflow-db.dump

# 3. Provision a new Neon database (or use a fresh branch)
#    Get the DATABASE_URL of the new target.

# 4. Restore (pgbouncer URL won't work for restore — use the DIRECT URL)
pg_restore \
  --dbname="<DIRECT_DATABASE_URL>" \
  --no-owner --no-privileges \
  --jobs=4 \
  ./matflow-db.dump

# 5. Apply any migrations newer than the dump
DATABASE_URL="<DIRECT_DATABASE_URL>" npx prisma migrate deploy

# 6. Point production at the new DATABASE_URL (Vercel → redeploy)
```

**Caveat:** the dump is logical (no row-level state of in-flight transactions). Re-run any cron / webhook reconciliation after restore (e.g. `/api/cron/monthly-reports` for the relevant month).

## Pre-flight checks before flipping the cutover

- [ ] Stripe webhook idempotency table (`StripeEvent`) is intact — replays won't double-charge.
- [ ] Email log is restored — won't re-send password resets / invites already delivered.
- [ ] `RateLimitHit` is empty or recent — login won't be locked out for users.
- [ ] Manually verify one tenant's: members count, last 10 attendances, last 5 payments.
- [ ] **DSAR erasures between the recovery point and now are identified and queued for replay** — see below. A restore that silently resurrects erased personal data is an ICO-reportable failure of Article 17.

## Re-applying DSAR erasures after a restore

A restore rolls the database back to a point where erased members were still present. Every right-to-erasure request fulfilled after that timestamp is undone by the restore, so each one must be re-applied before the restored database serves traffic.

This is possible because `AuditLog` rows carry `tenantId` as a plain string with no foreign key, and the retention cron (`/api/cron/retention`) deliberately preserves them for their full 12 months — the erasure-evidence trail outlives the data it attests to.

1. Find the erasures to replay (run against the **restored** database, direct URL):

   ```sql
   SELECT "entityId" AS "memberId", "tenantId", "createdAt"
   FROM "AuditLog"
   WHERE action = 'member.dsar_erase'
     AND "createdAt" > '<recovery_point>'
   ORDER BY "createdAt";
   ```

   If the audit rows themselves fall after the recovery point they will also have been rolled back. In that case query the **pre-restore** database (or the S3 dump / the Neon branch you restored *from*) for the same rows before cutting over — the list of erasures is the one thing you must carry across the gap.

2. For each `memberId`, re-run the erasure via `POST /api/admin/dsar/erase?memberId=<id>` as an owner of that tenant. The route is idempotent-safe: an already-erased member returns 409, so re-running the whole list is harmless.

   Note the route rate-limits to 5 erasures per hour per tenant. For a larger backlog, either wait out the window or apply the same field scrub directly (see `app/api/admin/dsar/erase/route.ts` for the exact column list) and write a matching `member.dsar_erase` audit row for each.

3. Confirm zero survivors before cutover:

   ```sql
   SELECT m.id FROM "Member" m
   JOIN "AuditLog" a ON a."entityId" = m.id AND a.action = 'member.dsar_erase'
   WHERE m.email NOT LIKE 'deleted-%';
   ```

   This must return no rows.

4. Record the replay in the incident note (step 3 of *After restore*) — count of erasures re-applied and the timestamp range covered.

## After restore

1. Audit the gap: query for missing data (e.g. `SELECT count(*) FROM "Member" WHERE "joinedAt" > '<recovery_point>'`).
2. Notify affected tenant owners via in-app announcement + email.
3. Capture incident details in `docs/incidents/<date>-restore.md`.
4. Verify backups are running again (next workflow run within 7 days).

## Anti-patterns

- **Do not** `prisma migrate reset` against production — that's a data wipe.
- **Do not** restore on top of the existing primary; always restore to a new branch / database first.
- **Do not** point production at the restored DB before pre-flight checks.

## Setup status

- ✅ Neon PITR — automatic, no setup required (verify retention window matches your Neon plan).
- ❌ S3 dumps — **not disabled, and currently failing.** `.github/workflows/db-backup.yml` is on a live schedule (`cron: '0 3 * * 0'`, Sundays 03:00 UTC) plus `workflow_dispatch`. Its `Validate secrets` step exits 1 whenever a required secret is missing, so every weekly run has failed since the workflow landed and **no S3 dump has ever been taken**. That failure is the intended fail-loud signal — do not silence it by disabling the schedule; set the secrets. Required repo secrets (Settings → Secrets and variables → Actions):
  - `DATABASE_URL_DIRECT` — non-pooled Postgres URL (pgbouncer can't `pg_dump`)
  - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` — IAM user with S3 PutObject on the bucket
  - `BACKUP_S3_BUCKET` — bucket name
  - `BACKUP_S3_REGION` — e.g. `eu-west-2`

  Until all five exist, treat Neon PITR as the **only** backup and size the incident response to its window. Verify with `gh run list --workflow=db-backup.yml` before relying on Option B.
- ✅ Retention sweep — `/api/cron/retention`, daily 03:30 UTC (`vercel.json`). Enforces the published retention windows and hard-deletes tenants 30 days after soft-delete. Requires `CRON_SECRET`; returns 503 without it.
