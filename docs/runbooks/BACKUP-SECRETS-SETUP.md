# Weekly database backup: secrets and least-privilege setup

Status: **BACKUP UNVERIFIED** (6 Oct 2026). No dump has ever been taken. Configuring the secrets is **not**
the acceptance gate. The gate is a green run that uploads a dump of current data, followed by an isolated
restore of that dump with integrity checks (§6). This file covers the setup. `RESTORE-REHEARSAL-ISOLATED.md`
covers the restore. The workflow's client-version and integrity-check defects were changed locally on
6 Oct 2026 but have never run (§5).

## 1. Evidence (read-only, 6 Oct 2026)

- `gh secret list` on the repository returns **nothing**: 0 Actions secrets. The job declares no
  `environment:`, so environment secrets would not reach it either.
- `gh run list --workflow db-backup.yml --limit 5`: five failures, every one a scheduled run on `main`.
  The runs are 37191501029 (2026-10-04), 36307478583 (09-27), 35498891626 (09-20), 34746356344 (09-13) and
  34019317170 (09-06). The 4 Oct run's log shows the `Validate secrets` step reporting all five secrets as
  missing, so no dump step ran. The earlier runbook records 22 of 22 failures since 2026-05-10.
- The Neon project runs **PostgreSQL 17.11**. This was read from the test branch of the same project with
  `SHOW server_version`. Neon sets the Postgres version per project.

## 2. The five secrets the workflow reads (exact names, from `.github/workflows/db-backup.yml`)

| Secret | Used by step | Purpose | Least-privilege value |
|---|---|---|---|
| `DATABASE_URL_DIRECT` | Validate secrets, Take logical dump | `pg_dump` connection. **Non-pooled** host: the hostname must **not** contain `-pooler`, because `pg_dump` cannot run through PgBouncer's transaction pooling. | `postgresql://matflow_backup:<pw>@<ep-…>.<region>.aws.neon.tech/neondb?sslmode=require` using the dedicated read role in §3, **not** `neondb_owner` |
| `AWS_ACCESS_KEY_ID` | Validate, Upload, Verify | Access key of the IAM principal that writes dumps | Key of the write-only IAM user in §4 |
| `AWS_SECRET_ACCESS_KEY` | Validate, Upload, Verify | Its secret | |
| `BACKUP_S3_BUCKET` | Validate, Upload, Verify | Bucket name. Objects are written to `s3://<bucket>/<UTC stamp>/matflow-db.dump`, at the bucket root with no prefix. | A bucket used **only** for MatFlow DB dumps, so that "whole bucket" is the narrowest scope the current key layout allows |
| `BACKUP_S3_REGION` | Validate; exported as `AWS_DEFAULT_REGION` for Upload and Verify | Bucket region | The bucket's region (the workflow comment's example is `eu-west-2`; use whatever the bucket is in) |

Set each secret with `gh secret set <NAME>`, which prompts for the value. Alternatively use GitHub, then
Settings, Secrets and variables, Actions, New repository secret. Never put a value on a command line,
because it would land in shell history. Never paste one into an issue, chat or this repository.

## 3. Database role for the dump (`matflow_backup`)

Why not `neondb_owner`: it can write and run DDL. A leaked backup secret should give read access at most.

Why the role needs `BYPASSRLS`: RLS is `FORCE`d on the tenant tables. `pg_dump` runs with
`row_security = off` and **aborts** ("query would be affected by row-level security policy") on any such
table when the role cannot bypass RLS. A role without `BYPASSRLS` therefore produces no backup. The
`--enable-row-security` flag is not an alternative: it would dump only the rows the policies show, which
is none. Reading all data is what a backup is, so the risk is managed by keeping this role read-only and
its password only in the Actions secret.

Run as `neondb_owner` in the Neon SQL Editor. Run it on the **test branch first**, then on production with
Noe's authorisation. `neondb_owner` holds `CREATEROLE` and `BYPASSRLS` on this project (probed on the test
branch, 6 Oct 2026). PostgreSQL 16 and later lets only a role that has `BYPASSRLS` create a role with it.
[NEEDS VERIFICATION that Neon permits it. If it refuses, stop and record the error; do not fall back to
`neondb_owner` without a decision.]

```sql
CREATE ROLE matflow_backup LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE
  CONNECTION LIMIT 2 PASSWORD '<generated, 32+ chars>';
GRANT USAGE ON SCHEMA public TO matflow_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO matflow_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO matflow_backup;
-- Tables added by future migrations (which run as neondb_owner):
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT SELECT ON TABLES TO matflow_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public GRANT SELECT ON SEQUENCES TO matflow_backup;
-- Verify: superuser false, bypassrls true, NOT a member of neon_superuser.
SELECT rolsuper, rolbypassrls, pg_has_role('matflow_backup', 'neon_superuser', 'member')
FROM pg_roles WHERE rolname = 'matflow_backup';
```

Branches inherit roles. A Neon branch created later (for a restore rehearsal) will contain
`matflow_backup` with the same password, so treat that branch's URLs as production secrets.

Test the role on the test branch before production, from a machine with a **PostgreSQL 17** client:
`pg_dump --format=custom --no-owner --no-privileges --file=%TEMP%\bk-test.dump "<test-branch direct URL as matflow_backup>"`
should finish without an RLS error. Then `pg_restore --list %TEMP%\bk-test.dump` should list every table.
Delete the file afterwards. The test branch holds synthetic data only, but treat the file carefully all the
same.

## 4. AWS: bucket and write-only IAM principal

Bucket (one bucket used only for these dumps):
- Block Public Access: all four settings on.
- Default encryption: SSE-S3 at minimum, or SSE-KMS with a dedicated key if key-level audit is wanted.
- Versioning: on, so an overwrite or delete through a leaked key cannot destroy earlier dumps. Optionally
  add Object Lock in governance mode with 30-day retention, for deletion protection against a compromised
  account.
- Lifecycle: expire current versions after 30 days and non-current versions after 30 days. The workflow
  step is **named** "with 30-day lifecycle" but configures no lifecycle. Retention exists only if it is set
  on the bucket.
- Bucket policy: deny any request where `aws:SecureTransport` is `false`.

IAM user `matflow-backup-writer` (name is a suggestion). Programmatic access only, no console password.
Policy, with `<bucket>` substituted:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "WriteDumps", "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::<bucket>/*" },
    { "Sid": "ListForVerifyStep", "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::<bucket>" }
  ]
}
```

There is no `GetObject` and no `DeleteObject`, so a leaked writer key cannot read or remove past dumps.
`ListBucket` exists only for the workflow's `aws s3 ls` verify step. If SSE-KMS is used, also allow
`kms:GenerateDataKey` on that one key ARN.

A separate **reader** principal (`s3:GetObject` and `s3:ListBucket` on the same bucket) is used only for
restores. Its keys stay with Noe, offline, and are **never** stored in GitHub.

## 5. Defects in the workflow that block a working backup even once secrets exist

W-1, W-2 and W-4 were changed in `.github/workflows/db-backup.yml` on 6 Oct 2026 (lane F). The YAML parses
and every `run:` block passes `bash -n`, but the workflow has **not been executed**. The first
`workflow_dispatch` run after the secrets exist is the real test (§6). The five secret names are
unchanged.

| # | Defect | Effect | Status / change |
|---|---|---|---|
| W-1 | It installed `postgresql-client-16`. The server is **17.11**. | `pg_dump` 16 refuses a newer server ("aborting because of server version mismatch"), so the first run with secrets set would still have failed. | **Changed, unexecuted.** Installs `postgresql-client-17` and calls `/usr/lib/postgresql/17/bin/pg_dump` (`$PG_BIN`) explicitly, because the runner image ships its own older client on `PATH`. The step fails if that binary does not report version 17. |
| W-2 | It used `apt-key add` | Deprecated on current Ubuntu runners | **Changed, unexecuted.** The PGDG key is saved to `/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc` and referenced with `signed-by=` in the sources line (the PGDG-documented layout). |
| W-3 | "30-day lifecycle" exists only in a step name | Retention undefined | Open. Configure it on the bucket (§4). Optionally assert it with `aws s3api get-bucket-lifecycle-configuration` (needs one extra read permission). |
| W-4 | No readability check of the dump | A truncated or corrupt dump would upload "green" | **Changed, unexecuted.** New step "Check dump integrity (pg_restore --list)" runs before the upload. It fails the job, with an error in the run summary, when the file is empty, when `pg_restore --list` cannot read it, when it lists no tables or no table data, or when any of `Tenant`, `Member`, `User` or `_prisma_migrations` has no data section. Only counts are logged. The table-name matching was tested against a hand-written sample listing, not a real dump, so a false failure on the first run is possible and would need the pattern adjusting. |
| W-5 | Secrets are repository-wide | Any workflow edited on any branch by a collaborator can read them | Open (needs Noe in GitHub settings). The job now declares `permissions: contents: read`, but that does not restrict secrets. Move them to a GitHub Environment (for example `backup`) restricted to `main`, and add `environment: backup` to the job. The secret names stay the same. Better still: replace the AWS key pair with GitHub OIDC and an IAM role trust policy, which removes the two AWS secrets entirely. |
| W-6 | Keys sit at the bucket root (`<stamp>/matflow-db.dump`) | Cannot scope IAM to a prefix in a shared bucket | Open. Keep a dedicated bucket (§4), or change the key to `matflow/<stamp>/matflow-db.dump` and scope the policy to `<bucket>/matflow/*` |

## 6. Acceptance (all required before anyone writes "backed up")

1. A `workflow_dispatch` run of `Database backup (logical pg_dump)` is **green**, including the verify step.
2. The object exists in S3 with the expected stamp, and its size is plausible against the database size.
3. The restore is tested. Download the dump with the **reader** principal. Restore it into an isolated
   target: a fresh empty Neon branch or project, or a local PostgreSQL 17, using
   `pg_restore --no-owner --no-privileges -d <empty target>`. Then run the integrity checks of
   `RESTORE-REHEARSAL-ISOLATED.md` §4 against it.
4. Record the run id, the dump stamp, the restore duration and the data age, using the record table in
   `RESTORE-REHEARSAL-ISOLATED.md` §8.

Until all four are done: **BACKUP UNVERIFIED**. Neon point-in-time restore is a separate recovery path,
with its own window (§2 of the rehearsal runbook). Missing workflow secrets do not prove Neon cannot
recover. Equally, an unverified Neon window is not evidence of recovery.

## 7. Recovery dependencies outside the dump

- `AUTH_SECRET`: `lib/encryption.ts` derives the AES-256-GCM key for stored Google Drive tokens from it.
  It also signs every session. A restore onto a deployment with a **different** `AUTH_SECRET` cannot decrypt
  those tokens, and every session becomes invalid. Keep the production value in the password manager,
  apart from Vercel.
- Vercel Blob objects (logos, member photos, waiver signatures, attachments) are **not** in the dump and
  have no backup. A restored database points at blobs that may since have been deleted.
- The source TeamUp export files are needed to re-run attendance reconciliation after a restore. They are
  held by the operator, not the system.
