// Lane F3 (iteration 2, SF-96): review R3's tamper probe (evidence/R3/tamper-classes.mjs.txt — its 27 cases copied
// verbatim, including the 7 classes R3 proved uncaught), R3's three follow-up cases (tamper-classes.log, second
// block), and F3's own extra cases for each new fingerprint section. ISOLATED PGlite restore only (backup-restore.mjs
// <export> --no-revoke --serve-seconds=N --port=P); every tamper runs in its own transaction, is fingerprinted inside
// it and rolled back. Prints verdicts and the first fail line only (catalogue names, no row data).
//
//   node docs/security/evidence/F3/tamper-classes-f3.mjs <export-dir> <port>
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { takeFingerprint, compareFingerprints } from "../../../../scripts/readiness/restore-verify.mjs";

const [exportDir, portArg] = process.argv.slice(2);
const baseline = JSON.parse(fs.readFileSync(path.join(exportDir, "baseline-fingerprint.json"), "utf8"));
const owner = baseline.tables.AuditLog.owner;
const c = new pg.Client({ host: "127.0.0.1", port: Number(portArg), user: "postgres", database: "postgres", ssl: false });
await c.connect();
const avail = (await c.query(`select name from pg_available_extensions where installed_version is null order by name limit 1`)).rows[0]?.name;
const fnSig = "matflow_lowercase_email()";
const L = (group, name, stmts) => ({ group, name, stmts });
const cases = [
  L("R3-listed", "positive control (no tamper)", []),
  L("R3-listed", "policy expression", [`ALTER POLICY tenant_isolation ON "Member" USING (true)`]),
  L("R3-listed", "trigger definition (BEFORE INSERT only)", [`DROP TRIGGER "User_email_lowercase" ON "User"`, `CREATE TRIGGER "User_email_lowercase" BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION matflow_lowercase_email()`]),
  L("R3-listed", "trigger enabled state", [`ALTER TABLE "Member" DISABLE TRIGGER USER`]),
  L("R3-listed", "function source", [`CREATE OR REPLACE FUNCTION ${fnSig} RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`]),
  L("R3-listed", "function owner", [`ALTER FUNCTION ${fnSig} OWNER TO matflow_app`]),
  L("R3-listed", "function SECURITY DEFINER", [`ALTER FUNCTION ${fnSig} SECURITY DEFINER`]),
  L("R3-listed", "function search_path config", [`ALTER FUNCTION ${fnSig} SET search_path = public, pg_temp`]),
  L("R3-listed", "function ACL", [`REVOKE EXECUTE ON FUNCTION ${fnSig} FROM PUBLIC`]),
  L("R3-listed", "table owner", [`ALTER TABLE "Tenant" OWNER TO matflow_app`]),
  L("R3-listed", "table ACL", [`GRANT TRUNCATE ON "Member" TO matflow_app`]),
  L("R3-listed", "role flag (BYPASSRLS)", [`ALTER ROLE matflow_app BYPASSRLS`]),
  L("R3-listed", "role membership", [`GRANT "${owner}" TO matflow_app`]),
  L("R3-listed", "schema ACL", [`GRANT CREATE ON SCHEMA public TO matflow_app`]),
  L("R3-listed", `extension (${avail ?? "none available"})`, avail ? [`CREATE EXTENSION "${avail}"`] : []),
  L("R3-listed", "event trigger", [`CREATE FUNCTION public.zz_r3_evt() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$`, `CREATE EVENT TRIGGER zz_r3_evt ON ddl_command_start EXECUTE FUNCTION public.zz_r3_evt()`]),
  L("R3-listed", "migration checksum", [`UPDATE _prisma_migrations SET checksum = repeat('0',64) WHERE migration_name = (SELECT min(migration_name) FROM _prisma_migrations)`]),
  L("R3-listed", "content hash (row rewritten, count kept)", [`UPDATE "Member" SET name = name || ' ' WHERE id = (SELECT id FROM "Member" ORDER BY id LIMIT 1)`]),
  L("R3-listed", "RLS flags (NO FORCE)", [`ALTER TABLE "Member" NO FORCE ROW LEVEL SECURITY`]),
  L("R3-listed", "foreign key dropped", [`ALTER TABLE "Member" DROP CONSTRAINT IF EXISTS "Member_tenantId_fkey"`]),
  // R3-5: the seven classes the SF-64 fingerprint passed.
  L("R3-5", "column-level grant (UPDATE (action) on AuditLog)", [`GRANT UPDATE ("action") ON "AuditLog" TO matflow_app`]),
  L("R3-5", "rewrite rule (INSERT into AuditLog DO INSTEAD NOTHING)", [`CREATE RULE zz_r3_drop AS ON INSERT TO "AuditLog" DO INSTEAD NOTHING`]),
  L("R3-5", "role default setting (matflow_app: app.bypass_rls = on)", [`ALTER ROLE matflow_app SET app.bypass_rls = 'on'`]),
  L("R3-5", "database default setting (app.bypass_rls = on)", [`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET app.bypass_rls = %L', current_database(), 'on'); END $$`]),
  L("R3-5", "default privileges for future tables", [`ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public GRANT ALL ON TABLES TO matflow_app`]),
  L("R3-5", "view over User granted to the runtime role", [`CREATE VIEW public.zz_r3_view AS SELECT * FROM "User"`, `GRANT SELECT ON public.zz_r3_view TO matflow_app`]),
  L("R3-5", "sequence/other-schema function shadow (new schema + role search_path)", [`CREATE SCHEMA zz_r3`, `CREATE FUNCTION zz_r3.btrim(text) RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$`, `ALTER ROLE matflow_app SET search_path = zz_r3, public`]),
  // R3 follow-up block (tamper-classes.log, second run).
  L("R3-followup", "role membership (pg_write_all_data granted to matflow_app)", [`GRANT pg_write_all_data TO matflow_app`]),
  L("R3-followup", "role membership (runtime role granted into a new role)", [`CREATE ROLE zz_r3_grp NOLOGIN`, `GRANT zz_r3_grp TO matflow_app`]),
  L("R3-followup", "view over User created BY THE OWNER, granted to the runtime role", [`SET LOCAL ROLE "${owner}"`, `CREATE VIEW public.zz_r3_view2 AS SELECT * FROM "User"`, `GRANT SELECT ON public.zz_r3_view2 TO matflow_app`, `RESET ROLE`]),
  // F3 extras: one per new section, each the narrowest form (no side effect visible to the older sections).
  L("F3", "other-schema function ALONE (no search_path change)", [`SET LOCAL ROLE "${owner}"`, `CREATE SCHEMA zz_f3`, `CREATE FUNCTION zz_f3.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`, `RESET ROLE`]),
  L("F3", "role search_path ALONE (pg_temp first)", [`ALTER ROLE matflow_app SET search_path = pg_temp, public`]),
  L("F3", "role row_security setting", [`ALTER ROLE matflow_app SET row_security = off`]),
  L("F3", "ALTER ROLE ALL SET app.bypass_rls", [`ALTER ROLE ALL SET app.bypass_rls = 'on'`]),
  L("F3", "role setting IN DATABASE", [`DO $$ BEGIN EXECUTE format('ALTER ROLE matflow_app IN DATABASE %I SET app.bypass_rls = %L', current_database(), 'on'); END $$`]),
  L("F3", "role statement_timeout setting added", [`ALTER ROLE matflow_app SET statement_timeout = '5s'`]),
  L("F3", "column grant SELECT (passwordHash) on User", [`GRANT SELECT ("passwordHash") ON "User" TO matflow_app`]),
  L("F3", "rule on Member, created by the owner, DO ALSO", [`SET LOCAL ROLE "${owner}"`, `CREATE RULE zz_f3_also AS ON UPDATE TO "Member" DO ALSO NOTHING`, `RESET ROLE`]),
  L("F3", "default privileges for FUNCTIONS (global)", [`ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" GRANT EXECUTE ON FUNCTIONS TO matflow_app WITH GRANT OPTION`]),
  L("F3", "default privileges REVOKED (matflow_app loses future-table DML)", [`ALTER DEFAULT PRIVILEGES FOR ROLE "${owner}" IN SCHEMA public REVOKE DELETE ON TABLES FROM matflow_app`]),
  L("F3", "materialised view by the owner, no grant", [`SET LOCAL ROLE "${owner}"`, `CREATE MATERIALIZED VIEW public.zz_f3_mv AS SELECT id FROM "Tenant"`, `RESET ROLE`]),
  L("F3", "sequence by the owner granted to the runtime role", [`SET LOCAL ROLE "${owner}"`, `CREATE SEQUENCE public.zz_f3_seq`, `GRANT USAGE ON SEQUENCE public.zz_f3_seq TO matflow_app`, `RESET ROLE`]),
  L("F3", "database ACL: CREATE to the runtime role", [`DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO matflow_app', current_database()); END $$`]),
];
const out = [];
for (const k of cases) {
  await c.query("BEGIN");
  try {
    for (const s of k.stmts) await c.query(s);
    await c.query(`SET LOCAL ROLE "${owner}"`);
    const fp = await takeFingerprint(c, { contentHash: true });
    const r = compareFingerprints(baseline, fp);
    const expectPass = k.stmts.length === 0;
    out.push({ group: k.group, case: k.name, got: r.verdict, caught: (r.verdict === "PASS") === expectPass, firstFail: r.fails[0] ?? null, fails: r.fails.length });
  } catch (e) {
    out.push({ group: k.group, case: k.name, got: "ERROR", caught: null, error: String(e.message).slice(0, 160) });
  } finally {
    await c.query("ROLLBACK");
  }
  console.log(JSON.stringify(out.at(-1)));
}
await c.end();
const by = (g) => ({ caught: out.filter((o) => o.group === g && o.caught === true).length, errors: out.filter((o) => o.group === g && o.got === "ERROR").length, total: out.filter((o) => o.group === g).length });
console.log(JSON.stringify({ cases: out.length, "R3-listed": by("R3-listed"), "R3-5": by("R3-5"), "R3-followup": by("R3-followup"), F3: by("F3"), node: process.version }));
process.exit(out.some((o) => o.caught === false) ? 1 : 0);
