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
  let facts;
  try {
    facts = await readDbRole(url);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // An enforcement run that cannot be checked is refused. Otherwise say so and let the suites report the database.
    if (flag === "1") throw new Error(`[db-role-guard] RLS_ENFORCED=1 but the role could not be read: ${reason}`);
    process.stderr.write(`[db-role-guard] role not checked (could not connect): ${reason}\n`);
    return;
  }
  process.stderr.write(`[db-role-guard] ${describeDbRole(facts)}; RLS_ENFORCED=${flag ?? "unset"}\n`);
  const mismatch = dbRoleMismatch(facts, flag);
  if (mismatch) throw new Error(`[db-role-guard] refusing this run: ${mismatch}`);
}
