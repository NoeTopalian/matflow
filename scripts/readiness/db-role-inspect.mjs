// READ-ONLY database runtime-identity inspection (security campaign 9 Oct 2026, SEC-021/SEC-068). Usage: node scripts/readiness/db-role-inspect.mjs <env-file> <expected-host-substring> [VAR=DATABASE_URL]
// Opens one connection to the URL in the named env file, runs a READ ONLY transaction, prints role flags,
// memberships, grants, policy settings, table ownership and pooling context. Prints no credentials and no row data.
import fs from "node:fs";
import pg from "pg";

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
const host = new URL(url).hostname;
if (!host.includes(expectHost)) { console.error(`REFUSED: host does not contain ${expectHost}`); process.exit(2); }
console.log(JSON.stringify({ host, pooler: host.includes("-pooler"), sslmode: new URL(url).searchParams.get("sslmode") }));

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true }, application_name: "matflow-security-readonly" });
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = '15s'");
  const q = async (label, sql) => { const r = await client.query(sql); console.log(label, JSON.stringify(r.rows)); };
  await q("identity", "select current_user, session_user, current_database() as db, version() as pg");
  await q("role_flags", "select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolcanlogin, rolconnlimit from pg_roles where rolname in (current_user, session_user)");
  await q("memberships", "select r.rolname as member_of from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = current_user");
  await q("roles_present", "select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname not like 'pg_%' order by rolname");
  await q("table_owners", "select c.relname as tablename, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by c.relname");
  await q("policies", "select tablename, policyname, cmd, roles, permissive from pg_policies where schemaname = 'public' order by tablename, policyname");
  await q("grants_current_user", "select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where grantee = current_user and table_schema = 'public' group by table_name order by table_name");
  await q("grants_public_role", "select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where grantee = 'PUBLIC' and table_schema = 'public' group by table_name order by table_name");
  await q("settings", "select name, setting from pg_settings where name in ('row_security','ssl','is_superuser','default_transaction_read_only','statement_timeout','idle_in_transaction_session_timeout')");
  await q("app_bypass_setting", "select current_setting('app.bypass_rls', true) as bypass, current_setting('app.tenant_id', true) as tenant");
  await q("pooling", "select count(*) as my_app_connections from pg_stat_activity where application_name = 'matflow-security-readonly'");
  await client.query("ROLLBACK");
} finally {
  await client.end();
}
