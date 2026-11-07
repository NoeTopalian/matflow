// READ-ONLY. Lists mats whose stored name key is not what lib/mats.ts matNameKey gives for their name today.
//
// Why: from 7 Nov 2026 a mat's key also drops default-ignorable characters (a soft hyphen, a zero-width joiner),
// so "Mat<soft hyphen>1" keys as "mat1". A mat saved before then with such a character keeps its old key, and a
// new "Mat1" would not be recognised as the same mat. This script only reports; it changes nothing. A listed mat
// is put right by renaming it in the Mats sheet (a rename stores the key afresh).
//
// Run with DATABASE_URL set to the database to check (the test branch; Noe runs it on production himself):
//   node scripts/check-mat-name-keys.mjs
// Prints the count and, per mat: club id, mat id, name (non-ASCII as code points, so invisible ones show), stored key and
// expected key. Exit 0 when none differ, 1 when some do, 2 when it could not run.
import { pathToFileURL } from "node:url";

// The same steps as lib/mats.ts (cleanMatName, then matNameKey). Kept in step by tests/unit/check-mat-name-keys.test.ts.
const INVISIBLE_FORMATTING = /[\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
export function matNameKey(raw) {
  const clean = raw.normalize("NFC").replace(INVISIBLE_FORMATTING, "").replace(/\s+/g, " ").trim();
  return clean.replace(/\p{Default_Ignorable_Code_Point}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
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
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // A read-only transaction: the database itself refuses any write.
    await client.query("BEGIN READ ONLY");
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
