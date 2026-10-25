# Migration and environment safety (24 Oct 2026)

Branch `sean/c1-ops` (from `aded8cee`, PR #41's head). Everything below was measured on the Neon **TEST** endpoint, on
scratch databases this work created and dropped, with synthetic data only. Nothing here was run against production,
and no production fact is recorded here; facts about production hold only as of the dated evidence they cite.

## 1. Who may migrate, against what (from the code)

`npm run build` = `node scripts/maybe-migrate.mjs && next build`. `maybe-migrate.mjs` reads only the process
environment (it does not load `.env`); `prisma.config.ts` does load `.env` through `dotenv/config`, but never
overrides a variable already set, and the build passes the URL explicitly.

| Context | Runs migrations through | URL used | What refuses or skips |
|---|---|---|---|
| Local `npm run build` | `maybe-migrate.mjs` | `MIGRATION_DATABASE_URL`, else `DATABASE_URL`, **from the shell only** | Neither set: skip (exit 0). Production endpoint and `VERCEL_ENV` ≠ `production`: **skip with a warning, exit 0 — the build carries on**. Any other database in the shell **is migrated**, including the shared test branch. |
| Local, `matflow-verify-local` build | (nothing) | none: `buildEnv()` deletes every database variable | Always skips. |
| `npx prisma migrate deploy` typed by hand | Prisma CLI | `DATABASE_URL` from `.env` (dotenv) — **production** in the main checkout | **No guard at all.** Only the project rule forbids it. |
| CI (`ci.yml`, `e2e.yml`) | `npx prisma migrate deploy` directly; CI never runs `npm run build` | the job's own Postgres container | Not reachable: no repository secret is in scope. `db-backup.yml` holds `DATABASE_URL_DIRECT` for `pg_dump` only and never migrates. |
| Vercel preview | `maybe-migrate.mjs`, `VERCEL_ENV=preview` | Preview-scoped variables | Unset: skip. Production endpoint: skip with warning, **and the preview build still deploys, running new code against an unmigrated production database**. Any other database: migrated. |
| Vercel production | `maybe-migrate.mjs`, `VERCEL_ENV=production` | `MIGRATION_DATABASE_URL`, else `DATABASE_URL` | Both set on different endpoints: exit 1. Otherwise migrates whatever endpoint it is given. |

Corrections to the earlier one-line summary ("refuses production outside a production deploy, migrates any other
database"): the production case is a **skip** (exit 0, the build continues), not a failing refusal; "production" is
recognised by a substring of the endpoint id in the URL (not through `scripts/readiness/db-target.mjs`, so `?host=`-style
overrides are not considered); and `VERCEL_ENV` is an ordinary variable — any shell that sets `VERCEL_ENV=production`
passes the check. "Migrates any other database" is accurate, and includes the shared test branch.

Added on this branch (applied in every context that runs `maybe-migrate.mjs`):
- **Direct host.** A Neon `-pooler` URL is migrated on its direct host (§3.3 for why).
- **Preflight.** With migrations pending, the build refuses (exit 1, nothing recorded) while another session has had a
  transaction open for more than 5 s. Sessions of roles it cannot see (`pg_read_all_stats` absent) are counted and
  reported, not silently passed.

## 2. Bounded waits in the release's six migrations

`SET LOCAL lock_timeout = '5s'` and `SET LOCAL statement_timeout = '15s'` follow `BEGIN` in `20261017020102`,
`20261017035912`, `20261017052858`, `20261021140000`, `20261021170000` and `20261021230000`
(`tests/unit/migrations-bounded-waits.test.ts` pins them for every migration from `20261017020102` on).

- **5 s lock wait.** An `ALTER TABLE` waiting for ACCESS EXCLUSIVE queues every later request on that table behind it.
  5 s is below the app's own lock bound (`TENANT_LOCK_BOUND_MS`, 10 s), so a request queued behind a waiting migration
  is delayed rather than failed by its own bound, and it outlasts the app's ordinary short transactions.
  **Qualification (review 25 Oct):** the bound is per lock wait, not per file. A file that locks several tables in turn
  can hold one while it waits up to 5 s for the next: `20261021230000` (`Member`, then `MembershipTier`) can keep a
  check-in queued on `Member` for about 10 s, at the app's own bound; `20261017020102` takes four foreign-key locks in
  sequence. The preflight (§4) makes a long blocker at the start unlikely, so this is a low risk, not a guarantee.
- **15 s statement bound.** Above the lock bound (a lock wait counts toward `statement_timeout`; equal values would end
  a lock wait as 57014 instead of 55P03) and more than a hundred times the longest statement measured (§3.2).
- Verified on PostgreSQL 17.11: `SET LOCAL statement_timeout` bounds each later statement of the same simple-query
  message separately, and the session value is back to its default after COMMIT/ROLLBACK.
- Checksums: no test pins a migration hash. `prisma migrate deploy` and `migrate status` (7.10.0) ignore an applied
  file whose checksum changed; `migrate dev` does not. The shared test branch applied the earlier files, so after
  integration run `scripts/readiness/test-branch-restamp-migrations.mjs DATABASE_URL --from aded8cee --apply <the six>`
  (dry run first; it re-stamps only rows provably applied from the `aded8cee` file).

## 3. Clean-baseline rehearsal

`scripts/readiness/migration-rehearsal.mjs` (commands `create`, `migrate`, `seed`, `profile`, `partial`, `resolve`,
`state`, `advisory`, `drop`). Three scratch databases were created on the TEST endpoint with `CREATE DATABASE`, migrated
from empty to exactly `main` `41b608aa` (100 migrations, 284–311 s from this machine), seeded with 4 synthetic clubs,
16 plans, 12,000 members, 24 classes, 4,320 sessions, 480,000 attendance rows and 36,000 status events (172 MB), and
dropped afterwards.

### 3.1 Locks each release file takes

| Migration | Strongest locks (in its own transaction) |
|---|---|
| `20261017020102_class_membership_tier` | ACCESS EXCLUSIVE on the new `ClassMembershipTier`; SHARE ROW EXCLUSIVE on `Class`, `MembershipTier`, `Tenant`, `User` (foreign keys: writes to those four wait until COMMIT) |
| `20261017035912_class_category` | ACCESS EXCLUSIVE + SHARE UPDATE EXCLUSIVE on `Class` |
| `20261017052858_tier_class_allowance` | ACCESS EXCLUSIVE + SHARE UPDATE EXCLUSIVE on `MembershipTier` |
| `20261021140000_tier_class_allowance_basis`, `20261021170000_…_null_safe` | ACCESS EXCLUSIVE on `MembershipTier` |
| `20261021230000_member_billing_period_allowance_basis` | ACCESS EXCLUSIVE on `Member` and `MembershipTier` |

### 3.2 Durations

Clean run through `maybe-migrate.mjs` (pooled URL given, migrated on the direct host): six files in 44 s of wall time;
Prisma recorded 2.6–4.6 s per file, which is almost entirely Prisma's own round trips from this machine (about 0.25 s
each). The SQL itself: each file ran in 0.20–0.31 s client-side including one round trip of about 0.29 s, i.e. tens of
milliseconds on the server. No file rewrites a table (every column is nullable without a default; the CHECK
validations scan `Class` and `MembershipTier` only).

### 3.3 Prisma Migrate's advisory lock (by experiment, Prisma 7.10.0)

- `migrate deploy` runs `SELECT pg_advisory_lock(72707369)` on its own session (in `pg_locks`: advisory, classid 0,
  objid 72707369, objsubid 1, ExclusiveLock) and holds it for the whole run, even with nothing pending.
- While another session holds the shared form, it waits 10 s, then fails `P1002` ("Timed out trying to acquire a
  postgres advisory lock"), exit 1, nothing applied. Server-side the abandoned request kept waiting about 14 s.
- While it waits, a new `pg_try_advisory_xact_lock_shared(72707369)` is refused (Postgres queues it behind the waiter).
- **Through the pooler the lock leaks.** After each of three successful pooled deploys an idle `pgbouncer` backend
  still held the ExclusiveLock (seen 3 min later); a following direct-host deploy then failed `P1002`. Pooled deploys
  kept succeeding only because they landed on the same backend. On the direct host nothing was left behind (checked
  after each run). Hence the direct-host rule in §1.

### 3.4 Partial progress and recovery

Another session held ACCESS SHARE on `Member` (what any open transaction that has read it holds) while the release was
deployed:
1. Files 1–5 committed. File 6 (`20261021230000`) waited 4.9 s for ACCESS EXCLUSIVE on `Member` (seen by a lock
   poller), then its lock_timeout ended it.
2. Prisma's message was **"current transaction is aborted, commands ignored until end of transaction block"**: the
   file's own `BEGIN` left the connection in the aborted transaction, so Prisma could not even record the cause
   (`logs` empty, `applied_steps_count` 0). The real error (55P03) appears nowhere in the build log.
3. State: `_prisma_migrations` 105 finished + 1 row with `finished_at` and `rolled_back_at` both NULL; the release's
   `ClassMembershipTier`, `Class.category`, the four `MembershipTier` columns and their constraints present;
   `Member.billingPeriodStart/End` **absent** (the failed file applied nothing).
4. The next `migrate deploy` failed `P3009` ("migrate found failed migrations … new migrations will not be applied").
5. Recovery, tested twice: confirm the failed file's objects are absent (`migration-rehearsal.mjs state`), then
   `prisma migrate resolve --rolled-back 20261021230000_member_billing_period_allowance_basis`, then deploy again →
   applied (2.5–3.0 s); the row history keeps the rolled-back row and the new finished row.

In production the same recovery is Noe's: a read-only check that the named file's objects are absent, `migrate
resolve --rolled-back <name>` against production, redeploy. `maybe-migrate.mjs` now prints this on a failed deploy.

## 4. What each layer prevents (and does not)

| Layer | Prevents | Does not prevent |
|---|---|---|
| `lock_timeout` / `statement_timeout` in each file | An unbounded stall of every request on a table behind a waiting `ALTER` | A part-applied deploy (earlier files committed, P3009 until resolved) |
| Preflight in `maybe-migrate.mjs` | Starting a deploy beside a transaction already open > 5 s — the usual cause of that part-applied deploy | A long transaction that starts after the check; sessions of roles it cannot see (reported) |
| `lib/migration-lock.ts` (shared form of Prisma's key, first in each job write transaction) | Any TeamUp commit/refresh/rollback or attendance commit/step/rollback transaction overlapping a `migrate deploy`; a job starting once a migration holds or awaits the key (refused at once, 503, nothing written; attendance steps answer "busy" and the client retries) | A migration between two of a job's transactions (the release is expand-only, so the job's next transaction still works); ordinary app writes (check-ins, bookings); the status back-fill until #39 adds the call (§5) |
| Direct-host migration | The leaked session lock in §3.3, which would block later deploys and make the job layer refuse imports while it lingers | — |

## 5. Integration notes

- **Status back-fill (#39).** In `lib/status-backfill.ts`, `applyTenantBackfill` and `rollbackTenantBackfill` should
  call `await holdOffMigrations(tx)` before `lockClub(tx, tenantId)`, and `scripts/backfill-status-events.ts` should
  report `MigrationInProgressError` as "a database update is running; nothing was written; run it again". Separately,
  `lockClub` uses the single-bigint key space `pg_advisory_xact_lock(hashtext(key))` that Prisma's 72707369 lives in;
  the two-int4 form with a namespace (as `lib/login-email.ts` does) removes the (remote) chance of a club's hash
  colliding with Prisma's key.
- **A leaked lock in production (check before merging; Noe, read-only).** Every production deploy so far migrated
  through the pooled URL, which §3.3 shows can leave an idle backend holding 72707369. If one is held, the first
  direct-host deploy fails `P1002` (nothing applied), and once this code is live every import is refused as "a
  database update is being applied" for as long as that backend lives. Before the merge, run
  `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = 72707369 AND objsubid = 1 AND granted;`
  expecting **0**. If it is not 0: wait for the pooler to recycle the backend, or end that one idle backend
  (`pg_terminate_backend` on its pid from `pg_locks`). Merge this branch before any other branch that would still
  deploy with the old script.
- **Test branch checksums.** §2.
- **`migrate dev` on a modified history** was not observed to complete: on a scratch database with one checksum
  changed it did not return within 180 s (non-interactive), and created nothing.

## 6. A production-derived rehearsal (a later step that needs Noe)

Isolation that must be in place **before** any application process or script starts against a branch created from
production (adds to `docs/readiness/BACKFILL-REHEARSAL-PROCEDURE-2026-10-23.md` on #39):

- Local only, in a worktree with no `.env*` file; never a Vercel preview against the branch.
- `DATABASE_URL` = the branch's **direct** URL, kept in a private file outside the repository; `MIGRATION_DATABASE_URL`,
  `VERCEL`, `VERCEL_ENV` unset. Every script resolves it through `db-target.mjs` with `--expect-host <whole branch
  endpoint id>` (which refuses `ep-bold-wave`).
- Mail: **`EMAIL_DELIVERY=off`, set explicitly.** In `lib/email-delivery.ts` on `main`, #39 and #41, an **unset**
  `EMAIL_DELIVERY` means **on** (the #39 procedure says the opposite). Also `RESEND_API_KEY`, `RESEND_FROM`,
  `RESEND_WEBHOOK_SECRET` empty.
- Payments: `STRIPE_SECRET_KEY` a non-working test-format placeholder (as the verify skills use) or absent;
  `STRIPE_WEBHOOK_SECRET`, `STRIPE_CLIENT_ID`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` placeholders or absent.
- Other outbound effects: `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` empty (the branch holds live push subscriptions);
  `BLOB_READ_WRITE_TOKEN` empty (branch rows point at the production Blob store); `ANTHROPIC_API_KEY` empty;
  `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` empty (error events would carry customer data); Google OAuth variables unset;
  `CRON_SECRET` and `RETENTION_CRON_ENABLED` unset; `MATFLOW_APPLICATIONS_TO` unset.
- Sessions and links: a fresh `AUTH_SECRET`/`NEXTAUTH_SECRET` (no production cookie verifies, nothing signed on the
  branch verifies in production); `NEXTAUTH_URL`/`APP_URL` = localhost; `MATFLOW_ADMIN_SECRET` unset;
  `TESTING_MODE=false`; `E2E_AUTH_BYPASS`, `E2E_BYPASS_TOKEN`, `DEMO_MODE` unset.
- Before the first start: `scripts/readiness/backup-post-restore.mjs <env-file> <branch endpoint id> DATABASE_URL
  inventory` (counts only), then `revoke --i-confirm-this-is-a-restored-copy` so every session, sign-in link and reset
  code on the branch is dead.
- A start check that prints each variable above as set/unset (never a value) and stops unless mail resolves to off.
- Access: Noe creates the branch and holds its URL; outputs are counts, tallies, ids and digests only — no names,
  emails or phone numbers leave the branch. Retention: the branch and the private env file are deleted within 24 h,
  with the deletion time recorded.
