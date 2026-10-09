// READ-ONLY restore verifier (security campaign 9 Oct 2026, lane F, SEC-086 / SEC-087; iteration 2 lane F2, SF-64).
//
// Takes a structural + security-state FINGERPRINT of a database and compares two fingerprints, so a restored
// copy (a Neon point-in-time branch, a pg_restore of a dump, or the isolated restore built by backup-restore.mjs)
// can be checked against a baseline of the source. Catalogue facts, counts and one-way hashes only: no row data,
// no credentials, no addresses.
//
//   node scripts/readiness/restore-verify.mjs snapshot <env-file> <expected-host-substring> [VAR] [--content-hash] > fp.json
//   node scripts/readiness/restore-verify.mjs compare <baseline.json> <restored.json> [--allow-drift=T1,T2] [--expect-revoked]
//
// snapshot opens ONE connection, runs ONE `BEGIN READ ONLY` transaction (statement_timeout 15 s, 60 s for content
// hashes, whole run capped at 180 s). backup-export.mjs calls takeFingerprint() inside its own REPEATABLE READ
// export transaction so the baseline and the exported rows are the same snapshot.
//
// The fingerprint records (iteration 2 closes SF-64 — each item below was a tamper the old fingerprint missed):
//   per public table: exact row count, RLS enabled/forced, owner, ACL, every policy WITH its command, permissive
//     flag, roles and the USING / WITH CHECK expressions (pg_policies carries pg_get_expr text), every non-internal
//     trigger as pg_get_triggerdef plus its enabled state (a DISABLED trigger is a tamper), and with --content-hash
//     an md5 over every row's text in a collation-independent order (catches an UPDATE that keeps row counts);
//   every function in schema public: owner, SECURITY DEFINER flag, proconfig (search_path), language, ACL and an
//     md5 of its source (a replaced trigger body under the same name);
//   every role that owns, or holds a grant on, a public object, plus the connecting role: superuser, BYPASSRLS,
//     inherit, createrole, createdb, login, replication and its memberships (BYPASSRLS granted to the app role);
//   schema public owner/ACL, installed extensions, event triggers;
//   Postgres major version; every migration in _prisma_migrations (name, finished/rolled-back state, checksum);
//   every FK constraint with its validated flag and ORPHAN count;
//   the security state a restore silently rewinds (outstanding sign-in/reset tokens, session-version sums, operators,
//     newest audit row);
//   (lane F3, SF-96 — seven classes review R3 planted and this list missed) role- and database-level settings for
//     EVERY role (pg_db_role_setting: app.bypass_rls, search_path, row_security …; values digested), the database's
//     owner and ACL, every non-system schema, views / materialised views (definition, owner, ACL, options),
//     sequences, foreign tables and tables outside public, rewrite rules on every relation, column-level grants
//     (pg_attribute.attacl), default privileges (pg_default_acl), and functions in every non-system schema. The
//     fingerprint runs with search_path = public so object names never depend on the connecting role's own setting.
// The production host (ep-bold-wave) is refused unless `--production-read-only` is passed explicitly; that flag is
// for the lead or Noe taking a baseline, never for a lane. A PGOPTIONS / PGHOST / PGHOSTADDR environment variable
// is refused (pg applies PGOPTIONS when the URL has no options=, which would let `endpoint=` route a TEST hostname
// elsewhere — not covered by db-target.mjs; see evidence/F2/REPORT.md).
//
// compare exits 0 only when: same major version; identical migration list (and checksums); identical table set;
// identical RLS flags, owners, ACLs, policies (expressions included) and triggers (definition and enabled state);
// identical public functions, roles, schema ACL, extensions and event triggers; zero orphans and zero unvalidated
// FKs in the restored copy; identical row counts and content hashes except tables named in --allow-drift; and an
// IDENTICAL security state — a restored copy whose session versions or outstanding tokens differ from the baseline
// FAILS (iteration 1 only printed them). With --expect-revoked the security state must instead show the
// post-restore revocation applied: zero outstanding sign-in links and reset codes, and every User / Member /
// Operator session version raised by at least one (sum delta >= row count); content and AuditLog growth on the
// revocation's own tables are then expected.
import fs from "node:fs";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { resolveDbTarget, TargetRefused } from "./db-target.mjs";

/** Tables the post-restore revocation is expected to change (content), and AuditLog (it records the revocation). */
export const REVOCATION_TABLES = ["User", "Member", "Operator", "MagicLinkToken", "PasswordResetToken", "AuditLog"];

const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

/** @param {Record<string, string | undefined>} [env] */
export function refuseConnectionEnv(env = process.env) {
  for (const k of ["PGOPTIONS", "PGHOST", "PGHOSTADDR"]) {
    if (env[k]) throw new TargetRefused(`REFUSED: ${k} is set in the environment (pg would apply it to this connection)`);
  }
}

export function readEnvFile(envFile) {
  return Object.fromEntries(
    fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
      const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
  );
}

/** SQL predicate: a schema that is not a system schema (pg_catalog, information_schema, pg_toast*, pg_temp_*). */
const USER_SCHEMA = (col) => `(${col} not in ('pg_catalog','information_schema') and ${col} !~ '^pg_(toast|temp_)')`;

/** SQL: an ACL rendered as sorted grantee=privilege[*]/grantor items, so insertion order never matters. */
const ACL = (expr) => `coalesce((select string_agg(x, ',' order by x) from (
    select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || '=' || a.privilege_type
           || case when a.is_grantable then '*' else '' end || '/' || pg_get_userbyid(a.grantor) x
      from aclexplode(${expr}) a) s), '')`;

/** One-way digest of a setting value (a custom GUC could carry a key; names stay readable). */
const settingDigest = (v) => crypto.createHash("sha256").update(String(v)).digest("hex").slice(0, 16);

/**
 * Fingerprint sections added by lane F3 (iteration 2, SF-96 / review R3-5). Each closes a tamper class R3 planted in a
 * restored copy that the SF-64 fingerprint passed. compareFingerprints fails on ANY difference in any of them, and
 * fails when one side has a section the other lacks (fingerprints from different verifier versions).
 */
export const CATALOGUE_SECTIONS = {
  roleSettings: "role/database setting", // ALTER ROLE … SET / ALTER DATABASE … SET (app.bypass_rls, search_path, row_security …)
  database: "database", // owner and effective ACL of the current database
  schemas: "schema", // every non-system schema: owner and effective ACL
  relations: "relation", // views, materialised views, sequences, foreign tables, and tables outside public
  rules: "rewrite rule", // pg_rewrite on every relation (DO INSTEAD NOTHING on AuditLog)
  columnPrivileges: "column grant", // pg_attribute.attacl (UPDATE (action) ON "AuditLog")
  defaultPrivileges: "default privileges", // pg_default_acl (ALTER DEFAULT PRIVILEGES … GRANT … TO matflow_app)
};

async function catalogueSections(q) {
  const out = {};
  // pg_db_role_setting is readable by every role. Rows for OTHER databases do not apply to connections to this one
  // and are left out; rows for "all databases" and for this database are kept, keyed by scope, so a restore into a
  // database with a different name compares equal. Values are digested (names readable).
  const rs = await q(`select coalesce(r.rolname, case when s.setrole = 0 then '<ALL ROLES>' else '<unknown role ' || s.setrole || '>' end) who,
                             case when s.setdatabase = 0 then 'ALL DATABASES' else 'THIS DATABASE' end scope, s.setconfig cfg
                        from pg_db_role_setting s left join pg_roles r on r.oid = s.setrole
                       where s.setdatabase in (0, (select oid from pg_database where datname = current_database()))`);
  out.roleSettings = {};
  for (const r of rs) {
    const items = pgArr(r.cfg ?? []).filter(Boolean).map((kv) => {
      const i = kv.indexOf("=");
      return `${kv.slice(0, i).toLowerCase()}=${settingDigest(kv.slice(i + 1))}`;
    }).sort();
    out.roleSettings[`${r.who} @ ${r.scope}`] = items;
  }
  const d = (await q(`select pg_get_userbyid(datdba) owner, ${ACL("coalesce(datacl, acldefault('d', datdba))")} acl
                        from pg_database where datname = current_database()`))[0];
  out.database = { owner: d.owner, acl: d.acl };
  out.schemas = Object.fromEntries((await q(`select nspname, pg_get_userbyid(nspowner) owner, ${ACL("coalesce(nspacl, acldefault('n', nspowner))")} acl
                                               from pg_namespace where ${USER_SCHEMA("nspname")} order by 1`))
    .map((s) => [s.nspname, { owner: s.owner, acl: s.acl }]));
  out.relations = Object.fromEntries((await q(`select n.nspname || '.' || c.relname k, c.relkind::text kind, pg_get_userbyid(c.relowner) owner,
                                                      ${ACL("c.relacl")} acl, coalesce(array_to_string(c.reloptions, ','), '') options,
                                                      c.relrowsecurity rls, c.relforcerowsecurity force,
                                                      case when c.relkind in ('v','m') then md5(pg_get_viewdef(c.oid)) else '' end def
                                                 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                                where ${USER_SCHEMA("n.nspname")} and c.relkind in ('r','p','v','m','S','f')
                                                  and not (n.nspname = 'public' and c.relkind in ('r','p')) order by 1`))
    .map((r) => [r.k, { kind: r.kind, owner: r.owner, acl: r.acl, options: r.options, rls: r.rls, force: r.force, defMd5: r.def }]));
  out.rules = Object.fromEntries((await q(`select n.nspname || '.' || c.relname || '.' || r.rulename k, r.ev_enabled::text enabled, md5(pg_get_ruledef(r.oid)) def
                                             from pg_rewrite r join pg_class c on c.oid = r.ev_class join pg_namespace n on n.oid = c.relnamespace
                                            where ${USER_SCHEMA("n.nspname")} and r.rulename <> '_RETURN' order by 1`))
    .map((r) => [r.k, `enabled=${r.enabled}|${r.def}`]));
  // pg_attribute.attacl, not information_schema.column_privileges: the latter only lists columns the CURRENT role
  // holds or granted, so a grant made by another role to matflow_app would be invisible to the fingerprinting role.
  out.columnPrivileges = Object.fromEntries((await q(`select n.nspname || '.' || c.relname || '.' || a.attname k, ${ACL("a.attacl")} acl
                                                        from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
                                                       where ${USER_SCHEMA("n.nspname")} and a.attnum > 0 and not a.attisdropped and a.attacl is not null order by 1`))
    .map((r) => [r.k, r.acl]));
  out.defaultPrivileges = Object.fromEntries((await q(`select pg_get_userbyid(d.defaclrole) || '|' || coalesce(n.nspname, '<all schemas>') || '|' || d.defaclobjtype::text k,
                                                             ${ACL("d.defaclacl")} acl
                                                        from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace order by 1`))
    .map((r) => [r.k, r.acl]));
  return out;
}

/**
 * Fingerprint the database the client is connected to. The caller owns the transaction (READ ONLY, or the export's
 * REPEATABLE READ READ ONLY). Sets transaction-local formatting so content hashes are comparable across servers.
 */
export async function takeFingerprint(client, { contentHash = false } = {}) {
  const q = async (sql, p = []) => (await client.query(sql, p)).rows;
  await client.query("SET LOCAL TimeZone = 'UTC'");
  await client.query("SET LOCAL DateStyle = 'ISO, MDY'");
  await client.query("SET LOCAL IntervalStyle = 'postgres'");
  await client.query("SET LOCAL extra_float_digits = 1");
  await client.query("SET LOCAL bytea_output = 'hex'");
  // Object names (regprocedure text) must not depend on the connecting role's search_path, which is itself part of
  // what is fingerprinted (F3, SF-96): public objects print unqualified, every other schema qualified.
  await client.query("SET LOCAL search_path = public");
  // Counts must not depend on the connecting role: the policies honour this transaction-local flag.
  await client.query("SELECT set_config('app.bypass_rls','on',true)");
  const fp = { takenAt: (await q("select now() as t"))[0].t };
  fp.role = (await q("select current_user as u"))[0].u;
  fp.pgMajor = Number((await q("show server_version_num"))[0].server_version_num.slice(0, 2));
  const mig = await q(`select migration_name, checksum, finished_at is not null as finished, rolled_back_at is not null as rolled_back
                         from _prisma_migrations order by migration_name, started_at`);
  fp.migrations = mig.map((m) => `${m.migration_name}${m.finished ? "" : " [UNFINISHED]"}${m.rolled_back ? " [ROLLED-BACK]" : ""}`);
  fp.migrationChecksums = Object.fromEntries(mig.filter((m) => m.finished && !m.rolled_back).map((m) => [m.migration_name, m.checksum]));
  const tables = await q(`select c.relname t, c.relrowsecurity rls, c.relforcerowsecurity force,
                                 pg_get_userbyid(c.relowner) owner, coalesce(c.relacl::text,'') acl
                            from pg_class c join pg_namespace n on n.oid=c.relnamespace
                           where n.nspname='public' and c.relkind in ('r','p') order by c.relname`);
  const pol = await q(`select tablename t, policyname, permissive, roles::text roles, cmd, coalesce(qual,'') qual,
                              coalesce(with_check,'') wc
                         from pg_policies where schemaname='public' order by tablename, policyname`);
  const trg = await q(`select c.relname t, tg.tgname, tg.tgenabled::text enabled, pg_get_triggerdef(tg.oid) def
                         from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace n on n.oid=c.relnamespace
                        where n.nspname='public' and not tg.tgisinternal order by c.relname, tg.tgname`);
  const group = (rows, key, fmt) => rows.reduce((m, r) => ((m[r[key]] ??= []).push(fmt(r)), m), {});
  const polBy = group(pol, "t", (r) => `${r.policyname}|${r.cmd}|${r.permissive}|${r.roles}|USING(${r.qual})|CHECK(${r.wc})`);
  const trgBy = group(trg, "t", (r) => `${r.tgname}|enabled=${r.enabled}|${r.def}`);
  fp.tables = {};
  for (const t of tables) {
    const n = (await q(`select count(*)::bigint n from public.${ident(t.t)}`))[0].n;
    fp.tables[t.t] = {
      rows: Number(n), rls: t.rls, force: t.force, owner: t.owner, acl: t.acl,
      policies: (polBy[t.t] ?? []).join("\n"), triggers: (trgBy[t.t] ?? []).join("\n"),
    };
  }
  if (contentHash) {
    await client.query("SET LOCAL statement_timeout = '60s'");
    for (const t of tables) {
      const h = (await q(`select md5(coalesce(string_agg(x.r, E'\\n' order by x.r collate "C"), '')) h
                            from (select (t.*)::text r from public.${ident(t.t)} t) x`))[0].h;
      fp.tables[t.t].contentMd5 = h;
    }
    await client.query("SET LOCAL statement_timeout = '15s'");
  }
  // F3 (SF-96): every non-system schema, not only public — a function planted in another schema plus a role
  // search_path naming that schema shadows a built-in for every session of that role.
  const fns = await q(`select p.oid::regprocedure::text sig, pg_get_userbyid(p.proowner) owner, p.prosecdef secdef,
                              coalesce(array_to_string(p.proconfig, ';'),'') config, l.lanname lang,
                              coalesce(p.proacl::text,'') acl, md5(coalesce(p.prosrc,'')) src
                         from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
                        where ${USER_SCHEMA("n.nspname")} order by 1`);
  fp.functions = Object.fromEntries(fns.map((f) => [f.sig, { owner: f.owner, secdef: f.secdef, config: f.config, lang: f.lang, acl: f.acl, srcMd5: f.src }]));
  const ns = (await q(`select pg_get_userbyid(nspowner) owner, coalesce(nspacl::text,'') acl from pg_namespace where nspname='public'`))[0];
  fp.schemaPublic = { owner: ns.owner, acl: ns.acl };
  fp.extensions = (await q(`select extname||'@'||extversion e from pg_extension order by 1`)).map((r) => r.e);
  fp.eventTriggers = (await q(`select evtname||'|'||evtevent||'|'||evtenabled::text e from pg_event_trigger order by 1`)).map((r) => r.e);
  Object.assign(fp, await catalogueSections(q));
  // Roles that matter for this schema: owners, grantees of tables/functions/schema, and the connecting role.
  const roleNames = await q(`
    with g as (
      select c.relowner r from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
      union select (aclexplode(c.relacl)).grantee from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relacl is not null
      union select p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      union select (aclexplode(p.proacl)).grantee from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proacl is not null
      union select (aclexplode(nspacl)).grantee from pg_namespace where nspname='public' and nspacl is not null
      union select oid from pg_roles where rolname = current_user)
    select distinct r.rolname from g join pg_roles r on r.oid = g.r order by 1`);
  fp.roles = {};
  for (const { rolname } of roleNames) {
    const r = (await q(`select rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication,
                               coalesce((select string_agg(distinct b.rolname, ',' order by b.rolname) from pg_auth_members m join pg_roles b on b.oid=m.roleid
                                          where m.member = r.oid), '') memberof
                          from pg_roles r where r.rolname = $1`, [rolname]))[0];
    fp.roles[rolname] = r;
  }
  const fks = await q(`select con.conname, cl.relname child, pl.relname parent, con.convalidated validated,
                              (select array_agg(a.attname order by k.i) from unnest(con.conkey) with ordinality k(n,i) join pg_attribute a on a.attrelid=con.conrelid and a.attnum=k.n) ccols,
                              (select array_agg(a.attname order by k.i) from unnest(con.confkey) with ordinality k(n,i) join pg_attribute a on a.attrelid=con.confrelid and a.attnum=k.n) pcols
                         from pg_constraint con join pg_class cl on cl.oid=con.conrelid join pg_class pl on pl.oid=con.confrelid
                         join pg_namespace n on n.oid=cl.relnamespace where con.contype='f' and n.nspname='public' order by con.conname`);
  fp.foreignKeys = {};
  for (const f of fks) {
    const cc = pgArr(f.ccols), pc = pgArr(f.pcols);
    const notNull = cc.map((c) => `ch.${ident(c)} is not null`).join(" and ");
    const join = cc.map((c, i) => `p.${ident(pc[i])} = ch.${ident(c)}`).join(" and ");
    const orphans = (await q(`select count(*)::bigint n from public.${ident(f.child)} ch where ${notNull}
                                 and not exists (select 1 from public.${ident(f.parent)} p where ${join})`))[0].n;
    fp.foreignKeys[f.conname] = { child: f.child, parent: f.parent, validated: f.validated, orphans: Number(orphans) };
  }
  // Security state that rewinds with the data (counts and sums only).
  const one = async (sql) => Number(Object.values((await q(sql))[0])[0]);
  const latest = (await q(`select max("createdAt") m from "AuditLog"`))[0].m;
  fp.securityState = {
    magicLinkOutstanding: await one(`select count(*) from "MagicLinkToken" where not used and "expiresAt" > now()`),
    passwordResetOutstanding: await one(`select count(*) from "PasswordResetToken" where not used and "expiresAt" > now()`),
    userSessionVersionSum: await one(`select coalesce(sum("sessionVersion"),0) from "User"`),
    memberSessionVersionSum: await one(`select coalesce(sum("sessionVersion"),0) from "Member"`),
    operatorSessionVersionSum: await one(`select coalesce(sum("sessionVersion"),0) from "Operator"`),
    operators: await one(`select count(*) from "Operator"`),
    latestAuditAt: latest instanceof Date ? latest.toISOString() : latest,
  };
  return fp;
}

/** Pure comparison (unit-tested in tests/unit/sec-f2-restore-verify-compare.test.ts). */
export function compareFingerprints(A, B, { allowDrift = [], expectRevoked = false } = {}) {
  const allow = new Set(allowDrift);
  const revokeTables = new Set(expectRevoked ? REVOCATION_TABLES : []);
  const fails = [];
  const notes = [];
  if (A.pgMajor !== B.pgMajor) fails.push(`postgres major ${A.pgMajor} -> ${B.pgMajor}`);
  const ma = A.migrations.join("\n"), mb = B.migrations.join("\n");
  if (ma !== mb) fails.push(`migrations differ (baseline ${A.migrations.length}, restored ${B.migrations.length}; restored head ${B.migrations.at(-1)})`);
  if (B.migrations.some((m) => /UNFINISHED|ROLLED-BACK/.test(m))) fails.push("restored copy has an unfinished or rolled-back migration");
  for (const [k, v] of Object.entries(A.migrationChecksums ?? {})) {
    if (B.migrationChecksums && B.migrationChecksums[k] !== v) fails.push(`migration checksum differs: ${k}`);
  }
  const ta = Object.keys(A.tables), tb = Object.keys(B.tables);
  for (const t of ta) if (!B.tables[t]) fails.push(`table missing in restored copy: ${t}`);
  for (const t of tb) if (!A.tables[t]) fails.push(`unexpected table in restored copy: ${t}`);
  for (const t of ta) {
    const x = A.tables[t], y = B.tables[t];
    if (!y) continue;
    if (x.rls !== y.rls || x.force !== y.force) fails.push(`RLS flags changed on ${t}: ${x.rls}/${x.force} -> ${y.rls}/${y.force}`);
    if (x.policies !== y.policies) fails.push(`policies changed on ${t} (name, command, roles or expression)`);
    if (x.triggers !== y.triggers) fails.push(`triggers changed on ${t} (definition or enabled state)`);
    if (x.owner !== y.owner) fails.push(`owner changed on ${t}: ${x.owner} -> ${y.owner}`);
    if (x.acl !== y.acl) fails.push(`grants changed on ${t}: ${x.acl} -> ${y.acl}`);
    const drift = allow.has(t) || (revokeTables.has(t) && t === "AuditLog" && y.rows >= x.rows);
    if (x.rows !== y.rows) (drift ? notes : fails).push(`row count ${t}: ${x.rows} -> ${y.rows}${drift ? " (allowed drift)" : ""}`);
    if (x.contentMd5 !== undefined && y.contentMd5 !== undefined && x.contentMd5 !== y.contentMd5) {
      (allow.has(t) || revokeTables.has(t) ? notes : fails).push(`content of ${t} differs${allow.has(t) || revokeTables.has(t) ? " (allowed)" : ""}`);
    }
    if ((x.contentMd5 === undefined) !== (y.contentMd5 === undefined)) notes.push(`content hash present on one side only for ${t} (not compared)`);
  }
  const keys = (o) => Object.keys(o ?? {}).sort();
  const diffMap = (label, a, b) => {
    for (const k of new Set([...keys(a), ...keys(b)])) {
      if (!(k in (b ?? {}))) fails.push(`${label} missing in restored copy: ${k}`);
      else if (!(k in (a ?? {}))) fails.push(`unexpected ${label} in restored copy: ${k}`);
      else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) fails.push(`${label} changed: ${k}`);
    }
  };
  if (A.functions || B.functions) diffMap("function", A.functions, B.functions);
  if (A.roles || B.roles) {
    // The connecting role may legitimately differ between the two snapshots; every other role must match.
    const strip = (r, who) => Object.fromEntries(Object.entries(r ?? {}).filter(([k]) => k !== who || (A.roles?.[k] && B.roles?.[k])));
    diffMap("role", strip(A.roles, A.role), strip(B.roles, B.role));
  }
  if (JSON.stringify(A.schemaPublic) !== JSON.stringify(B.schemaPublic)) fails.push("schema public owner or grants changed");
  if (JSON.stringify(A.extensions) !== JSON.stringify(B.extensions)) fails.push(`extensions differ: [${A.extensions}] -> [${B.extensions}]`);
  if (JSON.stringify(A.eventTriggers) !== JSON.stringify(B.eventTriggers)) fails.push(`event triggers differ: [${A.eventTriggers}] -> [${B.eventTriggers}]`);
  for (const [k, label] of Object.entries(CATALOGUE_SECTIONS)) {
    const inA = A[k] !== undefined, inB = B[k] !== undefined;
    if (inA !== inB) fails.push(`${k} recorded on one side only (fingerprints from different verifier versions: re-take both)`);
    else if (inA) diffMap(label, A[k], B[k]);
  }
  for (const [k, f] of Object.entries(B.foreignKeys)) {
    if (f.orphans > 0) fails.push(`orphans in ${f.child} via ${k}: ${f.orphans}`);
    if (!f.validated) fails.push(`foreign key not validated: ${k}`);
    if (!A.foreignKeys[k]) fails.push(`unexpected foreign key ${k}`);
  }
  for (const k of Object.keys(A.foreignKeys)) if (!B.foreignKeys[k]) fails.push(`foreign key missing in restored copy: ${k}`);
  const s = B.securityState, sa = A.securityState;
  if (!expectRevoked) {
    for (const k of new Set([...Object.keys(sa), ...Object.keys(s)])) {
      if (String(sa[k]) !== String(s[k])) fails.push(`security state differs: ${k} ${sa[k]} -> ${s[k]}`);
    }
  } else {
    if (s.magicLinkOutstanding !== 0) fails.push(`revocation not applied: ${s.magicLinkOutstanding} sign-in links still outstanding`);
    if (s.passwordResetOutstanding !== 0) fails.push(`revocation not applied: ${s.passwordResetOutstanding} reset codes still outstanding`);
    for (const [sum, table] of [["userSessionVersionSum", "User"], ["memberSessionVersionSum", "Member"], ["operatorSessionVersionSum", "Operator"]]) {
      const need = sa[sum] + (A.tables[table]?.rows ?? 0);
      if (s[sum] < need) fails.push(`revocation not applied: ${sum} ${s[sum]} < baseline ${sa[sum]} + ${A.tables[table]?.rows ?? 0} rows`);
    }
    if (s.operators !== sa.operators) fails.push(`operator count changed: ${sa.operators} -> ${s.operators}`);
  }
  return { verdict: fails.length ? "FAIL" : "PASS", mode: expectRevoked ? "expect-revoked" : "identical", fails, notes };
}

async function snapshotCli(envFile, expectHost, varName, flags) {
  if (!envFile || !expectHost) die("snapshot needs <env-file> <expected-host-substring>");
  const env = readEnvFile(envFile);
  const url = env[varName];
  if (!url) die(`no ${varName} in ${envFile}`);
  let host;
  try {
    refuseConnectionEnv();
    host = resolveDbTarget(url, { expectHost, allowProduction: flags.includes("--production-read-only") });
  } catch (e) {
    die(e instanceof TargetRefused ? e.message : `REFUSED: ${String(e)}`);
  }
  const killer = setTimeout(() => die("ABORTED: 180 s ceiling reached", 3), 180_000);
  const client = new pg.Client({ connectionString: url, application_name: "matflow-restore-verify-readonly" });
  await client.connect();
  let fp;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    fp = await takeFingerprint(client, { contentHash: flags.includes("--content-hash") });
    await client.query("ROLLBACK");
  } finally {
    clearTimeout(killer);
    await client.end();
  }
  fp.hostPrefix = host.slice(0, 16);
  fp.pooler = host.includes("-pooler");
  console.log(JSON.stringify(fp, null, 1));
}

function compareCli(basePath, restoredPath, flags) {
  if (!basePath || !restoredPath) die("compare needs <baseline.json> <restored.json>");
  const A = JSON.parse(fs.readFileSync(basePath, "utf8"));
  const B = JSON.parse(fs.readFileSync(restoredPath, "utf8"));
  const allowDrift = (flags.find((f) => f.startsWith("--allow-drift=")) ?? "").replace("--allow-drift=", "").split(",").filter(Boolean);
  const res = compareFingerprints(A, B, { allowDrift, expectRevoked: flags.includes("--expect-revoked") });
  console.log(JSON.stringify(res, null, 1));
  const s = B.securityState, sa = A.securityState;
  console.log("\nPOST-RESTORE SECURITY ACTIONS (always required; the restored copy rewinds them):");
  console.log(`- Session versions (restored sums user ${s.userSessionVersionSum}/member ${s.memberSessionVersionSum}/operator ${s.operatorSessionVersionSum} vs baseline ${sa.userSessionVersionSum}/${sa.memberSessionVersionSum}/${sa.operatorSessionVersionSum}): every revocation after the restore point is undone. Revoke all sessions (runbook §3.4), then re-run compare with --expect-revoked.`);
  console.log(`- ${s.magicLinkOutstanding} sign-in links and ${s.passwordResetOutstanding} reset codes are outstanding in the restored copy, including any consumed after the restore point. Cancel them (runbook §3.4).`);
  console.log("- Re-apply DSAR erasures and account removals made after the restore point (docs/runbooks/db-restore.md).");
  process.exit(res.verdict === "PASS" ? 0 : 1);
}

function ident(s) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) throw new Error(`unexpected identifier ${JSON.stringify(s)}`);
  return `"${s}"`;
}
function pgArr(v) {
  return Array.isArray(v) ? v : String(v).replace(/^{|}$/g, "").split(",").map((x) => x.replace(/^"|"$/g, ""));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, a, b, c4] = process.argv.slice(2);
  const flags = process.argv.slice(2).filter((x) => x.startsWith("--"));
  if (mode === "snapshot") await snapshotCli(a, b, c4 && !c4.startsWith("--") ? c4 : "DATABASE_URL", flags);
  else if (mode === "compare") compareCli(a, b, flags);
  else die("usage: restore-verify.mjs snapshot <env-file> <expected-host-substring> [VAR] [--content-hash] | compare <base.json> <restored.json> [--allow-drift=A,B] [--expect-revoked]");
}
