/**
 * TOTP self-disable guard.
 *
 * Once `totpEnabled === true` on a User or Member, the only paths that may
 * flip it back to false are the dedicated reset routes:
 *   - User:   POST /api/admin/customers/[id]/totp-reset            (operator only)
 *   - Member: POST /api/admin/customers/[id]/member-totp-reset     (operator)
 *   - Member: POST /api/members/[id]/totp-reset                    (staff)
 *
 * Every other PATCH/PUT/POST endpoint that spreads request-body fields into a
 * Prisma update on User or Member must run `stripTotpFields()` defensively, so
 * a body like `{ totpEnabled: false, totpSecret: null, totpRecoveryCodes: null }`
 * cannot bypass the security floor.
 */

const TOTP_FIELDS = ["totpEnabled", "totpSecret", "totpRecoveryCodes"] as const;

/**
 * Returns a shallow copy of `body` with the three TOTP fields removed.
 * Use on every PATCH/PUT body before forwarding to Prisma.
 */
export function stripTotpFields<T extends Record<string, unknown>>(body: T): Omit<T, (typeof TOTP_FIELDS)[number]> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if ((TOTP_FIELDS as readonly string[]).includes(key)) continue;
    out[key] = body[key];
  }
  return out as Omit<T, (typeof TOTP_FIELDS)[number]>;
}

/**
 * Throws if `body` contains any TOTP field. Use at request-validation time
 * when you want a hard 400 instead of a silent strip.
 */
export function assertNoTotpFields(body: Record<string, unknown>): void {
  const found = TOTP_FIELDS.filter((f) => f in body);
  if (found.length > 0) {
    throw new Error(`TOTP fields are immutable via this route: ${found.join(", ")}`);
  }
}
