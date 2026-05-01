# Rate Limiting

> **Status:** ✅ Working · DB-backed sliding window with in-memory fallback · 5% probabilistic prune on writes · single `checkRateLimit()` API used everywhere.

## Purpose

Stop bad behaviour without going down: brute-force login attempts, scraped member data, spammed apply submissions, double-tapped purchase buttons, runaway client retries. Without per-bucket rate limiting, a single stuck client could bring the platform to its knees, and a single stolen credential could exfiltrate the whole member roster.

## Design

Sliding window, two-tier fallback:

1. **Primary**: DB table `RateLimitHit` — durable, multi-instance safe (works when Vercel runs N concurrent serverless functions)
2. **Fallback**: in-memory `Map` — used only when the DB call throws

The fallback exists because rate-limiting must NEVER cause a 500. Better to permit a few requests during a DB blip than crash the whole route.

## Data model

```prisma
model RateLimitHit {
  id     String   @id @default(cuid())
  bucket String                          // "login:alice@example.com" or "apply:1.2.3.4"
  hitAt  DateTime @default(now())

  @@index([bucket, hitAt])
}
```

`(bucket, hitAt)` index makes the count + oldest-hit queries cheap.

## API — `checkRateLimit(bucket, max, windowMs)`

[lib/rate-limit.ts](../lib/rate-limit.ts):

```ts
export async function checkRateLimit(
  bucket: string,
  max: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  try {
    return await checkDbRateLimit(bucket, max, windowMs);
  } catch {
    return checkMemoryRateLimit(bucket, max, windowMs);
  }
}
```

### DB path

```ts
const cutoff = new Date(Date.now() - windowMs);
const count = await prisma.rateLimitHit.count({
  where: { bucket, hitAt: { gte: cutoff } },
});
if (count >= max) {
  const oldest = await prisma.rateLimitHit.findFirst({
    where: { bucket, hitAt: { gte: cutoff } },
    orderBy: { hitAt: "asc" },
  });
  const resetAt = oldest ? oldest.hitAt.getTime() + windowMs : Date.now() + windowMs;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)) };
}
await prisma.rateLimitHit.create({ data: { bucket } });

// Probabilistic prune — 5% chance per write to delete rows older than 1h
if (Math.random() < 0.05) {
  const pruneCutoff = new Date(Date.now() - 60 * 60 * 1000);
  prisma.rateLimitHit.deleteMany({ where: { hitAt: { lt: pruneCutoff } } }).catch(() => {});
}
return { allowed: true, retryAfterSeconds: 0 };
```

The 5% prune amortises cleanup over write traffic — at ~1000 writes/hour, the table self-tidies without a dedicated cron. The 1-hour cutoff is long enough that any active window sees correct counts.

### In-memory path

```ts
const memoryStore = new Map<string, { count: number; resetAt: number }>();

function checkMemoryRateLimit(bucket, max, windowMs) {
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
```

Per-process Map — won't share across Vercel function instances. Acceptable as a fallback because:

1. DB outage is rare and short
2. The "permitted overage" during the outage is bounded by N-instances × max × windowMs
3. The alternative (failing closed) blocks legitimate users entirely

## Bucket key conventions

The bucket name encodes the actor + resource:

| Bucket pattern | Where used | Limit |
|---|---|---|
| `login:{email}` | login attempts per email | 10 / 15 min |
| `login:ip:{ip}` | login attempts per IP | 30 / 15 min |
| `forgot:{email}` | password reset requests per email | 3 / hour |
| `apply:{ip}` | apply form submissions per IP | 5 / hour |
| `pack:buy:{memberId}` | class pack purchase attempts | 10 / hour |
| `magic:{email}` | magic link sends per email | 5 / hour |
| `invite:{tenantId}` | staff invite sends | 30 / hour |
| `ai_report:{tenantId}` | monthly AI report generation | 5 / 30 days |

Buckets are tenant-scoped where the action is tenant-specific, and actor-scoped (email/memberId/IP) where it's not. Public IP-only buckets are fragile to NAT (whole offices behind one IP), so they're set generously.

## `getClientIp(req)`

```ts
export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() ?? "unknown";
}
```

Vercel always sets these headers. Local dev returns `"unknown"` — buckets like `apply:unknown` collide all dev traffic into one bucket, which is fine.

## Response shape

When the limit is hit:

```ts
return NextResponse.json(
  { error: "Too many ..." },
  { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
);
```

The `Retry-After` header lets well-behaved clients (and some browsers) self-throttle. The number is calculated from the OLDEST hit in the current window, so it's accurate to the second.

## Reset (test-only)

```ts
export async function resetRateLimit(bucket: string) {
  memoryStore.delete(bucket);
  try {
    await prisma.rateLimitHit.deleteMany({ where: { bucket } });
  } catch { /* ignore */ }
}
```

Used in test setup; never called from production code paths. No admin UI to reset a bucket — would be a deliberate add for "I locked myself out".

## Security

| Control | Where |
|---|---|
| Sliding window | More accurate than fixed-window for burst behaviour |
| DB-backed primary | Multi-instance safe |
| In-memory fallback | Never fails closed on DB blips |
| Probabilistic prune | Self-cleaning without cron dependency |
| Tenant-scoped buckets where possible | Cross-tenant DoS isolation |
| Retry-After header | Lets well-behaved clients back off |
| Bucket key length is bounded | Email/IP fit in a varchar |
| No bucket key from raw user input | Always `prefix:{normalized_value}` |

## Known limitations

- **In-memory fallback isn't cluster-aware** — during a DB outage, N Vercel instances each maintain their own `Map`. Real limit is N × configured.
- **Race condition on the count + insert** — between `count()` and `create()`, two concurrent requests can both pass the threshold. Net overage is bounded but not zero.
- **No allowlist** — can't whitelist a known-good IP from rate limits today.
- **No exponential backoff on repeated violations** — `Retry-After` is window-bounded; doesn't grow with persistent abuse.
- **Bucket cardinality unbounded** — buckets like `pack:buy:{memberId}` create one row per active member; acceptable but worth a `take: 100k` sanity cap on the `count()` if traffic ever exploded.
- **Prune is best-effort** — `.catch(() => {})` silently swallows errors. If the DB is partially up enough to count but not delete, table grows unbounded.
- **No per-tenant override** — a high-traffic gym can't request "raise my apply limit to 50/hour" without code change.

## Test coverage

- Unit tests cover both the DB path (mocked Prisma) and the memory path
- Sliding-window + retry-after math tested

## Files

- [lib/rate-limit.ts](../lib/rate-limit.ts) — the whole library
- [prisma/schema.prisma](../prisma/schema.prisma) — `RateLimitHit` model
- See [apply-form.md](apply-form.md), [login-credentials.md](login-credentials.md), [forgot-password.md](forgot-password.md), [magic-link.md](magic-link.md), [member-class-pack-purchase.md](member-class-pack-purchase.md), [ai-monthly-report.md](ai-monthly-report.md)
