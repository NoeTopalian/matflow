/**
 * Operator (super-admin) gate for /admin/* pages and /api/admin/* routes.
 *
 * WHAT GRANTS OPERATOR AUTHORITY (operator auth hardening, 6 Oct 2026)
 *
 *  1. A named operator session (`matflow_op_session`) that is MFA-VERIFIED:
 *     minted only after a valid authenticator code, either at sign-in
 *     (/api/admin/auth/operator-totp) or at the end of enrolment
 *     (/api/admin/auth/operator-totp/setup). HMAC-signed, 8 h expiry, revoked by
 *     the operator's `sessionVersion` — see lib/operator-auth.ts.
 *
 *  2. In development and test ONLY: the shared `MATFLOW_ADMIN_SECRET`, as the
 *     `x-admin-secret` header or the `matflow_admin` cookie. Local tooling and
 *     the unit suites use it. It grants NOTHING when `sharedAdminSecretPermitted()`
 *     is false — on Vercel production, on any `NODE_ENV=production` build
 *     (Vercel preview and a local `next start` included), and on anything whose
 *     DATABASE_URL is the production database. No environment flag re-opens it:
 *     `ALLOW_ADMIN_SECRET_HEADER` can only close the header further.
 *
 * WHAT DOES NOT
 *  - A password-only operator: an operator with no authenticator gets an
 *    ENROLMENT session (`matflow_op_enrol`, Path=/api/admin/auth, separate HMAC
 *    domain) that the setup route alone accepts. It is never read here.
 *  - The TOTP challenge cookie (`matflow_op_challenge`): its own HMAC domain.
 *  - A session minted before this change: the MFA session HMAC is domain
 *    separated, so every older `matflow_op_session` fails verification and the
 *    operator signs in again with their code.
 *
 * Why the secret is refused rather than flagged: it is an anonymous constant
 * that bypassed operator identity, bcrypt, TOTP, lockout and revocation at once,
 * and the `matflow_admin` cookie value WAS the secret (audit 5 Oct 2026, Q1).
 * Emergency access is a local script run by someone holding database access
 * (docs/runbooks/OPERATOR-ACCESS-RECOVERY.md), never an HTTP door.
 */
import { cookies } from "next/headers";
import { OP_SESSION_COOKIE, resolveOperatorFromCookie } from "@/lib/operator-auth";
import { constantTimeEq } from "@/lib/constant-time";
import { isProductionDatabase } from "@/lib/testing-mode";

export const ADMIN_COOKIE = "matflow_admin";
const ADMIN_COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours

// Audit iter-1-infra A7I1-S-4: hash both inputs first so the comparison is
// strictly fixed-length (32-byte SHA-256 digest). The previous shape
// returned `false` on length mismatch as the first statement, leaking the
// expected length via response-time differences — narrowing brute-force on
// MATFLOW_ADMIN_SECRET from charset^N to charset×N.
//
// The implementation moved to lib/constant-time.ts in round 1 (defect 3) so
// the cron routes could reach it without importing this module's Prisma and
// next/headers graph. Re-exported here because every existing caller and test
// imports it from this path.
export { constantTimeEq };

/**
 * May the shared MATFLOW_ADMIN_SECRET authenticate anything in this process?
 *
 * True only for a development or test process that is not Vercel production
 * and is not pointed at the production database. Deliberately reads NO opt-in
 * flag: a variable that can silently restore anonymous full power is the
 * defect this replaces. proxy.ts mirrors this decision at the edge (it cannot
 * import this module); tests/unit/operator-auth-hardening.test.ts pins the two
 * against each other.
 */
export function sharedAdminSecretPermitted(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.VERCEL_ENV === "production") return false;
  if (isProductionDatabase()) return false;
  return true;
}

/**
 * Is the `x-admin-secret` HEADER door open?
 *
 * Closed whenever `sharedAdminSecretPermitted()` is false — that decision is
 * not overridable. Where the secret is permitted (development/test), the
 * historical `ALLOW_ADMIN_SECRET_HEADER` switch can still close the header:
 * "0" / "false" / "off" / "no" shut it; unset or anything else leaves it open.
 */
export function adminSecretHeaderAllowed(): boolean {
  if (!sharedAdminSecretPermitted()) return false;
  const flag = process.env.ALLOW_ADMIN_SECRET_HEADER;
  if (flag === undefined || flag === "") return true;
  return !["0", "false", "off", "no"].includes(flag.trim().toLowerCase());
}

/** Check a header-supplied admin secret. Returns false on missing env, mismatch, empty, or production. */
export function checkAdminHeader(req: Request): boolean {
  if (!adminSecretHeaderAllowed()) return false;
  const secret = process.env.MATFLOW_ADMIN_SECRET;
  if (!secret) return false;
  const provided = req.headers.get("x-admin-secret");
  if (!provided) return false;
  return constantTimeEq(provided, secret);
}

/** Check the shared-secret cookie. Returns false on missing env, mismatch, no cookie, or production. */
export async function checkAdminCookie(): Promise<boolean> {
  if (!sharedAdminSecretPermitted()) return false;
  const secret = process.env.MATFLOW_ADMIN_SECRET;
  if (!secret) return false;
  const store = await cookies();
  const cookie = store.get(ADMIN_COOKIE)?.value;
  if (!cookie) return false;
  return constantTimeEq(cookie, secret);
}

/**
 * Check the operator-session cookie. True only for a valid, unexpired,
 * unrevoked MFA-verified session of an operator who still has TOTP enabled.
 */
export async function checkOperatorSession(): Promise<boolean> {
  const store = await cookies();
  const value = store.get(OP_SESSION_COOKIE)?.value;
  const op = await resolveOperatorFromCookie(value);
  return op !== null;
}

/** Cookie-only check for server-rendered /admin pages. Headers are for API/scripts. */
export async function isAdminPageAuthed(): Promise<boolean> {
  if (await checkOperatorSession()) return true;
  return await checkAdminCookie();
}

/**
 * True if the request carries operator authority:
 *   - an MFA-verified `matflow_op_session` (every environment), or
 *   - in development/test only, the shared secret as header or cookie.
 */
export async function isAdminAuthed(req: Request): Promise<boolean> {
  if (checkAdminHeader(req)) return true;
  if (await checkOperatorSession()) return true;
  return await checkAdminCookie();
}

/** Set the admin cookie response-side. Call from a route after validating the typed secret. */
export function adminCookieSetHeaders(secret: string): Record<string, string> {
  return {
    "Set-Cookie": [
      `${ADMIN_COOKIE}=${secret}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
      `Max-Age=${ADMIN_COOKIE_MAX_AGE}`,
    ].join("; "),
  };
}

/** Clear the admin cookie. */
export function adminCookieClearHeaders(): Record<string, string> {
  return { "Set-Cookie": adminCookieClearHeaderValue() };
}

export function adminCookieClearHeaderValue(): string {
  return [
    `${ADMIN_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
    "Max-Age=0",
  ].join("; ");
}
