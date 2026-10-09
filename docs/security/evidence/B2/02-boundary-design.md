# SF-62 enforced-boundary design (lane B, iteration 2)

## Selected architecture (measured as design P2)

1. **Role-keyed system access.** One NOLOGIN, NOBYPASSRLS role `matflow_system` carries the only cross-tenant policy
   (`system_access … TO matflow_system USING (true)` on every RLS table). Cross-tenant operator and cron work logs in
   as `matflow_ops` (LOGIN, own password, member of matflow_system, created out of band) through a *separate* URL that
   exists only where operator/cron code runs. `matflow_app` is never a member, so SET ROLE / SET SESSION AUTHORIZATION /
   self-GRANT are refused (C06). No GUC grants anything to anyone.
2. **Signed, transaction-bound tenant context.** `tenant_isolation` accepts `app.current_tenant_id` only when
   `app.ctx_mac` = HMAC-SHA256(key, `tenant|pg_backend_pid()|transaction start µs`). Verified by
   `matflow_sec.ctx_tenant()` (SECURITY DEFINER, owner matflow_system, `search_path = pg_catalog, pg_temp`, all objects
   qualified, EXECUTE named, never PUBLIC). The key's HMAC pads sit in `matflow_sec.context_key`, readable only by
   matflow_system (RLS + grant); the app holds the key in `RLS_CONTEXT_SIGNING_KEY`. Binding to backend pid and
   transaction start makes a captured MAC useless in any later transaction or on any other connection (C09), and a
   session-level leftover useless (C12). Cost: one extra round trip per tenant transaction (pid/start), one InitPlan per
   statement; no xid is assigned (read-only transactions stay read-only).
3. **Narrow pre-tenant resolvers.** `matflow_sec.tenant_id_by_{slug,kiosk_token_hash,display_token_hash,stripe_account,
   magic_link_hash,reset_token_hash}` map one exact public identifier to one tenant id and nothing else (NULL/empty/
   wildcard → NULL). The app then enters a signed context for that tenant and reads under RLS — the resolver is not a
   second bypass (C13: resolving B then reading B without a MAC sees 0).
4. **Append-only audit and no ledger rights** at the runtime-role boundary (C15; phase 2 revokes `_prisma_migrations`;
   the AuditLog part is lane F's SF-57 migration).
5. **Separate credentials.** Owner/migration (DDL, BYPASSRLS) only in a migration pipeline; runtime `matflow_app`;
   operator/cron `matflow_ops`. While `MIGRATION_DATABASE_URL` is a Vercel environment variable it is, per Vercel's
   documented model (not verified in this lane), readable by the same runtime functions — so it is not separated.

## What each compromised credential yields (P2 vs today)

| attacker holds | today (deployed design) | after P2 + phase 3 |
|---|---|---|
| runtime DB credential only (leaked URL; injected SQL) | every club, read/write; audit rewrite; operator credential rewrite; migration ledger | nothing in tenant tables (no MAC); resolvers return ids only; append-only audit; no ledger. Still: non-RLS public tables until phase 3 |
| runtime env (DB URL + signing key) = full app compromise | as above | any one club at a time, read/write of mutable rows (R1, expected) — the app legitimately serves every club; no audit rewrite, no purge, no operator powers, no DDL |
| operator credential (matflow_ops) | n/a | cross-tenant DML by policy; bounded purge; no DDL, no BYPASSRLS (C17) |
| owner credential | everything | everything — keep it out of every runtime environment |

## Alternatives evaluated

- **SECURITY DEFINER wrapper around the bypass** (e.g. `enable_bypass()`): rejected — it is the same unrestricted bypass
  behind a callable door; whoever can call it is the runtime role.
- **SET ROLE to a privileged role** (matflow_app member of matflow_system, NOINHERIT): rejected — arbitrary SQL can SET
  ROLE as freely as it can set a GUC.
- **Policies keyed on `current_user` only (P1)**: removes the global bypass (C05 holds) but the tenant id stays a forgeable
  GUC: C08, C09, C12, C16 fail. Adopted as the role half of P2, not on its own.
- **Signed context with pg_locks virtual-xid or txid_current() binding**: rejected — pg_locks takes lock-manager
  partition locks per call; txid_current() assigns an xid (commit record, WAL flush) to every read.
- **pgcrypto hmac()**: not needed; built-in `sha256()` with stored pads is exact HMAC for a 64-byte key (unit + DB tests).

## Measured (harness-run-2026-10-09.json; Node 24.21.0; scratch schema, genuine logins)

| cell | CURRENT | P1 | **P2** | MUTANT (P2 + bypass clause) |
|---|---|---|---|---|
| C01 runtime identity, C02 positive control, C03 default deny, C04 cross-tenant in context | hold | hold | **hold** | hold |
| C05 bypass GUC | **BREACH** | hold | **hold** | **BREACH** (caught) |
| C06 SET ROLE / SESSION AUTH / self-grant; C07 row_security=off | hold | hold | **hold** | hold |
| C08 forged tenant; C09 random/replayed/transplanted MAC (+ positive control) | BREACH | BREACH | **hold** | hold |
| C10 commit/error/savepoint; C11 concurrent pooled | hold | hold | **hold** | hold |
| C12 session-level tenant / bypass leftovers (direct connection only) | BREACH | BREACH | **hold** | BREACH |
| C13 resolvers narrow, purge not executable, search_path hijack | n/a | hold | **hold** | hold |
| C14 runtime cannot alter RLS/policies/functions, read key, TRUNCATE, self-grant | hold | hold | **hold** | hold |
| C15 audit UPDATE/DELETE/back-dated INSERT (SF-57 interplay) | BREACH | hold | **hold** | hold |
| C16 cross-tenant provenance rewrite (SF-67 chain) | BREACH | BREACH | **hold** | BREACH |
| C17 operator credential: cross-tenant, purge floor (+ positive control), no DDL | n/a | hold | **hold** | hold |

Exit 0 = CURRENT reproduces the breach, P2 holds on every boundary cell, MUTANT caught. Teardown count-checked (0 schemas,
0 roles left). Session-level settings were exercised only on a direct (non-pooler) connection: through the shared
PgBouncer they would leak to other lanes' clients — the pooled leak itself was therefore deliberately not reproduced.
