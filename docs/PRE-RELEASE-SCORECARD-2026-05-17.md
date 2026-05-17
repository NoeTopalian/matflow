# Pre-release scorecard — 2026-05-17

Snapshot of what's shipped, what's measured, what's pending, and what's blocked. Generated mid-session after perf rounds 1 + 2 landed.

## Commits shipped this session (chronological)

| SHA | Title | Surface |
|---|---|---|
| `4ccf694` | perf(auth): cache JWT sessionVersion (10 min) + brand refresh 5→30 min + fire-and-forget audit log | NextAuth callback, audit pipeline, brand-refresh cadence |
| `063585a` | perf: skip auth() on self-authed routes, warm Neon, route-level Suspense, narrow Member selects | `proxy.ts` matcher, `vercel.json` cron, dashboard + member `loading.tsx`, members + checkin Member selects |
| `36ce726` | perf(db): add 6 composite indexes on hot tenant-scoped tables | `prisma/schema.prisma` + new migration `20260517000001_add_perf_indexes` |
| `8d1cae5` | feat(admin): add 2FA status card to super-admin dashboard | `/admin` dashboard panel |
| `cb36692` | fix(onboarding): toast when logo upload fails during owner wizard | `OwnerOnboardingWizard.tsx` |
| `37ad337` | docs: pre-release scorecard with perf-2 evidence + user-action queue | This document (initial version) |
| `89de826` | perf(health): drop 3 redundant DB round-trips per warmup ping | `/api/health` no longer wraps `SELECT 1` in `withRlsBypass` transaction |
| `60e4cf0` | perf(infra): pin Vercel functions to lhr1 (London) to colocate with Neon | `vercel.json` `regions: ["lhr1"]` |
| `aefa201` | perf(infra): set preferredRegion=lhr1 in layout + health route | Next.js 15 canonical region pin (belt-and-braces with vercel.json) |

All auto-deployed via Vercel on push to `main`.

## 🚨 Geography finding (2026-05-17 17:13)

`x-vercel-id` on `/api/health` showed `lhr1::iad1::...` — **request hit LHR edge, function ran in IAD (Virginia)**. Neon is in eu-west-2 (London). Every DB round-trip was paying 80-120 ms transatlantic latency on top of normal connection costs.

This dominates the per-request latency picture and is bigger than U1 (pgbouncer) in impact. The region-pin commits (`60e4cf0` + `aefa201`) should move all functions to lhr1, colocating with Neon. Confirm post-deploy that `x-vercel-id` flips to `lhr1::lhr1::...`.

If Neon is actually in a different EU region (eu-west-1 Ireland, eu-central-1 Frankfurt), swap `lhr1` → `dub1` / `fra1`. Within-EU RTT is 10-30 ms either way — vastly better than transatlantic.

## Live perf measurements (post `cb36692` deploy)

Plain `curl`/`Invoke-WebRequest` against production, no auth, sequential warm pings:

| Endpoint | TTFB / Total | Notes |
|---|---|---|
| `/manifest.webmanifest` | 195 ms | ✅ Confirms perf-2 matcher exclusion is live — middleware no longer wraps PWA assets |
| `/login` | 494 ms | ✅ Good for a server-rendered public page |
| `/` (root) | 1,054 ms | ⚠ Slow public marketing page — possibly first-render after deploy |
| `/api/health` ping 1 | 2,289 ms | ❌ First hit after deploy — Neon cold start |
| `/api/health` ping 2 | 1,830 ms | ❌ Still slow on warm function |
| `/api/health` ping 3 | 1,791 ms | ❌ Pattern is stable |
| `/api/health` ping 4 | 1,703 ms | ❌ |
| `/api/health` ping 5 | 1,737 ms | ❌ |

### Diagnosis

`/api/health` runs `withRlsBypass((tx) => tx.$queryRaw\`SELECT 1\`)` and nothing else — it's the cheapest possible DB-touching endpoint. The route is outside middleware (perf-2 matcher exclusion confirmed by the manifest timing). Yet every warm ping takes 1.7–2.3 s.

A `SELECT 1` round-trip from Vercel EU-west to Neon EU-west should be **<200 ms** when the connection is pooled. The 1.5+ s overhead is consistent with **TLS + auth handshake on every request** — i.e. connection pooling is not engaged. That's the exact pathology that `?pgbouncer=true&connection_limit=1` on the Vercel `DATABASE_URL` would prevent.

**Conclusion:** perf-1 + perf-2 code-level changes are working as designed, but their wins are masked by a 500–800 ms per-request connection-setup tax on every DB-touching path.

## User-action queue (blocks further progress)

Ordered by impact. **U1 is the highest-leverage move on the entire roadmap.**

| # | Action | Unblocks | Where |
|---|---|---|---|
| **U1** | **Set `?pgbouncer=true&connection_limit=1` on Vercel production `DATABASE_URL`** | **Full perf-1 + perf-2 impact** | Vercel → MatFlow → Settings → Env Variables → `DATABASE_URL` (Production) |
| U2 | Run `DATABASE_URL=<prod> npx prisma migrate deploy` | Activates the 6 new indexes from `36ce726` | Local shell with prod URL |
| U3 | Connect Stripe Connect on TotalBJJ + flip `memberSelfBilling: true` | F2/F3 (member self-subscribe + parent-pays-for-kid) | TotalBJJ owner dashboard → Settings → Revenue |
| U4 | Seed a parent-with-kid on TotalBJJ | F4 + F6 (kids family panel) visual verification | Family panel on any parent member |
| U5 | Provision Neon test branch + export `TEST_DATABASE_URL` | 96 integration tests that currently can't even execute | Neon dashboard → Branches → New branch from main |

### U1 — the one to do first

1. Vercel → **MatFlow** project → **Settings** → **Environment Variables**
2. Find `DATABASE_URL` for the **Production** environment, click Edit
3. If the value looks like:
   ```
   postgres://user:pwd@ep-xxx.eu-west-2.aws.neon.tech/neondb?sslmode=require
   ```
   change it to:
   ```
   postgres://user:pwd@ep-xxx-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require&pgbouncer=true&connection_limit=1
   ```
   The two changes are:
   - host swap to `-pooler` (Neon's pooled endpoint — grab it from Neon dashboard → Connection → toggle "Pooled connection")
   - append `&pgbouncer=true&connection_limit=1`
4. Save — Vercel auto-redeploys (~2 min)
5. Tell me when done — I'll re-run the `/api/health` ping loop. Expected: TTFB drops to 100–300 ms.

## Phase status

| Phase | State | Notes |
|---|---|---|
| 0. Ship perf-2 | ✅ Done | 2 commits pushed |
| 1. Handle unrelated dirty files | ✅ Done | 2 commits pushed |
| 2. Live latency measurement | ✅ Done | This doc |
| 3. User-action blockers | ⏸ Awaiting U1-U5 | U1 critical |
| 4. Perf round 3 | ⛔ Blocked on U1 | Cache / edge / PWA all sit behind the DB connection cost; measuring them would be noise |
| 5. Test infra | ⛔ Blocked on U5 | Need Neon test branch |
| 6a. Hot-path Playwright sweep | ⛔ Blocked on this session | Edge/Playwright MCP profile lock from a prior session — will run in next session |
| 6b. Full sweep + mobile + reduced-motion | ⛔ Blocked on U1 + Playwright | Same as 6a; also want post-pgbouncer timings in the same pass |
| 7. Sign-off doc | ⛔ Blocked on 6 | Final artifact |

## Code-fixable items closed this session

- ✅ 5 HIGH CSRF gaps (refund, manual payment, logout-all, totp/setup) — `cfaaa01`
- ✅ Backend audit doc (146 routes / ~210 handlers, 0 critical) — `cfaaa01`
- ✅ React #418 hydration warning fix — `d529318`
- ✅ Prisma-tenant passthrough shim across 20 unit tests (148→96 failures) — `edc8bfb` + `d2e9acf`
- ✅ F2/F3 kid-tier validation activated server-side — `12d4b1b`
- ✅ Vitest `fileParallelism: false` makes `npm test` work on Windows — `12d4b1b`
- ✅ Perf round 1 (JWT cache + audit log + brand refresh) — `4ccf694`
- ✅ Perf round 2 (matcher + cron + indexes + Suspense + select) — `063585a` + `36ce726`
- ✅ Super-admin 2FA status card — `8d1cae5`
- ✅ Onboarding logo-upload failure UX — `cb36692`

## Code-fixable items still open

None that aren't waiting on a user-action or Playwright access. The remaining backlog is:

- Mobile 360 / reduced-motion sweep (Phase 6b — needs Playwright)
- Console-error audit per route (Phase 6a/b — needs Playwright)
- Full pre-release sign-off doc (Phase 7 — final artifact)
- Auto-promote kid-to-adult cron (no user demand yet, deferred)
- TeamUp / Glofox / Mindbody CSV import (separate spec, ~2 days)
- Real-money Stripe live testing (needs U3 first)

## Next-action for next session

1. **User completes U1** (pgbouncer) — required before any further perf work
2. **Re-run `/api/health` ping loop** — expect <300 ms TTFB
3. **Re-run Playwright sweep** (Phase 6a + 6b) once Edge profile lock clears or with `--isolated` flag
4. **Decide Phase 4** based on post-pgbouncer numbers:
   - If hot-path p95 is <800 ms → skip Phase 4, go to Phase 7
   - Otherwise pick the highest-leverage subset (`unstable_cache` is easiest first)
5. **Write Phase 7 sign-off** doc

Exit condition for the comprehensive plan: every phase has its verification check passing, every U-item has either been completed or has a clear next-action for the user, and the sign-off doc is committed.
