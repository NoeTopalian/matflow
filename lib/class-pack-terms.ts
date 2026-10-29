/**
 * Class pack terms (owner decision, 27 Oct 2026):
 *
 *   "Class packs: the club chooses an expiry or no expiry per new pack
 *   product. Existing purchases keep their recorded terms and remaining
 *   credits; do not revive expired credits or extend existing purchases
 *   through a blanket never-expire change. Later product edits must not
 *   silently rewrite sold entitlements."
 *
 * A pack PRODUCT (ClassPack) carries `validityDays`: a whole number of days,
 * or null for "Never expires". It is chosen when the product is created and is
 * not edited afterwards (like credits and price).
 *
 * A PURCHASE (MemberClassPack) records its own term once, at sale:
 * `expiresAt = purchasedAt + validityDays`, or null. That recorded value is the
 * entitlement and nothing rewrites it.
 *
 * A purchase is usable when its status is "active", it has credits left, and
 * it has no expiry or an expiry still ahead. The legacy status "expired" is
 * never usable.
 *
 * Pure: imported by client components as well as routes.
 */

/** The longest validity a product may have, in days (the pre-27-Oct range). */
export const PACK_VALIDITY_MAX_DAYS = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The expiry a purchase records at sale: purchasedAt + validityDays, or null for a no-expiry product. */
export function packExpiresAt(purchasedAt: Date, validityDays: number | null | undefined): Date | null {
  if (validityDays === null || validityDays === undefined) return null;
  return new Date(purchasedAt.getTime() + validityDays * DAY_MS);
}

/**
 * Whether a purchase's recorded expiry has passed. A purchase with no expiry
 * never expires: null is not a date in the past (the old member pack list
 * compared `expiresAt < now`, and in JavaScript `null < now` is true).
 */
export function isPackPastExpiry(expiresAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (expiresAt === null || expiresAt === undefined) return false;
  return new Date(expiresAt).getTime() <= now.getTime();
}

/** How a product's validity reads where it is sold: "no expiry" or "valid 90 days". */
export function packValidityLabel(validityDays: number | null | undefined): string {
  if (validityDays === null || validityDays === undefined) return "no expiry";
  return `valid ${validityDays} ${validityDays === 1 ? "day" : "days"}`;
}
