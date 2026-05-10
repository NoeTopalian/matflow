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

const PROD_NEON_ENDPOINT = "ep-bold-wave-abt39t7x";

const testUrl = process.env.TEST_DATABASE_URL;

if (testUrl) {
  if (testUrl.includes(PROD_NEON_ENDPOINT)) {
    throw new Error(
      `TEST_DATABASE_URL points at the production Neon project (${PROD_NEON_ENDPOINT}). ` +
      `Integration tests must run against a Neon branch, not main. ` +
      `Provision one via neonctl branches create or the Neon console; see tests/integration/README.md.`
    );
  }
  // Mirror to DATABASE_URL so lib/prisma.ts picks up the safe URL.
  process.env.DATABASE_URL = testUrl;
} else if (process.env.DATABASE_URL?.includes(PROD_NEON_ENDPOINT)) {
  // The user has DATABASE_URL=production set (e.g. from .env) but no
  // TEST_DATABASE_URL override. Strip DATABASE_URL so integration tests
  // skip via their describe.skipIf(!HAS_DB) guards rather than touching prod.
  // Unit tests that don't read DATABASE_URL are unaffected.
  delete process.env.DATABASE_URL;
}
