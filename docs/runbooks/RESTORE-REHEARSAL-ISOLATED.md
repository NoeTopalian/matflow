# Isolated restore rehearsal: Neon point-in-time branch plus an isolated production build

Status: **PREPARED, NOT EXECUTED** (4 Oct 2026). No branch has been created and nothing has been restored.
This runbook is the executable form of `docs/runbooks/db-restore.md` §"Rehearsal status". It proves that a
point-in-time copy of production can be brought up, checked and thrown away **without touching production**.
It does not prove the production cut-over (Option A steps 5–8 of `db-restore.md`).

Steps marked **[AUTH]** need Noe's explicit go-ahead before anyone runs them. Everything else is read-only
or local.

> **BACKUP UNVERIFIED** (6 Oct 2026). This stays true until §3–§7 have been executed end to end with the
> record in §8 filled in, **and**, separately, a weekly dump has been taken and restored
> (`BACKUP-SECRETS-SETUP.md` §6). Neither has happened. A configured setting, a green workflow alone, or a
> console screenshot of a restore window is not recovery evidence.

**End-to-end order (6 Oct 2026 revision):** §1 authorisation, then §2 window checks (record the earliest
restore point), then §3 branch from a **past timestamp**, then §4 integrity checks (§4.1 per-table counts
for the synthetic tenant, §4.2 the real-tenant totals and the attendance reconcile), then §5 isolated
production build with outbound effects off, then §5.4 sign-in with a synthetic account, then §6 recovery
time and data age, then §7 delete the branch, then §8 record. The runtime role question is separate
(`RUNTIME-DB-ROLE-CHECK.md`). A branch inherits the parent's roles, so the rehearsal uses whatever role
production uses.

---

## 0. Where recovery stands today (evidence, 4 Oct 2026)

| Layer | State | Evidence |
|---|---|---|
| Weekly `pg_dump` to S3 (`.github/workflows/db-backup.yml`) | **Has never succeeded.** 22 of 22 runs failed (first 2026-05-10, latest run 37191501029 on 2026-10-04 09:14 UTC). Each fails at `Validate secrets` before any dump is taken. | `gh run list --workflow db-backup.yml`; `gh run view 37191501029` annotations list all five secrets as missing |
| Required Actions secrets | **0 of 5 present** (`DATABASE_URL_DIRECT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`). The repository has no Actions secrets at all; the `Production`/`Preview` environments have none either (and the job declares no environment). | `gh secret list` (empty), `gh api repos/NoeTopalian/matflow/actions/secrets` → `total_count 0` |
| Dump encryption / retention / access | **Not defined in code.** No client-side encryption; the "30-day lifecycle" exists only in a step name; bucket policy, versioning and lifecycle would live in AWS, and no bucket is configured. | `db-backup.yml` |
| Neon PITR (instant restore) | **Window UNKNOWN.** Plan not confirmed. Neon docs (fetched 4 Oct 2026): Free = 6 hours max (capped at 1 GB of history); paid plans default to **1 day** (Launch up to 7 days, Scale up to 30). | neon.com/docs/introduction/plans, /restore-window |
| Rehearsal | **Never run.** RTO and RPO never measured. | `db-restore.md` §Rehearsal status |
| Approved recovery objectives | **None.** No RPO/RTO is approved anywhere. `db-restore.md` gives unmeasured estimates (PITR RPO < 1 min; RTO "~5 min", later corrected to 15–30 min). | — |
| Dump workflow once secrets exist (added 6 Oct 2026) | **Would still fail.** The workflow installs `postgresql-client-16`; the project runs PostgreSQL **17.11** (`SHOW server_version` on the test branch of the same project). `pg_dump` refuses a newer server. A dump role without `BYPASSRLS` would also abort on the `FORCE`d RLS tables. | `BACKUP-SECRETS-SETUP.md` §3, §5 W-1 |
| Re-check 6 Oct 2026 | `gh secret list` still empty; the last 5 runs (09-06 … 10-04) all failed at `Validate secrets`. | `gh run list --workflow db-backup.yml --limit 5` |

Stated claims that conflict with the provider docs (correction owed, not made here):
- `/legal/privacy` (`app/legal/privacy/page.tsx:81-82`) tells customers the backup window is "typically between 7 and 30 days". On Free it is at most 6 hours; on a paid plan it is 1 day unless someone raised it.
- `db-restore.md` (backup inventory table) and `DEPLOY-2026-10.md:88` say "Free: 7 days". Current Neon docs say 6 hours.

**Is today's imported Total BJJ data backed up?**
- Weekly dump: **No.** No dump has ever been taken, and none will be until the secrets exist. The next scheduled run (Sunday 03:00 UTC) will fail the same way.
- Neon PITR: **Unknown window.** The data lives on the production root branch, so it is covered by Neon's rolling history for as long as that window lasts. Any damage discovered later than the window (6 hours on Free, 1 day by default on paid) cannot be undone. A restore point from *before* the 3 Oct imports has almost certainly expired already unless the window was raised to several days.
- Neon also keeps its own internal backups of storage (encrypted with SSE, retained 30 days, per neon.com/docs/security/security-overview). Customers cannot restore from these themselves, so they are not a recovery path we can rely on.

Storage outside Postgres:
- The imported members and attendance data live **only in Postgres**. The members CSV blob is deleted after commit (`app/api/admin/import/[id]/commit/route.ts` → `deleteImportFile`). Attendance upload chunks are stored in Postgres and deleted when consumed (`lib/import-upload.ts`, `importUploadChunk.deleteMany`). The source TeamUp exports therefore exist only where the operator saved them. **Keep them, under restricted handling. Reconciliation after any restore needs them.**
- Vercel Blob (logos, member photos, waiver signature PNGs, attachments) is written `access: "private"` and encrypted at rest with AES-256 (vercel.com/docs/vercel-blob/security). **It has no backup** (`USER-ACTIONS-2026-08.md` §4 Part B). A database restore brings back URLs, not objects: an object deleted after the restore point stays deleted. Total BJJ had 0 waivers at the 4 Oct reading; member photo count is unverified.
- Neon encrypts data at rest with AES-256 (security overview above).

---

## 1. Authorisation gate **[AUTH]**

The rehearsal copies **real personal data** (every member, including juniors, and attendance history) into a new
branch. Before step 3, Noe records in §8:

1. Approval to create **one** Neon branch from the production root branch, named `rr-<yyyymmdd>`, with a hard deletion deadline of **24 hours** after creation.
2. Who runs it, on which machine. One person and one machine only. No screen-sharing of row data.
3. Approval for that person to hold the branch connection string. **Neon branches inherit the parent's roles and passwords**, so the branch URL carries the *production* password. Treat it as a production secret.
4. Confirmation that nothing in this runbook changes production configuration. No Vercel environment change, no redeploy, no "set as primary", no restore onto the root branch.

Without all four, stop after §2 and record "rehearsal not authorised".

## 2. Read-only pre-checks (operator, Neon console)

1. Neon console → the MatFlow project → **Billing / plan**. Record the plan.
2. Project → **Settings** → the **History window** / instant-restore setting. Record the value (hours/days). With API access: `GET https://console.neon.tech/api/v2/projects/<project_id>` → `project.history_retention_seconds`. With neonctl: `neonctl projects get <project_id> --output json`.
3. Record the **earliest restorable time** = now − window (UTC). That is today's recoverable data age limit.
4. Record the production root branch name/id and that its compute endpoint is `ep-bold-wave…`. The rehearsal must never use that host.
5. Check the branch quota (Free has a low branch and compute-hour allowance) so creating the branch does not fail halfway.
6. Cross-check the window from the restore side (added 6 Oct 2026). Open Branches, then the production root
   branch, then **Restore** (or the "Create branch → Point in time" dialog in §3). Do not confirm anything.
   The time picker refuses times before the earliest restorable point. Record the earliest time it accepts,
   and check it matches step 3 to within a few minutes. If the two disagree, record both and use the later
   one. Console labels change between Neon releases [NEEDS VERIFICATION of the exact names on the day].
   The API field `history_retention_seconds` is the authoritative figure.
7. Record the Postgres version shown on the project dashboard (17.x expected). §5 does not depend on it,
   but a dump restore (Option B) needs a client of the same major version or newer.

CLI set-up if wanted (neonctl is **not installed** on Noe's machine as of 4 Oct 2026): `npm i -g neonctl`, then
`neonctl auth` (opens a browser; operator signs in). `neonctl me` should print the account. Use `--help` on every
command below before running it, because flags change between versions.

## 3. Create the point-in-time branch **[AUTH]**

Pick the target time **T_target (UTC)** inside the window. Use a recent point, e.g. 30–60 minutes ago with
no writes since. Then the expected counts below are the current production counts. Write down **T0** (start
time, UTC).

- Console: Branches → **Create branch** → parent = production root branch → **Point in time** → T_target → name `rr-<yyyymmdd>` → create with a compute.
- CLI:
  ```
  neonctl branches create --project-id <project_id> --name rr-<yyyymmdd> --parent <T_target ISO-8601 UTC>
  neonctl connection-string rr-<yyyymmdd> --project-id <project_id> --pooled
  ```
  (`--parent` with a timestamp branches the default branch at that time; confirm with `neonctl branches create --help`.)

Record **T1** when the branch's compute shows Active.

Store the pooled URL **outside the repository**, e.g. `%TEMP%\matflow-rr\rr.env` containing one line
`RR_DATABASE_URL=postgresql://…-pooler…/neondb?sslmode=require`. Never write it into `.env`, `.env.test` or any
file under the repo. Confirm the host is **not** `ep-bold-wave` and **not** `ep-hidden-salad`.

## 4. Integrity checks against the branch (read-only)

### 4.1 Per-table row counts for one synthetic tenant (added 6 Oct 2026)

The synthetic tenant is the Iron Path demo club (slug `ironpathbjj`, seeded data, no real people). It is
quiet, so its counts at T_target should equal its counts when the baseline is taken. The result is an
exact comparison over **every** table that carries `tenantId`, plus four child tables reached through a
parent. This complements the real-tenant totals in §4.2.

The same read-only SQL runs in two places:
- **Baseline [AUTH, read-only on production]:** Neon SQL Editor on the production root branch, run
  just **before** §3. Save the output as `%TEMP%\matflow-rr\baseline.txt`, which holds counts only.
- **Restored branch:** Neon SQL Editor on `rr-<yyyymmdd>`, or `psql` with the branch URL, after T1.

```sql
-- Read-only. Counts only. The SQL Editor connects as the project owner, which is not subject to RLS;
-- the set_config line makes the result the same under any role.
BEGIN READ ONLY;
SELECT set_config('app.bypass_rls', 'on', true);
WITH t AS (SELECT id FROM "Tenant" WHERE slug = 'ironpathbjj')
SELECT c.table_name AS tbl,
       (xpath('/row/n/text()', query_to_xml(
          format('SELECT count(*) AS n FROM public.%I WHERE "tenantId" = %L', c.table_name, (SELECT id FROM t)),
          false, true, '')))[1]::text::int AS n
FROM information_schema.columns c
WHERE c.table_schema = 'public' AND c.column_name = 'tenantId'
UNION ALL SELECT 'ClassSchedule (via Class)',   count(*)::int FROM "ClassSchedule" s JOIN "Class" k ON k.id = s."classId" WHERE k."tenantId" = (SELECT id FROM t)
UNION ALL SELECT 'ClassInstance (via Class)',   count(*)::int FROM "ClassInstance" i JOIN "Class" k ON k.id = i."classId" WHERE k."tenantId" = (SELECT id FROM t)
UNION ALL SELECT 'ClassSubscription (via Member)', count(*)::int FROM "ClassSubscription" s JOIN "Member" m ON m.id = s."memberId" WHERE m."tenantId" = (SELECT id FROM t)
UNION ALL SELECT 'MemberRank (via Member)',     count(*)::int FROM "MemberRank" r JOIN "Member" m ON m.id = r."memberId" WHERE m."tenantId" = (SELECT id FROM t)
UNION ALL SELECT 'zz latest AuditLog for tenant (epoch s)',
       COALESCE(extract(epoch FROM max("createdAt"))::int, 0) FROM "AuditLog" WHERE "tenantId" = (SELECT id FROM t)
ORDER BY 1;
ROLLBACK;
```

PASS means every row is equal between the baseline and the branch. The last row shows whether the demo
club had any activity between T_target and the baseline. If it did, a difference in those tables is
expected: note it, and do not record PASS for them. A missing table or a zero where the baseline is
non-zero is a FAIL, and the rehearsal stops there.

### 4.2 Real-tenant totals and migrations

Save this as `%TEMP%\matflow-rr\rr-check.mjs` (outside the repo) and run it from a MatFlow checkout so `pg`
resolves: `node --env-file=%TEMP%\matflow-rr\rr.env %TEMP%\matflow-rr\rr-check.mjs`. It prints counts only.

```js
import pg from "pg";
pg.types.setTypeParser(1114, (s) => new Date(s.replace(" ", "T") + "Z"));
const url = process.env.RR_DATABASE_URL ?? "";
const host = url.replace(/^.*@/, "").replace(/[/?].*$/, "");
if (!url || /ep-bold-wave|ep-hidden-salad/.test(host)) { console.error("refusing: not a rehearsal branch host"); process.exit(2); }
console.log("branch host:", host.slice(0, 18) + "…");
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  await c.query("BEGIN READ ONLY");
  await c.query("SELECT set_config('app.bypass_rls','on',true)");
  const one = async (sql, p = []) => Object.values((await c.query(sql, p)).rows[0])[0];
  const tid = await one(`SELECT id FROM "Tenant" WHERE slug='totalbjj'`);
  const n = (t) => one(`SELECT count(*)::int FROM "${t}" WHERE "tenantId"=$1`, [tid]);
  const got = {
    members: await n("Member"), attendance: await n("AttendanceRecord"),
    importedBookings: await n("ImportedBooking"), importedMemberships: await n("ImportedMembership"),
    users: await n("User"), classes: await n("Class"), tiers: await n("MembershipTier"),
    tenants: await one(`SELECT count(*)::int FROM "Tenant"`),
    migrations: await one(`SELECT count(*)::int FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`),
    lastMigration: await one(`SELECT migration_name FROM "_prisma_migrations" ORDER BY finished_at DESC NULLS LAST LIMIT 1`),
  };
  // The expected counts are production figures, held privately (25 Oct 2026): pass them in, never commit them.
  const want = JSON.parse(process.env.REHEARSAL_EXPECTED ?? "{}");
  for (const [k, v] of Object.entries(got)) console.log((k in want ? (want[k] === v ? "PASS " : "FAIL ") : "INFO ") + k + " = " + v + (k in want ? " (expected " + want[k] + ")" : ""));
} finally { await c.query("ROLLBACK").catch(() => {}); await c.end(); }
```

Expected: the same script's figures from production at T_target, held in Noe's private evidence folder (the
4 Oct 2026 figures are there; they are customer totals and are not kept in this repository). If
production changed after T_target, compare with the same script's figures from production at T_target instead.
The operator gets those with the existing read-only scripts. Any difference must be explained before PASS.

**Attendance reconciliation.** `scripts/readiness/attendance-reconcile.mjs` has a `--restore-branch` mode (added
4 Oct 2026): it reads `RECONCILE_DATABASE_URL` only, refuses the production (`ep-bold-wave`) and test (`ep-hidden-salad`)
hosts, and stays inside a READ ONLY transaction:
```
set RECONCILE_DATABASE_URL=<branch pooled URL>
node scripts/readiness/attendance-reconcile.mjs --csv <source attendance CSV> --tenant totalbjj --restore-branch --ledger %TEMP%\matflow-rr\private-ledger.json
```
Expected: RECONCILED 7/7 with the figures recorded for production (bookings, visits and sessions created; held privately). The source CSV is real personal data: read it from where the operator keeps it, and never copy it into the repo.

Record **T2** when the checks finish.

## 5. Isolated production build pointed at the branch **[AUTH, local only]**

Goal: the deployed code boots as a production build on the branch and **cannot reach any outside service**.
The deployed commit was `e8afb6a` on 4 Oct 2026. **Re-verify it on the day** in Vercel (Deployments,
then Production, then the commit), and use that SHA everywhere `e8afb6a` appears below. A rehearsal of
code that is not deployed proves nothing about production recovery.

1. Fresh worktree so no `.env*` file can be loaded and the shared `.next` is untouched:
   ```
   git worktree add %TEMP%\matflow-rr\wt e8afb6a
   cd %TEMP%\matflow-rr\wt && npm ci && npx prisma generate
   ```
   Check that `dir /a %TEMP%\matflow-rr\wt\.env*` finds **nothing**. Next.js loads `.env*` from the working
   directory, so with none present the production secrets cannot leak in.
2. Build and start with an explicit environment and nothing inherited from a `.env`. Every outbound path is
   disabled. (This adapts the "isolated" flag of the 2 Oct teamup-2 rehearsal launcher.)

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | branch pooled URL | the target; guard: not `ep-bold-wave` / `ep-hidden-salad` |
| `AUTH_SECRET`, `NEXTAUTH_SECRET` | fresh random 32 bytes, **never production's** | no production session or token is valid here |
| `MATFLOW_ADMIN_SECRET` | fresh random | boot guard requires it; unusable elsewhere |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_CLIENT_ID` | `sk_test_invalid_rr` / `whsec_invalid_rr` / `ca_invalid_rr` | boot guard needs values; Stripe rejects all of them |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | empty | |
| `RESEND_API_KEY` | `re_invalid_rr_never_sends`; `RESEND_FROM` empty; `RESEND_WEBHOOK_SECRET` empty | Resend rejects every send |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | empty | no push |
| `BLOB_READ_WRITE_TOKEN` | empty | no Blob read/write/delete (photos will not render; expected) |
| `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | empty; `ENABLE_GOOGLE_OAUTH=false`, `NEXT_PUBLIC_ENABLE_GOOGLE_OAUTH=false` | no AI, Drive or OAuth calls |
| `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | empty | no telemetry |
| `CRON_SECRET` | empty | every `/api/cron/*` answers 503; there is no Vercel scheduler locally anyway |
| `TESTING_MODE=false`, `E2E_BYPASS_TOKEN`, `DEMO_MODE` empty | | no test bypass |
| `MAINTENANCE_MODE` | `true` (until §5.4) | every route except `/api/health`, `/api/auth`, `/login` and `/_next` returns 503 (the `MAINTENANCE_MODE` block in `proxy.ts`, about line 170 on 6 Oct 2026), so nothing can write tenant data |
| `NEXTAUTH_URL`, `AUTH_URL`, `APP_URL` | `http://127.0.0.1:<port>`; `AUTH_TRUST_HOST=true` | no production links are generated |
| `VERCEL_ENV`, `VERCEL_URL` | unset | |

   Run `npx next build`, then `npx next start -H 127.0.0.1 -p <free port, not 3847>`. Bind to loopback only.
3. Smoke test (no sign-in. Nobody's credentials are used against this copy):
   - `GET http://127.0.0.1:<port>/api/health` → 200 and database reachable.
   - `GET /dashboard` → 503 maintenance JSON (shows the switch is holding).
   - Server log shows no outbound call succeeding. Any Stripe/Resend attempt must show an auth failure.

Record **T3** when health passes.

4. **Sign-in with a synthetic account (added 6 Oct 2026).** Health only proves a connection. This step
   proves the restored `User` rows, password hashes and session issuance work end to end.
   - Stop the server and restart it with the same environment, except `MAINTENANCE_MODE=false`. Every
     outbound key is still invalid or empty, `CRON_SECRET` is still empty, and the server is still bound to
     `127.0.0.1`. Writes now land **only on the throwaway branch** (login events, audit rows), which is
     deleted in §7.
   - Sign in at `http://127.0.0.1:<port>/login` with club code `IRONPATHBJJ` as the Iron Path **demo** owner.
     The credentials are in the password manager; never paste them into this document. **Never use a
     totalbjj account, and never Sean's.**
   - PASS: the credentials are accepted, and the app lands on the dashboard, the authenticator challenge
     (if that account has enrolled) or the forced-enrolment page. Each of these proves the credential
     check and session issuance on restored data. Enrolling a factor is not required. If someone does
     enrol to reach the dashboard, that factor exists only on the branch.
   - With a dashboard session, open Members and check the count matches §4.1 `Member`.
   - Record **T4** when sign-in passes. Then stop the server.

## 6. What to record (RTO / RPO)

| Measure | Definition |
|---|---|
| Branch creation | T1 − T0 |
| Verification | T2 − T1 |
| App on restored data | T3 − T0 = **rehearsed RTO, excluding cut-over** |
| Usable app on restored data | T4 − T0 (sign-in on a synthetic account passed) |
| Data age at restore | T0 − T_target. Also record the latest `createdAt` in `AuditLog` on the branch, which is the newest write the restored copy actually holds |
| Unrehearsed cut-over | Vercel env change, redeploy and pre-flight list in `db-restore.md`. Estimate 10–20 min, unmeasured. |
| RPO achieved | (moment the restored data represents = T_target) vs the latest production write before it. With PITR this is seconds, **inside the window only** |
| Recoverable data age | history window from §2. Damage found later than this is unrecoverable while the dump stays broken |

Compare these with an objective only once Noe approves one. Until then, write "no approved RPO/RTO" next to the numbers.

## 7. Cleanup **[AUTH, mandatory, within 24 h]**

1. Stop the server. `git worktree remove --force %TEMP%\matflow-rr\wt`.
2. Delete the branch: console Branches → `rr-<yyyymmdd>` → ⋯ → Delete, or
   `neonctl branches delete rr-<yyyymmdd> --project-id <project_id>`. Confirm with `neonctl branches list`.
   **Check the name twice. Never delete the root branch.**
3. Delete `%TEMP%\matflow-rr\` completely (env file, check script, private ledger).
4. Record the cleanup time in §8.

## 8. Rehearsal record (fill in; no personal data, counts only)

| Field | Value |
|---|---|
| Authorised by / date | |
| Run by / machine | |
| Neon plan / history window | |
| T_target (UTC) | |
| Earliest restorable time seen in the console (§2.6) | |
| Deployed SHA used in §5 | |
| T0 / T1 / T2 / T3 / T4 (UTC) | |
| §4.1 synthetic per-table counts: tables compared / equal / explained differences | |
| Counts (members / attendance / bookings / memberships / migrations) | |
| Reconcile result | |
| §5.4 synthetic sign-in result (dashboard / challenge / enrolment page) | |
| Rehearsed RTO (T3 − T0, T4 − T0) and data age (T0 − T_target) | |
| Verdict (BACKUP UNVERIFIED stays until every row above is filled and passing) | |
| Outbound calls observed | |
| Branch deleted at (UTC) | |
| Deviations | |

## Not covered here

- Cutting production over to a restored branch (needs a staging deployment; `db-restore.md` Option A 5–8).
- Restoring from S3 (Option B). There is nothing in S3. Once a dump exists, its restore test is
  `BACKUP-SECRETS-SETUP.md` §6, which reuses §4 of this runbook for the integrity checks.
- Blob objects. They have no backup.
- DSAR replay after a real restore (`db-restore.md` §Re-applying DSAR erasures). Not needed for a throwaway branch.
