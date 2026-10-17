// Prisma migrations of THIS worktree against the Neon TEST branch only (DATABASE_URL from .env.test, guarded).
//   node migrate-test.mjs status            read only: which migrations the test branch has applied
//   node migrate-test.mjs dev <name>        create a migration from schema changes and apply it to the test branch
//   node migrate-test.mjs deploy            apply this worktree's pending migrations to the test branch
// Never `db push`, never against production (the main checkout's .env is production and is never read here).
import { spawnSync } from "node:child_process";
import { APP, assertWorktree, node24, prismaEnv } from "./env.mjs";

const [cmd, name] = process.argv.slice(2);
const args = { status: ["migrate", "status"], deploy: ["migrate", "deploy"], dev: ["migrate", "dev", "--name", name] }[cmd];
if (!args || (cmd === "dev" && !/^[a-z0-9_]+$/.test(name ?? ""))) { console.log("usage: node migrate-test.mjs status | deploy | dev <snake_case_name>"); process.exit(2); }
assertWorktree();
const r = spawnSync(node24(), ["node_modules/prisma/build/index.js", ...args], { cwd: APP, env: prismaEnv(), encoding: "utf8" });
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/postgres(ql)?:\/\/[^\s"']+/g, "<url>");
console.log(out.split(/\r?\n/).filter((l) => l.trim() && !/sslmode|libpq|SSL modes|verify-full|uselibpqcompat|prepare for this change|current behavior|weaker security|trace-warnings/.test(l)).join("\n"));
console.log(`PRISMA ${cmd.toUpperCase()} EXIT ${r.status}`);
process.exit(r.status ?? 1);
