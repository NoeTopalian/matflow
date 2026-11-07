// Prisma migrations of THIS worktree against the Neon TEST branch only (DATABASE_URL from .env.test, guarded).
//   node migrate-test.mjs status            read only: which migrations the test branch has applied
//   node migrate-test.mjs dev <name>        create a migration from schema changes and apply it to the test branch
//   node migrate-test.mjs deploy            apply this worktree's pending migrations to the test branch
//   node migrate-test.mjs checksum <dir>    after editing an ALREADY-APPLIED migration of this worktree (comments, the
//                                           BEGIN/timeout wrapper — never its effect), record the edited file's checksum
//                                           on the test branch so `migrate dev` elsewhere does not see a modified
//                                           migration. Touches that one _prisma_migrations row only, compare-and-set.
// Never `db push`, never against production (the main checkout's .env is production and is never read here).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { APP, assertWorktree, node24, prismaEnv } from "./env.mjs";

const [cmd, name] = process.argv.slice(2);

if (cmd === "checksum") {
  if (!/^\d{14}_[a-z0-9_]+$/.test(name ?? "")) { console.log("usage: node migrate-test.mjs checksum <migration directory name>"); process.exit(2); }
  assertWorktree();
  const file = `${APP}/prisma/migrations/${name}/migration.sql`;
  if (!fs.existsSync(file)) { console.log(`refusing: ${name} is not a migration of this worktree`); process.exit(2); }
  // Prisma's migration checksum: sha256 of the file's bytes, lower-case hex.
  const want = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const pg = createRequire(`${APP}/package.json`)("pg");
  const client = new pg.Client({ connectionString: prismaEnv().DATABASE_URL });
  await client.connect();
  try {
    const row = (await client.query('SELECT checksum, finished_at FROM "_prisma_migrations" WHERE migration_name = $1', [name])).rows;
    if (row.length !== 1 || !row[0].finished_at) { console.log(`refusing: ${name} is not applied exactly once on the test branch (rows ${row.length})`); process.exit(2); }
    const had = row[0].checksum;
    if (had === want) { console.log(`CHECKSUM ${name} already matches the file (${want.slice(0, 12)}…)`); process.exit(0); }
    const set = await client.query('UPDATE "_prisma_migrations" SET checksum = $1 WHERE migration_name = $2 AND checksum = $3', [want, name, had]);
    const now = (await client.query('SELECT checksum FROM "_prisma_migrations" WHERE migration_name = $1', [name])).rows[0].checksum;
    console.log(`CHECKSUM ${name} ${had.slice(0, 12)}… -> ${now.slice(0, 12)}… (rows updated ${set.rowCount}; matches file ${now === want})`);
    process.exit(now === want ? 0 : 1);
  } finally {
    await client.end().catch(() => {});
  }
}

const args = { status: ["migrate", "status"], deploy: ["migrate", "deploy"], dev: ["migrate", "dev", "--name", name] }[cmd];
if (!args || (cmd === "dev" && !/^[a-z0-9_]+$/.test(name ?? ""))) { console.log("usage: node migrate-test.mjs status | deploy | dev <snake_case_name> | checksum <migration dir>"); process.exit(2); }
assertWorktree();
const r = spawnSync(node24(), ["node_modules/prisma/build/index.js", ...args], { cwd: APP, env: prismaEnv(), encoding: "utf8" });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/postgres(ql)?:\/\/[^\s"']+/g, "<url>");
console.log(out.split(/\r?\n/).filter((l) => l.trim() && !/sslmode|libpq|SSL modes|verify-full|uselibpqcompat|prepare for this change|current behavior|weaker security|trace-warnings/.test(l)).join("\n"));
console.log(`PRISMA ${cmd.toUpperCase()} EXIT ${r.status}`);
process.exit(r.status ?? 1);
