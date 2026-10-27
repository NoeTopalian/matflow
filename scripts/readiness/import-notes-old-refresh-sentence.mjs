// Read-only count of members whose notes still carry the sentence earlier
// TeamUp imports wrote about a scheduled plan: "...; the next status refresh
// after the start date moves them." Since 25 Oct 2026 a refresh changes
// nobody (owner decision), so that sentence is no longer true. This script
// changes NOTHING: it counts the members per club and prints the exact
// replacement sentence the importer now writes, so the operator can decide.
//
//   node scripts/readiness/import-notes-old-refresh-sentence.mjs --env <file> [--production]
//
// --env never defaults to .env. The TEST branch by default; a production run
// (read-only) is Noe's and needs --production. Prints counts only: no member
// ids, names or note text.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
import { resolveDbTarget, TargetRefused } from "./db-target.mjs";

const OLD = "the next status refresh after the start date moves them.";
const NEW = "change their plan in MatFlow once it starts (a later upload does not move them).";

const args = process.argv.slice(2);
const envIdx = args.indexOf("--env");
const envFile = envIdx >= 0 ? args[envIdx + 1] : undefined;
const production = args.includes("--production");
const finish = (code, summary) => { console.log(JSON.stringify(summary)); process.exit(code); };

if (!envFile) finish(2, { ok: false, error: "--env <file> is required (this script never defaults to .env)" });
dotenv.config({ path: envFile, override: true, quiet: true });
const url = process.env.DATABASE_URL ?? "";
if (!url) finish(2, { ok: false, error: "DATABASE_URL unset in the env file" });
let host;
try {
  host = resolveDbTarget(url, production ? { expectHost: "ep-bold-wave", allowProduction: true } : { expectHost: "ep-hidden-salad" });
} catch (e) {
  if (e instanceof TargetRefused) finish(2, { ok: false, error: `refused: ${e.message}` });
  throw e;
}
console.log(`target: ${production ? "PRODUCTION (read-only)" : "test branch"}  host: ${host}`);

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }) });
try {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return tx.$queryRaw`
      SELECT t."slug" AS slug, count(*)::int AS members
        FROM "Member" m JOIN "Tenant" t ON t."id" = m."tenantId"
       WHERE strpos(m."notes", ${OLD}) > 0
       GROUP BY t."slug" ORDER BY t."slug"`;
  });
  for (const r of rows) console.log(`${r.slug}: ${r.members} member(s) carry the old sentence`);
  console.log(`replace "${OLD}" with "${NEW}"`);
  finish(0, { ok: true, clubs: rows.length, members: rows.reduce((n, r) => n + r.members, 0), old: OLD, replacement: NEW, changed: 0 });
} finally {
  await prisma.$disconnect();
}
