# Runtime database role: check and, if needed, move to a restricted role

Status: **PREPARED, NOT EXECUTED** (6 Oct 2026). The production runtime role is **UNKNOWN**. Nobody in this
engineering run read production. Every step below that touches production is for Noe (or the lead, with
Noe's go-ahead) to run.

## Why this matters

Row-level security (RLS) is MatFlow's second line of tenant isolation. The policies (migration
`20260503100000_rls_policies_foundation`, enforced by `20260503200000_activate_rls_enforcement`) only apply
to a role **without** `BYPASSRLS`. If the app connects as such a role, RLS does nothing and the
application-layer `where: { tenantId }` filters are the only defence.

Evidence gathered on the Neon **test** branch (same project as production, endpoint `ep-hidden-salad`) on
6 Oct 2026, printing only role attributes:

| Connection | `current_user` | `rolsuper` | `rolbypassrls` | member of `neon_superuser` | server |
|---|---|---|---|---|---|
| `TEST_DATABASE_URL` (maintenance) | `neondb_owner` | false | **true** | true | PostgreSQL 17.11 |
| `RESTRICTED_DATABASE_URL` | `matflow_app` | false | false | false | PostgreSQL 17.11 |

So **`neondb_owner` bypasses RLS on this project.** If production `DATABASE_URL` uses `neondb_owner`, RLS
is inert in production.

The source points strongly at that being the case, though it is not proof. `npm run build` runs
`scripts/maybe-migrate.mjs`, which runs `prisma migrate deploy`. `prisma.config.ts` takes the URL from
`DATABASE_URL`, so on Vercel the **same** variable the app uses at runtime also has to be able to run
DDL. A role that can run MatFlow's migrations is in practice the owner.

This has a practical cost. The cross-tenant matrix
(`tests/integration/cross-tenant-authorisation-matrix.test.ts`, finding E-1) found a read of another
gym's class subscribers through `PATCH /api/classes/[id]?dryRun=1`. Under `neondb_owner` it **leaked**.
Under `matflow_app` the RLS policy hid the rows. The application fix is now made **locally** (6 Oct 2026,
not yet deployed; see §4), and the matrix passes on both roles.

## 1. Find the production role (read-only, connection string never displayed)

Use **one** of these. Option A is preferred because nothing secret leaves the Neon console.

### Option A: Neon console (no secret handled)

1. Neon console, then the MatFlow project, the production root branch (endpoint `ep-bold-wave…`), then **Roles**.
   Record every role listed.
   - If `neondb_owner` is the **only** role, the app must be connecting as `neondb_owner`. The verdict is
     **RLS inert**, and you can stop here and go to §2.
2. If other roles exist, open **SQL Editor** on the production branch and run this read-only query. It
   shows which roles the live app is connected as, by role name only:
   ```sql
   SELECT usename, application_name, state, count(*)
   FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid()
   GROUP BY 1, 2, 3
   ORDER BY 4 DESC;
   ```
   Load a dashboard page first so the app has a connection open. Connections through the pooler show the
   role the app authenticates as. Then, for that role, run:
   ```sql
   SELECT rolname, rolsuper, rolbypassrls,
          pg_has_role(rolname, 'neon_superuser', 'member') AS neon_superuser_member
   FROM pg_roles WHERE rolname = '<the role from the query above>';
   ```
3. Record the result in §5.

### Option B: one-off script on Noe's machine (prints three fields only)

Use this only if the console is unavailable. It handles the production URL on disk for a few minutes, so
treat that file as a production secret.

1. `vercel env pull --environment=production %TEMP%\matflow-role\prod.env`. This writes the file **outside
   the repo**. Do not open it, print it or paste it anywhere.
2. Save the following as `%TEMP%\matflow-role\probe.mjs` and run it from a MatFlow checkout, so that `pg`
   resolves: `node --env-file=%TEMP%\matflow-role\prod.env %TEMP%\matflow-role\probe.mjs`
   ```js
   import pg from "pg";
   const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
   await c.connect();
   const r = await c.query(
     "SELECT current_user AS role, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user");
   console.log(JSON.stringify(r.rows[0]));   // role name and two booleans: nothing else
   await c.end();
   ```
3. Delete `%TEMP%\matflow-role\` straight away.

Do **not** use `scripts/probe-role-attrs.mjs` for this. It loads the repo `.env` through `dotenv/config`,
and that file's `DATABASE_URL` is the local copy, not necessarily the value Vercel serves.

## 2. Verdict

| Result | Meaning | Action |
|---|---|---|
| `rolbypassrls = false` and `rolsuper = false` | RLS enforces in production | Record it. Deploy the E-1/E-2/E-3 app-layer fixes (§4) all the same. |
| `neondb_owner`, or any role with `rolbypassrls = true` | **RLS inert in production.** Isolation rests on application filters alone. | Plan §3. Severity: High (defence in depth missing on a multi-tenant product). It is not a breach on its own: with the §4 fixes, the matrix passes all 54 cases (refusals plus positive controls) under `neondb_owner` as well as under `matflow_app`. Until those fixes are deployed, E-1 and E-2 are open in production. |

## 3. Moving the runtime to a restricted role (**needs Noe's authorisation; not done**)

Do not just swap the URL. Each item below has to be in place first.

### 3.1 Create the role on production (SQL editor, as `neondb_owner`)

Create it **in SQL, not in the console Roles page**. Neon makes console-created roles members of
`neon_superuser`, which holds `BYPASSRLS` [NEEDS VERIFICATION against current Neon docs before running].
Use the same statements as `scripts/create-restricted-role.ts`. That script deliberately refuses
production, so run them by hand:

```sql
CREATE ROLE matflow_app LOGIN PASSWORD '<generated, 32+ chars, stored in the password manager only>';
GRANT USAGE ON SCHEMA public TO matflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO matflow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO matflow_app;
-- Future tables created by migrations (which run as neondb_owner) must be granted automatically:
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO matflow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO matflow_app;
-- Verify: all three must be false.
SELECT rolsuper, rolbypassrls, pg_has_role('matflow_app', 'neon_superuser', 'member') FROM pg_roles WHERE rolname = 'matflow_app';
```

No `DDL`, no `TRUNCATE`, no `CREATEROLE`, no ownership. The restricted role cannot run migrations, and it
should not be able to.

### 3.2 Which work needs which role

| Work | Role | Why / evidence |
|---|---|---|
| App runtime (route handlers, pages, auth, crons, webhooks) | `matflow_app` | Tenant work runs in `withTenantContext` (`lib/prisma-tenant.ts`). Cross-tenant system work runs in `withRlsBypass`, which sets the transaction-local `app.bypass_rls = 'on'` that every policy honours. Proven under `matflow_app` on the test branch: `rls-foundation` (9 passed), the matrix and the roster suites (fixtures are created through `withRlsBypass` as `matflow_app`). |
| `prisma migrate deploy` (Vercel build) | `neondb_owner` | DDL. Reads `MIGRATION_DATABASE_URL` when set (code change made locally, §3.3); that variable must exist before the switch. |
| Weekly `pg_dump` | dedicated read role with `BYPASSRLS` | Otherwise `pg_dump` aborts on RLS tables. See `BACKUP-SECRETS-SETUP.md`. |
| `scripts/readiness/*`, one-off maintenance scripts | `neondb_owner`, run by Noe only | Unchanged |

Bare `prisma.*` calls outside both wrappers (source sweep, 6 Oct 2026). These behave differently under
`matflow_app`:
- `lib/push.ts` reads and deletes `PushSubscription`. RLS is forced on that table, so under `matflow_app`
  bare calls would see **zero rows**. **Changed locally (6 Oct 2026):** both now run inside the caller's
  club with `withTenantContext` and filter on `tenantId` and `memberId` (no RLS bypass); each runs in its
  own short transaction. Both callers already hold the tenant, so it is passed in. Behaviour under
  today's owner role is unchanged, and push delivery is still not live. Pinned by
  `tests/unit/push-tenant-scope.test.ts`.
- `lib/rate-limit.ts` uses `RateLimitHit`. That table has no RLS by design, so it is unaffected.
- `lib/operator-auth.ts` and `app/api/admin/auth/operator-totp/**` use `Operator`. No RLS, so unaffected.
- `app/api/health/route.ts` runs `SELECT 1`. Unaffected.

Not yet established: the **whole** integration suite under `matflow_app`. Only `rls-foundation`, the
cross-tenant matrix and the roster suite were run as `matflow_app` in this pass. Run every
`tests/integration/*` file with `run-restricted.sh` (one file at a time) before the switch. A file that
cannot run counts as unproven, not passed.

### 3.3 Migration URL (code change made locally, 6 Oct 2026; not yet deployed)

`scripts/maybe-migrate.mjs` now migrates with `MIGRATION_DATABASE_URL` when that variable is set, and
otherwise falls back to `DATABASE_URL` exactly as before. On a production build that falls back, it logs a
warning naming the variable, never the value. The child process gets `DATABASE_URL` overridden with the
migration URL. `prisma.config.ts` reads `DATABASE_URL`, and `dotenv/config` never overrides a variable that
is already set. The production-endpoint and `VERCEL_ENV` guards apply to the URL that will actually be
migrated. Pinned by `tests/unit/maybe-migrate-url.test.ts`, which never reaches `migrate deploy`.

For Noe, before the switch: in Vercel **Production** scope, add `MIGRATION_DATABASE_URL` with the
`neondb_owner` **direct** (non-`-pooler`) URL. Do not add it to Preview. Nothing changes until it exists. If
the switch goes ahead without it, every production build fails at `migrate deploy` with permission denied
for DDL. That is safe, because nothing deploys, but it blocks shipping.

### 3.4 Cut-over and rollback

1. Pre-check: §3.1 has run and its verification row printed false, false, false. §3.3 and the `lib/push.ts`
   change are deployed, `MIGRATION_DATABASE_URL` is set in Vercel Production, and one production build
   has migrated through it (its build log says `MIGRATION_DATABASE_URL set`).
2. In Vercel Production, set `DATABASE_URL` to the `matflow_app` **pooled** (`-pooler`) URL. Keep the old
   value in the password manager for rollback. Redeploy.
3. Smoke tests: `/api/health` returns 200; owner sign-in on a **synthetic** account (Iron Path demo, never
   totalbjj or Sean); dashboard members list; a kiosk check-in on the demo club; one Stripe **test-mode**
   webhook replay if available.
4. Confirm with the §1 Option A query that the app sessions now show `usename = matflow_app`.
5. Rollback: restore the previous `DATABASE_URL` value and redeploy. Rollback returns to today's state
   (RLS inert). It does not disable any other control.

### 3.5 What RLS will and will not do once enforced

It stops a route that forgot its `tenantId` filter **inside** `withTenantContext` (finding E-1 was exactly
that). It does **not** stop code that deliberately calls `withRlsBypass`. It does not stop SQL injection
that sets `app.bypass_rls` itself, because any role may set that GUC. It does not stop stored cross-tenant
foreign keys (finding E-2), because Postgres FK checks ignore RLS. Application filters stay the primary
defence (`CLAUDE.md`).

### 3.6 Connection pooling and cache keys (source review, 6 Oct 2026)

- Tenant context is set only with `set_config(..., true)` (transaction-local) in `lib/prisma-tenant.ts:46`
  and `:72`. There are no session-level `SET` statements in `app/` or `lib/`, so the Neon pooler cannot
  carry one club's context into another client's transaction.
- Every `unstable_cache` key includes the tenant id: `lib/reports.ts:755`, `lib/leaderboard.ts:217`,
  `app/api/me/gym/route.ts:11`.
- Blob reads check a `/tenants/<session tenantId>/` path prefix after URL normalisation
  (`app/api/blob-image/route.ts:89-96`). These are covered by unit tests in `tests/unit/blob-image-*.test.ts`
  and were not re-tested in this pass.

## 4. Findings this check depends on

Status: **FIXED LOCALLY, 6 Oct 2026 (lane F), not yet deployed.** Production (`e8afb6a`) still has all
three until the fixes ship.

- **E-1** (`app/api/classes/[id]/route.ts`, PATCH): `affected` was computed with an unscoped
  `classSubscription.findMany({ where: { classId: id } })` **before** the ownership check, and
  `?dryRun=1` returned it. Under a `BYPASSRLS` role, gym B's subscriber member ids leaked to gym A. Fix:
  the PATCH now opens with a pre-flight transaction that checks ownership first (404, including for a dry
  run), and both subscription queries carry `member: { tenantId }`.
- **E-2** (`app/api/classes/[id]/route.ts` PATCH, and `app/api/classes/route.ts` POST): `requiredRankId`,
  `maxRankId` and `coachUserId` were written without a tenant check. `GET /api/classes/[id]` then returned
  gym B's belt name and coach name. RLS does not prevent this. Fix: `lib/class-refs.ts` runs a
  tenant-scoped `findFirst` for each id (and `locationId`) and the routes refuse with 400 before any
  write. PATCH roster member ids are now filtered to the caller's members, as POST already did.
- **E-3** (`app/api/ranks/[id]/route.ts`, DELETE): the 409 disclosed a belt-holder count taken without a
  tenant filter, before ownership was checked. Fix: ownership first (404), and the count is scoped
  through `member: { tenantId }`.
- Residual: a class row written **before** the fix that already points at another club's belt or coach
  still shows those names through GET. Detection, read-only, for Noe in the Neon SQL editor:
  `SELECT count(*) FROM "Class" c JOIN "RankSystem" r ON r.id IN (c."requiredRankId", c."maxRankId") WHERE r."tenantId" <> c."tenantId";`
  and the same with `JOIN "User" u ON u.id = c."coachUserId" WHERE u."tenantId" <> c."tenantId"`. A
  non-zero count should be reported, not silently cleared.

## 5. Record (fill in; role names and booleans only)

| Field | Value |
|---|---|
| Checked by / date (UTC) | |
| Method (A console / B script) | |
| Production runtime role | |
| `rolsuper` / `rolbypassrls` / `neon_superuser` member | |
| Verdict (RLS enforcing / RLS inert) | |
| Decision on §3 (authorised by, date) | |
