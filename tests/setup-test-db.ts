// Vitest setup file — runs before integration tests.
//
// Hardens production safety: refuses to let integration tests touch the
// production Neon branch by mistake. If TEST_DATABASE_URL is set, mirror it
// into DATABASE_URL so lib/prisma.ts uses the safe URL. If neither is set,
// allow the run to proceed (existing tests use describe.skipIf(!HAS_DB) to
// no-op gracefully — see tests/integration/rls-foundation.test.ts:22).
//
// Why a guard exists at all: .env contains DATABASE_URL pointing at the
// production Neon main branch. Without this gate, an accidental
// `npm run dev` or `npx vitest run tests/integration/` while .env is loaded
// would seed test fixtures into Total BJJ's real data.
//
// DO NOT import from "vitest" in this file. Vitest's setupFiles are loaded
// in a context where `import { vi } from "vitest"` produces the "Vitest
// failed to find the runner" error on every subsequent test file. Keep
// this file env-only; any vi.mock shims belong in individual test files.

import { randomBytes } from "node:crypto";

const PROD_NEON_ENDPOINT = "ep-bold-wave-abt39t7x";

// node-postgres applies PGOPTIONS (and PGHOST / PGHOSTADDR when a field is empty) from the environment, so an inherited
// PGOPTIONS=endpoint=<production id> could route a TEST URL to production without touching it. Refused outright, as
// scripts/readiness/db-target.mjs does (patch 0003; mirrored here in lane E3 after review R2).
for (const k of ["PGOPTIONS", "PGHOST", "PGHOSTADDR"]) {
  if (process.env[k]) {
    throw new Error(`${k} is set in the environment; node-postgres would apply it to the test database connection. Unset it before running the tests.`);
  }
}

const testUrl = process.env.TEST_DATABASE_URL;

if (testUrl) {
  if (testUrl.toLowerCase().includes(PROD_NEON_ENDPOINT)) {
    throw new Error(
      `TEST_DATABASE_URL points at the production Neon project (${PROD_NEON_ENDPOINT}). ` +
      `Integration tests must run against a Neon branch, not main. ` +
      `Provision one via neonctl branches create or the Neon console; see tests/integration/README.md.`
    );
  }
  // Mirror to DATABASE_URL so lib/prisma.ts picks up the safe URL.
  process.env.DATABASE_URL = testUrl;
} else if (process.env.DATABASE_URL?.toLowerCase().includes(PROD_NEON_ENDPOINT)) {
  // The user has DATABASE_URL=production set (e.g. from .env) but no
  // TEST_DATABASE_URL override. Strip DATABASE_URL so integration tests
  // skip via their describe.skipIf(!HAS_DB) guards rather than touching prod.
  // Unit tests that don't read DATABASE_URL are unaffected.
  delete process.env.DATABASE_URL;
}

// SF-102 (review R4; lane F3): the guarded TEST runners set neither NEXTAUTH_SECRET nor AUTH_SECRET, so every keyed
// digest a database suite computed (import provenance, login-email digests, card tokens …) was an HMAC with an EMPTY
// key and proved nothing about key secrecy. A database run with neither set gets a synthetic, random 64-hex
// AUTH_SECRET for this process (never committed, never printed) and one line saying so; a configured secret is never
// touched; a run without a test database (the plain unit suite) is left alone so unit cells about a missing secret
// keep their meaning. An empty NEXTAUTH_SECRET is removed, because lib/auth-secret.ts reads it first with "??".
// R6-N6 (lane A4): a BLANK value (empty or whitespace only) counts as unset here exactly as it now does in
// lib/auth-secret.ts, and a blank NEXTAUTH_SECRET is removed even when AUTH_SECRET is set — before, the removal ran
// only when both were empty, so NEXTAUTH_SECRET="" next to a real AUTH_SECRET left the run signing with "".
const blankSecret = (v: string | undefined) => v === undefined || v.trim() === "";
if (process.env.TEST_DATABASE_URL && blankSecret(process.env.NEXTAUTH_SECRET) && !blankSecret(process.env.AUTH_SECRET)) {
  delete process.env.NEXTAUTH_SECRET;
}
if (process.env.TEST_DATABASE_URL && blankSecret(process.env.NEXTAUTH_SECRET) && blankSecret(process.env.AUTH_SECRET)) {
  delete process.env.NEXTAUTH_SECRET;
  process.env.AUTH_SECRET = randomBytes(32).toString("hex");
  // stderr directly: Vitest swallows console output made by a setup file outside any test.
  process.stderr.write("[setup-test-db] AUTH_SECRET is SYNTHETIC for this test process (neither NEXTAUTH_SECRET nor AUTH_SECRET was set; SF-102)\n");
}

// A module (lane E3: the guard test re-imports this file).
export {};
