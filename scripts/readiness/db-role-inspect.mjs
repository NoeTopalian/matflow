// READ-ONLY database runtime-identity inspection (security campaign 9 Oct 2026, SEC-021/SEC-068; extended per lanes E2 G1-G5 and B2).
// Usage: node scripts/readiness/db-role-inspect.mjs <env-file> <expected-host-substring> [VAR=DATABASE_URL]
// Opens ONE connection built from an explicit config (the URL is parsed, ssl parameters in it are ignored and TLS
// verification is forced), runs a READ ONLY transaction, prints role flags, memberships (with admin option),
// table owners and RLS flags, policy EXPRESSIONS, SECURITY DEFINER functions with owner and ACL, schema privileges,
// grants, settings and the app context GUCs. Prints no credentials and no row data.
// Opens one connection to the URL in the named env file, runs a READ ONLY transaction, prints role flags,
// memberships, grants, policy settings, table ownership and pooling context. Prints no credentials and no row data.
import fs from "node:fs";
import pg from "pg";
import { parse as parsePg } from "pg-connection-string";
import { resolveDbTarget, TargetRefused } from "./db-target.mjs";

const envFile = process.argv[2];
const varName = process.argv[4] ?? "DATABASE_URL";
const expectHost = process.argv[3];
if (!envFile || !expectHost) { console.error("usage: node prod-db-role.mjs <env-file> <expected-host-substring>"); process.exit(2); }
const env = Object.fromEntries(
  fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
    const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
  }),
);
const url = env[varName];
if (!url) { console.error(`no ${varName} in env file`); process.exit(2); }
// Shared guard (review of lane F): effective host as pg resolves it; overrides refused; case-insensitive.
// Production is admissible here because this script exists for the read-only production baseline (SF-02).
let host;
try { host = resolveDbTarget(url, { expectHost, allowProduction: true }); } catch (e) { console.error(e instanceof TargetRefused ? e.message : String(e)); process.exit(2); }
console.log(JSON.stringify({ host, pooler: host.includes("-pooler"), sslmode: new URL(url).searchParams.get("sslmode") }));

// Explicit config: pg lets connection-string parameters (sslmode=disable, sslrootcert, ...) override the ssl option
// (lane E2 G1), so the URL is parsed and only host/port/user/password/database are taken; TLS verification is forced.
const parsed = parsePg(url);
const client = new pg.Client({
  host: parsed.host, port: parsed.port ? Number(parsed.port) : 5432, user: parsed.user, password: parsed.password, database: parsed.database,
  ssl: { rejectUnauthorized: true }, application_name: "matflow-security-readonly",
});
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = '15s'");
  const q = async (label, sql) => { const r = await client.query(sql); console.log(label, JSON.stringify(r.rows)); };
  await q("identity", "select current_user, session_user, current_database() as db, version() as pg");
  await q("role_flags", "select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin, rolconnlimit from pg_roles where rolname in (current_user, session_user)");
  await q("memberships", "select r.rolname as member_of, m.admin_option from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = current_user");
  await q("roles_present", "select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname not like 'pg_%' order by rolname");
  await q("table_owners", "select c.relname as tablename, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by c.relname");
  await q("policies", "select tablename, policyname, cmd, roles, permissive, qual as using_expr, with_check as check_expr from pg_policies where schemaname = 'public' order by tablename, policyname");
  await q("secdef_functions", "select n.nspname as schema, p.proname as name, pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer, p.proconfig as config, p.proacl as acl from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog','information_schema') and (p.prosecdef or p.proacl is not null) order by 1,2");
  await q("schema_privileges", "select n.nspname as schema, pg_get_userbyid(n.nspowner) as owner, n.nspacl as acl from pg_namespace n where n.nspname not like 'pg_%' and n.nspname <> 'information_schema' order by 1");
  await q("can_set_role_to_owner", "select r.rolname, pg_has_role(current_user, r.oid, 'MEMBER') as member, pg_has_role(current_user, r.oid, 'USAGE') as usage from pg_roles r where r.rolbypassrls or r.rolsuper order by 1");
  await q("grants_current_user", "select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where grantee = current_user and table_schema = 'public' group by table_name order by table_name");
  await q("grants_public_role", "select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where grantee = 'PUBLIC' and table_schema = 'public' group by table_name order by table_name");
  await q("settings", "select name, setting from pg_settings where name in ('row_security','ssl','is_superuser','default_transaction_read_only','statement_timeout','idle_in_transaction_session_timeout')");
  await q("app_context_gucs", "select current_setting('app.bypass_rls', true) as bypass, current_setting('app.current_tenant_id', true) as current_tenant_id");
  await q("pooling", "select count(*) as my_app_connections from pg_stat_activity where application_name = 'matflow-security-readonly'");
  await client.query("ROLLBACK");
} finally {
  await client.end();
}
