/**
 * Operator (super-admin) email + password + mandatory TOTP login.
 *
 * The shared MATFLOW_ADMIN_SECRET is development/test only — lib/admin-auth.ts.
 *
 * Per-operator account in the `Operator` table: email/password, MANDATORY TOTP
 * (6 Oct 2026), sessionVersion revocation, bcrypt lockout, real audit identity.
 *
 * Three signed tokens, three HMAC domains, three cookies — none verifies as
 * another:
 *
 *   matflow_op_session   FULL operator session, minted only after a valid TOTP
 *                        code. HMAC over "operator-session.mfa.v2.<payload>".
 *                        Path=/, 8 h. The only token the operator gates accept.
 *   matflow_op_challenge Between password and code for an ENROLLED operator.
 *                        HMAC over "operator-totp.<payload>". Path=/api/admin/auth, 5 min.
 *   matflow_op_enrol     Password-verified operator with NO authenticator yet.
 *                        HMAC over "operator-enrol.v1.<payload>". Path=/api/admin/auth,
 *                        15 min. Accepted ONLY by operator-totp/setup (and logout).
 *
 *   payload = <operatorId>.<sessionVersion>.<expiryUnixMs>; signature hex.
 *
 * Sessions minted before 6 Oct 2026 were signed over the bare payload and may
 * never have seen a code; the domain change makes every one of them fail
 * verification, so the deploy itself signs every operator out.
 *
 * Validity of a full session: HMAC, expiry, sessionVersion equal to the DB, and
 * the operator still has TOTP enabled.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { verifySync } from "otplib";
import { prisma } from "@/lib/prisma";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

export const OP_SESSION_COOKIE = "matflow_op_session";
export const OP_TOTP_CHALLENGE_COOKIE = "matflow_op_challenge";
export const OP_ENROL_COOKIE = "matflow_op_enrol";
/**
 * HMAC domain of a full (MFA-verified) operator session. proxy.ts verifies the
 * same tokens at the edge and carries a copy of this string; the hardening
 * test pins the two together.
 */
export const OP_SESSION_HMAC_DOMAIN = "operator-session.mfa.v2.";
const OP_CHALLENGE_HMAC_DOMAIN = "operator-totp.";
const OP_ENROL_HMAC_DOMAIN = "operator-enrol.v1.";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const TOTP_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ENROL_TTL_MS = 15 * 60 * 1000; // 15 minutes
const FAILED_LOGIN_LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const HMAC_HEX_RE = /^[a-f0-9]{64}$/i;

// Real bcrypt hash, cost 12. The value is intentionally not a secret; it keeps
// the missing-email path close to the real-user path without creating a DB row.
// Cracking it grants nothing: it is only ever the "expected" in a compare whose
// result is discarded when the operator row is absent (anti-enumeration timing).
// nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash
const PLACEHOLDER_HASH = "$2b$12$1WwUbW83tfNH39.ZB3jd1eAARDFo4d4w2BpCDf4CUI.ax/GkTzP7C";

// ── Session token (HMAC-signed) ──────────────────────────────────────────────

function hmac(payload: string): string {
  return createHmac("sha256", AUTH_SECRET_VALUE).update(payload).digest("hex");
}

function timingSafeHexEqual(actual: string, expected: string): boolean {
  if (!HMAC_HEX_RE.test(actual) || !HMAC_HEX_RE.test(expected)) return false;
  if (actual.length !== expected.length) return false;

  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (actualBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function issueToken(domain: string, operatorId: string, sessionVersion: number, ttlMs: number): string {
  const exp = Date.now() + ttlMs;
  const payload = `${operatorId}.${sessionVersion}.${exp}`;
  return `${payload}.${hmac(`${domain}${payload}`)}`;
}

function verifyToken(domain: string, cookieValue: string): VerifiedOperatorSession | null {
  const parts = cookieValue.split(".");
  if (parts.length !== 4) return null;
  const [id, ver, exp, sig] = parts;
  if (!id || !ver || !exp || !sig) return null;

  const expectedSig = hmac(`${domain}${id}.${ver}.${exp}`);
  if (!timingSafeHexEqual(sig, expectedSig)) return null;

  const expMs = Number(exp);
  if (!Number.isSafeInteger(expMs) || expMs <= Date.now()) return null;

  const sessionVersion = Number(ver);
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) return null;

  return { operatorId: id, sessionVersion };
}

/**
 * Mint a FULL operator session. Call ONLY after a valid TOTP code has been
 * accepted for this operator (operator-totp, or the end of enrolment).
 */
export function issueOperatorSession(operatorId: string, sessionVersion: number): string {
  return issueToken(OP_SESSION_HMAC_DOMAIN, operatorId, sessionVersion, SESSION_TTL_MS);
}

export function issueOperatorTotpChallenge(operatorId: string, sessionVersion: number): string {
  return issueToken(OP_CHALLENGE_HMAC_DOMAIN, operatorId, sessionVersion, TOTP_CHALLENGE_TTL_MS);
}

/** Password verified, no authenticator enrolled: good for operator-totp/setup only. */
export function issueOperatorEnrolmentSession(operatorId: string, sessionVersion: number): string {
  return issueToken(OP_ENROL_HMAC_DOMAIN, operatorId, sessionVersion, ENROL_TTL_MS);
}

export type VerifiedOperatorSession = {
  operatorId: string;
  sessionVersion: number;
};

/** Verify a FULL session's HMAC + expiry. Returns null on any failure. */
export function verifyOperatorSession(cookieValue: string): VerifiedOperatorSession | null {
  return verifyToken(OP_SESSION_HMAC_DOMAIN, cookieValue);
}

export function verifyOperatorTotpChallenge(cookieValue: string): VerifiedOperatorSession | null {
  return verifyToken(OP_CHALLENGE_HMAC_DOMAIN, cookieValue);
}

export function verifyOperatorEnrolmentSession(cookieValue: string): VerifiedOperatorSession | null {
  return verifyToken(OP_ENROL_HMAC_DOMAIN, cookieValue);
}

// ── Cookie response headers ──────────────────────────────────────────────────

export function operatorCookieSetHeaderValue(token: string): string {
  return [
    `${OP_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
    `Max-Age=${SESSION_TTL_MS / 1000}`,
  ].join("; ");
}

export function operatorCookieSetHeaders(token: string): Record<string, string> {
  return { "Set-Cookie": operatorCookieSetHeaderValue(token) };
}

export function operatorCookieClearHeaderValue(): string {
  return [
    `${OP_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
    "Max-Age=0",
  ].join("; ");
}

export function operatorCookieClearHeaders(): Record<string, string> {
  return { "Set-Cookie": operatorCookieClearHeaderValue() };
}

export function operatorTotpChallengeCookieSetHeaderValue(token: string): string {
  return [
    `${OP_TOTP_CHALLENGE_COOKIE}=${token}`,
    "Path=/api/admin/auth",
    "HttpOnly",
    "SameSite=Strict",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
    `Max-Age=${TOTP_CHALLENGE_TTL_MS / 1000}`,
  ].join("; ");
}

export function operatorTotpChallengeCookieClearHeaderValue(): string {
  return [
    `${OP_TOTP_CHALLENGE_COOKIE}=`,
    "Path=/api/admin/auth",
    "HttpOnly",
    "SameSite=Strict",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
    "Max-Age=0",
  ].join("; ");
}

export function operatorEnrolmentCookieSetHeaderValue(token: string): string {
  return [
    `${OP_ENROL_COOKIE}=${token}`,
    "Path=/api/admin/auth",
    "HttpOnly",
    "SameSite=Strict",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
    `Max-Age=${ENROL_TTL_MS / 1000}`,
  ].join("; ");
}

export function operatorEnrolmentCookieClearHeaderValue(): string {
  return [
    `${OP_ENROL_COOKIE}=`,
    "Path=/api/admin/auth",
    "HttpOnly",
    "SameSite=Strict",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
    "Max-Age=0",
  ].join("; ");
}

// ── Single-use TOTP ──────────────────────────────────────────────────────────

/**
 * Verify an operator's TOTP code and spend it.
 *
 * The code must be valid AND from a time-step later than the last one accepted
 * for this operator; the step is recorded with a CONDITIONAL update, so two
 * instances racing the same code cannot both win. Every operator code path —
 * sign-in, enrolment, step-up — goes through here, so a code observed once
 * (shoulder-surfed, phished, logged) cannot be replayed anywhere.
 */
export async function consumeOperatorTotp(
  operator: { id: string; totpSecret: string; totpLastUsedStep: number | null },
  code: string,
): Promise<boolean> {
  const result = verifySync({
    token: code,
    secret: operator.totpSecret,
    ...(operator.totpLastUsedStep !== null ? { afterTimeStep: operator.totpLastUsedStep } : {}),
  });
  if (!result.valid) return false;
  const step = (result as { timeStep?: number }).timeStep;
  if (typeof step !== "number" || !Number.isSafeInteger(step)) return false;
  const spent = await prisma.operator.updateMany({
    where: {
      id: operator.id,
      OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }],
    },
    data: { totpLastUsedStep: step },
  });
  return spent.count === 1;
}

/** SHA-256 hex, for storing nonces without storing the nonce. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ── Login helpers ────────────────────────────────────────────────────────────

export type LoginAttemptResult =
  | { ok: true; operator: { id: string; email: string; name: string; sessionVersion: number; totpEnabled: boolean } }
  | { ok: false; reason: "invalid" | "locked" };

/**
 * Verify operator credentials. Always runs bcrypt against a placeholder hash
 * if the email isn't found — equalises timing to prevent enumeration.
 *
 * Side effects on the Operator row:
 *   - on success: failedLoginCount → 0, lockedUntil → null, lastLoginAt → now
 *   - on bcrypt mismatch: failedLoginCount += 1; if >= threshold, lockedUntil set
 *
 * The session cookie is NOT issued here — caller does that after this returns ok.
 */
export async function attemptOperatorLogin(email: string, password: string): Promise<LoginAttemptResult> {
  const op = await prisma.operator.findUnique({
    where: { email: email.toLowerCase().trim() },
    select: {
      id: true, email: true, name: true, passwordHash: true,
      sessionVersion: true, totpEnabled: true,
      failedLoginCount: true, lockedUntil: true,
    },
  });

  if (!op) {
    await bcrypt.compare(password, PLACEHOLDER_HASH).catch(() => false);
    return { ok: false, reason: "invalid" };
  }

  // Audit iter-1-auth-boundary AH-6: ALWAYS run bcrypt before checking the
  // lockout state, so the locked-path response time is indistinguishable
  // from the not-locked-path. The previous implementation returned at line
  // 199 before bcrypt, leaking lock state via timing (~1ms vs ~250ms).
  const valid = await bcrypt.compare(password, op.passwordHash).catch(() => false);
  const isLocked = !!(op.lockedUntil && op.lockedUntil > new Date());

  if (isLocked) {
    // Drop the bcrypt result regardless — we don't want to grant access while
    // locked even if the password is correct.
    return { ok: false, reason: "locked" };
  }

  if (!valid) {
    const newCount = op.failedLoginCount + 1;
    const lockoutThresholdHit = newCount >= FAILED_LOGIN_LOCKOUT_THRESHOLD;
    // Audit iter-1-auth-boundary AH-7: on lock, reset failedLoginCount to 0
    // so the post-TTL window starts with a fresh attempt budget. The previous
    // implementation persisted `newCount`, meaning one failed attempt after
    // lock expiry re-locked immediately (permadenial vector). Mirrors the
    // User-side pattern at auth.ts:227.
    await prisma.operator.update({
      where: { id: op.id },
      data: lockoutThresholdHit
        ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) }
        : { failedLoginCount: newCount },
    });
    return { ok: false, reason: "invalid" };
  }

  // Password is correct. Audit iter-1-auth-boundary AH-11: DO NOT reset
  // failedLoginCount here when totpEnabled — the reset belongs in
  // completeOperatorLogin (after TOTP also succeeds). Without this guard, an
  // attacker who knows the password but not the TOTP code could attempt
  // login indefinitely: every cycle reset the brute-force counter at this
  // point, so the lockout never triggered. For non-TOTP operators the
  // immediate completeOperatorLogin call by the caller still resets cleanly.
  if (!op.totpEnabled) {
    await prisma.operator.update({
      where: { id: op.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  }

  return {
    ok: true,
    operator: {
      id: op.id,
      email: op.email,
      name: op.name,
      sessionVersion: op.sessionVersion,
      totpEnabled: op.totpEnabled,
    },
  };
}

export async function completeOperatorLogin(operatorId: string) {
  return await prisma.operator.update({
    where: { id: operatorId },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    },
    select: {
      id: true,
      email: true,
      name: true,
      sessionVersion: true,
      totpEnabled: true,
    },
  });
}

/**
 * Resolve the operator from a FULL session cookie value. Returns null if the
 * cookie is missing, invalid, expired, of another kind (challenge, enrolment,
 * pre-hardening), its sessionVersion no longer matches the DB, or the operator
 * no longer has TOTP enabled.
 */
export async function resolveOperatorFromCookie(cookieValue: string | null | undefined) {
  if (!cookieValue) return null;
  const verified = verifyOperatorSession(cookieValue);
  if (!verified) return null;
  const op = await prisma.operator.findUnique({
    where: { id: verified.operatorId },
    select: { id: true, email: true, name: true, sessionVersion: true, totpEnabled: true },
  });
  if (!op) return null;
  if (op.sessionVersion !== verified.sessionVersion) return null;
  if (op.totpEnabled !== true) return null;
  return { id: op.id, email: op.email, name: op.name, sessionVersion: op.sessionVersion };
}

// ── Enrolment ticket (review finding D3, 6 Oct 2026) ──────────────────────
//
// The password alone used to be enough to enrol an authenticator on an
// operator with none — and `operator-access.mjs recover` creates exactly that
// state. So whoever held (or guessed, or phished) the password in the window
// before the real operator enrolled could pin THEIR device to the operator
// account. Enrolment now also needs a single-use ticket that only the person
// running scripts/operator-access.mjs (direct database credentials) ever sees:
// printed once, stored as SHA-256 with a 30-minute expiry, cleared by the
// conditional update that enables TOTP. Already-enrolled operators never use
// this path.
//
// Format: 32 lowercase hex characters, printed in groups of four joined by
// "-". Input is normalised (case, spaces, dashes) before hashing.
// scripts/operator-access.mjs generates and hashes it the same way — keep the
// two in step (tests/integration/operator-enrolment-ticket-db.test.ts runs the
// real script against the test branch).

export const OPERATOR_ENROLMENT_TICKET_TTL_MS = 30 * 60 * 1000;
/** GET /api/admin/auth/operator-totp/setup carries the ticket here; POST in the body (`ticket`). */
export const OP_ENROLMENT_TICKET_HEADER = "x-matflow-enrolment-ticket";

/** Normalised ticket (32 hex chars) or null if it cannot be one. */
export function normaliseOperatorEnrolmentTicket(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const hex = raw.toLowerCase().replace(/[\s-]/g, "");
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null;
}

/** SHA-256 of the normalised ticket, or null if malformed. */
export function hashOperatorEnrolmentTicket(raw: unknown): string | null {
  const n = normaliseOperatorEnrolmentTicket(raw);
  return n ? sha256Hex(n) : null;
}

/** A fresh ticket, its hash and expiry. The ticket itself is never stored. */
export function newOperatorEnrolmentTicket(now: number = Date.now()) {
  const hex = randomBytes(16).toString("hex");
  return {
    ticket: hex.match(/.{4}/g)!.join("-"),
    hash: sha256Hex(hex),
    expiresAt: new Date(now + OPERATOR_ENROLMENT_TICKET_TTL_MS),
  };
}

function enrolmentTicketMatches(
  op: { enrolmentTicketHash: string | null; enrolmentTicketExpiresAt: Date | null },
  ticket: unknown,
): boolean {
  const hash = hashOperatorEnrolmentTicket(ticket);
  if (!hash || !op.enrolmentTicketHash || !op.enrolmentTicketExpiresAt) return false;
  if (op.enrolmentTicketExpiresAt.getTime() <= Date.now()) return false;
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(op.enrolmentTicketHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Resolve an operator from an ENROLMENT cookie value: password verified, no
 * authenticator yet. Null once the operator has enrolled (the token has done
 * its job), on a sessionVersion mismatch, or on any token failure.
 *
 * `access` (review finding D3): `{ ticket }` — the enrolment ticket must also
 * match and be unexpired, or the result is null. `"sign-out-only"` skips the
 * ticket and is ONLY for the logout route, which merely ends the enrolment.
 */
export async function resolveOperatorEnrolment(
  cookieValue: string | null | undefined,
  access: { ticket: unknown } | "sign-out-only",
) {
  if (!cookieValue) return null;
  const verified = verifyOperatorEnrolmentSession(cookieValue);
  if (!verified) return null;
  const op = await prisma.operator.findUnique({
    where: { id: verified.operatorId },
    select: {
      id: true, email: true, name: true, sessionVersion: true, totpEnabled: true,
      enrolmentTicketHash: true, enrolmentTicketExpiresAt: true,
    },
  });
  if (!op) return null;
  if (op.sessionVersion !== verified.sessionVersion) return null;
  if (op.totpEnabled === true) return null;
  if (access !== "sign-out-only" && !enrolmentTicketMatches(op, access.ticket)) return null;
  return { id: op.id, email: op.email, name: op.name, sessionVersion: op.sessionVersion };
}
