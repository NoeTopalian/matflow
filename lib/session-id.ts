import { createHash, randomBytes } from "node:crypto";

/**
 * Session identity (Round 8, 16 Nov 2026).
 *
 * A session id (`sid`) names ONE sign-in. It is minted when someone proves who they are — a password or Google
 * sign-in (auth.ts jwt(), user branch), a magic link (app/api/magic-link/verify), or the start of a support session in
 * a clean browser (the carrier, app/api/admin/impersonate) — and every later re-issue of that token keeps it: Auth.js
 * re-encodes the same token object, and the routes that re-encode by hand spread the decoded token. Nothing else may
 * mint one (tests/unit/session-id-minting.test.ts pins the call sites). That is what makes "sign out" end this
 * session and nothing else: the sign-out route records the sid (lib/session-signout.ts), the revocation check refuses
 * it on every request (lib/session-revocation.ts), and other devices hold other sids.
 */

/** The session cookie's lifetime. Every re-issue slides it forward by this much (Auth.js `session.maxAge`). */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * How long a token may stay "awaiting revalidation" (auth.ts, SF-44) before it is ended. Such a token is still
 * re-issued — its expiry slides — although no check has run, so this bound is part of the retention arithmetic below.
 */
export const REVALIDATE_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * How long a revocation record must be kept: until no token of that session can still be valid.
 *
 * After the record is written, the revocation check refuses the sid, so the only re-issues that can still happen are:
 *   1. requests already past the check when the record landed — their token expires within SESSION_MAX_AGE of the
 *      sign-out (plus the request's own duration, minutes at most);
 *   2. a token presented while the database cannot answer (SF-44): kept and re-issued without a check, but only for
 *      REVALIDATE_MAX_MS after the first failed check, and only starting from a token that was itself still valid —
 *      so its expiry can reach sign-out + SESSION_MAX_AGE + REVALIDATE_MAX_MS + SESSION_MAX_AGE.
 * One day on top covers request durations and clock skew. 30 + 1 + 30 + 1 = 62 days. Deleting a record any sooner
 * could hand a still-valid copy its session back; keeping it any longer protects nothing.
 */
export const REVOKED_SESSION_RETENTION_MS =
  2 * SESSION_MAX_AGE_SECONDS * 1000 + REVALIDATE_MAX_MS + 24 * 60 * 60 * 1000;

const SID_PATTERN = /^[A-Za-z0-9_-]{22,80}$/;

/** A fresh, unguessable session id (128 random bits, base64url). Only the sign-in paths call this. */
export function newSessionId(): string {
  return randomBytes(16).toString("base64url");
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SID_PATTERN.test(value);
}

/**
 * The id of the session this token belongs to, or null when it cannot have one.
 *
 * Tokens minted before session ids existed carry none. They cannot be told apart from one another — every claim in
 * them is re-written on each re-issue — so they get one id PER PERSON, derived from who they are: the same input on
 * every copy and every server, so no copy can ever be given a different, unrevoked id (a random one here would let a
 * delayed response mint an identity that escapes the sign-out). Signing out on one such device therefore ends that
 * person's other pre-release devices too; sessions signed in after the release have their own random ids and are not
 * touched. The derived id is a hash, so the revocation table holds no person identifier.
 *
 * A pre-release token in the middle of a support session has no own identity to derive from (its id is the person
 * being supported), so it gets none: auth.ts ends it and the operator starts support again.
 */
export function sessionIdOf(token: Record<string, unknown>): string | null {
  if (isSessionId(token.sid)) return token.sid;
  if (token.supportCarrier === true || token.impersonatorClaims || token.impersonatedBy) return null;
  const subject =
    typeof token.memberId === "string" && token.memberId
      ? `m:${token.memberId}`
      : typeof token.id === "string" && token.id
        ? `u:${token.id}`
        : null;
  if (!subject) return null;
  return `legacy-${createHash("sha256").update(`matflow-legacy-session:${subject}`).digest("base64url")}`;
}
