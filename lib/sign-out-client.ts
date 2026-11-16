/**
 * Sign out the session this browser holds, and only report success once the server has ended it (Round 8, 16 Nov
 * 2026). A session signed in after the release ends alone. A pre-release session (no own id) shares its person's
 * derived id, so signing it out also ends that person's other pre-release sessions, never their newer ones
 * (lib/session-id.ts; accepted by Noe 16 Nov 2026).
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
    // Auth.js answers a refused sign-out (e.g. a missing CSRF cookie) with 200 and its error page as the URL.
    const data = (await res.json().catch(() => null)) as { url?: unknown } | null;
    if (data && typeof data.url === "string" && /[?&]error=/.test(data.url)) return false;
  } catch {
    return false;
  }
  window.location.assign(callbackUrl);
  return true;
}
