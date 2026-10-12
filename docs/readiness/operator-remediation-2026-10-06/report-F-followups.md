# Lane F report (saved by lead; agent write refused by hook)
E-1 FIXED LOCALLY: classes/[id] PATCH pre-flight ownership check (404 before any query incl dryRun); subscription lookups carry member:{tenantId}; removed latent in-tx bad_location early-return (committed instead of rolled back).
E-2 FIXED LOCALLY: new lib/class-refs.ts classRefError (tenant-scoped location/requiredRank/maxRank/coach); PATCH pre-flight + POST; PATCH roster ids filtered to tenant. Residual: pre-existing cross-tenant links in prod stay — detection SQL in RUNTIME-DB-ROLE-CHECK.md §4 for Noe.
E-3 FIXED LOCALLY: ranks/[id] DELETE ownership first; count scoped member:{tenantId}.
Matrix: owner role 54/54, restricted 54/54; class-schedule-edit 5/5; roster-cross-tenant 3/3.
lib/push.ts: withRlsBypass, short tx, empty memberId guard (previously would read all). tests/unit/push-rls-bypass.
scripts/maybe-migrate.mjs: MIGRATION_DATABASE_URL else DATABASE_URL; guards on chosen URL; prints names only. tests/unit/maybe-migrate-url.
db-backup.yml: pg client 17 via PGDG signed-by keyring, version assert, pg_restore --list integrity step (empty/unreadable/no data/missing Tenant,Member,User,_prisma_migrations), set -euo pipefail, permissions contents:read; secret names unchanged; YAML + bash -n checked; NEVER RUN (table-pattern only tested on a hand-made listing).
Unit: class-cross-tenant-refs 21 (13 fail on old code); push+maybe-migrate 9. Lead applied class-roster-survives-edit mock fix: 28/28 with class-cross-tenant-refs.
