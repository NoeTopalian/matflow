/**
 * Operator (super-admin) email + password login — v1.5 of /admin auth.
 *
 * v1 (still supported as fallback): MATFLOW_ADMIN_SECRET cookie. Shared secret,
 * no per-operator identity, audit log uses SENTINEL_OPERATOR_ID. See
 * lib/admin-auth.ts.
 *
 * v1.5 (this file): per-operator account in the `Operator` table. Email/password
 * authenticated, optional TOTP, sessionVersion-based invalidation, bcrypt-
 * lockout against brute force, real audit identity.
 *
 * Session cookie:
 *   name:   matflow_op_session
 *   value:  <operatorId>.<sessionVersion>.<expiryUnixMs>.<hmac>
 *           where hmac = HMAC-SHA256(AUTH_SECRET_VALUE, "<id>.<sessionVersion>.<exp>")
 *           expressed as hex
 *
 * The cookie value does NOT contain the password or any reversible secret.
 * Forging it requires AUTH_SECRET_VALUE. Validity is enforced by:
 *   - HMAC verification (forgery resistance)
 *   - expiry timestamp (replay window cap)
 *   - sessionVersion match against DB (revocation)
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

export const OP_SESSION_COOKIE = "matflow_op_session";
export const OP_TOTP_CHALLENGE_COOKIE = "matflow_op_challenge";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const TOTP_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FAILED_LOGIN_LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const HMAC_HEX_RE = /^[a-f0-9]{64}$/i;

// Real bcrypt hash, cost 12. The value is intentionally not a secret; it keeps
// the missing-email path close to the real-user path without creating a DB row.
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

export function issueOperatorSession(operatorId: string, sessionVersion: number): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${operatorId}.${sessionVersion}.${exp}`;
  return `${payload}.${hmac(payload)}`;
}

export function issueOperatorTotpChallenge(operatorId: string, sessionVersion: number): string {
  const exp = Date.now() + TOTP_CHALLENGE_TTL_MS;
  const payload = `${operatorId}.${sessionVersion}.${exp}`;
  return `${payload}.${hmac(`operator-totp.${payload}`)}`;
}

export type VerifiedOperatorSession = {
  operatorId: string;
  sessionVersion: number;
};

/** Verify the cookie value's HMAC + expiry. Returns null on any failure. */
export function verifyOperatorSession(cookieValue: string): VerifiedOperatorSession | null {
  const parts = cookieValue.split(".");
  if (parts.length !== 4) return null;
  const [id, ver, exp, sig] = parts;
  if (!id || !ver || !exp || !sig) return null;

  const expectedSig = hmac(`${id}.${ver}.${exp}`);
  if (!timingSafeHexEqual(sig, expectedSig)) return null;

  const expMs = Number(exp);
  if (!Number.isSafeInteger(expMs) || expMs <= Date.now()) return null;

  const sessionVersion = Number(ver);
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) return null;

  return { operatorId: id, sessionVersion };
}

export function verifyOperatorTotpChallenge(cookieValue: string): VerifiedOperatorSession | null {
  const parts = cookieValue.split(".");
  if (parts.length !== 4) return null;
  const [id, ver, exp, sig] = parts;
  if (!id || !ver || !exp || !sig) return null;

  const expectedSig = hmac(`operator-totp.${id}.${ver}.${exp}`);
  if (!timingSafeHexEqual(sig, expectedSig)) return null;

  const expMs = Number(exp);
  if (!Number.isSafeInteger(expMs) || expMs <= Date.now()) return null;

  const sessionVersion = Number(ver);
  if (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0) return null;

  return { operatorId: id, sessionVersion };
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

  // Lockout check
  if (op.lockedUntil && op.lockedUntil > new Date()) {
    return { ok: false, reason: "locked" };
  }

  const valid = await bcrypt.compare(password, op.passwordHash).catch(() => false);
  if (!valid) {
    const newCount = op.failedLoginCount + 1;
    const lockoutThresholdHit = newCount >= FAILED_LOGIN_LOCKOUT_THRESHOLD;
    await prisma.operator.update({
      where: { id: op.id },
      data: {
        failedLoginCount: newCount,
        lockedUntil: lockoutThresholdHit ? new Date(Date.now() + LOCKOUT_DURATION_MS) : op.lockedUntil,
      },
    });
    return { ok: false, reason: "invalid" };
  }

  // Password is correct. Reset brute-force counters here; stamp lastLoginAt
  // only after any required second factor has completed.
  await prisma.operator.update({
    where: { id: op.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

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
 * Resolve the operator from a session cookie value. Returns null if the cookie
 * is missing, invalid, expired, or its sessionVersion no longer matches the DB.
 */
export async function resolveOperatorFromCookie(cookieValue: string | null | undefined) {
  if (!cookieValue) return null;
  const verified = verifyOperatorSession(cookieValue);
  if (!verified) return null;
  const op = await prisma.operator.findUnique({
    where: { id: verified.operatorId },
    select: { id: true, email: true, name: true, sessionVersion: true },
  });
  if (!op) return null;
  if (op.sessionVersion !== verified.sessionVersion) return null;
  return op;
}
