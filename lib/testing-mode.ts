/**
 * TESTING_MODE bypasses mandatory 2FA (TOTP) enforcement (Fix 4).
 *
 * ⚠️ Honoured in PRODUCTION too. The deploy-time warning in auth.ts makes
 * this loud at server start. Owners can flip it on in Vercel env to skip 2FA
 * during early-stage testing; unset it before onboarding additional gym
 * owners who would silently lose their 2FA layer.
 *
 * Read at runtime so tests can flip the env var per case.
 */
export function isTestingMode(): boolean {
  return process.env.TESTING_MODE === "true";
}
