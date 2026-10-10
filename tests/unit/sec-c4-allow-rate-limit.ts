/**
 * Test harness for unit files whose Prisma mock does not model the RateLimitHit store (lane C4, 10 Oct 2026).
 *
 * Those files used to reach lib/rate-limit's per-instance MEMORY fallback without knowing it: their fake prisma has
 * no `rateLimitHit` / `$transaction`, the database path threw a TypeError, and the old catch-all fallback allowed
 * the request. Review R6-N3 closed that fallback for security buckets (a store failure is now a refusal), so each
 * of them would see 429. None of them is about rate limiting; this states the assumption they were making — the
 * limiter allows — explicitly, and keeps every other export (getClientIp, resetRateLimit, the lock namespace) real.
 *
 * Usage (inside the test file):
 *   vi.mock("@/lib/rate-limit", async (orig) => (await import("./sec-c4-allow-rate-limit")).allowRateLimit(orig));
 */
type RateLimitModule = typeof import("@/lib/rate-limit");

export async function allowRateLimit(importOriginal: () => Promise<unknown>): Promise<RateLimitModule> {
  const real = (await importOriginal()) as RateLimitModule;
  const allow = async () => ({ allowed: true, retryAfterSeconds: 0 });
  return { ...real, checkRateLimit: allow, checkCronAuthAttempt: allow };
}

/**
 * For a file that DOES exercise a route's limit but whose fake prisma has no RateLimitHit store
 * (tests/integration/security.test.ts F10 relied on the old memory fallback by name): an explicit fixed-window
 * counter per bucket, the semantics that fallback used to supply. Not the production path — that is pinned by
 * sec-c3-rate-limit-atomic, sec-c4-rate-limit-store-failure and the two DB suites.
 */
export async function countingRateLimit(importOriginal: () => Promise<unknown>): Promise<RateLimitModule> {
  const real = (await importOriginal()) as RateLimitModule;
  const windows = new Map<string, { count: number; resetAt: number }>();
  const checkRateLimit: RateLimitModule["checkRateLimit"] = async (bucket, max, windowMs) => {
    const now = Date.now();
    const w = windows.get(bucket);
    if (!w || now >= w.resetAt) {
      windows.set(bucket, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (w.count >= max) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
    w.count++;
    return { allowed: true, retryAfterSeconds: 0 };
  };
  return { ...real, checkRateLimit };
}
