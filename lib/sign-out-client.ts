/**
 * Sign this device out, and only report success once the server has ended the session (Round 8, 16 Nov 2026).
 *
 * next-auth's client `signOut()` redirects to the sign-in page whatever the sign-out request answered, so a sign-out
 * the server refused (lib/session-signout.ts answers 503 when it cannot record it) or a request that never arrived
 * still looked like it had worked. This posts the same Auth.js sign-out (CSRF token included), and navigates only on
 * a 2xx. Anything else — a refusal, a network failure, a lost response — returns false and leaves the person signed
 * in on this page, so the caller can say so. Retrying is safe: the server ignores a session it has already ended.
 */
export const SIGN_OUT_FAILED_MESSAGE = "We couldn't sign you out. Try again.";

export async function signOutThisDevice(callbackUrl = "/login"): Promise<boolean> {
  try {
    const csrfRes = await fetch("/api/auth/csrf", { cache: "no-store", credentials: "same-origin" });
    if (!csrfRes.ok) return false;
    const { csrfToken } = (await csrfRes.json()) as { csrfToken?: unknown };
    if (typeof csrfToken !== "string" || !csrfToken) return false;
    const res = await fetch("/api/auth/signout", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
      body: new URLSearchParams({ csrfToken, callbackUrl }),
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  window.location.assign(callbackUrl);
  return true;
}
