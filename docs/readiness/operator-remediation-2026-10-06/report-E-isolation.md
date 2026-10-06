# Lane E report (saved by lead from the agent's hand-back; agent's own write was refused by a hook)

E1: 12/12 todo cases implemented.
- cross-tenant-authorisation-matrix: owner role `Tests 41 passed | 4 expected fail (45)`; restricted `Tests 42 passed | 3 expected fail (45)` (was 5 passed | 9 todo).
- roster-cross-tenant: `Tests 3 passed (3)` both roles. rls-foundation restricted `Tests 9 passed (9)`.
- Real bugs (kept as it.fails):
  - E-1 app/api/classes/[id]/route.ts:329-345,356-359 subscription lookups lack tenant filter and run before ownership check :380-384; ?dryRun=1 (:365-367) returns other gym's member ids (owner role); restricted role answers 200 not 404. Fix: ownership check first; add member: { tenantId } to both queries.
  - E-2 same file :441-448 writes requiredRankId / maxRankId / coachUserId without tenant check (only locationId checked); GET then leaks other gym's belt + coach names; FK persists under RLS. Same gap in app/api/classes/route.ts POST (~:80-92). Fix: tenant-scoped lookup for each id, 400 otherwise.
  - E-3 app/api/ranks/[id]/route.ts:100 counts belt holders without tenant filter (knock-on of E-2).
E2:
- Runtime role unknown; build runs prisma migrate deploy via scripts/maybe-migrate.mjs on same DATABASE_URL, so it is very likely the owner role (inference). Runbook docs/runbooks/RUNTIME-DB-ROLE-CHECK.md. Blockers before switching to matflow_app: lib/push.ts bare prisma.pushSubscription calls; maybe-migrate needs a separate MIGRATION_DATABASE_URL; full integration suite under matflow_app not yet run.
- Backups: 0 repo secrets; last 5 runs (6 Sep–4 Oct) fail at Validate secrets. Secrets: DATABASE_URL_DIRECT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, BACKUP_S3_BUCKET, BACKUP_S3_REGION. docs/runbooks/BACKUP-SECRETS-SETUP.md.
- WORKFLOW WILL STILL FAIL: installs postgresql-client-16; server is 17.11 → pg_dump refuses. Also add pg_restore --list check, replace apt-key, consider Environment/OIDC.
- RESTORE-REHEARSAL-ISOLATED.md updated, executable, BACKUP UNVERIFIED banner.
