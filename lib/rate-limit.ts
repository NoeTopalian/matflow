import { prisma } from "@/lib/prisma";

const memoryStore = new Map<string, { count: number; resetAt: number }>();

async function checkDbRateLimit(
  bucket: string,
  max: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const cutoff = new Date(Date.now() - windowMs);
  // Audit iter-1-infra A7I1-P-2 [Critical]: collapse the 2-query path
  // (count + findFirst-for-resetAt) into ONE aggregate. groupBy returns
  // both the count AND the min(hitAt) in a single round-trip. Saves
  // ~10-30ms per request on Neon's pooler and removes the rate-limiter
  // as a DoS amplifier (an attacker hammering a bucket-exceeded route
  // previously paid the cost of TWO queries to be told "denied").
  const agg = await prisma.rateLimitHit.groupBy({
    by: ["bucket"],
    where: { bucket, hitAt: { gte: cutoff } },
    _count: { _all: true },
    _min: { hitAt: true },
  });
  const row = agg[0];
  const count = row?._count?._all ?? 0;
  if (count >= max) {
    const oldest = row?._min?.hitAt;
    const resetAt = oldest ? oldest.getTime() + windowMs : Date.now() + windowMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) };
  }
  await prisma.rateLimitHit.create({ data: { bucket } });
  if (Math.random() < 0.05) {
    const pruneCutoff = new Date(Date.now() - 60 * 60 * 1000);
    prisma.rateLimitHit.deleteMany({ where: { hitAt: { lt: pruneCutoff } } }).catch(() => {});
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function checkMemoryRateLimit(
  bucket: string,
  max: number,
  windowMs: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const entry = memoryStore.get(bucket);
  if (!entry || now >= entry.resetAt) {
    memoryStore.set(bucket, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (entry.count >= max) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true, retryAfterSeconds: 0 };
}

export async function checkRateLimit(
  bucket: string,
  max: number,
  windowMs: number,
  options?: { failClosed?: boolean },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  let result: { allowed: boolean; retryAfterSeconds: number };
  try {
    result = await checkDbRateLimit(bucket, max, windowMs);
  } catch (err) {
    if (options?.failClosed) throw err;
    result = checkMemoryRateLimit(bucket, max, windowMs);
  }
  // Surface every rate-limit hit so they show up in Vercel logs + Sentry.
  // Without this, attacks against /api/auth/* or /api/apply are silent.
  if (!result.allowed) {
    console.warn(
      `[rate-limit] bucket=${bucket} max=${max} windowMs=${windowMs} ` +
        `retryAfter=${result.retryAfterSeconds}s`,
    );
  }
  return result;
}

export async function resetRateLimit(bucket: string) {
  memoryStore.delete(bucket);
  try {
    await prisma.rateLimitHit.deleteMany({ where: { bucket } });
  } catch { /* ignore */ }
}

/**
 * The client IP, as far as it can be trusted — and the trust order is the
 * whole point of this function.
 *
 * IT USED TO READ `x-forwarded-for` FIRST AND TAKE THE LEADING ENTRY. That
 * header is attacker-controlled: anyone can send `X-Forwarded-For: <random>`
 * on every request and land in a fresh rate-limit bucket each time. Since every
 * IP-keyed limit in this product is keyed on this return value, that made all
 * of them decorative. The consequence that mattered: `admin/auth/login` allows
 * 5 attempts per 15 minutes and is the ONLY brake on brute-forcing
 * MATFLOW_ADMIN_SECRET — a secret that bypasses operator identity, bcrypt,
 * TOTP, lockout and audit attribution. It also let anyone drain the club's
 * email budget through the kiosk waiver request, and made the limiter itself a
 * cheap way to fill the database, since each allowed request inserts a row.
 *
 * Order now, most trustworthy first:
 *  1. `x-vercel-forwarded-for` — set by Vercel's edge, overwritten on the way
 *     in, so a client cannot forge it. This is the real answer in production.
 *  2. `x-real-ip` — also platform-set in this deployment.
 *  3. `x-forwarded-for`, and then only its LAST entry. The list reads
 *     `client, proxy1, proxy2`, so anything a client injects is PREPENDED and
 *     the trusted proxy's value ends up at the end. Taking the last entry means
 *     a spoofed header adds noise the attacker cannot control rather than a
 *     bucket key they choose.
 *
 * "unknown" is still the fallback, and it is shared — which is deliberate. A
 * request that arrives with no proxy headers at all should collide with every
 * other such request rather than get a private allowance.
 */
export function getClientIp(req: Request): string {
  const vercel = req.headers.get("x-vercel-forwarded-for")?.trim();
  if (vercel) return vercel.split(",")[0].trim();

  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;

  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return "unknown";
}
