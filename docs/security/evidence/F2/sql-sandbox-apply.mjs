// Applies the SF-57 v2 proposal to the ISOLATED in-memory restore served by backup-restore.mjs (PGlite on 127.0.0.1)
// — never to TEST or production; the adoption of this migration on TEST was refused to the lead on 9 Oct 2026 and
// that refusal stands. This is validation of the SQL in a disposable copy that disappears when the serving process
// exits: does it parse and run on Postgres 17 as the table owner, and what are its effects (the integration test
// sec-f2-auditlog-append-only-db then runs against the same copy with SEC_F2_SET_ROLE).
//
//   node docs/security/evidence/F2/sql-sandbox-apply.mjs <port> [--mutant=stamp-noop|like-wildcard|delete-open]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const [portArg] = process.argv.slice(2);
const mutant = (process.argv.find((a) => a.startsWith("--mutant=")) ?? "").slice(9);
let sql = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "proposed-auditlog-append-only-v2.sql"), "utf8");
const swap = (from, to) => { if (!sql.includes(from)) throw new Error(`mutant anchor missing: ${from.slice(0, 60)}`); sql = sql.replace(from, to); };
if (mutant === "stamp-noop") swap(`NEW."createdAt" := (now() AT TIME ZONE 'UTC');`, `NULL; -- mutant: createdAt not forced`);
else if (mutant === "like-wildcard") swap(`AND NOT starts_with(a.action, 'member.dsar_erase')`, `AND a.action NOT LIKE 'member.dsar_erase%'`);
else if (mutant === "delete-open") {
  swap(`    IF audit_log_is_table_owner() THEN\n      RETURN OLD;`, `    IF true THEN -- mutant: any role may delete\n      RETURN OLD;`);
  swap(`EXECUTE 'REVOKE UPDATE, DELETE ON "AuditLog" FROM matflow_app';`, `EXECUTE 'REVOKE UPDATE ON "AuditLog" FROM matflow_app';`);
} else if (mutant) throw new Error(`unknown mutant ${mutant}`);
const c = new pg.Client({ host: "127.0.0.1", port: Number(portArg), user: "postgres", database: "postgres", ssl: false });
await c.connect();
const owner = (await c.query(`select pg_get_userbyid(relowner) o from pg_class where oid = '"AuditLog"'::regclass`)).rows[0].o;
const t = Date.now();
await c.query("BEGIN");
await c.query(`SET LOCAL ROLE "${owner}"`);
await c.query(sql);
await c.query("COMMIT");
const trg = (await c.query(`select string_agg(tgname || ':' || tgenabled::text, ',' order by tgname) g from pg_trigger where tgrelid = '"AuditLog"'::regclass and not tgisinternal`)).rows[0].g;
const acl = (await c.query(`select relacl::text a from pg_class where oid = '"AuditLog"'::regclass`)).rows[0].a;
await c.end();
console.log(JSON.stringify({ applied: true, mutant: mutant || null, asRole: owner, ms: Date.now() - t, triggers: trg, auditLogAcl: acl, node: process.version }));
