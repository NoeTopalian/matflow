# Audit — Iteration 1, Area 7: Infrastructure config (promoted)

**Date**: 2026-06-01
**Branch**: `audit/loop-fixes-07` (branched from `main` HEAD)
**Scope**: `vercel.json`, `next.config.ts`, `playwright.config.ts`, `.github/workflows/*`, infra `lib/*` (auth-secret, auth-cookie, encryption, env-guards, env-url, audit-log, rate-limit, brand-refresh, email, google-drive), `prisma.config.ts`, `middleware.ts` (= `proxy.ts`), Sentry configs, `tsconfig.json`, `.env.example`, `.gitignore`, `package.json`, `package-lock.json`, `prisma/seed.ts`.
**Method**: 3 OMC subagents in parallel.

## Convergence summary

| Agent | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security | 0 | 4 | 6 | 4 |
| Verifier | 2 | 3 | 3 | 3 |
| Perf | 2 | 4 | 4 | 2 |

**Deduplicated NEW Critical**: 4.
**Deduplicated NEW High**: 8 (after dedup: S-1 == V-4; S-2 == V-2 == P-5).

This is the **infra layer** — controls the WHOLE blast radius. Real PII + real Stripe + real charges go live soon.

---

## NEW Critical findings (must close this iter)

### A7I1-V-1 · Playwright doesn't load `.env.test` — e2e specs hit prod Neon
- **File**: `playwright.config.ts` (entire file, missing dotenv loader)
- **Class**: A04 Insecure Design — DB hazard
- **Description**: `playwright.config.ts` never loads `.env.test`. Two existing e2e specs (`totp-enrolment-flow.spec.ts`, `owner-defer-totp.spec.ts`) load `.env` via a hand-rolled parser — which reads `DATABASE_URL` from the production `.env`. Any developer running `npm run test:e2e` locally mutates real data on the prod Neon branch (TOTP reset, sessionVersion bump). `tests/setup-test-db.ts` only runs under Vitest; Playwright is a separate process.
- **Impact**: Direct production-data corruption hazard. This is THE KEY DELIVERABLE for Area 7 — unblocks per-area e2e for every previous area.
- **Fix**: `playwright.config.ts` calls `dotenv({ path: ".env.test", override: true })` before `process.env` is read. Falls back gracefully if `.env.test` is missing (CI provides via secrets).

### A7I1-V-2 / A7I1-S-2 / A7I1-P-5 · Vercel cron schedule violates Hobby plan limits
- **File**: `vercel.json:8-11`
- **Class**: A05 Security Misconfiguration + cron overhead
- **Description**: Health-warm cron `*/4 * * * *` requests 360 fires/day. Vercel Hobby: max 1 fire/day per cron. Either silently throttled (warm-up ineffective) or causes plan violation. Also useless on Hobby — no instance affinity, so each fire is its own cold start.
- **Impact**: Hobby plan violation; wastes one of two cron slots; provides zero warm-up benefit.
- **Fix**: Remove the `/api/health?warm=1` cron entry. Only the monthly-reports cron remains (within Hobby limits).

### A7I1-P-1 · `lib/encryption.ts` derives SHA-256 key on EVERY encrypt/decrypt call
- **File**: `lib/encryption.ts:8-10`
- **Class**: Cold-start cost (hot-path CPU waste)
- **Description**: `getKey()` runs `createHash("sha256").update(AUTH_SECRET_VALUE).digest()` per invocation. Secret never changes within process lifetime. Hot paths (Google Drive token decrypt per-request) allocate a new Buffer each time.
- **Fix**: Compute `KEY` once at module load. Also add `import "server-only"` so a client component accidentally transitively importing this file is a build-time error (A7I1-S-13 defence-in-depth).

### A7I1-P-2 · `lib/rate-limit.ts` issues 2 sequential DB queries on rate-limit denial
- **File**: `lib/rate-limit.ts:11-14`
- **Class**: Rate-limit DB cost / DoS amplifier
- **Description**: `count(*)` then `findFirst` to compute `resetAt` — two sequential Neon round-trips per rate-limit-exceeded request. An attacker hammering `/api/auth/*` triggers BOTH queries on every request after the bucket fills — the rate-limiter itself amplifies the DoS.
- **Fix**: Collapse to ONE `groupBy` aggregate that returns count + min(hitAt) in a single round-trip.

---

## NEW High findings (must close this iter)

### A7I1-S-1 / A7I1-V-4 · GitHub Actions pinned to floating tag, not commit SHA
- **File**: `.github/workflows/ci.yml:29,31`
- **Class**: A08 Software & Data Integrity (supply chain)
- **Description**: `actions/checkout@v4`, `actions/setup-node@v4` — floating major tags. Compromised upstream + force-push = malicious code in CI with full repo access. Realistic threat (tj-actions/changed-files 2024 incident).
- **Fix**: Pin to commit SHA with semver comment for grep + Dependabot. `actions/checkout@11bd71...683 # v4.2.2`, `actions/setup-node@1d817b...b35 # v4.2.0`.

### A7I1-S-3 · Sentry edge config missing PII scrubber
- **File**: `sentry.edge.config.ts:5-10`
- **Class**: A09 Logging + A02 Crypto Failures (sensitive data exposure)
- **Description**: Server + client Sentry configs strip `cookie`, `email`, `username`. Edge does NOT. Edge middleware sees admin cookies — the `matflow_admin` cookie value IS the MATFLOW_ADMIN_SECRET. A thrown error ships the raw secret to Sentry → Sentry team / Sentry breach yields super-admin access.
- **Fix**: Mirror the server/client `beforeSend` scrubber on `sentry.edge.config.ts`.

### A7I1-S-4 · `constantTimeEq` leaks length via early return (lib + proxy.ts duplicate)
- **File**: `lib/admin-auth.ts:27-32`, `proxy.ts:80-85`
- **Class**: A07 Auth Failures (timing side-channel)
- **Description**: Both implementations return `false` immediately on `a.length !== b.length` — leaks the expected length via response-time. Narrows MATFLOW_ADMIN_SECRET brute-force from `charset^N` to `charset×N`.
- **Fix**: Hash both inputs to fixed-length SHA-256 digest BEFORE comparison. Node side: `createHash("sha256")` + `timingSafeEqual`. Edge side: `crypto.subtle.digest("SHA-256", ...)` + manual constant-time XOR over 32-byte digests. Both equal-length by construction.

### A7I1-P-3 · `lib/email.ts` instantiates Resend per send
- **File**: `lib/email.ts:306`
- **Class**: Cold-start cost
- **Description**: `new Resend(apiKey)` inside `sendEmail()` runs on every call. SDK constructor initialises HTTP client + validates key format. Key is build-time constant.
- **Fix**: Module-level `resendClient = process.env.RESEND_API_KEY ? new Resend(...) : null`; sendEmail uses the cached instance; null-check replaces the prior `if (!apiKey)` branch.

### A7I1-P-4 · `EmailLog` bounce-check query needs composite index
- **File**: `lib/email.ts:257-268` + `prisma/schema.prisma`
- **Class**: Missing index
- **Description**: `emailLog.findFirst` with 30-day lookback filtered by `(tenantId, recipient, status, createdAt)` runs before EVERY send. No covering composite index — falls back to seq-scan at scale.
- **Fix**: Add `@@index([tenantId, recipient, status, createdAt])` via Prisma schema. Deferred to Area 8 (Database) since it's a schema migration — Area 8 is the next area and will consolidate all schema/index changes; documented in `M-A7I1-perf` for Area 8 to absorb.

### A7I1-P-6 · `.env.example` DATABASE_URL missing pgbouncer params
- **File**: `.env.example:15`
- **Class**: Connection pool
- **Description**: A developer copying the example value to Vercel production bypasses the pooler. The runtime warning in `lib/prisma.ts:30-37` is the only guard.
- **Fix**: Default the example to `…?sslmode=require&pgbouncer=true&connection_limit=1`.

### A7I1-V-3 · 12+ env-vars used in code missing from `.env.example`
- **File**: `.env.example`
- **Class**: A05 Misconfiguration
- **Description**: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `BLOB_READ_WRITE_TOKEN`, `ANTHROPIC_API_KEY`, `RESEND_FROM`, `RESEND_WEBHOOK_SECRET`, `GOOGLE_REDIRECT_URI`, `MATFLOW_APPLICATIONS_TO`, `CRON_SECRET` — all referenced in code, absent from example. New contributor onboarding will hit silent failures.
- **Fix**: Add documented placeholders for every missing var. Mark Vercel-injected ones (`VERCEL_URL`, `NEXT_PUBLIC_VERCEL_URL`) as "do not set manually".

### A7I1-V-5 · Vitest in CI runs with `continue-on-error: true` — no gating
- **File**: `.github/workflows/ci.yml:50-52`
- **Class**: A08 Integrity (CI defensive posture)
- **Description**: ~99 baseline failures (RB-001 mock migration) mean turning off `continue-on-error` would block every PR. Deferred to Area 9 (Tests final QA sweep) since RB-001 is the root cause and Area 9 owns the test-harness fix.
- **Status**: BACKLOG — Area 9 work, NOT Area 7. Flagged here for chain-of-custody.

---

## Backlog (Medium/Low — append to docs/audit/backlog-*.md)

**Medium (M-A7I1-*)**:
- S-5: Rate-limit memory fallback per-instance only (`lib/rate-limit.ts`)
- S-6: `.env.test` contains real Neon test-branch credentials on disk
- S-7: `TESTING_MODE=true` honoured on Vercel preview deployments
- S-8: `ANTHROPIC_API_KEY`/`RESEND_FROM` missing from `lib/env-guards.ts`
- S-9: Password reset OTP logged in dev mode without NODE_ENV guard on the log line
- S-10: `CRON_SECRET` verification uses `!==` not constant-time
- P-7: `next.config.ts` missing explicit `Cache-Control: public, immutable` for `/_next/static`
- P-8: Rate-limit memory fallback is per-instance (Vercel serverless) — documented vs enforced
- P-9: Monthly-reports cron iterates tenants sequentially — `Promise.allSettled` chunks recommended
- P-10: Playwright `workers: 1` on CI nullifies `fullyParallel`
- V-6: `db-backup.yml` uses deprecated `apt-key add`
- V-7: No backup restore test — `pg_restore --list` dry-run recommended
- V-8: `.env.test` doesn't reference `RESTRICTED_DATABASE_URL` in `.env.test.example`

**Low (L-A7I1-*)**:
- S-11: Vitest non-gating duplicate of V-5 — same backlog item
- S-12: `RESEND_API_KEY` listed as commented-out in `.env.example` despite being `error`-severity in env-guards (fixed inline as part of V-3)
- S-13: Encryption + token-hash share `AUTH_SECRET` without HKDF domain separation
- S-14: `package.json` uses caret ranges (lockfile mitigates)
- P-11: `ts-node` vs `tsx` in seed script
- P-12: `lib/encryption.ts` + `lib/auth-secret.ts` missing `server-only` guard (P-1 fix adds it for encryption.ts; auth-secret.ts deferred)
- V-9: ✓ **Fixed inline** — seed.ts owner name `Noe Romero` → `Demo Owner` (M3-3 deferred Critical from Area 3 backlog finally landed)
- V-10: CLAUDE.md says Next.js 15 but package.json shows 16
- V-11: Personal-name echo in test comment

---

## Batch plan

**Batch A — Critical (all 4)**:
- A7I1-V-1: `playwright.config.ts` loads `.env.test`
- A7I1-V-2/S-2/P-5: Remove warm-ping cron from `vercel.json`
- A7I1-P-1: `lib/encryption.ts` cache KEY at module load + `server-only`
- A7I1-P-2: `lib/rate-limit.ts` collapse to single `groupBy` aggregate

**Batch B — High (8)**:
- A7I1-S-1/V-4: GHA SHA-pin in `ci.yml`
- A7I1-S-3: Sentry edge `beforeSend` scrubber
- A7I1-S-4: `constantTimeEq` hash-first (both `lib/admin-auth.ts` + `proxy.ts`)
- A7I1-P-3: `lib/email.ts` module-level cached Resend client
- A7I1-P-6: `.env.example` DATABASE_URL with pgbouncer params
- A7I1-V-3: Add 12+ missing env vars to `.env.example`
- A7I1-V-9/M3-3: `prisma/seed.ts` `Noe Romero` → `Demo Owner`
- A7I1-V-5: defer to Area 9 (Tests final QA sweep)
- A7I1-P-4: defer to Area 8 (Database) — schema/index migration

---

## Status

iter-1 = 4 Critical + 8 High. Batch A + Batch B (minus V-5 and P-4 — both deferred to subsequent areas) applied. Static gates run next. iter-2 audit will confirm closures + scan for new issues.
