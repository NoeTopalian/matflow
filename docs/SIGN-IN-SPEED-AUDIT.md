# Sign-in speed audit (Sprint 4-A US-404)

**Date:** 2026-04-29
**Scope:** `auth.ts` Credentials provider + login page tenant fetch.

## Findings

### Win 1 — Sequential rate-limit checks → parallel
**Before:** `await checkRateLimit(ipRl)` then `await checkRateLimit(rl)` — two sequential round-trips to the DB-backed sliding-window store, ~10-25ms each.
**After:** `Promise.all([…])` — one round-trip wall-clock.
**Saved:** ~10-25ms per login.

### Win 2 — User + Member lookups parallelised
**Before:** `findUnique` on User, then conditionally `findUnique` on Member. The common case (member portal logins) always paid 2 sequential queries.
**After:** Both queries run in parallel. Adds one extra query for staff logins (rare path); saves a roundtrip on every member login.
**Saved:** ~30-80ms on the member-login hot path (Neon over the public internet typically takes 30-60ms per single-row lookup).

### No-op — bcrypt.compare
Already runs on `DUMMY_HASH` when neither user nor member is found, preventing email-enumeration via timing differences. This is correct behaviour; the cost (~80-120ms with bcrypt cost 12) is intentional and cannot be parallelised without leaking timing information.

### No-op — login page tenant fetch
Sprint 1 LOGIN-1 already added AbortController + last-write-wins to the branding fetch from `/api/tenant/[slug]`. No additional latency to capture there.

## Net expected improvement

P50 latency on member login: **~40-100ms reduction**, primarily from Win 2.

Realistic floor: bcrypt (~100ms) + 1× DB roundtrip (~50ms) + JWT encode (~5ms) ≈ 155ms minimum on Neon. Pre-fix this was ~205-280ms; post-fix ~155-180ms.

## Not measured (out of scope)

- DNS / TLS handshake costs to Neon
- Cold-start cost of the serverless function (separate problem)
- Front-end render time after redirect
