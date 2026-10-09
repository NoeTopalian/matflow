# SF-62 rollout order and compatibility with the deployed app (lane B, iteration 2)

Deployed app: e8afb6a (historical reference from the brief, not re-observed by this lane). It calls `withRlsBypass`
(116 call sites, 05-bypass-inventory.md) and `withTenantContext` (tenant GUC only). The production runtime identity is
UNKNOWN (SF-02, production read refused 9 Oct 11:40 UK; not retried). If production logs in as `neondb_owner`
(BYPASSRLS), no policy change below has any runtime effect until step 6.

| step | what | where | compatible with e8afb6a? | evidence |
|---|---|---|---|---|
| 0 | `withTenantContext` resets `app.bypass_rls` off per transaction (done, uncommitted, this lane) | app code | yes — same single statement, extra literal | stale-bypass red 1/6 → green 6/6 both roles |
| 1 | establish the production runtime role: Noe runs `node scripts/readiness/db-role-inspect.mjs .env ep-bold-wave-abt39t7x` and pastes the output (lead's prepared path; see note below) | production, read-only, Noe | n/a | — |
| 2 | **phase 1 migration** (proposed-sf62-phase1.sql): matflow_system, system_access policies, matflow_sec schema, ctx_tenant, resolvers | migration (lead applies) | **yes** — additive; bypass and plain tenant GUC behave exactly as before | validator `P1-compatible-with-deployed-app` PASS |
| 3 | provision secrets out of band: 64-byte key → pads into `matflow_sec.context_key` (owner session) and `RLS_CONTEXT_SIGNING_KEY` into the runtime env; create `matflow_ops` login (password manager) and put its URL only where cron/operator code runs | Noe / operator | yes — inert until used | — |
| 4 | **app release**: signing switched on by the env var (already coded, lib/prisma-tenant.ts); replace the 116 bypass sites per the inventory classes; system client for CRON/OPERATOR | app code (NOT done in this lane) | yes — works on both policy versions | signed-context DB test both roles |
| 5 | **phase 2 migration** (proposed-sf62-phase2.sql): policies switch to the signed context; runtime loses `_prisma_migrations` | migration | **NO** — any build still calling withRlsBypass under matflow_app sees nothing (login and webhooks break). Refuses to run without a provisioned key | validator P2-refuses-without-key, P2-applies, K1–K6, A1–A6 |
| 6 | production `DATABASE_URL` → matflow_app; owner credential out of every runtime environment (migrations from a separate pipeline — `MIGRATION_DATABASE_URL` as a Vercel env var is readable by the runtime per Vercel's model, not verified here) | Noe | — | runbook RUNTIME-DB-ROLE-CHECK §3 |
| 7 | phase 3: revoke Operator/PlatformConfig writes and GymApplication UPDATE/DELETE from matflow_app once the operator console runs as matflow_ops in its own deployment; lane F's SF-57 migration (purge owned by a non-BYPASSRLS role, EXECUTE to matflow_system only) | migration | after step 4's operator split | — |

Rollback: `proposed-sf62-rollback.sql` phase-2 block restores the deployed policy semantics exactly (validator R1/R2:
bypass sees both clubs again, plain tenant GUC works), so an app rollback to e8afb6a works after it; the phase-1 block
removes the role, schema and system policies (R3/R4). Never roll the app back below the phase-2 release while phase 2 is
applied without running the phase-2 rollback first.

Note on step 1 (for lane E / lead, not this lane's file): `scripts/readiness/db-role-inspect.mjs` reads
`current_setting('app.tenant_id')` — the application's setting is `app.current_tenant_id` — and prints policy names but
not their expressions or any SECURITY DEFINER function. For the SF-62 production verdict the operator-run inspection
should also print `pg_get_expr(polqual)` per policy and `prosecdef/proowner/proconfig/proacl` for functions, plus
`has_table_privilege('matflow_app', '_prisma_migrations', …)` and on `Operator`.
