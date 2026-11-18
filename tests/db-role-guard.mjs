// Which database role a test run is really connected as, and whether row-level security really applies to it.
//
// Why (closure phase, 19 Nov 2026): an ad-hoc runner ran the restricted pass as matflow_app but forgot RLS_ENFORCED=1.
// Nine security files then took their owner branch or refused to start, and the rest reported "passed" for a run that
// was not the one intended. The flag is only a statement of intent; this reads the facts from Postgres and refuses a
// run where the two disagree. Used by the Vitest global setup (every runner) and by the guarded database runner.
import pg from "pg";

const PROD_NEON_ENDPOINT = "ep-bold-wave";

/**
 * Facts about the connected role. Read-only: one connection, catalogue reads and one uncontexted count.
 * `memberRowsVisible` is the number of "Member" rows this connection can see with NO tenant context set (null when the
 * table does not exist yet). Under enforced RLS it is 0 however many rows the table holds.
 */
export async function readDbRole(url) {
  if (url.toLowerCase().includes(PROD_NEON_ENDPOINT)) throw new Error("refusing: the role check will not connect to production");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    const one = async (sql) => (await client.query(sql)).rows[0];
    const role = await one(`SELECT current_user AS "currentUser", r.rolsuper AS "superuser", r.rolbypassrls AS "bypassRls",
      current_setting('server_version') AS "serverVersion", coalesce(current_setting('app.bypass_rls', true), '') AS "sessionBypass"
      FROM pg_roles r WHERE r.rolname = current_user`);
    const tables = await one(`SELECT count(*)::int AS "tables", count(*) FILTER (WHERE c.relrowsecurity)::int AS "rlsTables",
      count(*) FILTER (WHERE c.relrowsecurity AND NOT c.relforcerowsecurity AND pg_get_userbyid(c.relowner) = current_user)::int AS "ownedUnforced"
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`);
    const hasMember = (await one(`SELECT to_regclass('public."Member"') IS NOT NULL AS "exists"`)).exists;
    const memberRowsVisible = hasMember ? (await one(`SELECT count(*)::int AS n FROM "Member"`)).n : null;
    return { ...role, ...tables, memberRowsVisible };
  } finally {
    await client.end();
  }
}

/** Why RLS does NOT bind this role (empty when it does). Postgres skips RLS for superusers, BYPASSRLS roles and unforced owners. */
export function rlsGaps(facts) {
  const gaps = [];
  if (facts.superuser) gaps.push("the role is a superuser");
  if (facts.bypassRls) gaps.push("the role has BYPASSRLS");
  if (facts.rlsTables === 0) gaps.push("no table in schema public has row-level security enabled");
  if (facts.ownedUnforced > 0) gaps.push(`the role owns ${facts.ownedUnforced} RLS table(s) without FORCE ROW LEVEL SECURITY`);
  if (facts.sessionBypass === "on") gaps.push("app.bypass_rls is 'on' for the session");
  if (typeof facts.memberRowsVisible === "number" && facts.memberRowsVisible > 0 && gaps.length === 0) {
    gaps.push(`${facts.memberRowsVisible} Member row(s) are visible with no tenant context`);
  }
  return gaps;
}

/**
 * Does the RLS_ENFORCED flag match the connection? Returns null when it does, otherwise the reason to refuse the run.
 *  - a role RLS binds, without RLS_ENFORCED=1: the security files would run their owner branch (the 19 Nov mistake);
 *  - RLS_ENFORCED=1 on a role RLS does not bind: the run would claim an enforcement proof it cannot give.
 */
export function dbRoleMismatch(facts, flag) {
  const gaps = rlsGaps(facts);
  const privileged = facts.superuser || facts.bypassRls;
  if (flag === "1") {
    return gaps.length ? `RLS_ENFORCED=1 but row-level security does not bind "${facts.currentUser}": ${gaps.join("; ")}.` : null;
  }
  if (!privileged) {
    return `connected as "${facts.currentUser}", a role without BYPASSRLS, but RLS_ENFORCED is not 1. A restricted run must set RLS_ENFORCED=1 (use the guarded runner: .claude/skills/matflow-verify-local/scripts/db-tests.mjs).`;
  }
  return null;
}

/** One line for a log: facts only, never a URL. */
export function describeDbRole(facts) {
  return `db user ${facts.currentUser} (superuser ${facts.superuser}, bypassrls ${facts.bypassRls}), PostgreSQL ${facts.serverVersion}, ` +
    `${facts.rlsTables}/${facts.tables} tables with RLS, Member rows visible without tenant context: ${facts.memberRowsVisible ?? "n/a"}`;
}
