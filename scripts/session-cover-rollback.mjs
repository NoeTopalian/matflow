// Before rolling the app back to a build from before session cover (PR #134), when cover rows exist.
//
// Why: the previous build deletes sessions (weekly-slot edit, attendance-import rollback) and clubs (the purge)
// without touching "SessionCover", whose keys are RESTRICT. With any cover row present those deletes fail
// (P2003, a 500 to the person editing). This script keeps the rows as a JSON file outside the database and then
// removes them, so the previous build works; the empty table stays and the previous build never reads it. Full
// procedure, and what to tell staff: docs/runbooks/SESSION-COVER-ROLLBACK.md.
//
//   node scripts/session-cover-rollback.mjs --expect-host <host> --export <new file.json>             (read only)
//   node scripts/session-cover-rollback.mjs --expect-host <host> --export <new file.json> --delete    (export, then remove)
//
// DATABASE_URL names the database. --expect-host is always required: a Neon endpoint the host must be
// (scripts/readiness/db-target.mjs), or 127.0.0.1 / localhost for a local rehearsal database, which the URL's host
// must then be exactly. Production (ep-bold-wave) is Noe's to run. The export file must not exist yet:
// a previous export is never overwritten. The export and the delete run in ONE transaction that first locks the
// table, so no cover row can be added between them. Prints the endpoint host (never the URL) and counts only.
// Exit 0 done, 2 refused or failed.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveDbTarget, TargetRefused } from "./readiness/db-target.mjs";

export function parseArgs(argv) {
  const at = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };
  const expectHost = at("--expect-host");
  const exportFile = at("--export");
  if (!expectHost) throw new TargetRefused("REFUSED: --expect-host <host> is required");
  if (!exportFile) throw new TargetRefused("REFUSED: --export <file.json> is required (the rows are always kept before anything is removed)");
  return { expectHost, exportFile, remove: argv.includes("--delete") };
}

const LOOPBACK = ["127.0.0.1", "localhost"];

/** A Neon endpoint goes through the shared allowlist; a local rehearsal database must be exactly the loopback host named. */
export function resolveTarget(url, expectHost) {
  if (!LOOPBACK.includes(expectHost)) return resolveDbTarget(url, { expectHost, allowProduction: true });
  for (const k of ["PGOPTIONS", "PGHOST", "PGHOSTADDR"]) {
    if (process.env[k]) throw new TargetRefused(`REFUSED: ${k} is set in the environment`);
  }
  let u;
  try { u = new URL(url); } catch { throw new TargetRefused("connection string is not a URL"); }
  for (const key of ["host", "hostaddr", "options", "endpoint"]) {
    if (u.searchParams.has(key)) throw new TargetRefused(`REFUSED: connection string carries a ${key}= parameter`);
  }
  if (u.hostname.toLowerCase() !== expectHost) throw new TargetRefused(`REFUSED: host is not ${expectHost}`);
  return expectHost;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new TargetRefused("DATABASE_URL is not set");
  const args = parseArgs(process.argv.slice(2));
  const endpoint = resolveTarget(url, args.expectHost);
  if (fs.existsSync(args.exportFile)) throw new TargetRefused(`REFUSED: ${args.exportFile} already exists; choose a new file`);
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const who = (await client.query("SELECT current_user AS u")).rows[0].u;
    console.log(`endpoint ${endpoint}; database user ${who}`);
    const exists = (await client.query(`SELECT to_regclass('"SessionCover"') IS NOT NULL AS t`)).rows[0].t;
    if (!exists) {
      await client.query("ROLLBACK");
      console.log("No SessionCover table: nothing to do.");
      return;
    }
    // No cover row can be written or removed by anyone else until this transaction ends.
    await client.query(`LOCK TABLE "SessionCover" IN SHARE ROW EXCLUSIVE MODE`);
    const { rows } = await client.query(`SELECT * FROM "SessionCover" ORDER BY "tenantId", "createdAt", "id"`);
    fs.writeFileSync(args.exportFile, JSON.stringify({ exportedAt: new Date().toISOString(), endpoint, rows }, null, 2), { flag: "wx" });
    const active = rows.filter((r) => r.status === "open" || r.status === "covered").length;
    console.log(`${rows.length} cover rows exported to ${args.exportFile} (${active} open or covered).`);
    if (!args.remove) {
      await client.query("ROLLBACK");
      console.log("Read only: nothing removed (add --delete to remove them).");
      return;
    }
    const del = await client.query(`DELETE FROM "SessionCover"`);
    if (del.rowCount !== rows.length) throw new Error(`removed ${del.rowCount}, expected ${rows.length}; rolled back`);
    await client.query("COMMIT");
    console.log(`${del.rowCount} cover rows removed. The previous build's session and club deletes now work.`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof TargetRefused ? e.message : `Could not run: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
