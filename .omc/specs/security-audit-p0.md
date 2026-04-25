# Security Audit — P0 Remediation Spec

## Metadata
- Type: brownfield security hardening
- Generated: 2026-04-19
- Source: AI Remediation Brief + SaaS Assurance Playbook + codebase deep-scan
- Final Ambiguity: ~5% (all findings have exact file + line evidence)

## Goal
Fix all P0/High security defects in MatFlow before any further feature work.
Do NOT rewrite working features. Patch surgically. Add tests for each critical fix.

## Constraints
- Next.js 16 App Router, TypeScript strict, Prisma/SQLite (local) / Postgres (prod)
- NextAuth v5 JWT sessions
- No external services required for fixes except: remove console.log leaks, add crypto-secure token generation
- Rate limiting: use in-memory Map (no Redis dependency required for MVP; Upstash can be wired later)
- All changes must pass `npm run build` (exit 0) and `npm test` (44+ tests)

## Non-Goals
- Stripe webhook implementation (P1 — needs Stripe account config)
- Database session store migration (P1 — cross-cutting; plan separately)
- Mobile hardening (not applicable — web only)
- Full MFA (P1)

## P0 Findings to Fix

### F1 — CRITICAL: OTP logged to console
- **File:** `app/api/auth/forgot-password/route.ts:47`
- **Issue:** `console.log(\`[MatFlow] Password reset OTP for ${email}: ${token}\`)` — OTP leaked to Vercel/cloud logs
- **Fix:** Remove the console.log entirely. OTP delivery is already handled by the email send above it. If no email provider is configured, log only a sanitized message (no OTP, no email).
- **Test:** Confirm no console.log call with `token` in forgot-password route

### F2 — CRITICAL: Demo backdoor in DB-error catch block
- **File:** `auth.ts:85–108`
- **Issue:** `catch` block fires on ANY DB exception and falls through to hardcoded `password === "password123"` owner credentials for `totalbjj` tenant. DB connection exhaustion → attacker gets owner access.
- **Fix:** Gate the demo fallback on an explicit `DEMO_MODE=true` env var check BEFORE the try/catch. Remove the catch-triggered fallback entirely. The catch block should return `null` (auth failure) on any DB error.
- **Test:** Test that auth returns null when DB throws and DEMO_MODE is not set

### F3 — HIGH: QR check-in memberId not validated against tenant
- **File:** `app/api/checkin/route.ts` (QR path, ~line 37–65)
- **Issue:** `memberId` from request body used directly without verifying it belongs to `resolvedTenantId`. Cross-tenant attendance injection possible.
- **Fix:** After resolving `resolvedTenantId`, add: `const member = await prisma.member.findFirst({ where: { id: resolvedMemberId, tenantId: resolvedTenantId } }); if (!member) return 404`
- **Test:** Test that QR checkin with memberId from different tenant returns 404

### F4 — HIGH: Client-controlled prices in Stripe checkout
- **File:** `app/api/member/checkout/route.ts`
- **Issue:** `items` array (name, price, quantity) taken entirely from client request body with no server-side validation. Price manipulation possible.
- **Fix:** Read product prices from `app/api/member/products/route.ts`'s PRODUCTS array (or a DB table). Validate each requested item's price against the server-side price. If mismatch, return 400. Never trust client-supplied `price`.
- **Test:** Test that checkout with manipulated price returns 400

### F5 — HIGH: Temporary staff password returned in response body
- **File:** `app/api/staff/route.ts:69`
- **Issue:** `temporaryPassword: rawPassword` included in POST response. Visible in browser devtools, APM logs, proxy logs.
- **Fix:** Remove `temporaryPassword` from response. Either (a) email it to the staff member, or (b) return only `{ ...user, mustChangePassword: true }` and implement a forced-change flow. For now: remove from response, log a safe notice that the password was set, and add a `mustChangePassword` flag to User model if not present.
- **Test:** Test that staff creation response does not contain any password field

### F6 — HIGH: `Math.random()` for cryptographic temp password generation
- **File:** `app/api/staff/route.ts:53`
- **Issue:** `Math.random().toString(36).slice(2)` is not cryptographically secure
- **Fix:** Replace with `crypto.randomBytes(16).toString('hex')` + append `Aa1!` for complexity requirement
- **Test:** Covered by F5 test

### F7 — MEDIUM: PII logged in gym application route
- **File:** `app/api/apply/route.ts:12–15`
- **Issue:** Full applicant PII (name, email, phone) logged to stdout → GDPR concern in production
- **Fix:** Remove the `console.log` entirely or replace with `console.log('[MatFlow] New gym application received')` (no PII)
- **Test:** Confirm no PII fields in any console output from apply route

### F8 — MEDIUM: `dashboard/stats` accessible to member role
- **File:** `app/api/dashboard/stats/route.ts`
- **Issue:** Any authenticated user including `member` role can access tenant-wide aggregate stats
- **Fix:** Add role guard: `const allowed = ["owner","manager","admin","coach"].includes(session.user.role); if (!allowed) return 403`
- **Test:** Test that member role returns 403 on stats endpoint

### F9 — MEDIUM: Missing `.env.example`
- **File:** (new file) `.env.example`
- **Issue:** No documentation of required env vars; easy to misconfigure production
- **Fix:** Create `.env.example` with all required vars listed (with placeholder values, not real secrets): `AUTH_SECRET`, `DATABASE_URL`, `NEXTAUTH_URL`, `MATFLOW_ADMIN_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `DEMO_MODE`, plus any email provider vars
- **Test:** File exists and covers all vars referenced in codebase

### F10 — MEDIUM: In-memory rate limiting on forgot-password
- **File:** `app/api/auth/forgot-password/route.ts`
- **Issue:** No rate limiting on OTP endpoint. 6-digit OTP brute-forceable within validity window.
- **Fix:** Add a simple in-memory rate limiter (Map<string, {count, resetAt}>) limiting to 3 requests per email per 15 minutes. Return 429 with `Retry-After` header on excess. Also: increase OTP entropy from 6 digits to a 32-char hex token (use `crypto.randomBytes(16).toString('hex')`), stored as a hash in DB.
- **Test:** Test that 4th request within window returns 429

## Acceptance Criteria
- [ ] `forgot-password/route.ts` has no console.log with token or email
- [ ] `auth.ts` demo fallback is gated on `DEMO_MODE=true` env var, not catch block
- [ ] QR checkin validates memberId belongs to resolved tenant before recording attendance
- [ ] Checkout validates item prices server-side; manipulated prices return 400
- [ ] Staff creation response contains no password field
- [ ] Staff temp password generated with `crypto.randomBytes`
- [ ] `apply/route.ts` logs no PII
- [ ] `dashboard/stats/route.ts` returns 403 for member role
- [ ] `.env.example` exists with all required vars
- [ ] `forgot-password` rate limited to 3 req/email/15min, returns 429 on excess
- [ ] `npm run build` exits 0
- [ ] `npm test` passes all existing tests + new security tests

## Technical Context

### Key files
- `auth.ts` — NextAuth config, demo fallback, JWT callbacks
- `app/api/auth/forgot-password/route.ts` — OTP generation, email send, console.log leak
- `app/api/checkin/route.ts` — QR path ~line 37; authenticated path earlier
- `app/api/member/checkout/route.ts` — Stripe session creation, client prices
- `app/api/member/products/route.ts` — PRODUCTS array (source of truth for prices)
- `app/api/staff/route.ts` — staff creation, Math.random password, response leak
- `app/api/apply/route.ts` — PII log
- `app/api/dashboard/stats/route.ts` — missing role guard
- `.env` — weak AUTH_SECRET (not fixed in code — note in .env.example to rotate)

### Patterns to follow
- Auth check pattern: `const session = await auth(); if (!session?.user) return NextResponse.json({error:'Unauthorized'},{status:401})`
- Role check pattern: `if (!["owner","manager"].includes(session.user.role)) return NextResponse.json({error:'Forbidden'},{status:403})`
- Prisma tenant scope: always `where: { ..., tenantId: session.user.tenantId }`

## Test strategy
- Add tests to `tests/integration/` following existing vitest + vi.mock pattern
- Each P0 fix needs at least one test proving the vulnerability is closed
- Existing 44 tests must continue to pass
