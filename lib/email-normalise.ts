import { z } from "zod";

/**
 * Email addresses are stored lowercase, always.
 *
 * The product was already half-committed to this and the halves disagreed,
 * which is the worst of both: **recovery routes normalise on READ while the
 * create paths did not normalise on WRITE.** `magic-link/request`,
 * `auth/forgot-password` and `auth/reset-password` all look up
 * `email.toLowerCase().trim()`. Staff create, staff update and member
 * create/update stored whatever was typed.
 *
 * So a member added as `Noe@example.com` could log in with a password — the
 * credentials lookup used the raw string — and then could never recover the
 * account, because every recovery path searched for `noe@example.com` and found
 * nothing. Both routes answer a deliberate silent 200 to avoid enumerating
 * addresses, so the member saw "if that address exists, we've sent a link" and
 * no email ever arrived. Nothing failed loudly anywhere.
 *
 * Normalising on write makes the two halves agree. `@@unique([tenantId, email])`
 * then means what everyone already assumed it meant.
 *
 * Trim as well as lowercase: a trailing space pasted from a spreadsheet is the
 * other half of this defect, and CSV import is how a club's whole roster
 * arrives.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * `z.string().email()` with the normalisation attached, so a schema cannot
 * accept an address it will then fail to find. Use this instead of a bare
 * `z.string().email()` anywhere an address is STORED.
 *
 * Note the order: zod validates the shape first, then transforms — so
 * " Noe@Example.com " is accepted and stored as "noe@example.com".
 */
export function emailField(max = 254) {
  return z.string().trim().email().max(max).transform(normaliseEmail);
}
