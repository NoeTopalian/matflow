// SF-62 tenant-isolation boundary harness (security campaign iteration 2, lane B). TEST branch only.
//
// Usage (repo root):  node scripts/readiness/rls-boundary-harness.mjs [--json <out-file>] [--sweep]
//
// What it does, with GENUINE logins (the runtime role matflow_app connects with its own credential — never SET ROLE
// from the owner, so no owner privilege is reachable from the session under test):
//   1. public-schema probe (READ ONLY, rolled back, counts only): how the deployed policy design behaves under the
//      runtime role — default deny, the app.bypass_rls GUC, a forged app.current_tenant_id, row_security=off.
//   2. a private scratch schema secb2_<stamp> (tables tenant/item/audit/src_map/ctx_key, owner = the TEST owner),
//      on which four policy designs are installed in turn and attacked by the same cells:
//        CURRENT  — the deployed design: tenant GUC OR bypass GUC, runtime role holds every DML grant;
//        P1       — role-keyed system access (policy TO a NOLOGIN system role), no bypass GUC, audit append-only;
//        P2       — P1 + a signed, transaction-bound tenant context verified by a SECURITY DEFINER function;
//        MUTANT   — P2 with the bypass GUC clause put back (proves the cells detect a re-introduced bypass).
//   3. teardown: DROP SCHEMA … CASCADE, DROP OWNED / DROP ROLE for the two harness roles; count-checked.
// Nothing outside secb2_<stamp> is written. Prints host + login role only, never a credential, key or MAC.
// Exit 0 only if: CURRENT reproduces the breach (red), P2 holds on every boundary cell (green), MUTANT is caught.
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import { loadTestTargets, describeTarget } from "./rls-test-target.mjs";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const SWEEP = args.includes("--sweep");

const STAMP = `secb2_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
if (!/^secb2_[a-z0-9]+$/.test(STAMP)) throw new Error("bad stamp");
const S = STAMP;               // scratch schema
const SYS = `${STAMP}_sys`;    // NOLOGIN system role: owns the definer functions, the only role with a cross-tenant policy
const OPS = `${STAMP}_ops`;    // LOGIN operator credential (member of SYS) — stands in for a separate cron/operator identity
const OPS_PW = crypto.randomBytes(24).toString("hex"); // never printed; [0-9a-f] only
const KEY = crypto.randomBytes(64);                    // context-signing key; never printed
const APP = "matflow_app";

const targets = loadTestTargets();
const OWNER = targets.ownerDirect.user;
const log = (...a) => console.log(...a);
const results = { stamp: STAMP, node: process.version, startedAt: new Date().toISOString(), targets: {}, publicProbe: {}, variants: {}, teardown: {} };
for (const [k, v] of Object.entries(targets)) results.targets[k] = describeTarget(v);

async function connect(cfg) { const c = new pg.Client(cfg); c.on("error", () => {}); await c.connect(); return c; }
// Inside a transaction every attempt runs under its own SAVEPOINT, so a refused statement does not abort the
// transaction and make the NEXT statement fail for an unrelated reason (25P02 would read as a false "refused").
async function attempt(c, sql, params) {
  if (c.__inTx) await c.query("SAVEPOINT b2_attempt");
  try {
    const r = await c.query(sql, params);
    if (c.__inTx) await c.query("RELEASE SAVEPOINT b2_attempt");
    return { ok: true, rows: r.rows, rowCount: r.rowCount };
  } catch (e) {
    if (c.__inTx) await c.query("ROLLBACK TO SAVEPOINT b2_attempt");
    return { ok: false, code: e.code, error: String(e.message).slice(0, 160) };
  }
}
async function begin(c) { await c.query("BEGIN"); c.__inTx = true; await c.query("SET LOCAL statement_timeout = '20s'"); }
async function finish(c, cmd) { c.__inTx = false; await c.query(cmd); }
async function tx(c, fn, { commit = false } = {}) {
  await begin(c);
  try { const v = await fn(); await finish(c, commit ? "COMMIT" : "ROLLBACK"); return v; }
  catch (e) { c.__inTx = false; await c.query("ROLLBACK").catch(() => {}); throw e; }
}
const n = (r) => (r.ok ? Number(r.rows[0]?.n ?? r.rowCount ?? 0) : null);

// ───────────────────────────── 1. public-schema probe (deployed design) ─────────────────────────────
async function publicProbe() {
  const app = await connect(targets.appPooled);
  try {
    const out = {};
    out.identity = (await app.query("select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as bypassrls, (select rolsuper from pg_roles where rolname = current_user) as super")).rows[0];
    await tx(app, async () => {
      await app.query("SET TRANSACTION READ ONLY");
      out.noContext_tenants = n(await attempt(app, `select count(*)::int as n from "Tenant"`));
      await app.query(`select set_config('app.bypass_rls', 'on', true)`);
      out.bypassGuc_tenants = n(await attempt(app, `select count(*)::int as n from "Tenant"`));
      out.bypassGuc_auditTenants = n(await attempt(app, `select count(distinct "tenantId")::int as n from "AuditLog"`));
      // pick any one tenant id that has members (not printed) to show a forged tenant context reads it
      const pick = await attempt(app, `select "tenantId" as t from "Member" group by 1 order by count(*) desc limit 1`);
      await app.query(`select set_config('app.bypass_rls', '', true)`);
      out.afterClearingBypass_tenants = n(await attempt(app, `select count(*)::int as n from "Tenant"`));
      if (pick.ok && pick.rows[0]) {
        await app.query(`select set_config('app.current_tenant_id', $1, true)`, [pick.rows[0].t]);
        out.forgedTenantGuc_membersVisible = n(await attempt(app, `select count(*)::int as n from "Member"`));
        out.forgedTenantGuc_otherTenantsVisible = n(await attempt(app, `select count(*)::int as n from "Member" where "tenantId" <> $1`, [pick.rows[0].t]));
      }
    });
    await tx(app, async () => {
      await app.query("SET LOCAL row_security = off");
      const r = await attempt(app, `select count(*)::int as n from "Member"`);
      out.rowSecurityOff = r.ok ? { ok: true, n: n(r) } : { ok: false, code: r.code, error: r.error };
    });
    out.runtimePrivileges = (await app.query(`select
        has_table_privilege(current_user, 'public._prisma_migrations', 'INSERT') as migrations_insert,
        has_table_privilege(current_user, 'public._prisma_migrations', 'UPDATE') as migrations_update,
        has_table_privilege(current_user, 'public._prisma_migrations', 'DELETE') as migrations_delete,
        has_table_privilege(current_user, 'public."AuditLog"', 'UPDATE') as audit_update,
        has_table_privilege(current_user, 'public."AuditLog"', 'DELETE') as audit_delete,
        has_table_privilege(current_user, 'public."AuditLog"', 'TRUNCATE') as audit_truncate,
        has_table_privilege(current_user, 'public."Operator"', 'INSERT') as operator_insert,
        has_schema_privilege(current_user, 'public', 'CREATE') as public_create,
        has_database_privilege(current_user, current_database(), 'TEMP') as temp,
        (select count(*) from pg_settings where name like 'app.%')::int as app_gucs_defined`)).rows[0];
    // Writer boundary on the tables RLS does not cover: the runtime credential may rewrite an operator's credentials and
    // the migration ledger. Proved with UPDATEs that match no row (ids carry the lane prefix and do not exist) inside a
    // rolled-back transaction: success with rowCount 0 = privilege present, no row touched; 42501 = privilege absent.
    out.writerBoundary = await tx(app, async () => {
      const op = await attempt(app, `update "Operator" set "passwordHash" = "passwordHash" where id = 'secB2-no-such-operator'`);
      const mig = await attempt(app, `update _prisma_migrations set finished_at = finished_at where id = 'secB2-no-such-migration'`);
      const cfg = await attempt(app, `update "PlatformConfig" set key = key where key = 'secB2-no-such-config'`);
      const fmt = (r) => (r.ok ? `PERMITTED (rows=${r.rowCount})` : r.code);
      return { operatorCredentialUpdate: fmt(op), migrationLedgerUpdate: fmt(mig), platformConfigUpdate: fmt(cfg) };
    });
    const sr = await tx(app, () => attempt(app, `SET LOCAL ROLE ${OWNER}`));
    out.setRoleOwner = sr.ok ? "ALLOWED" : sr.code;
    return out;
  } finally { await app.end(); }
}

// ───────────────────────────── 2. scratch schema and the four designs ─────────────────────────────
const T = { a: `${STAMP}-a`, b: `${STAMP}-b` };
const SLUG = { a: `${STAMP}-slug-a`, b: `${STAMP}-slug-b` };

async function setupSchema(own) {
  const ipad = Buffer.alloc(64), opad = Buffer.alloc(64);
  for (let i = 0; i < 64; i++) { ipad[i] = KEY[i] ^ 0x36; opad[i] = KEY[i] ^ 0x5c; }
  await tx(own, async () => {
    await own.query(`CREATE SCHEMA ${S}`);
    await own.query(`CREATE ROLE ${SYS} NOLOGIN NOINHERIT NOBYPASSRLS`);
    await own.query(`GRANT ${SYS} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`);
    await own.query(`CREATE ROLE ${OPS} LOGIN NOBYPASSRLS PASSWORD '${OPS_PW}'`);
    await own.query(`GRANT ${SYS} TO ${OPS} WITH INHERIT TRUE`);
    await own.query(`CREATE TABLE ${S}.tenant (id text primary key, slug text unique not null, name text not null)`);
    await own.query(`CREATE TABLE ${S}.item (id text primary key, tenant_id text not null references ${S}.tenant(id), body text not null)`);
    await own.query(`CREATE TABLE ${S}.audit (id bigserial primary key, tenant_id text not null, action text not null, created_at timestamptz not null default now())`);
    await own.query(`CREATE TABLE ${S}.src_map (id text primary key, tenant_id text not null, source_key text not null, member_id text not null)`);
    await own.query(`CREATE TABLE ${S}.ctx_key (kid int primary key, k_ipad bytea not null, k_opad bytea not null)`);
    for (const t of ["tenant", "item", "audit", "src_map", "ctx_key"]) {
      await own.query(`ALTER TABLE ${S}.${t} ENABLE ROW LEVEL SECURITY`);
      await own.query(`ALTER TABLE ${S}.${t} FORCE ROW LEVEL SECURITY`);
    }
    await own.query(`CREATE POLICY key_reader ON ${S}.ctx_key FOR SELECT TO ${SYS} USING (true)`);
    await own.query(`GRANT USAGE ON SCHEMA ${S} TO ${APP}, ${SYS}`);
    await own.query(`REVOKE ALL ON ${S}.ctx_key FROM PUBLIC`);
    await own.query(`GRANT SELECT ON ${S}.ctx_key TO ${SYS}`);
    // fixtures (the owner has BYPASSRLS on TEST, so these inserts are not policy-checked)
    await own.query(`INSERT INTO ${S}.tenant VALUES ($1,$2,'A club'),($3,$4,'B club')`, [T.a, SLUG.a, T.b, SLUG.b]);
    await own.query(`INSERT INTO ${S}.item VALUES ($1,$2,'a1'),($3,$4,'b1')`, [`${T.a}-i1`, T.a, `${T.b}-i1`, T.b]);
    await own.query(`INSERT INTO ${S}.audit (tenant_id, action, created_at) VALUES ($1,'member.update', now() - interval '10 days'),($2,'member.update', now() - interval '10 days')`, [T.a, T.b]);
    await own.query(`INSERT INTO ${S}.src_map VALUES ($1,$2,'teamup:111',$3),($4,$5,'teamup:222',$6)`, [`${T.a}-m`, T.a, `${T.a}-member`, `${T.b}-m`, T.b, `${T.b}-member`]);
    await own.query(`INSERT INTO ${S}.ctx_key VALUES (1, $1, $2)`, [ipad, opad]);
  }, { commit: true });
}

const TABLES = ["tenant", "item", "audit", "src_map"];
const tcol = (t) => (t === "tenant" ? "id" : "tenant_id");

async function installVariant(own, variant) {
  await tx(own, async () => {
    for (const t of TABLES) {
      await own.query(`DROP POLICY IF EXISTS tenant_isolation ON ${S}.${t}`);
      await own.query(`DROP POLICY IF EXISTS system_access ON ${S}.${t}`);
      await own.query(`REVOKE ALL ON ${S}.${t} FROM ${APP}, ${SYS}`);
    }
    await own.query(`DROP TRIGGER IF EXISTS audit_created_now ON ${S}.audit`);
    await own.query(`DROP FUNCTION IF EXISTS ${S}.audit_created_now() CASCADE`);
    await own.query(`DROP FUNCTION IF EXISTS ${S}.resolve_tenant_by_slug(text)`);
    await own.query(`DROP FUNCTION IF EXISTS ${S}.purge_audit(timestamptz)`);
    await own.query(`DROP FUNCTION IF EXISTS ${S}.ctx_tenant()`);
    await own.query(`REVOKE ALL ON SEQUENCE ${S}.audit_id_seq FROM ${APP}, ${SYS}`);

    if (variant === "CURRENT") {
      for (const t of TABLES) {
        await own.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${S}.${t} TO ${APP}`);
        await own.query(`CREATE POLICY tenant_isolation ON ${S}.${t} AS PERMISSIVE FOR ALL USING (
          current_setting('app.bypass_rls', true) = 'on' OR ${tcol(t)} = current_setting('app.current_tenant_id', true))`);
      }
      await own.query(`GRANT USAGE, SELECT ON SEQUENCE ${S}.audit_id_seq TO ${APP}`);
      return;
    }
    // P1 / P2 / MUTANT share grants, the system policy, the audit rules and the definer functions.
    for (const t of ["tenant", "item", "src_map"]) await own.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${S}.${t} TO ${APP}`);
    await own.query(`GRANT SELECT, INSERT ON ${S}.audit TO ${APP}`); // append-only at the runtime-role boundary (SF-57)
    await own.query(`GRANT USAGE, SELECT ON SEQUENCE ${S}.audit_id_seq TO ${APP}`);
    for (const t of TABLES) {
      await own.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${S}.${t} TO ${SYS}`);
      await own.query(`CREATE POLICY system_access ON ${S}.${t} AS PERMISSIVE FOR ALL TO ${SYS} USING (true) WITH CHECK (true)`);
    }
    await own.query(`GRANT USAGE, SELECT ON SEQUENCE ${S}.audit_id_seq TO ${SYS}`);
    await own.query(`CREATE FUNCTION ${S}.audit_created_now() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
      BEGIN NEW.created_at := now(); RETURN NEW; END $f$`);
    await own.query(`CREATE TRIGGER audit_created_now BEFORE INSERT ON ${S}.audit FOR EACH ROW EXECUTE FUNCTION ${S}.audit_created_now()`);

    // Pre-tenant lookup: one exact slug -> (id, name). Nothing else is reachable through it.
    await own.query(`CREATE FUNCTION ${S}.resolve_tenant_by_slug(p_slug text) RETURNS TABLE (id text, name text)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
        SELECT t.id, t.name FROM ${S}.tenant t WHERE p_slug IS NOT NULL AND t.slug = p_slug LIMIT 1 $f$`);
    // Operator-only retention: deletes nothing younger than the 365-day floor whatever the argument.
    await own.query(`CREATE FUNCTION ${S}.purge_audit(p_before timestamptz) RETURNS bigint
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
        DECLARE k bigint; BEGIN
          DELETE FROM ${S}.audit a WHERE a.created_at < LEAST(p_before, now() - interval '365 days');
          GET DIAGNOSTICS k = ROW_COUNT; RETURN k; END $f$`);
    await own.query(`CREATE FUNCTION ${S}.ctx_tenant() RETURNS text
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
        DECLARE t text := current_setting('app.current_tenant_id', true);
                m text := current_setting('app.ctx_mac', true);
                ki bytea; ko bytea; msg bytea;
        BEGIN
          IF t IS NULL OR t = '' OR m IS NULL OR m = '' THEN RETURN NULL; END IF;
          SELECT k.k_ipad, k.k_opad INTO ki, ko FROM ${S}.ctx_key k WHERE k.kid = 1;
          IF ki IS NULL THEN RETURN NULL; END IF;
          msg := convert_to(t || '|' || pg_backend_pid()::text || '|'
                 || floor(extract(epoch FROM transaction_timestamp()) * 1000000)::bigint::text, 'UTF8');
          IF encode(sha256(ko || sha256(ki || msg)), 'hex') = m THEN RETURN t; END IF;
          RETURN NULL;
        END $f$`);
    for (const f of ["resolve_tenant_by_slug(text)", "purge_audit(timestamptz)", "ctx_tenant()", "audit_created_now()"]) {
      await own.query(`REVOKE ALL ON FUNCTION ${S}.${f} FROM PUBLIC`);
    }
    // ALTER ... OWNER needs the new owner to hold CREATE on the schema; granted only for the hand-over.
    await own.query(`GRANT CREATE ON SCHEMA ${S} TO ${SYS}`);
    for (const f of ["resolve_tenant_by_slug(text)", "purge_audit(timestamptz)", "ctx_tenant()"]) {
      await own.query(`ALTER FUNCTION ${S}.${f} OWNER TO ${SYS}`);
    }
    await own.query(`REVOKE CREATE ON SCHEMA ${S} FROM ${SYS}`);
    await own.query(`GRANT EXECUTE ON FUNCTION ${S}.resolve_tenant_by_slug(text) TO ${APP}`);
    await own.query(`GRANT EXECUTE ON FUNCTION ${S}.ctx_tenant() TO ${APP}`);
    await own.query(`GRANT EXECUTE ON FUNCTION ${S}.purge_audit(timestamptz) TO ${OPS}`);

    const tenantExpr = variant === "P1"
      ? (t) => `${tcol(t)} = current_setting('app.current_tenant_id', true)`
      : (t) => `${tcol(t)} = (SELECT ${S}.ctx_tenant())`;
    const bypass = variant === "MUTANT" ? `current_setting('app.bypass_rls', true) = 'on' OR ` : "";
    for (const t of TABLES) {
      await own.query(`CREATE POLICY tenant_isolation ON ${S}.${t} AS PERMISSIVE FOR ALL TO PUBLIC
        USING (${bypass}${tenantExpr(t)}) WITH CHECK (${bypass}${tenantExpr(t)})`);
    }
  }, { commit: true });
}

// The application side of each design: how a request legitimately enters tenant context.
async function enter(c, variant, tenant) {
  if (variant === "CURRENT" || variant === "P1") {
    await c.query(`select set_config('app.current_tenant_id', $1, true)`, [tenant]);
    return;
  }
  const r = (await c.query(`select pg_backend_pid()::text as pid, floor(extract(epoch from transaction_timestamp()) * 1000000)::bigint::text as ts`)).rows[0];
  const mac = crypto.createHmac("sha256", KEY).update(`${tenant}|${r.pid}|${r.ts}`, "utf8").digest("hex");
  await c.query(`select set_config('app.current_tenant_id', $1, true), set_config('app.ctx_mac', $2, true)`, [tenant, mac]);
  return mac;
}

async function runCells(variant, own) {
  const cells = {};
  const cell = (id, desc, holds, observed) => { cells[id] = { desc, holds, observed }; };
  const app = await connect(targets.appPooled);
  const app2 = await connect(targets.appPooled);
  const appD = await connect(targets.appDirect);
  try {
    // C01 genuine identity
    const id = (await app.query(`select current_user as u, r.rolbypassrls as bypass, r.rolsuper as super,
        pg_has_role(current_user, '${SYS}', 'MEMBER') as in_sys, pg_has_role(current_user, '${OPS}', 'MEMBER') as in_ops,
        pg_has_role(current_user, '${OWNER}', 'MEMBER') as in_owner from pg_roles r where r.rolname = current_user`)).rows[0];
    cell("C01", "runtime login is matflow_app: no BYPASSRLS/superuser, not a member of system/ops/owner",
      id.u === APP && !id.bypass && !id.super && !id.in_sys && !id.in_ops && !id.in_owner, id);

    // C02 positive control
    const c02 = await tx(app, async () => {
      await enter(app, variant, T.a);
      const seen = n(await attempt(app, `select count(*)::int as n from ${S}.item`));
      const ins = await attempt(app, `insert into ${S}.item values ($1,$2,'new')`, [`${T.a}-i2`, T.a]);
      const aud = await attempt(app, `insert into ${S}.audit (tenant_id, action) values ($1,'x.y')`, [T.a]);
      return { seen, insert: ins.ok, auditInsert: aud.ok };
    });
    cell("C02", "positive control: in A's context A's row is visible and A can insert data and audit rows",
      c02.seen === 1 && c02.insert && c02.auditInsert, c02);

    // C03 default deny
    const c03 = await tx(app, async () => ({
      seen: n(await attempt(app, `select count(*)::int as n from ${S}.item`)),
      insert: (await attempt(app, `insert into ${S}.item values ($1,$2,'x')`, [`${T.a}-i3`, T.a])).ok,
    }));
    cell("C03", "no tenant context: nothing visible, insert refused", c03.seen === 0 && !c03.insert, c03);

    // C04 cross-tenant inside a legitimate context
    const c04 = await tx(app, async () => {
      await enter(app, variant, T.a);
      return {
        seenB: n(await attempt(app, `select count(*)::int as n from ${S}.item where tenant_id = $1`, [T.b])),
        updB: (await attempt(app, `update ${S}.item set body = 'x' where tenant_id = $1`, [T.b])).rowCount ?? null,
        delB: (await attempt(app, `delete from ${S}.item where tenant_id = $1`, [T.b])).rowCount ?? null,
        insB: (await attempt(app, `insert into ${S}.item values ($1,$2,'x')`, [`${T.b}-i9`, T.b])).ok,
        moveToB: (await attempt(app, `update ${S}.item set tenant_id = $1 where tenant_id = $2`, [T.b, T.a])).ok,
      };
    });
    cell("C04", "in A's context B is invisible; UPDATE/DELETE of B match 0; INSERT into B and moving A's row to B refused",
      c04.seenB === 0 && c04.updB === 0 && c04.delB === 0 && !c04.insB && !c04.moveToB, c04);

    // C05 the bypass GUC (SF-62 root cause)
    const c05 = await tx(app, async () => {
      await app.query(`select set_config('app.bypass_rls', 'on', true)`);
      return {
        tenants: n(await attempt(app, `select count(*)::int as n from ${S}.tenant`)),
        items: n(await attempt(app, `select count(*)::int as n from ${S}.item`)),
        updB: (await attempt(app, `update ${S}.item set body = 'pwned' where tenant_id = $1`, [T.b])).rowCount ?? null,
      };
    });
    cell("C05", "runtime role sets app.bypass_rls=on itself: must see/modify nothing",
      c05.tenants === 0 && c05.items === 0 && c05.updB === 0, c05);

    // C06 privileged role assumption
    const c06 = {};
    for (const [k, sql] of [["setRoleSys", `SET LOCAL ROLE ${SYS}`], ["setRoleOps", `SET LOCAL ROLE ${OPS}`], ["setRoleOwner", `SET LOCAL ROLE ${OWNER}`],
      ["sessionAuthOwner", `SET LOCAL SESSION AUTHORIZATION ${OWNER}`], ["grantSysToSelf", `GRANT ${SYS} TO ${APP}`]]) {
      const r = await tx(app, () => attempt(app, sql));
      c06[k] = r.ok ? "ALLOWED" : r.code;
    }
    cell("C06", "runtime role cannot SET ROLE / SET SESSION AUTHORIZATION to system, ops or owner, nor grant itself the system role",
      Object.values(c06).every((v) => v !== "ALLOWED"), c06);

    // C07 row_security = off is not a bypass
    const c07 = await tx(app, async () => {
      await app.query("SET LOCAL row_security = off");
      const r = await attempt(app, `select count(*)::int as n from ${S}.item`);
      return r.ok ? { ok: true, n: n(r) } : { ok: false, code: r.code };
    });
    cell("C07", "SET row_security = off raises (42501) instead of bypassing", !c07.ok && c07.code === "42501", c07);

    // C08 forged tenant GUC with no proof
    const c08 = await tx(app, async () => {
      await app.query(`select set_config('app.current_tenant_id', $1, true)`, [T.b]);
      return { seenB: n(await attempt(app, `select count(*)::int as n from ${S}.item where tenant_id = $1`, [T.b])) };
    });
    cell("C08", "forged app.current_tenant_id (no signature): B must stay invisible", c08.seenB === 0, c08);

    // C09 forged / replayed / transplanted signatures (meaningful for signed designs; recorded for all)
    const c09 = {};
    c09.randomMac = await tx(app, async () => {
      await app.query(`select set_config('app.current_tenant_id', $1, true), set_config('app.ctx_mac', $2, true)`, [T.b, crypto.randomBytes(32).toString("hex")]);
      return n(await attempt(app, `select count(*)::int as n from ${S}.item where tenant_id = $1`, [T.b]));
    });
    let captured = null;
    const capturedWorksInOwnTx = await tx(app, async () => {
      captured = await enter(app, variant, T.b);
      return n(await attempt(app, `select count(*)::int as n from ${S}.item where tenant_id = $1`, [T.b]));
    });
    c09.replayedMacNextTx = await tx(app, async () => {
      await app.query(`select set_config('app.current_tenant_id', $1, true), set_config('app.ctx_mac', $2, true)`, [T.b, captured ?? "x"]);
      return n(await attempt(app, `select count(*)::int as n from ${S}.item where tenant_id = $1`, [T.b]));
    });
    c09.replayedMacOtherConnection = await tx(app2, async () => {
      await app2.query(`select set_config('app.current_tenant_id', $1, true), set_config('app.ctx_mac', $2, true)`, [T.b, captured ?? "x"]);
      return n(await attempt(app2, `select count(*)::int as n from ${S}.item where tenant_id = $1`, [T.b]));
    });
    c09.macForASwitchedToB = await tx(app, async () => {
      await enter(app, variant, T.a);
      await app.query(`select set_config('app.current_tenant_id', $1, true)`, [T.b]);
      return n(await attempt(app, `select count(*)::int as n from ${S}.item where tenant_id = $1`, [T.b]));
    });
    c09.positiveControl_capturedContextWorksInItsOwnTx = capturedWorksInOwnTx;
    cell("C09", "random MAC, MAC replayed in a later transaction or on another connection, A's MAC with the tenant switched to B: B invisible (positive control: the captured context did work in its own transaction)",
      capturedWorksInOwnTx === 1 && [c09.randomMac, c09.replayedMacNextTx, c09.replayedMacOtherConnection, c09.macForASwitchedToB].every((v) => v === 0), c09);

    // C10 context does not survive commit, rollback, error or a rolled-back savepoint
    const c10 = {};
    await tx(app, async () => { await enter(app, variant, T.a); }, { commit: true });
    c10.afterCommit = n(await attempt(app, `select count(*)::int as n from ${S}.item`));
    await begin(app);
    await enter(app, variant, T.a);
    app.__inTx = false; // let the error abort the transaction for real
    await attempt(app, "select 1/0");
    await finish(app, "ROLLBACK");
    c10.afterError = n(await attempt(app, `select count(*)::int as n from ${S}.item`));
    c10.settingAfterError = (await app.query(`select coalesce(current_setting('app.current_tenant_id', true), '') as v`)).rows[0].v === "" ? "cleared" : "LEAKED";
    c10.afterSavepointRollback = await tx(app, async () => {
      await app.query("SAVEPOINT s1");
      await enter(app, variant, T.a);
      await app.query("ROLLBACK TO SAVEPOINT s1");
      return n(await attempt(app, `select count(*)::int as n from ${S}.item`));
    });
    cell("C10", "tenant context is gone after COMMIT, after an error + ROLLBACK, and after ROLLBACK TO SAVEPOINT",
      c10.afterCommit === 0 && c10.afterError === 0 && c10.settingAfterError === "cleared" && c10.afterSavepointRollback === 0, c10);

    // C11 pooled concurrency: two transactions on the pooler at once keep their own context
    await begin(app); await begin(app2);
    await enter(app, variant, T.a);
    const c11 = { y_noContext: n(await attempt(app2, `select count(*)::int as n from ${S}.item`)) };
    await enter(app2, variant, T.b);
    c11.x_seesOnlyA = (await app.query(`select array_agg(tenant_id order by tenant_id) as t from ${S}.item`)).rows[0].t;
    c11.y_seesOnlyB = (await app2.query(`select array_agg(tenant_id order by tenant_id) as t from ${S}.item`)).rows[0].t;
    await finish(app, "ROLLBACK"); await finish(app2, "ROLLBACK");
    cell("C11", "two concurrent pooled transactions (A and B) each see only their own tenant; a third with no context sees nothing",
      c11.y_noContext === 0 && JSON.stringify(c11.x_seesOnlyA) === JSON.stringify([T.a]) && JSON.stringify(c11.y_seesOnlyB) === JSON.stringify([T.b]), c11);

    // C12 session-level (non-local) settings on a DIRECT connection (never on the pooler — they would leak to other
    // clients of the shared PgBouncer). Models a code path or attacker that sets context with is_local = false.
    const c12 = {};
    await appD.query(`select set_config('app.current_tenant_id', $1, false)`, [T.a]);
    c12.sessionTenantLeaksIntoNextTx = await tx(appD, async () => n(await attempt(appD, `select count(*)::int as n from ${S}.item`)));
    await appD.query(`select set_config('app.current_tenant_id', '', false)`);
    await appD.query(`select set_config('app.bypass_rls', 'on', false)`);
    c12.sessionBypassThenContextA_seesB = await tx(appD, async () => {
      await enter(appD, variant, T.a);
      return n(await attempt(appD, `select count(*)::int as n from ${S}.item where tenant_id = $1`, [T.b]));
    });
    await appD.query(`select set_config('app.bypass_rls', '', false), set_config('app.current_tenant_id', '', false)`);
    await appD.query("RESET ALL");
    cell("C12", "a session-level tenant or bypass setting left on a connection grants nothing to the next transaction",
      c12.sessionTenantLeaksIntoNextTx === 0 && c12.sessionBypassThenContextA_seesB === 0, c12);

    // C13 definer lookup is narrow; operator-only function is not executable
    const c13 = {};
    if (variant !== "CURRENT") {
      c13.resolveB = (await tx(app, () => attempt(app, `select count(*)::int as n from ${S}.resolve_tenant_by_slug($1)`, [SLUG.b]))).rows?.[0]?.n ?? null;
      c13.resolveWildcard = (await tx(app, () => attempt(app, `select count(*)::int as n from ${S}.resolve_tenant_by_slug('%')`))).rows?.[0]?.n ?? null;
      c13.resolveNull = (await tx(app, () => attempt(app, `select count(*)::int as n from ${S}.resolve_tenant_by_slug(NULL)`))).rows?.[0]?.n ?? null;
      c13.resolveThenReadB = await tx(app, async () => {
        await attempt(app, `select * from ${S}.resolve_tenant_by_slug($1)`, [SLUG.b]);
        return n(await attempt(app, `select count(*)::int as n from ${S}.item where tenant_id = $1`, [T.b]));
      });
      const p = await tx(app, () => attempt(app, `select ${S}.purge_audit(now())`));
      c13.purgeByRuntime = p.ok ? "ALLOWED" : p.code;
      // search_path hijack attempt: a temp table shadowing "tenant" and a hostile search_path
      c13.hijack = await tx(app, async () => {
        await app.query(`create temp table tenant (id text, slug text, name text)`);
        await app.query(`insert into pg_temp.tenant values ('evil', $1, 'evil')`, [SLUG.b]);
        await app.query(`set local search_path = pg_temp, ${S}, public`);
        const r = await attempt(app, `select id from ${S}.resolve_tenant_by_slug($1)`, [SLUG.b]);
        return r.ok ? r.rows[0]?.id === T.b ? "real-row" : "HIJACKED" : r.code;
      });
      cell("C13", "slug lookup returns exactly one (id, name) for an exact slug, nothing for wildcard/NULL, grants no table access; purge not executable by the runtime role; search_path hijack ineffective",
        c13.resolveB === 1 && c13.resolveWildcard === 0 && c13.resolveNull === 0 && c13.resolveThenReadB === 0 && c13.purgeByRuntime !== "ALLOWED" && c13.hijack === "real-row", c13);
    } else {
      cell("C13", "definer functions (not present in CURRENT)", null, "n/a");
    }

    // C14 the runtime role cannot change the boundary itself
    const c14 = {};
    for (const [k, sql] of [
      ["disableRls", `ALTER TABLE ${S}.item DISABLE ROW LEVEL SECURITY`],
      ["dropPolicy", `DROP POLICY tenant_isolation ON ${S}.item`],
      ["createPolicy", `CREATE POLICY p_evil ON ${S}.item FOR ALL USING (true)`],
      ["replaceFn", `CREATE OR REPLACE FUNCTION ${S}.ctx_tenant() RETURNS text LANGUAGE sql AS 'select null::text'`],
      ["createInSchema", `CREATE TABLE ${S}.evil (x int)`],
      ["createInPublic", `CREATE TABLE public.secb2_evil (x int)`],
      ["readKey", `SELECT count(*) FROM ${S}.ctx_key`],
      ["truncateAudit", `TRUNCATE ${S}.audit`],
    ]) {
      const r = await tx(app, () => attempt(app, sql));
      c14[k] = r.ok ? "ALLOWED" : r.code;
    }
    const g = await tx(app, async () => {
      await attempt(app, `GRANT EXECUTE ON FUNCTION ${S}.purge_audit(timestamptz) TO ${APP}`);
      return (await attempt(app, `select has_function_privilege('${APP}', '${S}.purge_audit(timestamptz)', 'EXECUTE') as x`)).rows?.[0]?.x;
    });
    c14.grantSelfPurge = g === true ? "ALLOWED" : "no-privilege";
    cell("C14", "runtime role cannot disable RLS, drop/create policies, replace functions, create objects, read the key, TRUNCATE audit or grant itself purge",
      Object.values(c14).every((v) => v !== "ALLOWED"), c14);

    // C15 audit integrity (SF-57) inside the attacker's own legitimately-entered context
    const c15 = await tx(app, async () => {
      await enter(app, variant, T.b); // models a compromised app that can enter B (holds the key in P2)
      const upd = await attempt(app, `update ${S}.audit set action = 'forged', created_at = now() - interval '400 days' where tenant_id = $1`, [T.b]);
      const del = await attempt(app, `delete from ${S}.audit where tenant_id = $1`, [T.b]);
      const ins = await attempt(app, `insert into ${S}.audit (tenant_id, action, created_at) values ($1, 'backdated', now() - interval '400 days') returning (created_at > now() - interval '1 minute') as fresh`, [T.b]);
      return { update: upd.ok ? `ALLOWED rows=${upd.rowCount}` : upd.code, delete: del.ok ? `ALLOWED rows=${del.rowCount}` : del.code, backdatedInsertForcedToNow: ins.ok ? ins.rows[0].fresh : ins.code };
    });
    cell("C15", "in its own (or a forged) tenant context the runtime role cannot UPDATE or DELETE audit rows, and cannot back-date an INSERT",
      !String(c15.update).startsWith("ALLOWED") && !String(c15.delete).startsWith("ALLOWED") && c15.backdatedInsertForcedToNow === true, c15);

    // C16 import provenance (SF-67 chain): re-point another club's source mapping without that club's context
    const c16 = await tx(app, async () => {
      await app.query(`select set_config('app.bypass_rls', 'on', true), set_config('app.current_tenant_id', $1, true)`, [T.b]);
      const r = await attempt(app, `update ${S}.src_map set member_id = 'attacker-chosen' where tenant_id = $1`, [T.b]);
      return { rewriteB: r.ok ? r.rowCount : r.code };
    });
    cell("C16", "without a valid context for B, B's import source mapping cannot be re-pointed (bypass GUC + forged tenant GUC)",
      c16.rewriteB === 0, c16);

    // R1 (residual, not a boundary cell): a holder of the signing key (full app compromise) CAN act inside any one club.
    const r1 = await tx(app, async () => {
      await enter(app, variant, T.b);
      const r = await attempt(app, `update ${S}.src_map set member_id = 'attacker-chosen' where tenant_id = $1`, [T.b]);
      return { rewriteBWithValidContext: r.ok ? r.rowCount : r.code };
    });
    cell("R1", "RESIDUAL (expected): with a valid context for B (app holds the key) B's mutable rows can be changed — RLS is not an integrity control", null, r1);
  } finally { await app.end(); await app2.end(); await appD.end(); }

  // C17 the deliberately scoped operator path: separate credential, cross-tenant by role, bounded purge
  if (variant !== "CURRENT") {
    // Positive control for purge: one A audit row is aged past the floor by the owner (committed), restored after.
    const aged = (await own.query(`update ${S}.audit set created_at = now() - interval '400 days' where tenant_id = $1 and action = 'member.update'`, [T.a])).rowCount;
    const opsCfg = { ...targets.ownerDirect, user: OPS, password: OPS_PW };
    let ops;
    try { ops = await connect(opsCfg); } catch (e) { cells.C17 = { desc: "operator login", holds: null, observed: `LOGIN FAILED: ${e.code ?? ""} ${String(e.message).slice(0, 80)}` }; return cells; }
    try {
      const c17 = await tx(ops, async () => ({
        who: (await ops.query("select current_user as u")).rows[0].u === OPS ? "ops" : "other",
        tenantsVisible: n(await attempt(ops, `select count(*)::int as n from ${S}.tenant`)),
        agedRowsPrepared: aged,
        purgedRows: (await attempt(ops, `select ${S}.purge_audit(now() + interval '1 day') as n`)).rows?.[0]?.n ?? null,
        recentRowsLeft: n(await attempt(ops, `select count(*)::int as n from ${S}.audit where created_at > now() - interval '365 days'`)),
        ddl: (await attempt(ops, `ALTER TABLE ${S}.item DISABLE ROW LEVEL SECURITY`)).ok ? "ALLOWED" : "refused",
        bypassAttr: (await ops.query(`select rolbypassrls from pg_roles where rolname = current_user`)).rows[0].rolbypassrls,
      }));
      cells.C17 = { desc: "operator credential (separate login): cross-tenant by role; purge removes exactly the row past the 365-day floor (positive control) and nothing younger; no DDL; no BYPASSRLS",
        holds: c17.tenantsVisible === 2 && aged === 1 && Number(c17.purgedRows) === 1 && c17.recentRowsLeft === 1 && c17.ddl === "refused" && c17.bypassAttr === false, observed: c17 };
    } finally {
      await ops.end();
      await own.query(`update ${S}.audit set created_at = now() - interval '10 days' where tenant_id = $1 and action = 'member.update'`, [T.a]);
    }
  }
  return cells;
}

// ───────────────────────────── 3. teardown (count-checked) ─────────────────────────────
async function teardown(own, stamp) {
  const out = {};
  await tx(own, async () => {
    await own.query(`DROP SCHEMA IF EXISTS ${stamp} CASCADE`);
    for (const r of [`${stamp}_ops`, `${stamp}_sys`]) {
      const ex = await own.query(`select 1 from pg_roles where rolname = $1`, [r]);
      if (ex.rowCount) {
        // DROP OWNED needs the privileges of the role; the owner created it, so it holds ADMIN and may grant itself.
        await own.query(`GRANT ${r} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`);
        await own.query(`DROP OWNED BY ${r}`);
        await own.query(`DROP ROLE ${r}`);
      }
    }
  }, { commit: true });
  out.schemasLeft = Number((await own.query(`select count(*)::int as n from pg_namespace where nspname = $1`, [stamp])).rows[0].n);
  out.rolesLeft = Number((await own.query(`select count(*)::int as n from pg_roles where rolname like $1`, [`${stamp}\\_%`])).rows[0].n);
  return out;
}

async function sweep(own) {
  const schemas = (await own.query(`select nspname from pg_namespace where nspname ~ '^secb2_[a-z0-9]+$'`)).rows.map((r) => r.nspname);
  const roles = (await own.query(`select rolname from pg_roles where rolname ~ '^secb2_[a-z0-9]+_(sys|ops)$'`)).rows.map((r) => r.rolname);
  const stamps = new Set([...schemas, ...roles.map((r) => r.replace(/_(sys|ops)$/, ""))]);
  const out = {};
  for (const s of stamps) out[s] = await teardown(own, s);
  return out;
}

const own = await connect(targets.ownerDirect);
let exit = 1;
try {
  const who = (await own.query(`select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as b`)).rows[0];
  results.ownerIdentity = { user: who.u, bypassrls: who.b };
  if (SWEEP) { results.sweep = await sweep(own); log(JSON.stringify(results.sweep)); exit = 0; }
  else {
    results.publicProbe = await publicProbe();
    log("PUBLIC", JSON.stringify(results.publicProbe));
    await setupSchema(own);
    for (const v of ["CURRENT", "P1", "P2", "MUTANT"]) {
      await installVariant(own, v);
      results.variants[v] = await runCells(v, own);
      const line = Object.entries(results.variants[v]).map(([k, c]) => `${k}:${c.holds === null ? "-" : c.holds ? "hold" : "BREACH"}`).join(" ");
      log(v, line);
    }
    const V = results.variants;
    const boundary = (cells) => Object.entries(cells).filter(([k, c]) => k.startsWith("C") && c.holds !== null);
    results.verdict = {
      redReproducedOnCurrent: V.CURRENT.C05.holds === false,
      p2HoldsEverywhere: boundary(V.P2).every(([, c]) => c.holds === true),
      p2Failures: boundary(V.P2).filter(([, c]) => c.holds !== true).map(([k]) => k),
      p1Failures: boundary(V.P1).filter(([, c]) => c.holds !== true).map(([k]) => k),
      currentFailures: boundary(V.CURRENT).filter(([, c]) => c.holds !== true).map(([k]) => k),
      mutantCaught: V.MUTANT.C05.holds === false,
      mutantFailures: boundary(V.MUTANT).filter(([, c]) => c.holds !== true).map(([k]) => k),
    };
    exit = results.verdict.redReproducedOnCurrent && results.verdict.p2HoldsEverywhere && results.verdict.mutantCaught ? 0 : 1;
    log("VERDICT", JSON.stringify(results.verdict));
  }
} catch (e) {
  results.error = String(e?.message ?? e).slice(0, 300);
  log("ERROR", results.error);
} finally {
  if (!SWEEP) {
    try { results.teardown = await teardown(own, S); } catch (e) { results.teardown = { error: String(e.message).slice(0, 200) }; exit = 1; }
    log("TEARDOWN", JSON.stringify(results.teardown));
    if (results.teardown.schemasLeft !== 0 || results.teardown.rolesLeft !== 0) exit = 1;
  }
  await own.end();
  results.finishedAt = new Date().toISOString();
  results.exit = exit;
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2));
  process.exit(exit);
}
