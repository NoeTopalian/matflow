# Incident, restore and rollback runbook (security campaign, 9 Oct 2026)

Owner: lane F (availability and recovery). Candidate branch `security/assurance-2026-10` at `ab5f928` plus the lane
changes listed in `evidence/F/REPORT.md`. This page is the security view across three existing runbooks; it does not
replace them:
`docs/runbooks/db-restore.md` (restore options, DSAR re-application), `docs/runbooks/RESTORE-REHEARSAL-ISOLATED.md`
(the authorised PITR rehearsal, step by step), `docs/runbooks/OPERATOR-ACCESS-RECOVERY.md` (operator lock-out).

Steps marked **[NOE]** need Noe: production consoles, secrets, or a decision. Nothing here was run against production
by the campaign. Every value quoted from a provider is dated and needs checking on the day.

**Status of each path today (9 Oct 2026):**

| Path | State | Why |
|---|---|---|
| Revoke one person / one club (`POST /api/admin/customers/[id]/revoke-access`) | Built and tested on TEST, both roles (lane A: `sec-a-revoke-access-db`, 4/4 route mutants killed) | **Unusable in production until** an operator exists, has MFA and is in `OPERATOR_ALLOWED_IDS` (unset in production = nobody, lane A) and the branch is deployed. Until then use §1.3. |
| Global session kill (secret rotation) | Available **[NOE]** | Requires a redeploy; old deployments keep the old secret (SF-10). |
| Neon PITR restore | Available, **never rehearsed**; window UNKNOWN (6 h on Free, 1 day default on paid, per Neon docs read 4 Oct 2026 — re-check) | No Neon API key or CLI is available to the campaign; rehearsal is §2.4 **[NOE]**. |
| Weekly logical dump to S3 | **Has never succeeded** (0 Actions secrets) | SF-19. §2.6. |
| Restore verification | Built: `scripts/readiness/restore-verify.mjs` (read-only fingerprint + compare), proved on TEST with positive and negative controls (`evidence/F/restore-verify-runs-2026-10-09.txt`) | — |
| Security-preserving rollback | Procedure §4; Instant Rollback is forbidden | Old builds carry old code AND old environment. |

---

## 1. Incident: someone has access they must not have

### 1.1 Decide the scope (5 minutes, write it down)
Who (one staff user, one member, a whole club, an operator, a service key), since when, which plane (club dashboard,
member portal, operator `/admin`), and whether the credential itself is known to be compromised (then eviction alone is
not enough: §1.4). Record the time in UTC and Bali time if Noe is still there.

### 1.2 Evict with the control built for it (club staff and members)
Preconditions [NOE, once]: an Operator row with TOTP enrolled, its id in `OPERATOR_ALLOWED_IDS` in Vercel Production, and
this branch deployed. Then, signed in at `/admin` as that operator:

1. Request a step-up grant for action `access.revoke_all` on the club (the hub's Danger Zone asks for the TOTP code).
2. `POST /api/admin/customers/<tenantId>/revoke-access` with header `x-matflow-step-up: <grant>` and a strict body:
   - one staff user: `{"scope":"user","subjectId":"<User.id>","reason":"<10–500 chars>"}`
   - one member: `{"scope":"member","subjectId":"<Member.id>","reason":"…"}`
   - the whole club: `{"scope":"club","reason":"…"}`
3. In ONE transaction it spends the grant, bumps `sessionVersion` for every subject in scope (every JWT session ends at
   its next request, support sessions bound to the old version with it), retires every outstanding password-reset code
   and sign-in/activation link in scope, and writes the audit row `admin.access.revoked` with counts and the reason.
   Any failure rolls back all of it. A replay of the same grant returns the recorded result.
4. Verify: the response counts are non-zero where expected; the club's Activity log shows the row; a request with the
   evicted session now answers 401 (lane A's revocation check fails CLOSED on a database error since this branch, so a
   DB blip refuses rather than admits).

Eviction is not a lock-out. Someone holding the password can sign in again: pair it with §1.4.

### 1.3 Fallback while the operator path is unavailable [NOE, Neon SQL editor on production]
Equivalent effect, by hand, inside one transaction. Replace the ids; run the SELECTs first and compare counts.

```sql
BEGIN;
SELECT set_config('app.bypass_rls','on',true);
-- one staff user (repeat with "Member" for a member, or WHERE "tenantId" = '<tenantId>' for a whole club)
UPDATE "User" SET "sessionVersion" = "sessionVersion" + 1 WHERE id = '<User.id>' AND "tenantId" = '<tenantId>';
UPDATE "MagicLinkToken" SET used = true, "usedAt" = now() WHERE "tenantId" = '<tenantId>' AND email = '<address>' AND NOT used;
UPDATE "PasswordResetToken" SET used = true WHERE "tenantId" = '<tenantId>' AND email = '<address>' AND NOT used;
INSERT INTO "AuditLog" (id,"tenantId",action,"entityType","entityId",metadata,"createdAt")
VALUES ('incident-'||md5(random()::text), '<tenantId>', 'admin.access.revoked', 'User', '<User.id>',
        '{"via":"sql-fallback","reason":"<reason>"}', now());
COMMIT;
```
Record who ran it and why; this path has no step-up and no second person, which is why §1.2 exists.

### 1.4 The credential itself is compromised
- Club password: operator force-password-reset (step-up) or, for the person themselves, the reset flow once mail is live.
- Club TOTP: operator `totp-reset` / `member-totp-reset` (step-up).
- An operator: remove the id from `OPERATOR_ALLOWED_IDS` [NOE, Vercel] and redeploy — the allowlist is read per request;
  bump `Operator.sessionVersion` by SQL as in §1.3; re-enrol TOTP. `OPERATOR-ACCESS-RECOVERY.md` covers lock-out.
- Everyone at once (the session-signing secret or the database is suspected): rotate `AUTH_SECRET`/`NEXTAUTH_SECRET`
  [NOE, Vercel Production] and redeploy. Every JWT session and every HMAC-tagged sign-in token becomes invalid. Old
  deployments still hold the old secret until deleted (SF-10), so delete them (E-04) or keep Vercel SSO on them.
- A service key (Resend, Stripe, Blob, Neon, CRON_SECRET): rotate at the provider first, then in Vercel, then redeploy;
  the provider-side revoke is what stops an attacker, the redeploy only restores service. Old deployments keep the
  old value — revoking at the provider is the only thing that reaches them.

### 1.5 After any incident
Reproduce, write the failing regression test, fix, re-run the affected campaign evidence, and reopen the matching
FINDINGS.md rows. The audit log is mutable by the runtime role (SF-F2, §5): export the relevant rows (counts and ids,
not personal data) to the incident record immediately rather than relying on them later.

---

## 2. Restore

### 2.1 Before restoring anything
Freeze writes if the damage is ongoing (operator suspension of the affected club, or Vercel deployment protection on the
production domain [NOE]). Take a baseline fingerprint of the damaged state (read-only), which is also the evidence:

```
node scripts/readiness/restore-verify.mjs snapshot <env-file-with-prod-url> ep-bold-wave --production-read-only > before.json
```
`--production-read-only` exists for this step and for the rehearsal baseline only; the script is `BEGIN READ ONLY`,
statement_timeout 15 s, 180 s ceiling, counts and catalogue facts only.

### 2.2 Restore into an isolated branch, never onto production
Neon console → Branches → Create branch → from the production root branch at a past point in time (or "Restore" into a
**new** branch). Name `rr-<yyyymmdd>`, deletion deadline 24 h. The branch inherits production roles and passwords: its
URL is a production secret. Full procedure and authorisation gate: `RESTORE-REHEARSAL-ISOLATED.md` §1–§3.

### 2.3 Verify the restored branch
```
node scripts/readiness/restore-verify.mjs snapshot rr.env <branch-endpoint-id> > restored.json
node scripts/readiness/restore-verify.mjs compare before.json restored.json --allow-drift=<tables written since T>
```
Exit 0 only when: same Postgres major; identical migration list (none unfinished or rolled back); identical tables;
identical RLS enabled/forced flags, policies and triggers on every table (the email-lowercase triggers, the
tenant_isolation policies); zero orphaned foreign-key rows and no unvalidated foreign key; identical row counts except
the tables you name. Then `RESTORE-REHEARSAL-ISOLATED.md` §4 (per-tenant counts, attendance reconcile) and §5 (isolated
production build against the branch, mail off, synthetic sign-in).

Proved on 9 Oct 2026 against the TEST branch (both roles): positive control PASS with concurrent-lane drift named;
negative control (a policy removed, a trigger removed, a migration dropped, 3 orphans planted, a count changed) → FAIL
listing all five; the production host refused without the flag.

### 2.4 Rehearsal Noe must run [NOE]
No Neon API key or CLI was available to the campaign, so **no restore has ever been executed (SEC-086: BLOCKED)**.
Exactly: `RESTORE-REHEARSAL-ISOLATED.md` §2 (record the history window), §3 (branch from a past timestamp of the TEST
branch first — `ep-hidden-salad` — then of production once authorised), then §2.3 above with the TEST branch's own
fingerprint taken just before as the baseline, then delete the branch. Record RTO (start → compare PASS) and RPO
(restore point age). A TEST-branch rehearsal needs no production data and can be done today.

### 2.5 Cutting over (only after §2.3 passes and Noe decides)
`db-restore.md` Option A steps 5–8. Then **§3, always**.

### 2.6 The weekly dump (SF-19) [NOE]
Until the five Actions secrets exist the workflow fails at "Validate secrets" every Sunday and no dump exists. When
they are added, also decide (recommendations, none applied):
- a dedicated dump role: `SELECT` on all tables plus `BYPASSRLS` (pg_dump aborts on FORCEd RLS otherwise) and nothing
  else — not `neondb_owner`;
- client-side encryption of the archive before upload (e.g. `age` to a public key whose private half is offline), so a
  bucket leak is not a full PII and password-hash leak;
- bucket with versioning + Object Lock (compliance mode, ≥ 35 days) and an IAM key that can only `PutObject` — a
  stolen CI key then cannot delete or overwrite history (ransomware, SEC-085); prefer GitHub OIDC to a static key;
- a monthly restore of the latest dump into a throwaway branch, verified with §2.3.

---

## 3. After ANY restore or rollback: the security state rewinds with the data

A point-in-time copy restores `sessionVersion` counters, sign-in tokens and recovery state as they were. Every
revocation made after the restore point is undone, and a link consumed after the restore point is unconsumed again.
`restore-verify.mjs compare` prints the counts each time. Before reopening:

1. Revoke all sessions: rotate `AUTH_SECRET`/`NEXTAUTH_SECRET` and redeploy (simplest, global), or §1.2 with
   `scope: "club"` for every club.
2. Retire every outstanding token: `UPDATE "MagicLinkToken" SET used=true, "usedAt"=now() WHERE NOT used;` and
   `UPDATE "PasswordResetToken" SET used=true WHERE NOT used;` (bypass set as in §1.3). Rotating the secret also
   invalidates their HMAC tags.
3. Re-apply erasures, staff removals, role demotions, operator de-listings and ownership transfers made after the
   restore point (`db-restore.md` "Re-applying DSAR erasures"; the export of audit rows from §1.5 is the list).
4. Re-run the fingerprint and keep it with the incident record.

---

## 4. Security-preserving rollback (SEC-087)

**Never use Vercel Instant Rollback / "Promote" of an old deployment.** A Vercel deployment is a frozen build AND a
frozen copy of the environment as it was when it was built (SF-10: 63 old production builds each still carry the
then-current DATABASE_URL, NEXTAUTH_SECRET, Stripe, Resend and Blob credentials, none with EMAIL_DELIVERY=off).
Promoting one brings back: its code (e.g. pre-`ab5f928` the session-revocation check failed OPEN on a DB error, AH-G7),
its secrets (a rotated key comes back to life inside that build), and its flags (mail on). It does not roll the
database schema back, so old code meets a newer schema.

The rollback that preserves security is a roll-FORWARD:
1. `git revert <bad-sha>` on a branch (never a force-push; `main` is unprotected today, SF-15).
2. Run the gates on the revert: `npm run lint && npm test && npm run build`, plus the security DB set under both roles
   (`docs/security/TEST-EVIDENCE.md` §How to re-run) and `node scripts/readiness/test-skip-gate.mjs … --require-db`.
3. If the bad change included a migration: write a forward migration that undoes it; never `migrate reset`, never
   restore the database to undo code. Pushing `main` runs `prisma migrate deploy` against production.
4. Merge → Vercel builds the revert with the CURRENT environment.
5. If a secret was exposed by the bad deployment: rotate it at the provider (§1.4), and delete the bad deployment
   [NOE; the campaign's deletion attempt was refused and is not retried].
6. Re-verify revocation, mail gate (`EMAIL_DELIVERY`) and operator allowlist on the new deployment.

If production is down and a revert build is too slow, the least-bad emergency step is Vercel deployment protection or
maintenance mode on the domain, not promotion of an old build.

---

## 5. Known gaps this runbook works around (lane F findings; FINDINGS.md rows proposed)

- **SF-F2 audit history is mutable by the runtime role** (Medium). Under both TEST roles, inside a rolled-back
  transaction: the role updated an audit row's action, back-dated its `createdAt` by 400 days (so the retention cron
  would delete it), and, by setting the transaction-local `app.bypass_rls` itself, read every club's rows and deleted
  one. No trigger protects `AuditLog`; `matflow_app` holds UPDATE and DELETE; `neondb_owner` also TRUNCATE.
  Evidence: `evidence/F/audit-tamper-probe-2026-10-09.json`. Proposed migration in `evidence/F/REPORT.md`.
- **SF-17 extended**: with `CRON_SECRET` unset in production, the retention cron also never runs the Stripe
  reconciliation it hosts, so a webhook lost to an outage is never repaired, and soft-deleted clubs are never purged.
- **SF-19**: no logical backup exists; PITR window unknown; no restore ever executed.

---

## 6. Iteration 2 (lane F2, 9 Oct 2026 evening UK) — what exists, the drill that was run, and what changed above

### 6.1 Capabilities actually established (sources and times in `evidence/F2/backup-capabilities-2026-10-09.json`)
- **Neon PITR: UNKNOWN.** No Neon CLI or API key reachable from the campaign; the production read stays refused
  (SF-02). The history window, branch-restore time and whether a restore branch was ever made are not observable here.
  A dashboard showing "history retention" is not a demonstrated restore.
- **Weekly pg_dump: never produced a dump.** 22 of 22 recorded runs failed at "Validate secrets" (GitHub API, 9 Oct).
  Even when it runs, it dumps `--no-owner --no-privileges`: the `matflow_app` role, its table grants and its
  `USAGE` on schema public are in **no migration and no dump**. A restore from that archive alone leaves the runtime
  role with no privileges (outage) — or, if someone "fixes" it by pointing the app at the owner, with RLS off (SF-02).
  Record the role and grants separately (`backup-export.mjs` writes them into its manifest; §6.3 replays them).
- **Local:** no `pg_dump`, `psql`, server, Docker or WSL. PGlite 0.4.3 (Postgres 17.5 in WebAssembly) is present as a
  transitive dependency of Prisma and is what the drill below restores into.

### 6.2 Migration history does not match the repository for six migrations
The TEST branch's `_prisma_migrations` checksums for `20260923220000` … `20260930100000` (six) match the commits that
were applied (901bd83, 9993565, fe299eb, 30dce22, c6517c5, 0f8c2b1), not HEAD: d403f30 (30 Sep) wrapped them in
BEGIN/COMMIT after they had run. Semantically equivalent here, but a restore that replays migrations from HEAD is not
replaying what the source ran. `backup-restore.mjs` replays the committed text whose checksum matches and lists the
edits; whether production ran the original or the edited text is unknown (production unreadable).

### 6.3 The isolated restore drill (TEST branch → private in-process Postgres) — run 9 Oct 2026, Node 24.21.0
```
node scripts/readiness/backup-export.mjs .env.test ep-hidden-salad TEST_DATABASE_URL <scratch>/export      # read-only
node scripts/readiness/backup-restore.mjs <scratch>/export --port=55440 --out=<scratch>/restore           # 127.0.0.1, memory
```
- **Export**: one `REPEATABLE READ READ ONLY` transaction; the baseline fingerprint (with per-table content hashes) is
  taken inside the same snapshot as the rows, so the recovery point is exact (`now()` of that transaction). 53 tables,
  115,224 rows, 77 MB, 36–46 s. Output outside the repository only (refused inside it); production refused without an
  override; `PGOPTIONS`/`PGHOST`/`PGHOSTADDR` in the environment refused.
- **Restore**: export hashes verified → roles and memberships recreated with the source's flags → 100 migrations
  replayed as the table owner (six from history, §6.2) → rows loaded with triggers and FK checks off
  (`session_replication_role = replica`, as `pg_restore --disable-triggers`) → grants replayed → fingerprint compared.
- **Result**: first run **FAILED** — the content hash showed 6 `User.totpRecoveryCodes` values that were JSON `null`
  (Prisma `JsonNull`) restored as SQL `NULL` (`DbNull`); a logical JSON export cannot tell them apart. The export now
  carries a sentinel and the restore checks the count. Second run **PASS**: identical tables, rows, content hashes,
  policies (with expressions), triggers, functions, roles, grants, extensions, FKs (0 orphans) and security state.
  Restore time to a verified copy: **9.6 s** for this size, in-process (not representative of a Neon branch restore,
  which is unmeasured). Recoverable age: the export is the recovery point — **RPO = time since the last export; no
  schedule exists, so today it is unbounded** (and Neon PITR is UNKNOWN).
- **Tamper controls** on the restored copy (`evidence/F2/restore-tamper-controls.mjs`): 10/10 as expected — positive
  control PASS; policy expression, function body, disabled trigger, BYPASSRLS on the app role, an extra TRUNCATE
  grant, an audit row rewritten with its count kept, a rewound session version (with and without content hashes) and
  a planted outstanding sign-in link each FAIL. These were the SF-64 gaps.

### 6.4 Nothing restored may activate (checked on the drill copy; counts only)
The restored copy holds: 6 soft-deleted clubs **already past the 30-day purge grace** (the retention cron would
hard-delete them on its first run against a restored copy wired to a deployment with `CRON_SECRET`), 28 kiosk token
hashes, 5 Stripe connected-account ids (webhooks would route to the copy if it were promoted), 17 staff and 3 member
TOTP secrets, 0 Drive OAuth tokens, 0 push subscriptions, 0 outstanding links/codes. Rules for any restored copy:
attach no deployment, no `CRON_SECRET`, no mail (`EMAIL_DELIVERY=off`) and no Stripe webhook endpoint to it until §3
and §6.5 are done; the drill copy itself lives in process memory, listens on 127.0.0.1 only and vanishes at exit.

### 6.5 Post-restore revocation, proved on the drill copy
`scripts/readiness/backup-post-restore.mjs` (exports `revokeAllAfterRestore`; refuses production and the shared
TEST branch) applies the revoke-access route's containment to every club at once — `sessionVersion + 1` for every
User and Member, plus every **Operator** (the route never touches operator sessions), every outstanding reset code and
**every** sign-in link purpose (the route retires only `login` and `first_time_signup`) — in one audited transaction.
Then `restore-verify compare --expect-revoked` must PASS: 0 outstanding links/codes and each session-version sum
raised by at least its row count. Drill: 584 users, 3,916 members, 1 operator bumped; compare PASS. On a production
cut-over the order is unchanged from §3: rotate `AUTH_SECRET`/`NEXTAUTH_SECRET` (ends every JWT regardless of
version), then this revocation, then re-apply post-restore-point erasures. The script is not authorised for production.

### 6.5a Neutralise the restored copy BEFORE any app is attached (lane D2, SF-80)
After §6.5 and before any application process is pointed at the copy, run the same script's `neutralise` mode
(`neutraliseRestoredCopy` / `neutralisationCheck`, same refusals as §6.5). It resets every soft-deleted club's purge
clock (`deletedAt = now()`, so the first retention cron run hard-deletes nothing), revokes every kiosk and leaderboard
display token, detaches every Stripe account id, and records the originals in one `admin.restore.neutralise` audit
row. TOTP secrets are kept (they are the users' own) and proved unchanged by a digest; if the digest moves the run
refuses and rolls back. Drill on the TEST copy (9 Oct): 7 clubs past grace, 28 kiosk + 5 leaderboard tokens and
5 Stripe accounts neutralised, TOTP digest identical, second run idempotent, 11/11
(`evidence/D2/restore-neutralise-drill.mjs`). A copy that skips this step would, at its first cron run, hard-delete
every club past grace and would accept old kiosk tokens and Stripe account links.

### 6.6 restore-verify changes (SF-64) — `compare` now FAILS (it used to print) on
policy expressions/roles/permissive flag, trigger definitions and enabled state, public function source/owner/
SECURITY DEFINER/search_path/ACL, table owners and ACLs, role flags and memberships, schema ACL, extensions, event
triggers, migration checksums, per-table content hashes (`--content-hash`), and ANY security-state difference.
