/**
 * Fixed-cost secret comparison, and the bearer presentation built on it.
 *
 * Extracted from `lib/admin-auth.ts` (round 1, defect 3) so the four cron
 * routes can compare `CRON_SECRET` in constant time without importing
 * `lib/admin-auth.ts` — that module pulls `next/headers`,
 * `lib/operator-auth.ts` and Prisma, none of which a cron route needs.
 * `lib/admin-auth.ts` re-exports `constantTimeEq` from here, so there is one
 * implementation rather than two that can drift.
 *
 * Why hash first (carried over from the audit that produced this shape,
 * iter-1-infra A7I1-S-4): `timingSafeEqual` throws on a length mismatch, so the
 * obvious guard is an early `if (a.length !== b.length) return false` — which
 * answers in a different amount of time for a wrong-length candidate than for a
 * right-length one, and so leaks the secret's length. Hashing both inputs to a
 * 32-byte SHA-256 digest first makes every comparison the same fixed length,
 * and a length mismatch costs exactly what a content mismatch costs.
 */
import { createHash, timingSafeEqual } from "crypto";

export function constantTimeEq(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * True when `header` is exactly `Bearer <expected>`.
 *
 * The scheme prefix is matched with a plain comparison on purpose — it is not
 * a secret, and treating it as one would mean hashing the whole header and
 * losing the ability to reject a malformed presentation before the compare.
 * The SECRET is what goes through `constantTimeEq`.
 *
 * An absent header, an empty secret, or a presentation with no `Bearer `
 * prefix are all false, and all cost the same as a wrong secret of the same
 * shape.
 */
export function bearerMatches(header: string | null | undefined, expected: string): boolean {
  if (!expected) return false;
  if (!header) return false;
  const PREFIX = "Bearer ";
  if (!header.startsWith(PREFIX)) return false;
  return constantTimeEq(header.slice(PREFIX.length), expected);
}
