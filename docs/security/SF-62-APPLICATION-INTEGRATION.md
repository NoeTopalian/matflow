# SF-62 — application changes still needed before the proposed boundary can be applied

Lane B4, security campaign iteration 2, 10 Oct 2026 (analysis written 20:30–21:30 UTC). Read-only: no code edited, no
database connection, no production access. Source pinned to the executable candidate **03ef584** (HEAD at writing
90fcbf6, documentation-only on top; `git diff 03ef584 HEAD -- app lib auth.ts proxy.ts` is empty, and the call-site
extraction run against `git archive HEAD` is identical to the working tree). Lanes M1 and B3 were editing
`app/api/cron/retention/route.ts`, `lib/rate-limit.ts` and tests during this analysis; line numbers below are those of
03ef584. Every count was produced by this lane's own scan (commands in `evidence/B4/commands-and-counts.txt`); B2's
figures are reconciled, not copied.

Noe's instruction: *"Identify any application changes still needed to support the proposed SF-62 boundary. Do not treat
a validated SQL proposal as a completed application integration."*

**Verdict.** The SQL proposal (B2 phases 1–3) is validated on a TEST copy; the application is **not** integrated with
it. Before phase 2 can be applied, 116 call sites in 59 files must change, 2 resolvers and 1 helper function that the
phase-1 SQL does not contain must be added, two public interfaces change (the kiosk waiver-status poll and the disown
link format), a second database client and URL must exist, the migration step must leave the Vercel build, the backup
dump must stop copying key material, and 65 integration test files, 6 e2e specs, 123 unit test files and 23 scripts
must stop relying on `app.bypass_rls`. None of this is done. Release A (03ef584) can ship without any of it.

---

## 1. Inventory: every `withRlsBypass` call site and what it must become

Method: `scratchpad/security/B4/extract.mjs` (copy: `evidence/B4/extract.mjs.txt`) walks app/, lib/, auth.ts and
proxy.ts, finds every `withRlsBypass(` that is not the definition, scans the balanced parentheses of the call for
`tx.<model>.<op>(` and helper calls, and `classify.mjs` applies the class below. Cross-check: ripgrep counts 111
occurrences in 58 files under app/ and lib/ plus 5 in auth.ts = **116 in 59 files**, matching B2's total. Full
per-site JSON: `evidence/B4/callsite-classification.json`; table: `evidence/B4/callsite-table.md`.

Classes (target under design P2, `evidence/B2/02-boundary-design.md`):

- **(a)** runs as `matflow_ops` through a separate client/URL (operator console, cron, platform-level audit rows);
- **(b)** a narrow `matflow_sec.tenant_id_by_*` lookup, then a signed tenant context (**b\*** = the lookup does not
  exist in `proposed-sf62-phase1.sql`);
- **(c)** a signed tenant context — the tenant id is already known from a verified JWT, token or row;
- **(d)** genuinely needs the system role inside the tenant-facing app;
- **(e)** the wrapper can be deleted.

### Totals

| class | sites | files | notes |
|---|---|---|---|
| (a) ops client | **78** | 30 | operator 63 in 25 files (app/admin 6 in 4; app/api/admin 50 in 19; lib/tenant-purge 6; lib/operator-step-up 1) · cron 14 in 4 files · null-tenant audit 1 (lib/audit-log.ts) |
| (b) resolver + signed context | **24** | 21 | slug 10 · kiosk token 5 · display token 1 · magic-link hash 4 · Stripe account 1 · **b\*: 2 new functions** (Resend id; provisional-address check) · 1 interface change (kiosk-status) |
| (c) signed context | **12** | 11 | 1 of them needs a token-format change (disown link) |
| (d) system role in the tenant app | **0** | 0 | see justification below |
| (e) delete wrapper | **2** | 2 | apply form (no RLS on GymApplication); `isPromotionReady` (no caller) |
| **total** | **116** | **59** | |

Reconciliation with B2's classes (05-bypass-inventory.md): B2 OPERATOR 65 + CRON 14 = 79 → (a) 78, because
`lib/impersonation.ts:265` and `lib/review-lock.ts:37` already know their tenant (→ c) and `lib/audit-log.ts:245`
(B2 SHARED-LIB) writes `tenantId = null` rows whose only writers are operator flows (→ a). B2 PUBLIC-TOKEN 22 +
PRE-TENANT 7 + WEBHOOK 3 + SHARED-LIB 5 = 37 → (b) 24 + (c) 12 + (e) 2 − the audit-log site.

**(d) = 0, justified.** No tenant-facing path needs to see more than one club per transaction. The two cross-club
reads that exist by design are each one exact identifier → one answer: `lib/email.ts:416` asks "is this address any
club's provisional login address?" (a boolean) and `app/api/webhooks/resend/route.ts:124` maps a Resend message id to
its club. Both become SECURITY DEFINER functions in the same mould as the phase-1 resolvers (owner `matflow_system`,
pinned `search_path`, EXECUTE by name). Keeping either as system-role access would put the ops credential (or a
bypass) back into the public deployment for one lookup.

### Per-file table (line = first line of the `withRlsBypass(` call at 03ef584)

| file | sites (lines) | class | target |
|---|---|---|---|
| app/admin/billing/page.tsx | 1 (L26) | a | ops client |
| app/admin/page.tsx | 3 (L45, L67, L126) | a | ops client (L45 reads `Operator`, no RLS — wrapper is redundant today) |
| app/admin/tenants/[id]/page.tsx | 1 (L29) | a | ops client |
| app/admin/tenants/page.tsx | 1 (L29) | a | ops client |
| app/api/admin/activity/route.ts | 1 (L35) | a | ops client |
| app/api/admin/applications/[id]/approve/route.ts | 4 (L80, L93, L106, L163) | a | ops client (L80/L163 GymApplication, no RLS; L106 creates the Tenant) |
| app/api/admin/applications/[id]/reject/route.ts | 2 (L53, L60) | a | ops client (GymApplication UPDATE — phase 3 revokes it from the runtime) |
| app/api/admin/applications/route.ts | 1 (L25) | a | ops client |
| app/api/admin/auth/operator-totp/setup/route.ts | 1 (L217) | a | ops client (`Operator` write, no RLS — needed for phase 3) |
| app/api/admin/create-tenant/route.ts | 1 (L85) | a | ops client |
| app/api/admin/customers/[id]/force-password-reset/route.ts | 3 (L72, L75, L107) | a | ops client |
| app/api/admin/customers/[id]/login-email/check/route.ts | 1 (L89) | a | ops client |
| app/api/admin/customers/[id]/login-email/route.ts | 3 (L68, L109, L149) | a | ops client |
| app/api/admin/customers/[id]/member-totp-reset/route.ts | 3 (L72, L80, L99) | a | ops client |
| app/api/admin/customers/[id]/members/[memberId]/contact-email/route.ts | 3 (L122, L158, L196) | a | ops client |
| app/api/admin/customers/[id]/owner-profile/route.ts | 2 (L89, L110) | a | ops client |
| app/api/admin/customers/[id]/review-lock/route.ts | 4 (L54, L63, L91, L99) | a | ops client |
| app/api/admin/customers/[id]/revoke-access/route.ts | 2 (L114, L138) | a | ops client |
| app/api/admin/customers/[id]/soft-delete/route.ts | 5 (L71, L105, L151, L190, L276) | a | ops client |
| app/api/admin/customers/[id]/suspend/route.ts | 6 (L83, L128, L226, L255, L288, L307) | a | ops client |
| app/api/admin/customers/[id]/totp-reset/route.ts | 3 (L63, L69, L89) | a | ops client |
| app/api/admin/customers/[id]/transfer-ownership/route.ts | 3 (L51, L86, L117) | a | ops client |
| app/api/admin/impersonate/route.ts | 2 (L156, L211) | a | ops client |
| app/api/cron/class-instances/route.ts | 1 (L110) | a | ops client (tenant enumeration; per-tenant work already uses `withTenantContext`) |
| app/api/cron/monthly-reports/route.ts | 1 (L58) | a | ops client (same shape) |
| app/api/cron/retention/route.ts | 10 (L304, L324, L329, L356, L367, L382, L419, L422, L431, L454) | a | ops client; the `auditLog` rule must call `audit_log_purge()` (SF-57, §5) |
| lib/stripe/reconcile.ts | 2 (L67, L93) | a | ops client (L93 reads StripeEvent, no RLS) |
| lib/tenant-purge.ts | 6 (L81, L269, L378, L482, L485, L499) | a | ops client (destructive, cross-club; keep it off the runtime credential) |
| lib/operator-step-up.ts | 1 (L315) | a | ops client (only caller: app/api/admin/auth/step-up) |
| lib/audit-log.ts | 1 (L245) | a | `tenantId = null` rows → ops client; writers: admin/applications/[id]/reject:78, admin/auth/operator-totp:162, operator-totp/setup:236, admin/auth/step-up:111, admin/impersonate:319, lib/operator-auth.ts:454, lib/operator-step-up.ts:477 — all operator flows |
| auth.ts | 1 (L441) | b | `tenant_id_by_slug` (credentials sign-in; the user read at ~L495 already uses `withTenantContext`) |
| auth.ts | 1 (L859) | b | `tenant_id_by_slug` (Google sign-in; Google is disabled in production) |
| auth.ts | 1 (L1084) | b | `tenant_id_by_slug` (dev-only DEMO_MODE token upgrade; auth.ts:70 forbids DEMO_MODE in production — deletable with that fallback) |
| auth.ts | 2 (L1426, L1451) | c | `token.tenantId` from the verified JWT |
| app/api/account/pending-tenant/route.ts | 1 (L47) | b | `tenant_id_by_slug` |
| app/api/auth/forgot-password/route.ts | 1 (L42) | b | `tenant_id_by_slug` |
| app/api/auth/reset-password/route.ts | 1 (L78) | b | `tenant_id_by_slug` |
| app/api/auth/totp/recover/route.ts | 1 (L66) | b | `tenant_id_by_slug` |
| app/api/member/totp/recover/route.ts | 1 (L78) | b | `tenant_id_by_slug` |
| app/api/magic-link/request/route.ts | 1 (L32) | b | `tenant_id_by_slug` |
| app/api/tenant/[slug]/route.ts | 1 (L56) | b | `tenant_id_by_slug` |
| app/api/kiosk/[token]/checkin/route.ts | 1 (L60) | b | `tenant_id_by_kiosk_token_hash` |
| app/api/kiosk/[token]/classes/route.ts | 1 (L36) | b | `tenant_id_by_kiosk_token_hash` |
| app/api/kiosk/[token]/members/route.ts | 1 (L51) | b | `tenant_id_by_kiosk_token_hash` |
| app/api/waiver/kiosk-request/route.ts | 1 (L47) | b | `tenant_id_by_kiosk_token_hash` |
| app/kiosk/[token]/page.tsx | 1 (L29) | b | `tenant_id_by_kiosk_token_hash` |
| app/leaderboard/[token]/page.tsx | 1 (L33) | b | `tenant_id_by_display_token_hash` |
| app/api/magic-link/verify/route.ts | 1 (L44) | b | `tenant_id_by_magic_link_hash` |
| app/api/magic-link/verify/route.ts | 1 (L72) | c | the preflight's tenant; consume inside its signed context (no preflight row → `invalid_link`, as today) |
| app/api/members/accept-invite/route.ts | 1 (L104) | b | `tenant_id_by_magic_link_hash` |
| app/api/members/accept-invite/route.ts | 1 (L117) | c | `tokenRow.tenantId` |
| app/api/waiver/open/route.ts | 2 (L25, L77) | b | `tenant_id_by_magic_link_hash` |
| app/api/waiver/kiosk-status/route.ts | 1 (L25) | b | **interface change**: the lookup is by `MagicLinkToken.id` and no resolver exists for it; the poll (components/kiosk/KioskPage.tsx:226) must send the kiosk device token too → `tenant_id_by_kiosk_token_hash`, then read the token by id inside that context |
| app/api/waiver/kiosk-status/route.ts | 1 (L51) | c | `token.tenantId` |
| app/api/auth/disown-login/[token]/route.ts | 1 (L112) | c | **token-format change**: `signDisownToken` (lib/login-event.ts:45) signs only `loginEventId.issuedAt`; add the tenant id to the signed payload. Old links (7-day TTL, lib/login-event.ts:43) fail closed after phase 2 unless phase 2 waits 7 days after the new format ships |
| app/api/webhooks/resend/route.ts | 1 (L124) | b\* | **new** `matflow_sec.tenant_id_by_resend_id(text)` (EmailLog.resendId is unique, schema.prisma:1139) |
| app/api/webhooks/resend/route.ts | 1 (L141) | c | tenant from the resolver; update inside its signed context |
| app/api/stripe/webhook/route.ts | 1 (L137) | b | `tenant_id_by_stripe_account` **inside** the claim transaction (L137–1239 claims the StripeEvent and processes it atomically — keep that), then sign mid-transaction: needs the new helper in §2 |
| lib/email.ts | 1 (L416) | b\* | **new** `matflow_sec.is_provisional_login_address(text) RETURNS boolean` |
| lib/impersonation.ts | 1 (L265) | c | `imp.targetTenantId` from the verified support token (runs on every request of a support session, in the tenant app) |
| lib/leaderboard.ts | 1 (L163) | c | `tenantId` argument |
| lib/notify-member-action.ts | 1 (L71) | c | `args.tenantId` |
| lib/review-lock.ts | 1 (L37) | c | `tenantId` argument (via `refuseIfReviewLocked`: 8 staff/member routes pass the session tenant; 2 operator routes — admin/customers/[id]/soft-delete, admin/dsar/erase — pass the target club and run on ops) |
| lib/session-revocation.ts | 1 (L108) | c | `check.tenantId` from the verified JWT (every authenticated request) |
| app/api/apply/route.ts | 1 (L53) | e | GymApplication has no RLS; drop the wrapper — the runtime keeps INSERT after phase 3 |
| lib/promotion-candidates.ts | 1 (L188) | e | `isPromotionReady` has no caller in app/, lib/, components/, auth.ts, proxy.ts, tests/ or scripts/ — dead code |

### Code that must change besides the 116 sites

1. **`withRlsBypass` itself** (lib/prisma-tenant.ts:107–115) must be removed, with a unit ratchet that fails on any
   new call in app/, lib/, auth.ts, proxy.ts (116 → 0).
2. **Bare `Operator` writes** (own grep, `prisma.operator.(update|updateMany)` outside any wrapper): 10 —
   app/api/admin/auth/logout/route.ts:44, operator-totp/route.ts:129, operator-totp/setup/route.ts:136,
   lib/impersonation.ts:150 and :182, lib/operator-auth.ts:238, :305, :322, :341, lib/operator-step-up.ts:377 — plus
   two inside transactions (operator-totp/setup/route.ts:218; lib/operator-step-up.ts:599 in `consumeStepUpGrant`,
   called from 11 operator route files). All must use the ops client **before phase 3**. Operator reads (10 bare)
   may stay on the runtime client. Correction to B3/01-inventory: its own table lists 20 Operator rows and 5
   RateLimitHit rows; its summary line says 19 and 6. This lane's grep agrees with the table (20 / 5).
3. **`PlatformConfig`**: zero references in app/, lib/, auth.ts, proxy.ts — phase 3's revoke needs no app change.
4. **Null-tenant audit rows** (`lib/audit-log.ts:244–246`): after phase 2, `tenant_isolation`'s WITH CHECK refuses
   `tenantId = NULL` for the runtime role, so `writeOwnTx` needs a client argument (ops for null tenant).
5. **The retention cron's `auditLog` rule** (route.ts rule list, `deleteInBatches` over `tx.auditLog`): phase 1 already
   revokes UPDATE/DELETE on AuditLog from `matflow_system`, so as soon as retention runs as `matflow_ops` the direct
   delete fails — the rule must go through `audit_log_purge()` (lane F2 patch 0001) **in the same release** that moves
   retention to the ops client.

---

## 2. Signed-context wiring

**What lib/prisma-tenant.ts does today when `RLS_CONTEXT_SIGNING_KEY` is set** (lines 40–83): validates the key as
exactly 128 hex characters before opening a transaction (malformed → throws, fail closed; R2 checked 12 malformed
shapes); statement 1 sets `app.current_tenant_id` and forces `app.bypass_rls` off (L73); statement 2 reads
`pg_backend_pid()` and `transaction_timestamp()` in microseconds (L78–79); statement 3 sets
`app.ctx_mac = HMAC-SHA256(key, tenant|pid|µs)` (L80). Unset key → no MAC, today's behaviour. The maths matches the
database recomputation (sec-b2-signed-context-db 1/1 each role, B2). Under today's policies the MAC is inert.

**What is still missing for phase 2:**

1. **No verification — a refused context is silent.** After phase 2, a wrong or missing MAC makes `ctx_tenant()`
   return NULL: reads return zero rows (a club's dashboard renders as empty, which UI-RULES forbids: an error is never
   an empty state) and writes fail with an RLS WITH CHECK violation surfacing as a generic 500. Proposed call shape —
   two statements instead of today's three:
   ```sql
   -- 1: tenant + bypass off + nonce in one round trip
   SELECT set_config('app.current_tenant_id', $1, true), set_config('app.bypass_rls', 'off', true),
          pg_backend_pid()::text AS pid, floor(extract(epoch FROM transaction_timestamp()) * 1000000)::bigint::text AS ts;
   -- 2: set the MAC and get the database's verdict, in order (plpgsql, SECURITY INVOKER so the setting lands
   --    in the caller's transaction)
   SELECT matflow_sec.enter_tenant($1, $mac) AS ok;   -- = set_config('app.ctx_mac', $mac, true);
                                                      --   RETURN matflow_sec.ctx_tenant() IS NOT DISTINCT FROM $1
   ```
   `ok = false` → throw a typed `TenantContextRefusedError` (no tenant data in the message), mapped by lib/api-error.ts
   to 503 with a reference, logged with the reason. `enter_tenant` is **not** in phase 1: amend the SQL, grant
   EXECUTE to the runtime role by name, re-run `rls-proposal-validate.mjs`. (A single SELECT combining `set_config`
   and `ctx_tenant()` is not used: evaluation order within a select list is not a guarantee to build on.)
2. **Mode switch** `RLS_CONTEXT_MODE = off | observe | enforce`. *observe* (release B, phases 1 only): verify every
   context, log and count mismatches, continue — this proves the deployed key equals the stored pads **before**
   phase 2, which phase 2's own guard cannot (it checks a key row exists, not that it matches; R2 §4). *enforce*
   (set before phase 2): mismatch → 503.
3. **The empty-key outage (R2 §4).** Unset/empty key = signing off; under phase 2 that is a whole-site outage that
   looks like empty clubs. In *enforce* mode an absent key must throw on first use (and `/api/health` must report
   `signedContext: "missing-key"` rather than 200 ok). Production should refuse to start in *enforce* without a key.
4. **Resolver-then-sign helper.** The (b) sites need `withResolvedTenant(kind, identifier, fn)` that calls
   `matflow_sec.tenant_id_by_<kind>($1)` and enters the signed context in the **same** transaction — required by the
   Stripe webhook, whose claim and processing must stay atomic (route.ts:129–137), and cheaper elsewhere. NULL from
   the resolver → the route's existing "not found" answer, unchanged.
5. **Key provisioning** (out of band, per environment: production, every preview branch that runs the app, TEST, CI,
   e2e): 64 random bytes; pads into `matflow_sec.context_key` by an owner session; hex into the runtime env only. A
   preview deployment pointed at a branch without pads fails closed under *enforce*.
6. **Rotation** (not drilled — B2 gap): the database tries both slots (kid 1, 2), the app signs with one key.
   Insert K2's pads in the free slot → set `RLS_CONTEXT_SIGNING_KEY=K2` and redeploy → when no live deployment signs
   with K1, delete slot 1. Every old Vercel deployment keeps its own environment (64 production builds, R2 chain C5,
   observed 9 Oct): any old deployment still reachable fails closed once its key's slot is gone — an outage of that deployment,
   not an exposure. Emergency rotation = delete the leaked slot first (brief outage until the redeploy).
7. **Backups carry key material.** `.github/workflows/db-backup.yml` dumps the whole database with no schema filter;
   after phase 1 that includes `matflow_sec.context_key` (the pads are the key). Run as the owner, the pads land in
   S3; run as a non-owner dump role, pg_dump fails with permission denied on that table. Add
   `--exclude-table-data=matflow_sec.context_key`, re-provision pads after a restore, and re-apply function ownership
   and grants (the dump uses `--no-owner --no-privileges`, so a restore leaves the definer functions owned by the
   restoring BYPASSRLS role — wider than designed). Owned by lane F/E; listed here because phase 1 creates the hazard.
8. **Tests that would prove it.** NOT RUN today: `tests/integration/sec-b2-public-boundary-proposal.test.ts` (6 cases,
   DB-level only: catalogue, positive control, bypass/forged tenant grant nothing, cross-club invisible, no SET ROLE).
   Owed in addition: (i) unit — the two-statement shape, `enter_tenant` false → typed error, mode behaviour, missing
   key in *enforce* throws; (ii) DB, both roles, phases 1+2 on TEST — `withTenantContext` positive control, wrong key
   → 503 not empty, `withResolvedTenant` per resolver kind (positive + unknown identifier); (iii) the signed context on
   the **pooled** host (B2 measured on the direct host; B3 found several server pools behind the pooler); (iv) a
   rotation drill on TEST with two slots; (v) every (b)/(c) route: positive control and wrong-token refusal
   (404/redirect as today, never an empty 200); (vi) the full restricted-role integration suite with phases 1+2
   applied; (vii) `/api/health` signed-context probe.

---

## 3. Runtime identity split

**Who needs `matflow_ops`:** the 78 (a) sites, the 12 Operator writes in §1, operator login and logout
(`lib/operator-auth.ts` writes the failure counter and lock from an **anonymous** route), impersonation start/end, and
the null-tenant audit path. Nothing in the tenant-facing request path needs it.

**lib/prisma.ts** today builds one lazy client from `DATABASE_URL` with `prismaPoolConfig()` (max 5 in production,
20 elsewhere, keepAlive, 10 s connection timeout — L38–62) behind a Proxy (L124). Change: generalise
`createPrismaClient(envName, max)` and export a second lazy singleton `prismaOps` from `OPS_DATABASE_URL` (separate
`globalThis` key, same pooler warning, production max 2), plus `withSystemAccess(fn)` that opens a transaction on it
and, once per client, asserts `pg_has_role(current_user, 'matflow_system', 'MEMBER')` — so ops work never silently
runs as the runtime role and sees nothing. No fallback to `DATABASE_URL`: unset `OPS_DATABASE_URL` → the operator
console and crons answer 503. A unit import-boundary test allows `prismaOps`/`withSystemAccess` only from app/admin/**,
app/api/admin/**, app/api/cron/**, lib/tenant-purge.ts, lib/stripe/reconcile.ts, lib/operator-*.ts,
lib/impersonation.ts (start/end only) and the null-tenant branch of lib/audit-log.ts; and B3's bare-call allowlist
test is extended so a bare `prisma.operator` write fails.

**Same deployment first, separate deployment for phase 3.** With both URLs in one Vercel project, P2 still defeats a
leaked runtime URL and any SQL running as `matflow_app`, but a compromise of the app environment yields the ops
credential (B2's table, row 2, assumes it does not). The operator console, its anonymous login route and the crons
must move to their own deployment (own project and host; vercel.json crons move with them) before phase 3 and before
the P2 claim "runtime env compromise = one club at a time" is made. In that deployment `DATABASE_URL` can itself be the
ops URL, so no second client is needed there; the tenant deployment holds only `matflow_app` + the key.

**Migrations get their own pipeline.** Today `npm run build` = `node scripts/maybe-migrate.mjs && next build`
(package.json:7): the Vercel build migrates with `MIGRATION_DATABASE_URL` or, if unset, the runtime `DATABASE_URL`
(maybe-migrate.mjs:22–26, :80–83). A Vercel variable is visible to the same project's functions (Vercel's documented
model; not verified by this lane), so a migration URL there is not a separation, and once `DATABASE_URL` is
`matflow_app` the fallback makes every build fail on DDL. Recommendation: a GitHub Actions workflow in a protected
environment (required reviewer: Noe) holding the owner **direct** URL as an environment secret runs
`prisma migrate deploy`, then triggers the production deploy; production Git auto-deploy and the migrate step in the
build are removed. This touches ci/workflows and vercel.json, which the lead owns (SF-58, D-4) — proposal only.

**CI must apply the boundary the way production will.** ci.yml runs `prisma migrate deploy` (L73) and seeds before
creating `matflow_app` (L137, `scripts/ci-create-restricted-role.sql`), but phase 1 grants to `matflow_app` and fails
if the role does not exist; phase 2 refuses to run without a key row. So: create `matflow_app` and `matflow_ops`
before migrating, provision a per-run CI key before the phase-2 migration, and stop `ci-create-restricted-role.sql`
granting `ALL TABLES` (it re-grants `_prisma_migrations` and, after phase 3, Operator/PlatformConfig writes — CI would
test a weaker grant set than production). The RLS gate runs only `rls-foundation` as `matflow_app`; it should add the
acceptance test and the (b)/(c) route tests. Also: the phase-1 SQL needs B2's own owed assertion (R2 owed item 6:
refuse if `matflow_app` is a member of `matflow_system`) and **future migrations** must add `system_access` and the
`matflow_system` grants to every new RLS table (phase 1's loops cover existing tables only) — add a catalogue test.

**Pool and connection counts.** Today: ≤ 5 server-side connections per warm production instance (lib/prisma.ts:55).
Release B in one deployment: ≤ 5 + 2 per instance that has served operator or cron work (the ops pool is lazy);
after the split, back to 5 in the tenant deployment. Neon's pooler keeps a separate server-side pool per role and
database; the sum must fit the compute's connection limit (Neon documentation, not opened or measured by this lane —
check before release B). Signing costs one extra round trip per tenant transaction against today's unsigned path (two
statements instead of one; B2's current code with a key uses three). The ops identity's `system_access` policy is a
constant `true`, so ops queries pay no InitPlan.

---

## 4. Test and tooling changes

Counts from this lane's grep (`evidence/B4/tests-and-tooling-inventory.txt` lists every file):

- **Integration — bypass users: 65 of 81 files.** 62 call `withRlsBypass(` (**649 calls**; largest:
  cross-tenant-authorisation-matrix 69, attendance-import-engine 46, sec-d2-import-attacker-model-db 26,
  member-children-lifecycle 24); 8 set `app.bypass_rls` in raw SQL, 3 of them only that way
  (email-lowercase-invariant, sec-b2-public-boundary-proposal, sec-f2-auditlog-append-only-db). Under phase 2, run as
  `matflow_app` through `q78/run-restricted.sh` (which points the app singleton and the fixtures at the same
  restricted URL), every fixture creation and teardown through the bypass sees nothing. Change: a test-only
  `fixtureDb` client from a new `TEST_OWNER_DATABASE_URL` behind the same host guard as `tests/setup-test-db.ts`, and
  a mechanical swap of fixture calls. The 8 raw-bypass files assert bypass **semantics** and need rewriting, not
  swapping: after phase 2 the bypass must grant nothing.
- **AuditLog teardowns (SF-57 dependency): 34 files at 03ef584** delete AuditLog rows (`auditLog.delete[Many]` or
  `DELETE FROM "AuditLog"`) — this is the "~30" of RELEASE-SEQUENCE 5.3 and Stage 6's gate. A 35th
  (sec-m1-demo-rotate-db, lane M1, untracked) was in flight at writing. Under SF-57 these must delete through the
  owner connection.
- **e2e: 6 specs, not 4**, open their own Prisma client on the ambient `DATABASE_URL`: member-account-unlock,
  member-password-reset, member-totp-recovery (each sets `app.bypass_rls`, lines 103/123/100), member-totp-enrol,
  owner-defer-totp, totp-enrolment-flow (no bypass — under `matflow_app` their RLS-table reads already return
  nothing). All six need the fixture URL. The e2e harness (playwright.config.ts loads `.env.test`; the dev-server
  launcher) needs a phase-2 mode: server as `matflow_app` + key + `OPS_DATABASE_URL`, helpers on the owner URL.
- **Unit: 123 files** mention `withRlsBypass` (mostly `vi.mock("@/lib/prisma-tenant")`); every changed site's tests
  must mock `withResolvedTenant` / `withSystemAccess` instead. Mechanical but the largest diff.
- **Guarded runners:** `att/run-engine.sh` (owner) and `q78/run-restricted.sh` (matflow_app) need
  `TEST_OWNER_DATABASE_URL`, `OPS_DATABASE_URL` (a TEST `matflow_ops` login) and the TEST key exported, with the same
  endpoint guards.
- **Seed:** prisma/seed.ts connects with `DATABASE_URL` and no context (L17–34) — owner-only by construction; add a
  role assertion so it refuses to run as `matflow_app`. CI and e2e seed as `postgres` and are unaffected.
- **Scripts: 23** set `app.bypass_rls` or call `withRlsBypass` (list with URL source in the inventory). As the owner
  (BYPASSRLS) the setting is a no-op and they keep working; pointed at `matflow_app` after phase 2 they silently see
  nothing. Each should assert its role at start and drop the setting. Exceptions kept on purpose:
  `rls-boundary-harness.mjs` and `rls-proposal-validate.mjs` (they attack the bypass).
- **scripts/create-restricted-role.ts** (L45–52) grants DML on all public tables plus default privileges, revoking only
  `_prisma_migrations`; re-running it after phase 3 would undo phase 3. It must exclude Operator/PlatformConfig writes,
  GymApplication UPDATE/DELETE and AuditLog UPDATE/DELETE, never touch `matflow_sec`, and gain a `matflow_ops`
  counterpart for TEST. **scripts/apply-rls-enforcement.ts** (ENABLE/FORCE only) needs no boundary change but should
  refuse if a table lacks `system_access` once phase 1 is applied.

---

## 5. Phase-3 and SF-57 dependencies

| before … | these must have landed | why |
|---|---|---|
| **phase 3: revoke Operator writes** from `matflow_app` | the 12 Operator writes (§1 item 2) on the ops client; operator login/logout/TOTP/step-up/impersonation start-end on ops; **separate operator deployment** | otherwise operator sign-in (anonymous route) and every step-up fail; in one deployment the ops credential would be reachable from an anonymous route |
| **phase 3: revoke PlatformConfig writes** | nothing in the app (0 references) | — |
| **phase 3: revoke GymApplication UPDATE/DELETE** | approve/reject on ops (rows in §1) | they update the application row |
| **`_prisma_migrations` revoke** (B2 phase 2; RELEASE-SEQUENCE 5.6 lists it under phase 3 — the two documents disagree) | migrations off the runtime credential (§3) | a build migrating with `matflow_app` would fail; no app code touches the ledger |
| **SF-57 v2** (F2 patches 0001/0002) | retention's `auditLog` rule through `audit_log_purge()` in the same release as retention moves to ops; null-tenant audit writes on ops; the 34 AuditLog teardowns on the owner connection | append-only refuses the direct delete for both `matflow_app` and (phase 1) `matflow_system` |
| SF-57 v2 grant target | decide who runs retention: patch 0002 grants `audit_log_purge` EXECUTE to `matflow_app` (L186) and requires its definer to hold BYPASSRLS (L151); B2 (03-chain) recommends EXECUTE for `matflow_system`/`matflow_ops` only and a non-BYPASSRLS owner | with retention on ops, granting the runtime role a purge is unnecessary — the two proposals must be reconciled before either is applied |

---

## 6. Effort, ordering, and what can ship without the boundary

Estimates are this lane's judgement from the code read, not measured; they assume one engineer plus independent review.

| group | scope | risk | review | estimate |
|---|---|---|---|---|
| G1 primitives | lib/prisma-tenant.ts (two-statement signing, `enter_tenant`, mode, typed error, `withResolvedTenant`, remove `withRlsBypass`), lib/prisma.ts + `prismaOps`/`withSystemAccess`, lib/api-error.ts mapping, `/api/health` probe; SQL amendment (`enter_tenant`, 2 resolvers, membership assertion, role-existence guard) + validator re-run | **high** — every request | independent code + SQL review; both-role DB tests | 2–3 days |
| G2 (b)+(c)+(e) | 38 sites in 29 files (disjoint from G3's 30; 30 + 29 = 59) incl. auth.ts sign-in, Stripe and Resend webhooks, kiosk interface + KioskPage.tsx, disown token format | **high** — sign-in, payments, kiosk | independent review; route tests per site | 3–4 days |
| G3 (a) | 78 sites in 30 files → `withSystemAccess`; 12 Operator writes; retention auditLog rule → purge | medium — mechanical, but cron and purge are destructive | review of tenant-purge and retention diffs | 2–3 days |
| G4 tests/tooling | 65 integration files (649 calls), 6 e2e specs, 123 unit files, runners, 23 scripts, role scripts, seed guard | low product risk, high volume | spot review + full both-role sweep | 4–5 days |
| G5 pipeline | migrate workflow, build step, vercel.json crons/auto-deploy, CI role order and key, backup exclusion | medium — deploy path | lead/Noe (owned files) | 1–2 days + Noe's settings |
| G6 separate operator deployment | second Vercel project/host, env split, cron move | medium | Noe | 1–2 days + Noe |

**Ordering against 04-rollout.md (steps 0–7; RELEASE-SEQUENCE Stage 5):**
0 (bypass reset) ships in release A. 1 (production role, SF-02) gates everything. **Before 2:** amend and re-validate
the phase-1 SQL (G1 SQL part) — phase 1 as written lacks `enter_tenant`, the Resend and provisional-address
functions, R2's membership assertion and a guard for a missing `matflow_app`. 2 phase 1. 3 key pads + `matflow_ops`
login. 4 **release B = G1–G4 (+G5 for the build step)**, deployed with the key and `RLS_CONTEXT_MODE=observe`: it
needs the phase-1 resolvers, so it cannot precede step 2, and it still works on phase-1 policies. **Then switch the
runtime to `matflow_app` (04-rollout step 6) before phase 2** — this lane recommends reversing B2's 5/6 order: under
phase 1 the identity change and the boundary change fail in different ways and should be observed separately; the
interim exposure is no wider than today's owner login. After a clean observe period (zero mismatches) and at least 7
days after the new disown-link format shipped: set `enforce`, then 5 phase 2. 7 phase 3 after G6. SF-57 v2 after
phase 2 with the §5 reconciliation.

**Can ship without the boundary (now, on today's policies and owner role):** release A (03ef584) as it stands; the
two (e) deletions; the disown token carrying the tenant (accept both formats — starts the 7-day clock); the
kiosk-status interface change; the test `fixtureDb` client and runner variables; the role assertions in scripts and
seed; the backup exclusion (harmless before phase 1); the migration-workflow split; the `withRlsBypass` count ratchet;
the import-boundary test; `prismaOps` plumbing behind an unset `OPS_DATABASE_URL` only if the operator console is
allowed to fall back — this lane recommends it is **not**, so that piece waits for step 3.
**Must wait:** every (b) resolver call (needs phase 1 in that environment), observe/enforce, phase 2, phase 3,
SF-57 v2.

## Gaps and limits of this analysis

Nothing was executed against a database; claims about Postgres behaviour (refused context = empty reads, WITH CHECK on
NULL tenant, GRANT to a missing role failing) are from the SQL text and B2's measurements, not re-measured here. Vercel
env visibility and Neon per-role pooler limits are not verified. The per-site models were read by a scan of each
callback plus a manual read of every non-operator site; operator sites were classified by path and spot-read.
Residual after full integration (unchanged from B2): whoever holds the runtime environment (URL + key) can act inside
any one club; application-layer `tenantId` filters remain the first defence.
