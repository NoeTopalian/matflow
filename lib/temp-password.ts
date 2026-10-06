/**
 * Temporary passwords expire (operator audit 5 Oct 2026 Q5; lane A for operator
 * resets, lane B for passwords an owner sets for staff).
 *
 * A password chosen by someone else — the operator's force-password-reset, or
 * an owner creating a staff member / resetting their password — is temporary
 * (`User.mustChangePassword`) AND now has a deadline (`User.tempPasswordExpiresAt`).
 * auth.ts refuses it after the deadline (code temp_password_expired) and
 * /api/auth/set-password refuses and clears it. NULL means "no deadline
 * recorded" (rows written before 6 Oct 2026) — those expire at
 * LEGACY_TEMP_PASSWORD_DEADLINE below.
 */
export const TEMP_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

export function tempPasswordExpiresAt(now: number = Date.now()): Date {
  return new Date(now + TEMP_PASSWORD_TTL_MS);
}

/**
 * Review finding D2 (6 Oct 2026): a temporary password written before the
 * expiry column existed (`mustChangePassword` true, `tempPasswordExpiresAt`
 * NULL) used to never expire. Such a row is now treated as expiring at this
 * fixed deadline.
 *
 * The date is NOE'S DECISION. It applies to Sean's outstanding bootstrap
 * password (Total BJJ); after it, the operator issues a new temporary password
 * (force-password-reset, which records its own 72-hour expiry). Change it only
 * on Noe's say-so.
 */
export const LEGACY_TEMP_PASSWORD_DEADLINE = new Date("2026-10-20T23:59:59Z");

type TempPasswordRow = { mustChangePassword: boolean | null | undefined; tempPasswordExpiresAt: Date | null | undefined };

/** The deadline in force for a temporary password, or null if the password is not temporary. */
export function effectiveTempPasswordExpiry(row: TempPasswordRow): Date | null {
  if (row.mustChangePassword !== true) return null;
  return row.tempPasswordExpiresAt instanceof Date ? row.tempPasswordExpiresAt : LEGACY_TEMP_PASSWORD_DEADLINE;
}

/** True when the row holds a temporary password whose deadline has passed. */
export function isTempPasswordExpired(row: TempPasswordRow, now: number = Date.now()): boolean {
  const expiry = effectiveTempPasswordExpiry(row);
  return expiry !== null && expiry.getTime() <= now;
}
