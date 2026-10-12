# SF-62 root cause and policy matrix (lane B, iteration 2, 9 Oct 2026)

Source: branch `security/assurance-2026-10` at HEAD 6043fed (plus this lane's uncommitted changes). Database evidence: TEST
branch only (endpoint ep-hidden-salad, PostgreSQL 17.11), genuine logins — `matflow_app` with its own credential
(rolsuper false, rolbypassrls false, no memberships) and `neondb_owner` (rolbypassrls true). Runtime for every run: Node
v24.21.0 (`<scratchpad>/security/node24`). Production was not read (SF-02 refusal stands); nothing here is a claim about
production's identity.

## Mechanism (exact)

Every one of the 47 `tenant_isolation` policies on the public schema (47 RLS tables; catalogue read 9 Oct 18:2x UK by
`rls-proposal-validate.mjs`) has the same two-clause shape, `FOR ALL TO PUBLIC`, `USING` only (so `USING` is also the
`WITH CHECK`):

    (current_setting('app.bypass_rls', true) = 'on') OR <tenant predicate on current_setting('app.current_tenant_id', true)>

37 compare `"tenantId"`, `Tenant` compares `id`, 9 child tables compare through `EXISTS` on a parent (ClassSubscription,
ClassWaitlist, MemberRank → Member; RankHistory → MemberRank⋈Member; ClassInstance, ClassSchedule → Class;
ClassPackRedemption → MemberClassPack; PasswordHistory → User; InitiativeAttachment → Initiative).

- `app.bypass_rls` and `app.current_tenant_id` are **custom placeholder settings**. `pg_settings` lists no `app.%`
  parameter, so they are user-settable by any role with `set_config()` or `SET`; there is no privilege that withholds
  them from a role. `withRlsBypass` and `withTenantContext` (lib/prisma-tenant.ts) are simply the application choosing to
  set them; the database cannot tell the helper from any other statement on the same login.
- It is **not** role membership / SET ROLE (matflow_app has no memberships; `SET ROLE neondb_owner` → 42501), **not**
  table ownership (owner is neondb_owner), **not** BYPASSRLS on matflow_app, **not** a callable function (no function in
  public is SECURITY DEFINER; the only one is the email-lowercase trigger), and **not** `row_security = off` (that raises
  42501 "query would be affected by row-level security policy", it never bypasses).
- `FORCE ROW LEVEL SECURITY` is set on all 47 tables, but it only subjects the table *owner* to policies when the owner
  lacks BYPASSRLS. `neondb_owner` has BYPASSRLS: the harness inserts fixtures into FORCE-RLS tables as the owner with no
  context at all. FORCE does nothing against the owner identity.

## Measured on the deployed policy design (public schema, matflow_app, READ ONLY, rolled back, counts only)

| probe | result |
|---|---|
| no context | 0 Tenant rows (default deny) |
| `set_config('app.bypass_rls','on',true)` | **141 Tenant rows; AuditLog rows of 132 clubs visible** |
| bypass cleared | 0 again |
| forged `app.current_tenant_id` (an id read under the bypass, not printed) | **894 Member rows of that club**; 0 of others |
| `SET LOCAL row_security = off` | 42501 (refused, not a bypass) |
| `SET LOCAL ROLE neondb_owner` | 42501 |
| privileges outside RLS | AuditLog UPDATE/DELETE yes (TRUNCATE no); `_prisma_migrations` INSERT/UPDATE/DELETE yes; `Operator` INSERT/UPDATE yes; CREATE on public no; TEMP yes |
| writer probe (UPDATE matching no row, rolled back) | `Operator.passwordHash`, `_prisma_migrations`, `PlatformConfig`: **all PERMITTED** |

Evidence: harness-run-2026-10-09.json `publicProbe`, test logs in this folder.

## Which policies hold, under which control (campaign conclusion item 3, corrected)

The iteration-1 statement "RLS enforced in TEST" is true only for the first column. Both-role test counts do not settle
it: no iteration-1 cell used the bypass as an attacker would — it was the fixture tool.

| control over the runtime session | 47 tenant_isolation policies | non-RLS tables (Operator, PlatformConfig, GymApplication, RateLimitHit, StripeEvent, _prisma_migrations) |
|---|---|---|
| **Ordinary request** through `withTenantContext` (app picks the tenant from the session) | **HOLD**: other club invisible; UPDATE/DELETE match 0; INSERT/move into another club refused (WITH CHECK); no context = nothing; context gone after COMMIT, error+ROLLBACK, ROLLBACK TO SAVEPOINT; concurrent pooled transactions isolated (harness C02–C04, C10, C11) | not governed by RLS; grants only |
| **Application-role control** (any session on the runtime credential issuing its own SQL: leaked DATABASE_URL, injected statement, compromised dependency, a helper bug) | **ALL FAIL**: one statement `set_config('app.bypass_rls','on')` opens every club for read and write (C05); a forged tenant id opens any one club (C08); a session-level setting left on a connection leaks into later transactions (C12) | fully writable, incl. operator credentials and the migration ledger |
| **Owner credential** (`neondb_owner`, BYPASSRLS; also the Vercel build's migration identity) | never apply (FORCE irrelevant to BYPASSRLS) | everything, plus DDL/TRUNCATE |

Conclusion: under the deployed design RLS is a backstop against an application-layer filter mistake inside a correctly
entered context. It is not a boundary against anyone who controls SQL on the runtime login, and it protects nothing
while production logs in as the owner (SF-02 still unknown).

## Fixed now in code (compatible with every policy version)

`withTenantContext` now sets `app.bypass_rls = 'off'` for its transaction in the same statement as the tenant. Red first:
with the reset removed, a session-level bypass left on the reused connection made club A's transaction see club B
(`test-stale-red-restricted.log`: 1 failed, the intended cell, same backend pid asserted); with it, 6/6 under both
roles (`test-stale-green-*.log`). Residual recorded (not asserted): a plain query outside any transaction on a
connection carrying a leaked session-level tenant still sees that tenant — only the signed context removes it.
