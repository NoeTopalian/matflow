import { prisma } from "@/lib/prisma";

const memoryStore = new Map<string, { count: number; resetAt: number; windowStart: number }>();

/**
 * Advisory-lock namespace for the per-bucket check (ASCII "RLHT"). The
 * two-int4 key space does not overlap the single-bigint one, and the only
 * other two-int4 namespace in the product is lib/login-email.ts ("LGID").
 */
export const RATE_LIMIT_LOCK_NS = 0x524c4854;

/**
 * The shared-database limit, exact under concurrency (security campaign
 * iteration 2, lane C3, 9 Oct 2026 — review R5 §2).
 *
 * IT USED TO COUNT THE WINDOW AND THEN INSERT THE HIT AS TWO SEPARATE
 * STATEMENTS. Every caller in a concurrent burst read the same count before
 * any of them had inserted, so all of them passed: on the TEST branch a burst
 * of 20 parallel calls against max 5 let 10–20 through under both roles
 * (tests/integration/sec-c3-rate-limit-atomic-db.test.ts, red on fe2b645).
 * For an upload or a password guess that is the limit multiplied by however
 * many requests the attacker can keep in flight.
 *
 * Now one transaction of two statements:
 *  1. `pg_advisory_xact_lock(RLHT, hashtext(bucket))` — callers on the same
 *     bucket queue here; different buckets do not (a hash collision only
 *     serialises two unrelated buckets, it never merges their counts). The
 *     lock is TRANSACTION-scoped, so it is safe through Neon's PgBouncer
 *     pooler in transaction mode and is released by COMMIT or ROLLBACK, never
 *     leaked to another client.
 *  2. A single conditional insert: count the window, insert only if the count
 *     is below `max`, and return the count, whether it inserted, and the age
 *     of the oldest hit (for Retry-After) in the same round trip.
 *
 * Why not just the single `INSERT … SELECT … WHERE (SELECT count(*) …) < max`:
 * under READ COMMITTED each statement reads a snapshot taken when it STARTS,
 * so concurrent copies of that statement still cannot see one another's
 * uncommitted rows and the overshoot survives (measured: the same burst lets
 * 10+ through with the lock statement removed — evidence/C3). The lock has to
 * be taken in an EARLIER statement of the same transaction so that the
 * counting statement's snapshot is taken after the previous holder committed.
 *
 * Clock: the window and the stamp both use the database clock in UTC
 * (`statement_timestamp() AT TIME ZONE 'UTC'`, matching how Prisma stores
 * DateTime in this timestamp(3) column), so app/database skew cannot widen or
 * narrow the window.
 *
 * Fast refusal first: an UNLOCKED aggregate (Audit iter-1-infra A7I1-P-2 —
 * count and min(hitAt) in one round trip) refuses a bucket that is already
 * full without taking the lock or opening a transaction. That is sound because
 * a committed hit never un-commits: if the unlocked count already reaches
 * `max`, the locked count would too (give or take hits ageing out in the
 * milliseconds between, i.e. the same as arriving a moment earlier). It keeps
 * the attacker's path — hammering a full bucket — at one query, and stops a
 * burst against a full bucket from queueing on the lock while holding pool
 * connections (5 per instance in production).
 *
 * Cost, in round trips on the pooled connection: refused 1 (unchanged);
 * allowed 5 — the aggregate, then BEGIN, lock, conditional insert, COMMIT —
 * against 2 before (aggregate, insert). Measured on the TEST branch from a
 * high-latency client (~55 ms per round trip, 3 runs × 20 samples): allowed
 * min ~270–290 ms, median 340–580 ms, vs ~100 / 120–140 ms before; refused
 * ~60 ms both. On a same-region pooler that is a few milliseconds. Only
 * callers of the SAME bucket ever wait on each other.
 */
async function checkDbRateLimit(
  bucket: string,
  max: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const cutoff = new Date(Date.now() - windowMs);
  const agg = await prisma.rateLimitHit.groupBy({
    by: ["bucket"],
    where: { bucket, hitAt: { gte: cutoff } },
    _count: { _all: true },
    _min: { hitAt: true },
  });
  const pre = agg[0];
  if ((pre?._count?._all ?? 0) >= max) {
    const oldest = pre?._min?.hitAt;
    const resetAt = oldest ? oldest.getTime() + windowMs : Date.now() + windowMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) };
  }

  const id = `rl_${globalThis.crypto.randomUUID()}`;
  const [, result] = await prisma.$transaction([
    prisma.$executeRaw`SELECT pg_advisory_xact_lock(${RATE_LIMIT_LOCK_NS}::int4, hashtext(${bucket}::text))`,
    prisma.$queryRaw<Array<{ count: number; inserted: number; oldestAgeMs: number | null }>>`
      WITH clock AS (
        SELECT (statement_timestamp() AT TIME ZONE 'UTC') AS t
      ), win AS (
        SELECT count(*)::int AS n, min(h."hitAt") AS oldest
        FROM "RateLimitHit" h, clock
        WHERE h.bucket = ${bucket}::text
          AND h."hitAt" >= clock.t - make_interval(secs => ${windowMs}::float8 / 1000)
      ), ins AS (
        INSERT INTO "RateLimitHit" (id, bucket, "hitAt")
        SELECT ${id}::text, ${bucket}::text, clock.t FROM win, clock
        WHERE win.n < ${max}::int
        RETURNING 1
      )
      SELECT win.n AS "count",
             (SELECT count(*)::int FROM ins) AS "inserted",
             (extract(epoch FROM (clock.t - win.oldest)) * 1000)::float8 AS "oldestAgeMs"
      FROM win, clock`,
  ]);
  const row = result[0];
  if (!row || Number(row.inserted) !== 1) {
    const age = row?.oldestAgeMs;
    const resetInMs = age == null ? windowMs : windowMs - Number(age);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(resetInMs / 1000)) };
  }
  if (Math.random() < 0.05) {
    const pruneCutoff = new Date(Date.now() - 60 * 60 * 1000);
    prisma.rateLimitHit.deleteMany({ where: { hitAt: { lt: pruneCutoff } } }).catch(() => {});
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * What happens when the shared store cannot answer (security campaign
 * iteration 2, lane C4, 10 Oct 2026 — review R6-N3 against SF-40).
 *
 * IT USED TO FALL BACK TO A FRESH PER-INSTANCE MEMORY COUNT ON ANY ERROR, AND
 * SAY NOTHING. The C3 lock makes every allowed-path caller hold a pooled
 * connection while it queues on its bucket, so a burst on ONE bucket is itself
 * enough to exhaust the production pool (5 per instance): the queued callers
 * hit Prisma's transaction-start timeout ("Unable to start a transaction in
 * the given time"), landed here, and the memory store — which had never seen
 * the database's hits — allowed `max` more. R6 measured bursts of 60 and 120
 * against max 5 letting 10 through (5 rows + 5 from memory) under both roles
 * (tests/integration/sec-c4-rate-limit-saturation-db.test.ts, red on 1bad6ee).
 * The attacker controls the saturation, so the limit doubled on demand.
 *
 * Now, on any store failure (pool or transaction-start timeout, unreachable
 * database, anything else):
 *  - `failClosed` callers: the error is rethrown, unchanged — the route
 *    answers 503/500 (their declared contract, tests/unit/sec-f-provider-outage).
 *  - SECURITY buckets (every bucket not listed below): REFUSED, as if over the
 *    limit, with a short Retry-After. Never answered from memory. Every route
 *    behind a limiter needs the same database to do its work, so refusing
 *    costs nothing a healthy store would have given.
 *  - NON-SECURITY buckets (NON_SECURITY_BUCKET_PREFIXES): the memory fallback
 *    survives, but a window this instance did not watch from its start is
 *    seeded FULL — the database may already hold `max` hits for it — so the
 *    fallback can never add capacity. Only once a whole window has passed
 *    inside one continuous outage does memory count from zero (by then every
 *    pre-outage hit has aged out of the window).
 *  - Logged ONCE per window per (class, bucket family) with the reason and how
 *    many failures were folded into the line. The family is the bucket's first
 *    `:`-segment, always a literal at every call site; the key (IP, email,
 *    user, token hash) is never logged.
 */
const NON_SECURITY_BUCKET_PREFIXES = [
  // GET /api/tenant/[slug]: public club branding by slug. Load shedding only —
  // the slug is in every club's public URL and the route reads nothing secret.
  "tenant-lookup:",
  // GET /api/kiosk/[token]/classes: the bucket is keyed by the token's own hash,
  // so it cannot brake guessing (each guess is a fresh bucket); it only sheds a
  // legitimate kiosk's polling.
  "kiosk:classes:",
] as const;

type BucketClass = "security" | "non-security";

function bucketClass(bucket: string): BucketClass {
  return NON_SECURITY_BUCKET_PREFIXES.some((p) => bucket.startsWith(p)) ? "non-security" : "security";
}

function bucketFamily(bucket: string): string {
  const i = bucket.indexOf(":");
  return i > 0 ? bucket.slice(0, i) : "-";
}

/** Retry-After for a refusal caused by a store failure: transient by nature, never longer than the window. */
const STORE_FAILURE_RETRY_AFTER_S = 30;

function storeFailureReason(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const msg = typeof e?.message === "string" ? e.message : "";
  if (
    code === "P2028" ||
    code === "P2024" ||
    /unable to start a transaction|timeout exceeded when trying to connect|timed out fetching a new connection/i.test(msg)
  ) {
    return "pool-timeout";
  }
  if (/^P10(0[0-2]|17)$/.test(code) || /reach database|ECONNREFUSED|ENOTFOUND|connection terminated/i.test(msg)) {
    return "unreachable";
  }
  return "error";
}

/** When this instance first saw the store fail since its last success (null while it answers). */
let storeOutageSince: number | null = null;
const storeFailureLog = new Map<string, { until: number; suppressed: number }>();

function logStoreFailure(cls: BucketClass, bucket: string, windowMs: number, reason: string, outcome: string) {
  const family = bucketFamily(bucket);
  const k = `${cls}|${family}`;
  const now = Date.now();
  const seen = storeFailureLog.get(k);
  if (seen && now < seen.until) {
    seen.suppressed++;
    return;
  }
  console.error(
    `[rate-limit] store unavailable reason=${reason} class=${cls} family=${family} outcome=${outcome} ` +
      `windowMs=${windowMs} suppressedSinceLast=${seen?.suppressed ?? 0}`,
  );
  storeFailureLog.set(k, { until: now + windowMs, suppressed: 0 });
}

function checkMemoryRateLimit(
  bucket: string,
  max: number,
  windowMs: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const since = storeOutageSince ?? now;
  const entry = memoryStore.get(bucket);
  if (!entry || entry.windowStart < since) {
    // A window this instance did not count from its start: the database may
    // already hold `max` hits in it. Full until every pre-outage hit has aged out.
    const fullUntil = since + windowMs;
    if (now < fullUntil) {
      memoryStore.set(bucket, { count: max, resetAt: fullUntil, windowStart: since });
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((fullUntil - now) / 1000)) };
    }
    memoryStore.set(bucket, { count: 1, resetAt: now + windowMs, windowStart: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (now >= entry.resetAt) {
    memoryStore.set(bucket, { count: 1, resetAt: now + windowMs, windowStart: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (entry.count >= max) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
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
    storeOutageSince = null;
  } catch (err) {
    storeOutageSince ??= Date.now();
    const cls = bucketClass(bucket);
    const reason = storeFailureReason(err);
    if (options?.failClosed) {
      logStoreFailure(cls, bucket, windowMs, reason, "thrown");
      throw err;
    }
    if (cls === "security") {
      logStoreFailure(cls, bucket, windowMs, reason, "refused");
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.min(STORE_FAILURE_RETRY_AFTER_S, Math.ceil(windowMs / 1000))),
      };
    }
    // The store-failure line stands for any refusal the memory store gives
    // here; the per-call warning below is for database answers only.
    logStoreFailure(cls, bucket, windowMs, reason, "memory-fallback");
    return checkMemoryRateLimit(bucket, max, windowMs);
  }
  // Surface every rate-limit hit so they show up in Vercel logs + Sentry.
  // Without this, attacks against /api/auth/* or /api/apply are silent.
  // SF-120 (lane M1, 10 Oct 2026): the FAMILY only, never the bucket — the key
  // after the family is an e-mail address, an IP, a user id or a token hash.
  if (!result.allowed) {
    console.warn(
      `[rate-limit] over-limit family=${bucketFamily(bucket)} max=${max} windowMs=${windowMs} ` +
        `retryAfter=${result.retryAfterSeconds}s`,
    );
  }
  return result;
}

/**
 * The brake on guessing CRON_SECRET.
 *
 * The four `/api/cron/*` routes authenticate on a bearer token and nothing
 * else, and until now there was no limit of any kind on how many times that
 * token could be guessed — the constant-time comparison closed the timing
 * channel but left the attempt count unbounded, which on a 64-character secret
 * is academic and on a short one is not. Every other credential door in the
 * product (operator login, member login, the kiosk lookup) has a bucket.
 *
 * Only FAILED attempts spend the budget, so the scheduler — which presents a
 * valid bearer and is the only legitimate caller — can never be throttled,
 * however often Vercel runs it. The window is generous on purpose: the point
 * is to make an offline-scale guessing run impossible, not to police a
 * mistyped secret.
 */
const CRON_AUTH_MAX = 30;
const CRON_AUTH_WINDOW_MS = 15 * 60 * 1000;

export async function checkCronAuthAttempt(
  req: Request,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  return checkRateLimit(`cron:auth:${getClientIp(req)}`, CRON_AUTH_MAX, CRON_AUTH_WINDOW_MS);
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
