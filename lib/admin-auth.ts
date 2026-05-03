/**
 * Super-admin gate for /admin/* surfaces.
 *
 * The MATFLOW_ADMIN_SECRET env var is the only credential. Two ways to present it:
 *  - HTTP header `x-admin-secret: <value>` — for scripts/curl (existing pattern)
 *  - HTTP cookie `matflow_admin=<value>` (httpOnly, secure, sameSite=strict) — set by
 *    POST /api/admin/auth/login when an admin types the secret into /admin/login
 *
 * Helpers exported here are used by every /api/admin/* route + the /admin server pages.
 */
import { cookies } from "next/headers";

export const ADMIN_COOKIE = "matflow_admin";
const ADMIN_COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours

export function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
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

/** True if either the header or the cookie holds a valid admin secret. */
export async function isAdminAuthed(req: Request): Promise<boolean> {
  if (checkAdminHeader(req)) return true;
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
  return {
    "Set-Cookie": [
      `${ADMIN_COOKIE}=`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
      "Max-Age=0",
    ].join("; "),
  };
}
