/**
 * Canonical NextAuth v5 session-cookie name.
 *
 * Three custom routes hand-roll a JWT cookie write to mutate session state
 * server-side (TOTP enrolment verify, TOTP login second-factor, magic-link
 * verify). They MUST use the same cookie name and encode salt as auth.js's
 * own writes, otherwise the browser stores a parallel cookie that auth.js
 * ignores — silently breaking the mutation.
 *
 * NextAuth v5 default (verified against @auth/core/lib/utils/cookie.js):
 *   - secure context  →  __Secure-authjs.session-token
 *   - non-secure      →  authjs.session-token
 *
 * NOTE: do NOT use the v4 names (`next-auth.session-token`). The migration
 * to NextAuth v5 left those in three places and broke session updates on
 * production for ~2 weeks before the noe-locked-out incident surfaced it.
 */
export const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production"
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";

export const SESSION_COOKIE_SECURE = process.env.NODE_ENV === "production";
