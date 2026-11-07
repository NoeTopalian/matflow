// READ-ONLY. Lists mats whose stored name key is not what lib/mats.ts matNameKey gives for their name today.
//
// Why: from 7 Nov 2026 a mat's key also drops default-ignorable characters (a soft hyphen, a zero-width joiner),
// so "Mat<soft hyphen>1" keys as "mat1". A mat saved before then with such a character keeps its old key, and a
// new "Mat1" would not be recognised as the same mat. This script only reports; it changes nothing. How to put a
// listed mat right is in docs/RULES.md section 5b ("Same name, same mat").
//
// Run with DATABASE_URL set to the database to check. The test branch:
//   node scripts/check-mat-name-keys.mjs
// Production (Noe runs this himself), which is refused unless the host is named:
//   node scripts/check-mat-name-keys.mjs --expect-host ep-bold-wave
// It reads every club's mats with row security switched off for its own read-only transaction
// (app.bypass_rls), and prints the endpoint host it reached (never the URL) and the database user.
// Prints the count and, per mat: club id, mat id, name (non-ASCII as code points, so invisible ones show), stored key and
// expected key. Exit 0 when none differ, 1 when some do, 2 when it could not run.
import { pathToFileURL } from "node:url";
import { resolveDbTarget, TargetRefused } from "./readiness/db-target.mjs";

// The same steps as lib/mats.ts (cleanMatName, then matNameKey). Kept in step by tests/unit/check-mat-name-keys.test.ts.
const INVISIBLE_FORMATTING = /[\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const keptInKey = (cp) => (cp >= 0xfe00 && cp <= 0xfe0d) || (cp >= 0xe0100 && cp <= 0xe01ef) || (cp >= 0xe0000 && cp <= 0xe007f);
export function matNameKey(raw) {
  const clean = raw.normalize("NFC").replace(INVISIBLE_FORMATTING, "").replace(/\s+/g, " ").trim();
  let out = "";
  for (const ch of clean) if (!DEFAULT_IGNORABLE.test(ch) || keptInKey(ch.codePointAt(0) ?? 0)) out += ch;
  return out.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The database the script may read, vetted as scripts/erase-closed-club.mjs vets its target
 * (scripts/readiness/db-target.mjs resolveDbTarget: the effective host the way pg resolves it, with PGHOST,
 * PGHOSTADDR, PGOPTIONS and the host=, hostaddr=, options= and endpoint= overrides refused). With no
 * --expect-host it reads only the test branch, and anything naming production is refused outright; production
 * needs --expect-host ep-bold-wave. Returns the effective host (never the URL); throws TargetRefused.
 */
export function checkTarget(url, argv) {
  const i = argv.indexOf("--expect-host");
  const expectHost = i >= 0 ? argv[i + 1] : null;
  if (!expectHost && String(url).toLowerCase().includes("ep-bold-wave")) {
    throw new TargetRefused("REFUSED: this is production (ep-bold-wave). Run it with --expect-host ep-bold-wave if that is meant.");
  }
  return resolveDbTarget(url, { expectHost: expectHost ?? "ep-hidden-salad", allowProduction: true });
}

/** A name as printed: every character outside printable ASCII as its code point, so invisible ones show. */
const BACKSLASH = String.fromCharCode(92);
export const shown = (s) => [...s].map((ch) => { const cp = ch.codePointAt(0); return cp < 0x20 || cp > 0x7e ? `${BACKSLASH}u{${cp.toString(16)}}` : ch; }).join("");

/** The mats whose stored key differs from the key their name gives now. */
export function mismatches(rows) {
  return rows.filter((m) => m.nameKey !== matNameKey(m.name)).map((m) => ({ ...m, expected: matNameKey(m.name) }));
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }
  let endpoint;
  try {
    endpoint = checkTarget(url, process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // A read-only transaction: the database itself refuses any write. Row security is switched off for this
    // transaction only (set_config local), or every club's mats would read as none.
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
    const who = (await client.query("SELECT current_user AS u")).rows[0].u;
    console.log(`endpoint ${endpoint}; database user ${who}`);
    const { rows } = await client.query(`SELECT "tenantId", "id", "name", "nameKey" FROM "Mat" ORDER BY "tenantId", "sortOrder", "id"`);
    await client.query("COMMIT");
    const bad = mismatches(rows);
    console.log(`${rows.length} mats checked; ${bad.length} with a stored key that differs from matNameKey(name).`);
    for (const m of bad) console.log(`club ${m.tenantId} mat ${m.id} name "${shown(m.name)}" stored "${shown(m.nameKey)}" expected "${shown(m.expected)}"`);
    process.exitCode = bad.length > 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`Could not check: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
