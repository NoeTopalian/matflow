// SEC-083 probe: can the runtime DB role alter or delete audit history?
// TEST branch only (ep-hidden-salad), both roles. Every statement runs inside ONE
// transaction that is ROLLED BACK, so nothing persists (no teardown needed).
// Prints counts and booleans only.
import fs from "node:fs";
import { createRequire } from "node:module";
const pg = createRequire("C:/Users/NoeTo/Desktop/matflow/package.json")("pg");
const env = fs.readFileSync("C:/Users/NoeTo/Desktop/matflow/.env.test", "utf8");
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.replace(/["\r]/g, "");
const out = {};
for (const varName of ["TEST_DATABASE_URL", "RESTRICTED_DATABASE_URL"]) {
  const url = get(varName);
  if (!url || !url.includes("ep-hidden-salad") || url.includes("ep-bold-wave")) { out[varName] = "REFUSED"; continue; }
  const c = new pg.Client({ connectionString: url, application_name: "secF-audit-tamper-probe" });
  await c.connect();
  const r = { role: null };
  try {
    await c.query("SET statement_timeout = '10s'");
    await c.query("BEGIN");
    r.role = (await c.query("select current_user u")).rows[0].u;
    await c.query("SELECT set_config('app.bypass_rls','on',true)");
    const [t1, t2] = (await c.query(`SELECT id FROM "Tenant" ORDER BY slug='totalbjj' DESC, id LIMIT 2`)).rows.map((x) => x.id);
    await c.query("SELECT set_config('app.bypass_rls','off',true)");
    await c.query("SELECT set_config('app.current_tenant_id',$1,true)", [t1]);
    const ins = await c.query(
      `INSERT INTO "AuditLog" (id,"tenantId",action,"entityType","entityId",metadata,"createdAt")
       VALUES ('secF-probe-'||md5(random()::text), $1, 'secF.probe.original', 'Probe', 'secF-probe', '{"secF":true}', now()) RETURNING id`, [t1]);
    const id = ins.rows[0].id;
    r.update_own_tenant_ctx = (await c.query(`UPDATE "AuditLog" SET action='secF.probe.REWRITTEN' WHERE id=$1`, [id])).rowCount;
    r.backdate_own_tenant_ctx = (await c.query(`UPDATE "AuditLog" SET "createdAt"=now()-interval '400 days' WHERE id=$1`, [id])).rowCount;
    await c.query("SELECT set_config('app.current_tenant_id',$1,true)", [t2 ?? "secF-none"]);
    r.update_from_other_tenant_ctx = (await c.query(`UPDATE "AuditLog" SET action='secF.x' WHERE id=$1`, [id])).rowCount;
    await c.query("SELECT set_config('app.current_tenant_id','',true)");
    await c.query("SELECT set_config('app.bypass_rls','on',true)");
    r.read_all_tenants_with_self_set_bypass = Number((await c.query(`SELECT count(DISTINCT "tenantId")::int n FROM "AuditLog"`)).rows[0].n) > 1;
    r.delete_with_self_set_bypass = (await c.query(`DELETE FROM "AuditLog" WHERE id=$1`, [id])).rowCount;
    r.truncate_privilege = (await c.query(`SELECT has_table_privilege(current_user,'"AuditLog"','TRUNCATE') p`)).rows[0].p;
    r.update_privilege = (await c.query(`SELECT has_table_privilege(current_user,'"AuditLog"','UPDATE') p`)).rows[0].p;
    r.delete_privilege = (await c.query(`SELECT has_table_privilege(current_user,'"AuditLog"','DELETE') p`)).rows[0].p;
    r.non_internal_triggers_on_auditlog = Number((await c.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='"AuditLog"'::regclass AND NOT tgisinternal`)).rows[0].n);
  } catch (e) {
    r.error = String(e.message).slice(0, 200);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    r.residue = Number((await c.query(`SELECT count(*)::int n FROM "AuditLog" WHERE id LIKE 'secF-probe-%'`).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n);
    await c.end();
  }
  out[varName] = r;
}
console.log(JSON.stringify(out, null, 1));
