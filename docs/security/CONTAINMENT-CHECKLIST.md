# Production containment checklist — MatFlow (redacted)

Lane E2, security campaign iteration 2, 9 Oct 2026. Branch `security/assurance-2026-10`, HEAD `6043fed` when this was
written. Production serving `e8afb6a` (built 2026-10-04T02:32Z). Status: **PREPARED, NOTHING EXECUTED IN PRODUCTION**.

This file holds no secret value, no full connection string and no provider credential. Credentials are named by
variable and by a 12-hex SHA-256 fingerprint. The unredacted working inventory is kept outside the repository
(`<scratchpad>/security/E2/PRIVATE-credential-inventory.md`); it also holds no values. All times are UTC.

**Authority.** The agent may observe read-only and prepare. Every production change below is Noe's action, done in
the provider's own console or with Noe's own CLI. Earlier refusals stand and were not retried by any route:
production database read by an agent (SF-02), bulk deletion of old deployments (iteration 1), the append-only AuditLog
migration and CI edits (SF-57/SF-58). A merge or push to `main` is a production deployment **and** a production
migration (Vercel builds `main`; the build runs `prisma migrate deploy`).

## 1. Observation register (what this checklist rests on)

| ID | Observation | Source (read-only) | UTC |
|---|---|---|---|
| O1 | 64 production deployments (62 READY, 2 ERROR), 0 preview; 59 distinct SHAs, all `main`; oldest 2026-09-11T19:17 (`c6a1774`), newest 2026-10-04T02:32 (`e8afb6a`). Identical URL and SHA set to the lead's inventory file (00:29) | `vercel ls matflow --prod/--all --format json`, 4 pages each, CLI 59.1.4 | 17:28:58 |
| O2 | 14 aliases: 4 production aliases on the serving deployment; 10 `matflow-git-<branch>-…vercel.app` aliases whose target deployment ids are not found (deleted), aged 50–125 days | `vercel alias ls --format json`; `vercel inspect <id>` ×10 | 17:29–17:30 |
| O3 | Serving build: Node `24.x` project setting, functions `nodejs24.x`, build CLI 62.1.0, region lhr1; migrations ran with `DATABASE_URL`; Prisma datasource host = `ep-bold-wave-abt39t7x` **direct (not `-pooler`)**; npm did not run 5 dependency install scripts (allowScripts) | `vercel inspect --logs` on the serving URL; redacted extract `evidence/E2/build-log-extract-e8afb6a.txt` | 17:30 (log of 2026-10-04T02:32) |
| O4 | 19 Production/Preview variables with type, targets, createdAt, updatedAt; no values | `vercel env ls --format json`, value field dropped in the pipe; `evidence/E2/vercel-env-metadata-2026-10-09.json` | 17:31:56 |
| O5 | DNS: no apex TXT/SPF, no apex MX, no `_dmarc`; `send` SPF `include:amazonses.com ~all` + MX to SES eu-west-1; DKIM TXT at `resend._domainkey` (1024-bit RSA prefix); wildcard answers A | Google DNS-over-HTTPS; `evidence/E2/dns-passive-2026-10-09.json` | 17:35:43 |
| O6 | Project: SSO `all_except_custom_domains`; no password protection, trusted IPs, OPTIONS allowlist or protection-bypass tokens; retention 30 days for production/preview/canceled/errored, keep 10; OIDC enabled (team issuer); fork protection on; Git deployments enabled, production branch `main`, 0 deploy hooks; crons enabled since 2026-04-24; no rollback ever recorded; team plan **Hobby** | `vercel api /v9/projects/matflow` and `/v2/teams`, fields picked in the pipe; `evidence/E2/vercel-project-settings-2026-10-09.json` | 17:37:02 |
| O7 | GitHub: repository public; `main` not protected (HTTP 404); 0 rulesets; secret scanning and push protection on, validity checks off, Dependabot security updates off; 0 secret-scanning alerts (open or resolved); CI on `e8afb6a` = failure; last 3 backup-workflow runs = failure | `gh api` (repo, branch protection, rulesets, secret-scanning alerts with value fields dropped, actions runs) | 17:38–17:39 |
| O8 | Blob stores: 3. Private `matflow-blob` (iad1, 12 objects, 814,630 bytes, connected to production+preview+development, host fp `47cdb2caa57e`); public `matflow-blob` (lhr1, 0 objects, unconnected, fp `283587ce482d`); public `matflow-blobbby` (iad1, 0 objects, unconnected, fp `ba4940e3fbc9`). Counts are dashboard metadata | `vercel api /v1/storage/stores`, ids fingerprinted in the pipe | ~17:40 |
| O9 | Provider docs read: Vercel deployment retention + 30-day restore window; Vercel Hobby runtime-log retention **1 hour**; Vercel private Blob (OIDC preferred over the long-lived token); Neon role reset ("takes effect immediately… old password stops working on the next connection"; no CLI; no connection/audit logs documented on that page); Resend API keys (values never viewable; delete supported; last-used shown); Resend DMARC staging; RFC 7489 §6.3, §6.6.3, §7.1 | vercel.com/docs, neon.com/docs/manage/roles, resend.com/docs, rfc-editor.org | 17:40–17:50 |

Not observed (UNKNOWN, not "safe"): any secret value; the Production values of TESTING_MODE, LOGIN_THROTTLE_ENABLED,
RESEND_FROM; which Postgres role the app uses; Neon IP Allow, PITR window and backups; Resend/Stripe/Neon key lists;
GitHub/Vercel/Neon/Stripe/Resend 2FA; live TLS and headers; cron invocation logs.

## 2. Credential inventory (redacted)

"Usable" means the exposed material alone authenticates. "Planning status" follows the brief: a usable exposed value
whose revocation is not demonstrated is treated as **compromised**.

| # | Credential (variable) | Service and permission | Exposure, source and time | Fingerprint / provider id | Consumers (O1, O4) | Usable? | Planning status |
|---|---|---|---|---|---|---|---|
| C1 | Neon role password inside `DATABASE_URL` | Neon Postgres, production endpoint `ep-bold-wave-abt39t7x`; role presumed owner-level (migrations run with it, O3) — full read/write/DDL | Public git history, commit `fa3c460`, authored 2026-05-07T14:17:51Z, copied from the laptop `.env`; still public | `af8167cf87cc` (`npg_` form, 16 chars) | Vercel Production `DATABASE_URL` (Sensitive, updated 2026-05-07T13:59Z, unchanged since); all 64 builds hold the current value; laptop `.env` | **Yes**, if the same role still has that password | **Compromised for planning** until §4 evidence |
| C2 | `RESEND_API_KEY` | Resend, permission level UNKNOWN (full or sending-only); sends mail as the verified domain | Same commit, full key | `7879e88681d3` (`re_` form, 36 chars) | Vercel Production+Preview (created 2026-05-07T09:03Z, never updated); all 64 builds | **Yes**, until the key is deleted at Resend | **Compromised for planning** |
| C3 | `CRON_SECRET` | Bearer for `/api/cron/*` (retention purge, class generation, reports) | Same commit, 64 hex | `f71010f7e71b` | **No current variable** in any environment (O4). Whether any of the 64 builds holds a CRON_SECRET is UNKNOWN (deleted variables leave no trace) | Yes, against a build holding that exact value | **Contained if** the cron log shows 503 on the serving build (§4 step 5); old builds sit behind SSO |
| C4 | `STRIPE_SECRET_KEY` | Stripe restricted live key | Same commit, **first 25 characters only** | `7d3bddd6e499` (prefix) | Production+Preview (updated 2026-05-07T12:41Z, never after); all 64 builds | **No** (prefix only; a prefix is not a secret key). Also reused as a test fixture (iteration-1 E-06) | Not exposed. Roll as hygiene with the release |
| C5 | `BLOB_READ_WRITE_TOKEN` | Vercel Blob, read/write on the private store `47cdb2caa57e` (member photos, waiver signatures, import CSVs) | (a) `/api/blob-image` in every deployed build forwards it as `Authorization: Bearer` to any `*.blob.vercel-storage.com` host carrying the caller's tenant prefix (SF-28; anchored pattern, so only Vercel-operated hosts). (b) Stored non-sensitive: readable by anyone with project access and written to Development `.env` files by `vercel env pull` | Store host fp `47cdb2caa57e`; created 2026-04-30T00:37Z, never rotated | Production+Preview+Development; all 64 builds | Recipient in (a) is Vercel, the issuer; whether another store's owner can see request headers: **UNKNOWN**, no documented mechanism. Historic use **cannot be reconstructed** (Hobby logs keep 1 hour) | Treat as **possibly exposed**; rotate only **after** the SF-28 fix is live |
| C6 | `NEXTAUTH_SECRET` | Session JWT signing | Not leaked. Shared variable name on Preview; whether the Preview value equals Production is UNKNOWN | — | Production+Preview; all 64 builds | n/a | Hygiene: distinct Preview value; rotate at the release (forces re-login) |
| C7 | `MATFLOW_ADMIN_SECRET` | Legacy operator shared secret | Not leaked. Updated 2026-10-03T11:56Z: **62 builds hold an older value**, 2 hold the current one | — | Production+Preview | n/a | Rotation never reaches old builds; deletion of old builds is the control (release package already requires rotation) |
| C8 | `STRIPE_WEBHOOK_SECRET`, `STRIPE_CLIENT_ID`, `RESEND_FROM`, `NEXT_PUBLIC_*`, `SENTRY_DSN` | Webhook verification; Connect client id (public identifier); sender address; public keys/DSN | Not leaked | — | Production(+Preview) | n/a | No action beyond Preview separation |

## 3. New facts from this pass that change the plan

1. **The rotation note and the Vercel record disagree.** The 9 May note in `2ee3bfb` says Resend, Stripe and CRON were
   rotated on 9 May and the DB password on 7 May. Vercel shows `RESEND_API_KEY` created 7 May 09:03 and never changed,
   `STRIPE_SECRET_KEY` last changed 7 May 12:41, and `DATABASE_URL` last changed 7 May 13:59 — 18 minutes **before** the
   leaking commit was authored (O4 vs git). Three readings remain open and are not adjudicated here: the laptop keys
   differed from the Vercel keys (so the rotation touched laptop keys only); the leaked keys were never revoked; or they
   were revoked and production Resend/Stripe calls have failed since 9 May. Provider dashboards decide (§4 step 1).
2. **Production runtime and migration identity are the same, on the direct host.** The serving build migrated with
   `DATABASE_URL` on `ep-bold-wave-abt39t7x` without `-pooler` (O3); `MIGRATION_DATABASE_URL` does not exist (O4).
   Iteration-1 E-07 said the host was pooled; that was an expectation, now corrected. Consequences: the runtime role
   can run DDL (SF-62/SF-57 context); connections are not pooled by PgBouncer (capacity, lane F).
3. **Deleting a deployment is not erasure.** Retention is already 30 days for production (O6), so the oldest builds
   start expiring around 11 Oct; any deleted or expired build stays restorable from "Recently Deleted" for 30 days
   (O9). Only provider-side revocation actually cuts an old build off.
4. **No historic forensics are possible from Vercel**: Hobby runtime logs keep 1 hour (O9). Whether C1, C2, C3 or the
   blob proxy were abused before today cannot be established from Vercel data.
5. **`LOGIN_THROTTLE_ENABLED` is set on Production** since 2026-09-23T09:48 (O4); its value is Sensitive. The code
   treats only the exact string `false` as off. If the value is `false`, the 6 newest builds, including the serving
   one, run with no sign-in throttle. Noe confirms the value or deletes the variable (default is on).
6. **npm on Vercel did not run dependency install scripts** in the serving build (O3); iteration-1 SEC-060 assumed it did.

## 4. Safely ordered containment plan

Decision rule: steps 1–2 decide whether a usable leaked value is live. If any is, steps 3–4 run **now** as an
emergency containment on the current code (a redeploy of `e8afb6a` with new variables; no code change). If none is,
they run as hygiene with the campaign release. Never Instant Rollback or Promote an old deployment at any point.

| Step | Action (who / where) | Approval needed | Impact: current app · queued jobs · old builds · rollback | Evidence to return (redacted) |
|---|---|---|---|---|
| 0 | **Preserve evidence first.** Resend: screenshot API-keys list (name, permission, created, last used, request count) and Logs for the available window. Stripe: Developers → API keys (restricted keys, created, last used) and request logs filtered per key. Neon: Roles list; project Operations/activity if offered. Vercel: env metadata JSON (already captured here, O4). | Noe (read-only in consoles) | None. Limits: Vercel runtime logs 1 h (Hobby); Resend/Stripe log retention per plan — unknown here; Neon documents no connection log on the roles page, so DB misuse since May **cannot be ruled in or out** | Screenshots with values absent (Resend/Stripe never show full keys) |
| 1 | **Offline fingerprint check** of what the laptop holds: `node scripts/readiness/ops-credential-fingerprint.mjs --from-env-file .env --var DATABASE_URL --var RESEND_API_KEY --var STRIPE_SECRET_KEY --var CRON_SECRET`. Offline; prints MATCH/no match only. The option is `--from-env-file` (changed in lane E3): Node 24 intercepts `--env-file` even after the script name, loads the file into the process and, if the path is wrong, prints the path. `--var` takes UPPER_CASE names; an argument mistake reports only its position, never the value; `KEY="…" # comment` lines are read as dotenv reads them. | Noe (laptop) | None | Script output (no values) |
| 2 | **Identify the runtime role** (Neon SQL Editor, production, read-only): `select usename, count(*) from pg_stat_activity where datname = current_database() and usename is not null group by 1;` then Roles → note whether that role is the one whose password leaked (owner role). | Noe | None | Role name + count |
| 3 | **Resend (C2)**: create a new **sending-only** key restricted to `matflow.studio`; set it in Vercel **Production only**, Sensitive; remove `RESEND_API_KEY` from Preview; redeploy (step 3a); then **delete every key created on or before 2026-05-07T14:17Z** — Resend never displays values, so provenance cannot be proven otherwise. | Noe: Resend console; Vercel env; **production redeploy** | Current app: mail uses the old key until the redeploy completes. Queued jobs: none (crons do not run). Old builds: lose mail at deletion (intended). Rollback: a deleted key cannot be restored; fix forward with a new key | Key list after deletion showing no key ≤ 7 May 14:17 (dates only); Vercel `updatedAt` for RESEND_API_KEY after today |
| 3a | **Redeploy for new variables**: Vercel → the serving deployment → Redeploy **without build cache**, same commit `e8afb6a`, or ship the campaign candidate if its gates have passed. A redeploy re-runs `prisma migrate deploy` (no pending migrations at `e8afb6a`). | Noe: **production deploy** | ~3 min build; the old serving build keeps answering until the new one is aliased | `vercel ls --prod` shows the new deployment READY on the 4 production aliases |
| 4 | **Neon (C1)** if step 1 shows MATCH, or step 2/0 cannot exclude it: Roles → the runtime role → **Reset password**; put the new URL in Vercel Production `DATABASE_URL` (keep the **direct** host for this emergency, because `e8afb6a` has no `MIGRATION_DATABASE_URL` support and migrations should not run through PgBouncer); redeploy (3a) immediately; update or, better, remove production credentials from the laptop `.env`. If step 1 shows MATCH and the laptop held the production value, open a **personal-data-breach assessment** (UK GDPR notification clock) — the production database password would have been public since May. | Noe: Neon console; Vercel env; production deploy | Current app: new connections fail between reset and the new build (~3–5 min; existing pooled connections are not stated to drop). Stripe webhooks failing in that window are retried by Stripe. Queued jobs: none. Old builds: lose the database (intended). Rollback: the old password cannot be restored; fix forward | Negative test by Noe with the previous password from his own copy → `password authentication failed`; fingerprint of the new value = no match; Vercel `updatedAt` for DATABASE_URL after today |
| 5 | **CRON (C3)**: Vercel → Cron Jobs → logs of the serving deployment: a 503 "CRON_SECRET not configured" proves the serving build holds no CRON_SECRET, so C3 authenticates nothing reachable without SSO. Do **not** set CRON_SECRET yet (§8). When it is set: fresh 32-byte random, fingerprint-checked ≠ `f71010f7e71b`. | Noe (read-only) | None | Status code of the last cron invocation |
| 6 | **Blob (C5)** — only **after** the SF-28 store pin is live in production: regenerate the private store's read/write token (store settings; exact control name to be confirmed in the dashboard), store it **Sensitive, Production only**, no Preview/Development copy; redeploy. Target state: OIDC (already enabled on the project) once the code no longer derives the store from the token (lane C/lead change). | Noe: Vercel Storage + env; production deploy | Photos/waiver reads fail between regeneration and the new build. Old builds lose Blob (intended). Rollback: fix forward | Store token "created" date after today; env metadata shows Production-only, Sensitive |
| 7 | **Stripe (C4)**: roll the restricted key with an overlap expiry (Stripe "roll key"), set new value in Production only, redeploy, let the old one expire. Preview gets test-mode keys. | Noe: Stripe; Vercel; production deploy | No outage with an overlap expiry. Old builds lose Stripe at expiry | API-keys page: old key expired |
| 8 | **Preview separation and flags**: give Preview its own NEXTAUTH_SECRET; delete Preview copies of MATFLOW_ADMIN_SECRET, STRIPE_WEBHOOK_SECRET, live Stripe and Resend keys; delete `TESTING_MODE` from Production; confirm or delete `LOGIN_THROTTLE_ENABLED`. | Noe: Vercel env | None until the next build | Env metadata JSON re-run (lead) |
| 9 | **Retire old deployments** after the new production deployment passes `release-verify --target production`: delete the 63 older production deployments in `evidence/E2/retirement-list-2026-10-09.tsv` (61 READY + 2 ERROR; then `e8afb6a` itself once superseded) and the 10 dangling branch aliases in `evidence/E2/vercel-aliases-2026-10-09.json`. Do not restore anything from "Recently Deleted". | Noe (dashboard, or Noe's own `vercel remove`/`vercel alias rm`). The agent's earlier deletion attempt was denied; that denial stands | None for the serving app. Rollback = redeploy a commit with current variables, never a restore | `vercel ls --prod` = 1 deployment; `vercel alias ls` = 4 production aliases (lead re-observes) |
| 9a | Iron Path demo accounts (SF-109): the tool is TEST-only; for production Noe runs the equivalent steps by hand per runbook §1.3 (session bump) and the password-reset path; the tool does not verify the old password, it makes it irrelevant. (`scripts/readiness/demo-accounts-rotate.mjs`, lane M1 v2: no production mode — the target guard is fixed to the TEST endpoint and no option admits production; proved on TEST under both roles by `tests/integration/sec-m1-demo-rotate-db.test.ts`.) | Noe (production by hand; the agent does not run it against production) | Rotated staff are signed out on their next request (session version moved); their old password stops working | Count of rows bumped and passwords reset; no addresses |
| 10 | **Account hardening**: confirm 2FA (hardware key or TOTP) on GitHub, Vercel, Neon, Stripe, Resend; turn on GitHub secret-scanning validity checks. | Noe | None | Yes/no per account |

## 5. Deployments, aliases and protection (reconciled at O1/O2/O6)

64 production deployments, not 63 "old" plus an assumption: 1 serving + 63 superseded (61 READY, 2 ERROR without
functions). All 64 contain the TESTING_MODE production refusal (`ed3e146` is an ancestor of every deployed SHA). Every
build holds the current DATABASE_URL, NEXTAUTH_SECRET, Stripe, Resend and Blob values (no update since before the
oldest build); 62 hold an older MATFLOW_ADMIN_SECRET. Protection: Standard (custom domain public, every `*.vercel.app`
URL behind Vercel Authentication); no bypass tokens (shareable links were not checked). Single-member
Hobby team, so "anyone with project access" today means Noe's Vercel identity.
Retirement path: §4 step 9. The retention policy (30 days) already retires them automatically; deletion just brings the
date forward. Recommended policy change: production retention to the shortest available, keep only the last 3.

## 6. Runtime access and environment settings

**`scripts/readiness/db-role-inspect.mjs` review (owner: lead/lane B; not edited by E2).**
Read-only: PASS — one `BEGIN READ ONLY` transaction, statement timeout, SELECT only, ROLLBACK. Target: PASS — shared
guard `db-target.mjs` resolves the host the way pg does, refuses `host`/`hostaddr`/`options`/`endpoint` overrides and
requires an expected-host substring; production is admitted explicitly. Credential output: PASS — prints host, pooler
flag, sslmode, role names, grants and policy names, never the URL; a malformed URL is refused without echo.
Gaps to fix before Noe runs it: (G1) TLS can be downgraded by the URL — with pg 8.20.0 / pg-connection-string 2.12.0,
connection-string parameters override the `ssl` option (`connection-parameters.js` lines 59–60), so `sslmode=no-verify`
or `uselibpqcompat=true` would switch verification off; reuse `assertTlsNotDowngraded` from
`scripts/readiness/ops-blob-host-count.mjs`. (G2) The env parser accepts only `^[A-Z_]+=`, ignores `export` and keeps
single quotes (fails closed). (G3) Missing evidence for SF-62/SF-57: SECURITY DEFINER functions with owner, `proconfig`
search_path and EXECUTE grants (incl. PUBLIC); schema and database privileges (`has_schema_privilege` CREATE/USAGE,
`has_database_privilege` CREATE/TEMP); `pg_auth_members` admin/inherit/set options; `pg_default_acl`. (G4) The usage
string still names `prod-db-role.mjs`. (G5) It inspects whatever URL it is given, which may not be the role Vercel uses.
**Operator-run path (Noe; the agent's production read stays refused):** §4 step 2 query in the Neon SQL Editor →
copy that role's connection string from the Neon console into a temporary file outside the repo and outside any synced
folder → `node scripts/readiness/db-role-inspect.mjs <tmpfile> ep-bold-wave-abt39t7x > role-inspect.out` (Node 24) →
optionally `node scripts/readiness/ops-blob-host-count.mjs <tmpfile> ep-bold-wave-abt39t7x` (SF-48; since lane E3 it
connects from an explicit config with TLS verification forced, refuses every TLS/target URL parameter except one
`sslmode=require|verify-full` and `channel_binding`, and refuses any PG* environment variable — unset them first) → delete the
temporary file → hand over the outputs (no credentials in them). Best done after the step-4 reset, with the new value.

**Runtime vs migration identity.** Production: one URL, direct host, used for both (O3, O4). `scripts/maybe-migrate.mjs`
at HEAD prefers `MIGRATION_DATABASE_URL` and refuses mismatched endpoints; `e8afb6a` predates that. Target: runtime
`DATABASE_URL` = restricted role on the `-pooler` host; `MIGRATION_DATABASE_URL` = owner role on the direct host, same
endpoint; both Production-only; never inferred from the laptop `.env`. Switch only with a release that contains the
HEAD `maybe-migrate.mjs`, after the SF-62 role design lands.

**TESTING_MODE.** Parser: `process.env.TESTING_MODE === "true"` exactly. `isTestingMode()` also returns false when
`VERCEL_ENV=production` or `DATABASE_URL` names the production endpoint. When true it: skips mandatory TOTP enrolment for
owner/manager/admin (auth.ts, proxy.ts, lib/api-authz.ts, account/password, magic-link verify); skips the TOTP challenge
at sign-in and on magic-link (auth.ts `totpPending`); skips the login rate limit for loopback/"unknown" IPs; with
`E2E_BYPASS_TOKEN` (not in Vercel) allows a password bypass from loopback; and `lib/import-storage.ts` separately keeps
import CSVs in the OS temp directory when not production (raw check, without the production-database refusal).
Production: present (O4), value unreadable; inert in all 64 builds because every one carries the refusal. Preview:
honoured if `"true"`, but there are 0 preview deployments and Preview has no `DATABASE_URL`. Delete it from Production
(§4 step 8).

**Blob: metadata versus exposure.** "Non-sensitive" in the dashboard is a storage class for the variable, not evidence
that anything leaked: it means the value is retrievable by project members and copied into Development pulls. Actual
exposure paths are C5 (a) and (b). The two public stores are empty by metadata (O8); the August "public CSV blobs"
are therefore not present in either public store as of O8. The private store is in iad1 (US) while functions run in
lhr1 (data-location note for the privacy policy, not a vulnerability). SF-48: run `ops-blob-host-count.mjs`; if every
reference has host fp `47cdb2caa57e`, the residual is nil.

**Repository protection and release controls.** Today a push to `main` deploys and migrates production with no
required check (O6, O7). Prepared ruleset: `evidence/E2/github-ruleset-main-proposed.json` (no deletion, no force-push,
linear history, pull request required with 0 approvals because a solo maintainer cannot approve his own PR, required
check "Typecheck + Lint + Vitest", strict). Apply only once CI on the release branch is green, otherwise nothing can
merge: `gh api -X POST repos/NoeTopalian/matflow/rulesets --input <file>` (Noe). Add "Lockfile policy, advisories,
secrets" as a second required check once that workflow exists on `main`. Every merge into `main` is a production
approval and must carry: exact SHA, migrations included, configuration prerequisites, backup/restore evidence (SF-19),
mail and cron state, rollout checks and the rebuild-based rollback.

## 7. Cron inventory (`app/api/cron/**`, `vercel.json`)

| Route | Schedule (UTC) | Auth | What it changes | Caps / dry-run | Idempotent | Audit | Recovery |
|---|---|---|---|---|---|---|---|
| `class-instances` | `40 2 * * *` daily | Bearer CRON_SECRET, constant-time, failed attempts throttled; 503 when unset | Adds class instances 56 days ahead per active tenant | Batched createMany, deadline; **no dry-run** | Yes (`skipDuplicates`) | JSON response + console only | Additive; wrong rows deletable |
| `monthly-reports` | `0 2 1 * *` (1st of month) | same; also 503 without `ANTHROPIC_API_KEY` (absent, O4) | One MonthlyReport per tenant; **sends tenant data to Anthropic** | No dry-run | Yes (unique key) | console | Delete rows |
| `retention` | `30 3 * * *` daily | same | Stripe reconciliation (read-only) then **irreversible deletes**: AuditLog past 12 months (6 years for evidence rows), EmailLog and LoginEvent past 365 days, expired sign-in/reset tokens + 24 h, RateLimitHit past 1 day, StripeEvent past 90 days, abandoned ImportJobs past 30 days with their blobs, import diagnostics scrub, ImportUploads, and **hard deletion of tenants soft-deleted over 30 days ago** | 1,000-row batches; stops new work at 240 s; ≤ 2 tenant purges per run; `?dryRun=1` counts only | Yes; resumes at batch boundaries | Tenant purge writes an evidence AuditLog row in the same transaction; other rules leave only the JSON response and logs (Hobby keeps 1 h) | **Only a backup** — and no backup exists (SF-19) |
| `stripe-reconcile` | not scheduled | same; 503 without Stripe key | Read-only detection | — | — | Sentry + logs | — |

What enabling CRON_SECRET would run first: nothing until a new production deployment is built with it (variables are
bound at build). After that, the first run is class-instances at 02:40 and then retention at 03:30 the same night;
monthly-reports stays 503 without the Anthropic key. Safe order: (1) a verified backup and restore (SF-19, lane F);
(2) ship a `vercel.json` without the retention entry (lead's file) together with CRON_SECRET, so the first enabled job
is the additive one; (3) Noe runs retention once by hand with `?dryRun=1` and reads every count, in particular the
tenant list; (4) fresh backup; (5) restore the retention schedule. Irreversible deletion never runs before step 1.

## 8. Mail domain (O5; records in `evidence/E2/mail-records-proposed.json`, checked by `tests/unit/sec-e2-mail-records.test.ts`)

Sending path (inferred from DNS; `RESEND_FROM` is Sensitive): From `@matflow.studio`, DKIM `d=matflow.studio` via
selector `resend`, envelope `send.matflow.studio` with SPF for Amazon SES. Under relaxed alignment both DKIM and SPF
align with the From domain, so DMARC would pass for Resend mail. Missing apex SPF does not make Resend mail
unauthenticated; it only leaves the bare apex as an unprotected envelope sender. The absence of `_dmarc` is the gap:
receivers have no policy for forged `@matflow.studio` mail (and, by RFC 7489 §6.6.3, for any subdomain).
Prepared rollout: stage 0 apex `v=spf1 -all` (no existing SPF there, so no duplicate); stage 1 `p=none` with a working
`rua` for at least 14 days; stage 2 `p=quarantine; pct=25` then 100; stage 3 `p=reject` after 30 clean days. The `rua`
cannot be an `@matflow.studio` address (no MX) and an external address needs the RFC 7489 §7.1 authorisation record,
which hosted DMARC-report services publish; a personal Gmail address does not. Noe first confirms in a received message
header that From is `matflow.studio` and DKIM/SPF pass. Approval: Noe, Vercel DNS. Rollback: edit the TXT back.

## 9. Node runtime actually used

Serving build: project Node `24.x`, functions `nodejs24.x`, build image CLI 62.1.0 (O3, O6). The exact patch version is
not printed in the build log and was not discoverable read-only. HEAD pins `engines.node ">=24.18.1 <25"` and `.nvmrc 24`.
E2 unit evidence ran under Node v24.21.0 (lead-provided binary).

## 10. Approvals in one place

| Item | Who approves / acts | Where | Previously denied to an agent? |
|---|---|---|---|
| Evidence capture, fingerprint check, role identification (§4 0–2, 5) | Noe | Provider consoles, laptop | Production DB read: yes (SF-02) — Noe runs it |
| Key creation/deletion at Resend, Neon reset, Stripe roll, Blob regeneration (§4 3, 4, 6, 7) | Noe | Provider consoles | Rotation: never attempted by an agent; not authorised |
| Vercel variable changes (§4 3–8) | Noe | Vercel → Settings → Environment Variables | Not attempted |
| Production redeploy / merge to `main` (§4 3a) | Noe, as a production release | Vercel / GitHub | Push/deploy: not authorised for agents |
| Deployment and alias deletion (§4 9) | Noe | Vercel dashboard or Noe's CLI | **Yes**, denied in iteration 1; not retried |
| Ruleset, 2FA, secret-scanning validity checks (§4 10, §6) | Noe | GitHub/Vercel settings | Not attempted |
| `vercel.json` retention entry, db-role-inspect fixes, OIDC Blob code | Lead / owning lane (repo change, local) | Repository | — |
| DNS records (§8) | Noe | Vercel DNS | Not attempted |
