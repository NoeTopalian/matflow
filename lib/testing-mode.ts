/**
 * TESTING_MODE bypasses mandatory 2FA (TOTP) enforcement (Fix 4) for local
 * dev and Vercel preview deployments. Read at runtime so tests can flip the
 * env var per case. Real production NEVER honours it — see the runtime guard
 * in auth.ts which forbids the bypass on `VERCEL_ENV=production`.
 *
 * Vercel sets VERCEL_ENV to "production", "preview", or "development".
 * Locally VERCEL_ENV is unset. We allow the bypass on every value EXCEPT
 * "production" so feature-branch previews can be tested friction-free.
 */
/**
 * The production Neon endpoint. Mirrors the identical guard already used by
 * tests/setup-test-db.ts, scripts/maybe-migrate.mjs and
 * scripts/backfill-invoice-payment-ids.mjs — same constant, same purpose.
 */
const PROD_NEON_ENDPOINT = "ep-bold-wave-abt39t7x";

/** True when this process is pointed at the production database, whatever it calls itself. */
export function isProductionDatabase(): boolean {
  return (process.env.DATABASE_URL ?? "").includes(PROD_NEON_ENDPOINT);
}

export function isTestingMode(): boolean {
  if (process.env.TESTING_MODE !== "true") return false;
  // Real production NEVER honours TESTING_MODE.
  if (process.env.VERCEL_ENV === "production") return false;
  // Nor does anything pointed at the production DATABASE, whatever VERCEL_ENV
  // says. Preview deployments run with VERCEL_ENV=preview and legitimately
  // honour TESTING_MODE, so a preview whose DATABASE_URL is scoped to the
  // production branch would otherwise be a 2FA-free door into real member data
  // on a URL that is not treated as production. Environment names are a
  // convention; the connection string is the fact.
  if (isProductionDatabase()) return false;
  // Honour on Vercel preview, Vercel dev, and local dev (VERCEL_ENV unset).
  return true;
}
