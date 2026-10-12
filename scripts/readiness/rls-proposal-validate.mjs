// Validate the SF-62 migration PROPOSAL (docs/security/evidence/B2/proposed-sf62-*.sql) without touching the shared
// public schema (security campaign iteration 2, lane B). TEST branch only (rls-test-target.mjs guard).
//
// Usage (repo root): node scripts/readiness/rls-proposal-validate.mjs [--json <out-file>]
//
// 1. Clones every public table of the TEST branch into a private schema secb2v_<stamp> (structure, RLS flags and the
//    exact deployed policy expressions, re-resolved inside the clone), grants matflow_app what it has today.
// 2. Applies the proposal files with only identifiers substituted (public -> clone, matflow_system -> <clone>_sys,
//    matflow_sec -> <clone>_sec): phase 1; phase 2 WITHOUT a key (must refuse); key provisioned; phase 2.
// 3. Checks the catalogue and then attacks the clone as the GENUINE runtime login (matflow_app, own credential).
// 4. Applies the rollback file and checks the deployed semantics are back; then tears everything down, count-checked.
// Prints host/role names and counts only — never a credential, key, pad or MAC.
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadTestTargets, describeTarget } from "./rls-test-target.mjs";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const STAMP = `secb2v_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
if (!/^secb2v_[a-z0-9]+$/.test(STAMP)) throw new Error("bad stamp");
const V = STAMP, SYS = `${STAMP}_sys`, SEC = `${STAMP}_sec`;
const KEY = crypto.randomBytes(64);
const PROPOSAL_DIR = path.join("docs", "security", "evidence", "B2");
const targets = loadTestTargets();
const out = { stamp: STAMP, node: process.version, startedAt: new Date().toISOString(), targets: { owner: describeTarget(targets.ownerDirect), app: describeTarget(targets.appPooled) }, checks: {}, ok: {} };
const check = (id, pass, observed) => { out.checks[id] = { pass, observed }; console.log(`${pass ? "PASS" : "FAIL"} ${id} ${JSON.stringify(observed).slice(0, 240)}`); };

async function connect(cfg) { const c = new pg.Client(cfg); c.on("error", () => {}); await c.connect(); return c; }
async function attempt(c, sql, params) {
  try { const r = await c.query(sql, params); return { ok: true, rows: r.rows, rowCount: r.rowCount }; }
  catch (e) { return { ok: false, code: e.code, error: String(e.message).slice(0, 200) }; }
}
// A proposal file is one multi-statement BEGIN … COMMIT; on error the server skips the rest and leaves the
// transaction aborted, so close it before the next step.
async function applyFile(sql) { const r = await attempt(own, sql); if (!r.ok) await own.query("ROLLBACK").catch(() => {}); return r; }
const transform = (sql) => sql
  .replace(/\bmatflow_system\b/g, SYS)
  .replace(/\bmatflow_sec\b/g, SEC)
  .replace(/\bpublic\b/g, V); // lower-case identifier only; the PUBLIC pseudo-role is written upper-case in the files
// --mutant=<name> plants a defect in the proposal text to show the checks catch it (never used for a pass verdict):
//   grant-sys-to-app  phase 1 also makes the runtime role a member of the system role
//   keep-bypass       phase 2 keeps the bypass GUC clause in every rewritten policy
const MUTANT = (args.find((a) => a.startsWith("--mutant=")) ?? "").slice(9) || null;
const mutate = (name, sql) => {
  if (MUTANT === "grant-sys-to-app" && name === "proposed-sf62-phase1.sql") return sql.replace("\nCOMMIT;", "\nGRANT matflow_system TO matflow_app;\nCOMMIT;");
  if (MUTANT === "keep-bypass" && name === "proposed-sf62-phase2.sql") return sql.replace("USING (%s) WITH CHECK (%s)', r.relname, q, q", "USING ((current_setting(''app.bypass_rls'', true) = ''on'') OR %s) WITH CHECK (%s)', r.relname, q, q");
  return sql;
};
const proposal = (name) => transform(mutate(name, fs.readFileSync(path.join(PROPOSAL_DIR, name), "utf8")));
out.mutant = MUTANT;
const rollbackBlocks = () => {
  const src = proposal("proposed-sf62-rollback.sql");
  const i = src.indexOf("-- ── rollback of phase 1 ──");
  return { phase2: src.slice(0, i), phase1: src.slice(i) };
};

const own = await connect(targets.ownerDirect);
await own.query(`SET search_path = ${V}, pg_catalog`); // session-level on a PRIVATE direct connection only
let exit = 1;
const T = { a: `${STAMP}-a`, b: `${STAMP}-b` };

async function cloneSchema() {
  await own.query("BEGIN");
  await own.query(`CREATE SCHEMA ${V}`);
  const tables = (await own.query(`select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`)).rows;
  for (const t of tables) {
    await own.query(`CREATE TABLE ${V}."${t.relname}" (LIKE public."${t.relname}" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`);
    if (t.rls) await own.query(`ALTER TABLE ${V}."${t.relname}" ENABLE ROW LEVEL SECURITY`);
    if (t.force) await own.query(`ALTER TABLE ${V}."${t.relname}" FORCE ROW LEVEL SECURITY`);
  }
  // Read the deployed expressions with search_path = public (unqualified), re-create them resolving inside the clone.
  await own.query(`SET LOCAL search_path = public, pg_catalog`);
  const pols = (await own.query(`select c.relname, p.polname, p.polcmd, p.polpermissive, p.polroles::text as roles,
      pg_get_expr(p.polqual, p.polrelid) as qual, pg_get_expr(p.polwithcheck, p.polrelid) as wcheck
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'`)).rows;
  await own.query(`SET LOCAL search_path = ${V}, pg_catalog`);
  const CMD = { "*": "ALL", r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE" };
  for (const p of pols) {
    if (p.roles !== "{0}") throw new Error(`policy ${p.polname} on ${p.relname} is not TO PUBLIC; extend the clone`);
    await own.query(`CREATE POLICY ${p.polname} ON ${V}."${p.relname}" AS ${p.polpermissive ? "PERMISSIVE" : "RESTRICTIVE"} FOR ${CMD[p.polcmd]}
      ${p.qual ? `USING (${p.qual})` : ""} ${p.wcheck ? `WITH CHECK (${p.wcheck})` : ""}`);
  }
  await own.query(`GRANT USAGE ON SCHEMA ${V} TO matflow_app`);
  await own.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${V} TO matflow_app`);
  await own.query("COMMIT");
  return { tables: tables.length, rlsTables: tables.filter((t) => t.rls).length, policies: pols.length };
}

// Insert one synthetic row, filling every NOT NULL column that has no default with a type-shaped placeholder.
async function seedRow(table, values) {
  const cols = (await own.query(`select column_name, data_type, udt_name from information_schema.columns
      where table_schema = $1 and table_name = $2 and is_nullable = 'NO' and column_default is null`, [V, table])).rows;
  const row = { ...values };
  for (const c of cols) {
    if (c.column_name in row) continue;
    const t = c.data_type;
    row[c.column_name] = t.includes("char") || t === "text" ? `${STAMP}-${c.column_name}`
      : t.includes("int") || t === "numeric" || t.includes("double") || t === "real" ? 0
      : t === "boolean" ? false : t.includes("timestamp") || t === "date" ? new Date()
      : t === "jsonb" || t === "json" ? "{}" : t === "ARRAY" ? "{}" : t === "USER-DEFINED" ? null : `${STAMP}`;
  }
  const keys = Object.keys(row);
  await own.query(`INSERT INTO ${V}."${table}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map((k) => row[k]));
}

async function asApp(fn) {
  const app = await connect(targets.appPooled);
  try { await app.query("BEGIN"); await app.query("SET LOCAL statement_timeout = '20s'"); const v = await fn(app); await app.query("ROLLBACK"); return v; }
  catch (e) { await app.query("ROLLBACK").catch(() => {}); throw e; }
  finally { await app.end(); }
}
async function enterSigned(app, tenant) {
  const r = (await app.query(`select pg_backend_pid()::text as pid, floor(extract(epoch from transaction_timestamp()) * 1000000)::bigint::text as ts`)).rows[0];
  const mac = crypto.createHmac("sha256", KEY).update(`${tenant}|${r.pid}|${r.ts}`, "utf8").digest("hex");
  await app.query(`select set_config('app.current_tenant_id', $1, true), set_config('app.ctx_mac', $2, true)`, [tenant, mac]);
}
// Refusal probe inside a runtime transaction: its own SAVEPOINT, so one refusal cannot make the next probe fail with
// 25P02 (which would read as a false "refused").
async function refusal(c, sql) {
  await c.query("SAVEPOINT b2v");
  const r = await attempt(c, sql);
  await c.query(r.ok ? "RELEASE SAVEPOINT b2v" : "ROLLBACK TO SAVEPOINT b2v");
  return r.ok ? "PERMITTED" : r.code;
}
const cnt = async (c, sql, p) => { const r = await attempt(c, sql, p); return r.ok ? Number(r.rows[0].n) : r.code; };

try {
  out.clone = await cloneSchema();
  console.log("CLONE", JSON.stringify(out.clone));
  await seedRow("Tenant", { id: T.a, slug: `${STAMP}-slug-a`, name: "A" });
  await seedRow("Tenant", { id: T.b, slug: `${STAMP}-slug-b`, name: "B" });
  await seedRow("Member", { id: `${T.a}-m`, tenantId: T.a, email: `${STAMP}-a@example.test`, name: "A m" });
  await seedRow("Member", { id: `${T.b}-m`, tenantId: T.b, email: `${STAMP}-b@example.test`, name: "B m" });
  await seedRow("ClassSubscription", { id: `${T.b}-cs`, memberId: `${T.b}-m` });

  // Baseline: the clone reproduces the deployed weakness.
  check("B0-clone-reproduces-bypass", (await asApp(async (a) => { await a.query(`select set_config('app.bypass_rls','on',true)`); return cnt(a, `select count(*)::int n from ${V}."Tenant"`); })) === 2, "runtime bypass GUC sees both clone tenants");

  const p1 = await applyFile(proposal("proposed-sf62-phase1.sql"));
  check("P1-applies", p1.ok, p1.ok ? "ok" : p1.error);
  // Phase 1 must not change anything the deployed build (e8afb6a) relies on: the bypass GUC and the plain tenant GUC.
  const compat = await asApp(async (a) => {
    await a.query(`select set_config('app.bypass_rls','on',true)`);
    const bypassTenants = await cnt(a, `select count(*)::int n from ${V}."Tenant"`);
    await a.query(`select set_config('app.bypass_rls','',true), set_config('app.current_tenant_id',$1,true)`, [T.b]);
    return { bypassTenants, plainTenantB: await cnt(a, `select count(*)::int n from ${V}."Member"`) };
  });
  check("P1-compatible-with-deployed-app", compat.bypassTenants === 2 && compat.plainTenantB === 1, compat);
  const p2early = await applyFile(proposal("proposed-sf62-phase2.sql"));
  check("P2-refuses-without-key", !p2early.ok && /provision/.test(p2early.error ?? ""), p2early.ok ? "APPLIED WITHOUT KEY" : p2early.error);
  const ipad = Buffer.from(KEY.map((b) => b ^ 0x36)), opad = Buffer.from(KEY.map((b) => b ^ 0x5c));
  await own.query(`INSERT INTO ${SEC}.context_key (kid, k_ipad, k_opad) VALUES (1, $1, $2)`, [ipad, opad]);
  const p2 = await applyFile(proposal("proposed-sf62-phase2.sql"));
  check("P2-applies", p2.ok, p2.ok ? "ok" : p2.error);

  // Catalogue.
  const pol = (await own.query(`select c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) q, pg_get_expr(p.polwithcheck, p.polrelid) w, p.polroles::text roles
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1`, [V])).rows;
  const ti = pol.filter((p) => p.polname === "tenant_isolation");
  check("K1-no-policy-trusts-a-plain-setting", pol.every((p) => !/app\.(bypass_rls|current_tenant_id)/.test(`${p.q} ${p.w ?? ""}`)), { policies: pol.length });
  check("K2-every-tenant-policy-uses-signed-context", ti.length === out.clone.policies && ti.every((p) => p.q.includes(`${SEC}.ctx_tenant()`) && p.w === p.q), { rewritten: ti.length, deployed: out.clone.policies });
  const rlsTables = Number((await own.query(`select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind = 'r' and c.relrowsecurity`, [V])).rows[0].n);
  const sysPol = pol.filter((p) => p.polname === "system_access");
  check("K3-system-policy-on-every-rls-table-role-keyed", sysPol.length === rlsTables && sysPol.every((p) => p.q === "true"), { rlsTables, systemPolicies: sysPol.length });
  const fns = (await own.query(`select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) owner, p.proconfig::text cfg,
      exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_exec,
      has_function_privilege('matflow_app', p.oid, 'EXECUTE') app_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1`, [SEC])).rows;
  check("K4-definer-functions-hardened", fns.length === 7 && fns.every((f) => f.prosecdef && f.owner === SYS && /search_path=pg_catalog, pg_temp/.test(f.cfg ?? "") && !f.public_exec && f.app_exec), fns.map((f) => `${f.proname}:${f.owner === SYS ? "sys" : f.owner}:${f.public_exec ? "PUBLIC" : "named"}`));
  const roleRow = (await own.query(`select r.rolbypassrls, r.rolcanlogin, pg_has_role('matflow_app', r.oid, 'MEMBER') app_member from pg_roles r where r.rolname = $1`, [SYS])).rows[0];
  check("K5-system-role-nologin-nobypass-not-granted-to-runtime", roleRow && !roleRow.rolbypassrls && !roleRow.rolcanlogin && !roleRow.app_member, roleRow);
  const mig = (await own.query(`select has_table_privilege('matflow_app', $1, 'INSERT') i, has_table_privilege('matflow_app', $1, 'UPDATE') u, has_table_privilege('matflow_app', $1, 'DELETE') d`, [`${V}._prisma_migrations`])).rows[0];
  check("K6-runtime-has-no-migration-ledger-privileges", !mig.i && !mig.u && !mig.d, mig);

  // Behaviour as the genuine runtime login.
  check("A1-bypass-guc-sees-nothing", await asApp(async (a) => { await a.query(`select set_config('app.bypass_rls','on',true)`); return { t: await cnt(a, `select count(*)::int n from ${V}."Tenant"`), m: await cnt(a, `select count(*)::int n from ${V}."Member"`) }; }).then((r) => r.t === 0 && r.m === 0), "bypass GUC");
  check("A2-forged-tenant-sees-nothing", (await asApp(async (a) => { await a.query(`select set_config('app.current_tenant_id',$1,true)`, [T.b]); return cnt(a, `select count(*)::int n from ${V}."Member"`); })) === 0, "forged tenant GUC");
  const a3 = await asApp(async (a) => { await enterSigned(a, T.a); return {
    ownMember: await cnt(a, `select count(*)::int n from ${V}."Member" where "tenantId" = $1`, [T.a]),
    otherMember: await cnt(a, `select count(*)::int n from ${V}."Member" where "tenantId" = $1`, [T.b]),
    otherChildRow: await cnt(a, `select count(*)::int n from ${V}."ClassSubscription"`),
    plantMemberInB: await refusal(a, `update ${V}."Member" set "tenantId" = '${T.b}' where "tenantId" = '${T.a}'`),
  }; });
  check("A3-signed-context-own-club-only-incl-child-table", a3.ownMember === 1 && a3.otherMember === 0 && a3.otherChildRow === 0 && a3.plantMemberInB === "42501", a3);
  check("A4-signed-context-B-sees-B-child-row (positive control)", (await asApp(async (a) => { await enterSigned(a, T.b); return cnt(a, `select count(*)::int n from ${V}."ClassSubscription"`); })) === 1, "child policy rewritten correctly");
  const a5 = await asApp(async (a) => ({
    bySlug: (await a.query(`select ${SEC}.tenant_id_by_slug($1) id`, [`${STAMP}-slug-b`])).rows[0].id === T.b,
    emptySlug: (await a.query(`select ${SEC}.tenant_id_by_slug('') id`)).rows[0].id,
    nullKiosk: (await a.query(`select ${SEC}.tenant_id_by_kiosk_token_hash(NULL) id`)).rows[0].id,
    readKey: await refusal(a, `select count(*) from ${SEC}.context_key`),
    setRoleSys: await refusal(a, `set local role ${SYS}`),
  }));
  check("A5-resolvers-narrow-key-unreadable-no-role-assumption", a5.bySlug && a5.emptySlug === null && a5.nullKiosk === null && a5.readKey === "42501" && a5.setRoleSys === "42501", a5);
  await own.query("BEGIN"); await own.query(`SET LOCAL ROLE ${SYS}`);
  const sysSees = Number((await own.query(`select count(*)::int n from ${V}."Tenant"`)).rows[0].n);
  await own.query("ROLLBACK");
  check("A6-system-role-crosses-clubs (control, owner session SET ROLE)", sysSees === 2, { tenants: sysSees });

  // Rollback round trip.
  const rb = rollbackBlocks();
  const r2 = await applyFile(rb.phase2);
  check("R1-rollback-phase2-applies", r2.ok, r2.ok ? "ok" : r2.error);
  const restored = await asApp(async (a) => {
    await a.query(`select set_config('app.bypass_rls','on',true)`);
    const t = await cnt(a, `select count(*)::int n from ${V}."Tenant"`);
    await a.query(`select set_config('app.bypass_rls','',true), set_config('app.current_tenant_id',$1,true)`, [T.b]);
    return { bypassTenants: t, plainTenantB: await cnt(a, `select count(*)::int n from ${V}."Member"`) };
  });
  check("R2-deployed-semantics-restored", restored.bypassTenants === 2 && restored.plainTenantB === 1, restored);
  const r1 = await applyFile(rb.phase1);
  check("R3-rollback-phase1-applies", r1.ok, r1.ok ? "ok" : r1.error);
  const gone = (await own.query(`select (select count(*)::int from pg_namespace where nspname = $1) sec, (select count(*)::int from pg_roles where rolname = $2) sys,
      (select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = $3 and p.polname = 'system_access') pols`, [SEC, SYS, V])).rows[0];
  check("R4-phase1-objects-gone", gone.sec === 0 && gone.sys === 0 && gone.pols === 0, gone);
  exit = Object.values(out.checks).every((c) => c.pass) ? 0 : 1;
} catch (e) {
  out.error = String(e?.message ?? e).slice(0, 300);
  console.log("ERROR", out.error);
  await own.query("ROLLBACK").catch(() => {});
} finally {
  try {
    await own.query(`DROP SCHEMA IF EXISTS ${V} CASCADE`);
    await own.query(`DROP SCHEMA IF EXISTS ${SEC} CASCADE`);
    const ex = await own.query(`select 1 from pg_roles where rolname = $1`, [SYS]);
    if (ex.rowCount) { await own.query(`GRANT ${SYS} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`).catch(() => {}); await own.query(`DROP OWNED BY ${SYS}`); await own.query(`DROP ROLE ${SYS}`); }
    out.teardown = (await own.query(`select (select count(*)::int from pg_namespace where nspname in ($1, $2)) schemas, (select count(*)::int from pg_roles where rolname = $3) roles`, [V, SEC, SYS])).rows[0];
  } catch (e) { out.teardown = { error: String(e.message).slice(0, 200) }; exit = 1; }
  console.log("TEARDOWN", JSON.stringify(out.teardown));
  if (out.teardown.schemas !== 0 || out.teardown.roles !== 0) exit = 1;
  await own.end();
  out.exit = exit; out.finishedAt = new Date().toISOString();
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2));
  process.exit(exit);
}
