/**
 * MFA policy — which staff roles MUST enrol an authenticator before they can
 * use the dashboard or its API (1 Oct 2026, "owner and admin accounts should
 * have more security than normal accounts").
 *
 * One source for auth.ts (computes `requireTotpSetup` on the token), proxy.ts
 * (page gate) and lib/api-authz.ts (API gate). No imports on purpose: auth.ts
 * and lib/authz.ts both need this and must not pull each other in.
 *
 * Elevated = can see every member's personal data and move money or settings:
 * owner, manager, admin. A coach runs registers and check-ins only, so a
 * second factor stays optional there (the `totpPending` challenge still
 * applies once a coach enrols). Members are unaffected.
 */
export const ELEVATED_ROLES: readonly string[] = ["owner", "manager", "admin"];

export function isElevatedRole(role: string | null | undefined): boolean {
  return typeof role === "string" && ELEVATED_ROLES.includes(role);
}

/**
 * True when this user must be held at /login/totp/setup (pages) or refused
 * with 403 (API) until an authenticator is enrolled. `testingMode` is the
 * existing TESTING_MODE bypass (refused on VERCEL_ENV=production), threaded
 * through so the decision stays a pure function.
 */
export function requiresTotpEnrolment(args: {
  role: string | null | undefined;
  totpEnabled: boolean | null | undefined;
  testingMode: boolean;
}): boolean {
  if (args.testingMode) return false;
  if (!isElevatedRole(args.role)) return false;
  return args.totpEnabled !== true;
}
