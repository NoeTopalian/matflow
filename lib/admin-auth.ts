/**
 * Super-admin gate for /admin/* surfaces.
 *
 * Two parallel auth paths are accepted:
 *
 *  v1 — MATFLOW_ADMIN_SECRET (shared secret). Two presentation modes:
 *    - HTTP header `x-admin-secret: <value>` — for scripts/curl
 *    - HTTP cookie `matflow_admin=<value>` (httpOnly, secure, sameSite=strict) —
 *      set by POST /api/admin/auth/login when an admin types the secret into
 *      /admin/login. The cookie value IS the secret. Kept as a bootstrap /
 *      fallback path until v1.5 is fully adopted.
 *
 *  v1.5 — per-operator account session (preferred). Issued by
 *    POST /api/admin/auth/operator-login after bcrypt verify against the
 *    Operator table. Cookie name: matflow_op_session. Value is HMAC-signed
 *    (operatorId.sessionVersion.exp.hmac) — see lib/operator-auth.ts.
 *
 * `isAdminAuthed` accepts EITHER path. Helpers below are used by every
 * /api/admin/* route + the /admin server pages.
 */
import { createHash, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { OP_SESSION_COOKIE, resolveOperatorFromCookie } from "@/lib/operator-auth";

export const ADMIN_COOKIE = "matflow_admin";
const ADMIN_COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours

// Audit iter-1-infra A7I1-S-4: hash both inputs first so the comparison is
// strictly fixed-length (32-byte SHA-256 digest). The previous shape
// returned `false` on length mismatch as the first statement, leaking the
// expected length via response-time differences — narrowing brute-force on
// MATFLOW_ADMIN_SECRET from charset^N to charset×N.
export function constantTimeEq(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/** Check a header-supplied admin secret. Returns false on missing env, mismatch, or empty. */
export function checkAdminHeader(req: Request): boolean {
  const secret = process.env.MATFLOW_ADMIN_SECRET;
  if (!secret) return false;
  const provided = req.headers.get("x-admin-secret");
  if (!provided) return false;
  return constantTimeEq(provided, secret);
}

/** Check the admin cookie. Returns false on missing env, mismatch, or no cookie. */
export async function checkAdminCookie(): Promise<boolean> {
  const secret = process.env.MATFLOW_ADMIN_SECRET;
  if (!secret) return false;
  const store = await cookies();
  const cookie = store.get(ADMIN_COOKIE)?.value;
  if (!cookie) return false;
  return constantTimeEq(cookie, secret);
}

/** Check the operator-session cookie (v1.5 path). Returns false on missing/invalid/expired. */
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
 * True if any of the supported auth paths validates:
 *   - x-admin-secret header (v1)
 *   - matflow_admin cookie (v1)
 *   - matflow_op_session cookie (v1.5 — per-operator)
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
