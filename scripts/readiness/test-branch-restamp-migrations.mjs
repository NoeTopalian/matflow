// Re-stamp `_prisma_migrations.checksum` on the Neon TEST endpoint after an UNRELEASED migration file was edited
// (brief S2.2, 24 Oct 2026: the six plan-limits migrations gained `SET LOCAL lock_timeout/statement_timeout`).
//
// Why: the shared test branch applied those files before the edit. `prisma migrate deploy` and `migrate status` ignore
// the changed checksum (verified on Prisma 7.10.0), but `prisma migrate dev` (the matflow-verify-local skill's
// `migrate-test.mjs dev`) treats an applied file whose checksum changed as drift and wants to reset the database. This
// script records the checksum of the file as it is now, and ONLY where the stored checksum is provably that of the same
// file at `--from <git ref>` (any line-ending form): a row applied from any other content is reported and left alone.
// Never for production (no migration that production applied may ever be edited; the target guard refuses it anyway).
//
//   node --env-file=<main>/.env.test scripts/readiness/test-branch-restamp-migrations.mjs DATABASE_URL --from <ref> \
//        [--database matflow_rehearsal_<digits>] [--apply] <migration_dir> …
// Dry run unless --apply. Prints migration names and verdicts only. Exit 0 ok, 1 a row did not match, 2 refused.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { resolveDbTarget, TargetRefused } from "./db-target.mjs";

const TAG = "[restamp]";
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const apply = argv.includes("--apply");
if (apply) argv.splice(argv.indexOf("--apply"), 1);
const from = flag("--from");
const database = flag("--database");
const [varName, ...names] = argv;
const refuse = (m) => { console.error(`${TAG} REFUSED: ${m}`); process.exit(2); };
if (!/^[A-Z_][A-Z0-9_]*$/.test(varName ?? "")) refuse("name the variable holding the TEST-endpoint URL");
if (!from || !/^[\w./-]+$/.test(from)) refuse("--from <git ref> (the commit whose file content the branch applied) is required");
if (!names.length || names.some((n) => !/^\d{14}_[a-z0-9_]+$/.test(n))) refuse("list migration directory names");
if (database !== null && !/^matflow_rehearsal_\d{14}$/.test(database)) refuse("--database admits only a matflow_rehearsal_<digits> scratch database");

const u = new URL(process.env[varName] ?? "");
if (database) u.pathname = `/${database}`;
try {
  resolveDbTarget(u.toString(), { expectHost: "ep-hidden-salad" });
} catch (e) {
  if (e instanceof TargetRefused) refuse(e.message);
  throw e;
}

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const forms = (text) => [text, text.replace(/\r\n/g, "\n"), text.replace(/\r?\n/g, "\r\n")].map((t) => sha(Buffer.from(t, "utf8")));
const repo = process.cwd();

const c = new pg.Client({ connectionString: u.toString(), application_name: "restamp-migrations" });
c.on("error", () => {});
await c.connect();
let bad = 0;
try {
  await c.query("BEGIN");
  for (const name of names) {
    const rel = `prisma/migrations/${name}/migration.sql`;
    const now = fs.readFileSync(path.join(repo, rel));
    let old;
    try {
      old = execFileSync("git", ["show", `${from}:${rel}`], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      console.log(`${TAG} ${name}: not in ${from}; left alone`);
      bad++;
      continue;
    }
    const row = (await c.query(`SELECT checksum FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`, [name])).rows[0];
    if (!row) { console.log(`${TAG} ${name}: not applied on this database; nothing to do`); continue; }
    const target = sha(now);
    if (row.checksum === target) { console.log(`${TAG} ${name}: already matches the file`); continue; }
    if (!forms(old).includes(row.checksum)) { console.log(`${TAG} ${name}: stored checksum is NOT the ${from} file in any line-ending form; left alone`); bad++; continue; }
    if (apply) await c.query(`UPDATE "_prisma_migrations" SET checksum = $2 WHERE migration_name = $1`, [name, target]);
    console.log(`${TAG} ${name}: applied from the ${from} file; ${apply ? "re-stamped to the current file" : "would re-stamp (dry run)"}`);
  }
  await c.query(apply && bad === 0 ? "COMMIT" : "ROLLBACK");
  if (apply && bad) console.log(`${TAG} nothing written: ${bad} row(s) did not match`);
} finally {
  await c.end();
}
process.exit(bad ? 1 : 0);
