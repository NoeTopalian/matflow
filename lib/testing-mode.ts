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
export function isTestingMode(): boolean {
  if (process.env.TESTING_MODE !== "true") return false;
  // Real production NEVER honours TESTING_MODE.
  if (process.env.VERCEL_ENV === "production") return false;
  // Honour on Vercel preview, Vercel dev, and local dev (VERCEL_ENV unset).
  return true;
}
