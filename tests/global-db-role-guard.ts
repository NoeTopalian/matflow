// Vitest global setup: once per run, before any test file. Refuses a database run whose RLS_ENFORCED flag does not
// match the role actually connected (tests/db-role-guard.mjs explains why). A run with no database is left alone.
import { readDbRole, dbRoleMismatch, describeDbRole } from "./db-role-guard.mjs";

const PROD_NEON_ENDPOINT = "ep-bold-wave";

export default async function setup(): Promise<void> {
  // The same precedence as tests/setup-test-db.ts: TEST_DATABASE_URL wins and is mirrored to DATABASE_URL there.
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  // No database: the DB suites skip. Production: setup-test-db.ts refuses or strips it; this never connects to it.
  if (!url || url.toLowerCase().includes(PROD_NEON_ENDPOINT)) return;

  const flag = process.env.RLS_ENFORCED;
  // A run whose role cannot be read is refused whatever the flag says: letting it through is how a restricted run
  // without RLS_ENFORCED=1 would slip past (review of PR #109, F1). One retry covers a cold database.
  let facts;
  try {
    facts = await readDbRole(url);
  } catch (first) {
    if (first instanceof Error && first.message.startsWith("refusing:")) throw new Error(`[db-role-guard] ${first.message}`);
    try {
      facts = await readDbRole(url);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`[db-role-guard] refusing this run: a database URL is set but the connected role could not be read (${reason}). Unset the URL to run without a database.`);
    }
  }
  process.stderr.write(`[db-role-guard] ${describeDbRole(facts)}; RLS_ENFORCED=${flag ?? "unset"}\n`);
  const mismatch = dbRoleMismatch(facts, flag);
  if (mismatch) throw new Error(`[db-role-guard] refusing this run: ${mismatch}`);
}
