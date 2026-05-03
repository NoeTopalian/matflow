/**
 * TESTING_MODE bypasses mandatory 2FA (TOTP) enforcement (Fix 4) for local dev.
 * Read at runtime so tests can flip the env var per case. Hard-disabled in
 * production — the runtime guard in auth.ts logs a warning and ignores the
 * flag when NODE_ENV=production.
 */
export function isTestingMode(): boolean {
  return process.env.TESTING_MODE === "true" && process.env.NODE_ENV !== "production";
}
