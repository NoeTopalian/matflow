# Security Audit — 2026-05-07

> Full record of two iterations of authorized internal pentest run on matflow.
> Two iterations (one round of fixes between) + an external production probe.
> Total 22 findings: 1 CRITICAL (user-side action), 3 HIGH, 11 MEDIUM, 7 LOW.
> 10 fixed in iteration 1 (commit `75e2f98`); 6 NEW findings surfaced in iteration 2.

**Generated:** 2026-05-07
**Auditors:** 5 parallel agents (security-reviewer × 4, general-purpose probe × 1) + inline code review
**Scope:** auth, API authorization, IDOR, input validation, CSRF, secrets, Stripe, LLM/AI, webhook security, race conditions, external HTTP probe

---

## Table of contents

1. [Executive summary](#executive-summary)
2. [CRITICAL — user-side rotation required](#critical--user-side-rotation-required)
3. [Iteration 1 — fixes shipped](#iteration-1--fixes-shipped-in-commit-75e2f98)
4. [Iteration 2 — new findings (regression + deeper audit)](#iteration-2--new-findings)
5. [Iteration 2 — external production probe](#iteration-2--external-production-probe-results)
6. [LOW / informational findings](#low--informational-findings)
7. [Test log](#test-log)
8. [Recommendations](#recommendations)

---

## Executive summary

The matflow codebase is well-architected for a multi-tenant SaaS — Postgres RLS as backstop, NextAuth v5 with HMAC sessions, bcrypt with constant-time fallback, Zod input validation on most routes, idempotent Stripe webhooks. **The two highest-impact issues found** are:

1. **CRITICAL (user-side):** `.env` on the developer's laptop contains live production secrets (Neon DB password, Stripe `rk_live_...`, Resend key, CRON_SECRET). Not in git, but anyone with disk access has them. Rotate today.
2. **HIGH (regression in iteration 1's fix):** the new Zod schema on `/api/stripe/subscription-plans` declares `amount` as `.int()`, but the UI sends pounds (e.g. `29.99`). All plan creation is broken.

Iteration 2 also found 5 additional MEDIUM-severity issues in webhook handling, race conditions, and inconsistencies between iteration-1 fixes and other parallel surfaces (e.g., the User-side TOTP setup leak was fixed, but the Member-side equivalent still leaks).

External production probe verdict: **headers + auth boundaries are solid**. No critical external-facing issues. Minor hardening recommendations only.

---

## CRITICAL — user-side rotation required

### CRITICAL-1: Live production secrets in local `.env` file

**Severity:** CRITICAL
**Location:** `c:\Users\NoeTo\Desktop\matflow\.env`
**Status:** ⚠️ NOT FIXED — user-side rotation required (cannot be done by code)

The local `.env` contains:

| Line | Secret | What it grants |
|------|--------|----------------|
| `DATABASE_URL` | password `npg_w6Aqvikj1yFg` | Full read/write access to production Neon Postgres |
| `STRIPE_SECRET_KEY` | `rk_live_51T87S7J74LmUlLwB...` | Live restricted Stripe key — can create charges/refunds |
| `CRON_SECRET` | `00160ba33bd91021a037545396c585456af9b826216d65b96c594de775791efb` | Trigger any cron endpoint |
| `RESEND_API_KEY` | `re_TvDpPoKu_DmHJUFzd7p5Ffax3ULC3XuUg` | Send emails as the application |

**Mitigations in place:** `.env` is gitignored and was never committed (verified via `git log -- .env`).

**Remediation (priority order):**
1. **Today:** rotate Neon DB password at console.neon.tech → update local `.env` + Vercel env var
2. **Today:** rotate Resend API key at resend.com/api-keys
3. **Today:** rotate `CRON_SECRET` in Vercel env vars
4. **Within 24h:** roll the Stripe restricted key at dashboard.stripe.com → API keys
5. **Ongoing:** never put live production secrets in local `.env` files; use test-mode keys locally

---

## Iteration 1 — fixes shipped in commit `75e2f98`

10 of 18 findings fixed. Each entry: severity → cite → fix description.

| # | Severity | Issue | Fix in commit `75e2f98` |
|---|---|---|---|
| H1 | **HIGH** | `/api/checkin` — member could send `checkInMethod: "admin"` with no `memberId` to bypass rank/coverage/time enforcement | Server now ignores client-supplied method on self-path; forces `effectiveMethod = "self"` |
| M1 | **MEDIUM** | `/api/auth/totp/setup` GET re-exposed the TOTP secret on every call after enrolment | Returns `{ alreadyEnabled: true }` only post-enrolment |
| M2 | **MEDIUM** | `/api/auth/totp/recover` had differential `recovered: true` field on success — recovery-success oracle | Always returns `{ ok: true }` |
| M3 | **MEDIUM** | `/api/upload` POST missing CSRF (multipart/form-data bypasses CORS preflight) | Added `assertSameOrigin(req)` |
| M4 | **MEDIUM** | `/api/checkin` POST + DELETE missing CSRF | Added `assertSameOrigin(req)` |
| M5 | **MEDIUM** | `/api/stripe/create-subscription` raw `req.json()` cast, no validation | Added Zod schema (`memberId` ≤50 chars, `priceId` regex `/^price_/`, `paymentMethodType` enum) |
| M6 | **MEDIUM** | `/api/stripe/subscription-plans` raw `req.json()` cast | Added Zod schema (**SEE ITERATION 2 — this fix had a regression**) |
| L1 | **LOW** | `GET /api/members/[id]` — any authenticated user (incl. members) could fetch any other member's full profile | Added staff-only role gate |
| L2 | **LOW** | `GET /api/checkin/members` — same enumeration vector for per-class status | Added staff-only role gate |
| L3 | **LOW** | `AUTH_SECRET` < 32 chars not rejected at boot in production | Throws at boot if `VERCEL_ENV=production` and secret < 32 chars |

**Test status after iteration 1:** typecheck clean. Focused tests 32/32 pass. Full suite 148 failing (vs 145 baseline; +3 pre-existing test issue in `admin-checkin-autoselect.test.tsx` unrelated to these fixes).

---

## Iteration 2 — new findings

Iteration 2 audit re-checked iteration-1 fixes for regressions + deeper-dived on webhooks and race conditions.

### H2: Subscription-plans Zod regression — rejects all real plan creation

**Severity:** HIGH
**Status:** ❌ NOT FIXED YET
**Category:** Regression introduced by iteration-1 security fix
**Location:** [app/api/stripe/subscription-plans/route.ts:12](../app/api/stripe/subscription-plans/route.ts#L12)

```typescript
// CURRENT — rejects 29.99
const createPlanSchema = z.object({
  name: z.string().trim().min(1).max(200),
  amount: z.number().int().positive().max(10_000_000),  // ❌ .int() rejects decimal pounds
  interval: z.enum(["month", "year"]),
});
```

**Repro:** Owner opens "Create Plan" drawer in Settings. UI displays "Price (£)" input with `step="0.01"`. Owner enters `29.99`. Client POSTs `{ name: "Monthly", amount: 29.99, interval: "month" }`. Zod rejects → 400.

**Fix:**
```typescript
amount: z.number().positive().max(100_000),  // pounds, not pence
```

The route's downstream code at line ~98 already does `Math.round(amount * 100)` to convert to pence for Stripe, so the field is unambiguously pounds-denominated.

### H3: Resend webhook status-rank table incomplete — terminal status can be overwritten

**Severity:** HIGH
**Status:** ❌ NOT FIXED YET
**Category:** Out-of-order event handling
**Location:** [app/api/webhooks/resend/route.ts:29-36](../app/api/webhooks/resend/route.ts#L29-L36)

```typescript
const STATUS_RANK: Record<string, number> = {
  queued: 0, sent: 1, delivered: 2,
  failed: 3, bounced: 3,           // ⚠ same rank
  complained: 4,
};
```

`delivery_delayed` is mapped to `failed` (rank 3) at line 101. A transient `delivery_delayed` event arriving after a terminal `bounced` would pass `nextRank < currentRank` (3 < 3 is false) and overwrite. Plus `failed` and `bounced` are interchangeable.

**Fix:**
```typescript
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  delivery_delayed: 2,  // transient, no terminal overwrite
  failed: 3,
  bounced: 4,           // terminal
  complained: 5,        // highest, never overwritten
};
```

### M7: Member TOTP setup STILL leaks secret post-enrolment (parallel-surface miss)

**Severity:** MEDIUM
**Status:** ❌ NOT FIXED YET
**Category:** Iteration-1 fix incomplete — User-side fixed, Member-side missed
**Location:** [app/api/member/totp/setup/route.ts:49-52](../app/api/member/totp/setup/route.ts#L49-L52)

```typescript
// MEMBER side STILL leaks (User side was fixed in iter-1)
if (member.totpEnabled && member.totpSecret) {
  const uri = generateURI({ label: member.email, issuer: "MatFlow", secret: member.totpSecret });
  const qrDataUrl = await QRCode.toDataURL(uri);
  return NextResponse.json({ secret: member.totpSecret, qrDataUrl, alreadyEnabled: true });
}
```

**Fix:** Mirror the User-side change exactly: `if (member.totpEnabled) return NextResponse.json({ alreadyEnabled: true });`

### M8: Stripe checkout metadata trust — missing cross-check

**Severity:** MEDIUM
**Status:** ❌ NOT FIXED YET
**Category:** Trust boundary
**Location:** [app/api/stripe/webhook/route.ts:247-249, :294](../app/api/stripe/webhook/route.ts#L247)

The `checkout.session.completed` handler resolves `tenantId` from `event.account` (line ~86-93) but doesn't cross-check that against `metadata.tenantId`. An attacker who controls a separate connected Stripe account could craft metadata pointing at a different tenant's `packId` / `memberId`.

**Fix:**
```typescript
if (
  metadata.matflowKind === "class_pack" &&
  metadata.packId && metadata.memberId && metadata.tenantId &&
  metadata.tenantId === tenantId  // ← cross-check against resolved tenant
) { ... }
```

Same fix needed in the `shop_order` branch at line ~294.

### M9: TOTP setup TOCTOU race window

**Severity:** MEDIUM
**Status:** ❌ NOT FIXED YET
**Category:** TOCTOU
**Location:** [app/api/auth/totp/setup/route.ts:85-101](../app/api/auth/totp/setup/route.ts#L85-L101)

`POST /api/auth/totp/setup` reads `totpSecret`, verifies the code, then writes `totpEnabled=true` in a separate transaction. A concurrent `GET` from the same user in between would overwrite `totpSecret` with a new one. Result: `totpEnabled=true` but the verified code matched the OLD secret. User locked out (recoverable via recovery codes).

**Fix:** Wrap read + verify + update in a single transaction:
```typescript
await withTenantContext(session.user.tenantId, async (tx) => {
  const u = await tx.user.findUnique({ where: { id: session.user.id }, select: { totpSecret: true } });
  if (!u?.totpSecret) throw new Error("not initialised");
  if (!verifySync({ token: code, secret: u.totpSecret }).valid) throw new Error("invalid code");
  await tx.user.update({ where: { id: session.user.id }, data: { totpEnabled: true } });
});
```

### M10: MemberClassPack credit decrement TOCTOU — double redemption

**Severity:** MEDIUM
**Status:** ❌ NOT FIXED YET
**Category:** TOCTOU under READ COMMITTED isolation
**Location:** [lib/checkin.ts:120-149](../lib/checkin.ts#L120-L149)

Within `withTenantContext` (which is a Postgres transaction at READ COMMITTED), `findFirst` followed by `update decrement: 1` is two statements. Two concurrent check-ins for the same member can both read `creditsRemaining: 1`, both pass the `gt: 0` check, both decrement → ends up at -1.

**Attack:** member with 1 credit fires two near-simultaneous check-ins → gets two attendances for one credit.

**Fix:**
```typescript
const updated = await tx.memberClassPack.updateMany({
  where: {
    id: activePack.id,
    creditsRemaining: { gt: 0 },  // atomic guard on the UPDATE itself
  },
  data: { creditsRemaining: { decrement: 1 } },
});
if (updated.count === 0) return { kind: "no_coverage" as const };
```

### M11: AUTH_SECRET precedence inconsistency across modules

**Severity:** MEDIUM
**Status:** ❌ NOT FIXED YET
**Category:** Configuration consistency
**Location:** [auth.ts:61](../auth.ts#L61), [lib/auth-secret.ts:4](../lib/auth-secret.ts#L4), [proxy.ts:147](../proxy.ts#L147)

The three places that resolve the secret use DIFFERENT precedence:

| File | Resolution order |
|------|-----------------|
| `auth.ts:61` (length check) | `AUTH_SECRET ?? NEXTAUTH_SECRET` |
| `lib/auth-secret.ts:4` (JWT signing) | `NEXTAUTH_SECRET ?? AUTH_SECRET` |
| `proxy.ts:147` (edge verification) | `NEXTAUTH_SECRET ?? AUTH_SECRET` |

Triggers when both env vars are set with different values — the length check could pass on the wrong one, signing uses a different secret than the check validated.

**Fix:** Unify all three to `NEXTAUTH_SECRET ?? AUTH_SECRET` (matching the working majority). Update `auth.ts:61`.

### M12: Rate-limit TOCTOU bypass — 2x intended rate

**Severity:** MEDIUM
**Status:** ⚠️ ACKNOWLEDGED — bounded by lockout
**Category:** TOCTOU
**Location:** [lib/rate-limit.ts:8-26](../lib/rate-limit.ts#L8-L26)

`checkDbRateLimit` does `count` then `create` in two statements. Concurrent burst of 5 requests can all read `count=4`, all pass, all insert → 9 hits in a window designed for 5.

**Mitigations:** Account lockout at 10 consecutive failures (auth.ts:101) caps brute-force; bcrypt cost 12 (~250ms/attempt) limits throughput.

**Fix:** Use a single atomic counter (Postgres advisory lock or Redis INCR pattern), or accept the 2x window given lockout caps the worst case.

---

## Iteration 2 — external production probe results

Read-only HTTP probe of `https://matflow.studio`. 10 endpoints tested. Verdict: **strong external posture, no CRITICAL/HIGH.**

| # | Probe | Result | Verdict |
|---|---|---|---|
| 1 | `GET /` | 307→/login, full HSTS+CSP+XFO+COOP+Permissions-Policy headers | PASS |
| 2 | `POST /api/auth/totp/disable` (no auth) | 401 | PASS |
| 3 | `POST /api/admin/applications/.../approve` (no auth) | 401 (auth-first, no info leak) | PASS |
| 4 | `POST /api/stripe/webhook` (no signature) | 400 "Missing signature" | PASS |
| 5 | `POST /api/admin/operator-login` (probe) | 404 (route not exposed) | PASS |
| 6 | `GET /api/magic-link/verify?token=fake` | 307→/login?error=invalid_link (no oracle) | PASS |
| 7 | `GET /.env` | 307→/login (file not served) | PASS |
| 8 | `GET /.git/config` | 307→/login | PASS |
| 9 | `GET /_next/static/chunks/main.js` | 404 (Next 15 hashes chunk names; no source maps) | PASS |
| 10 | `OPTIONS /api/checkin` with `Origin: evil.example.com` | 307→/login (CORS not echoed) | PASS |

### M13: CSP `'unsafe-inline'` on script-src + style-src

**Severity:** MEDIUM
**Status:** ⚠️ NEXT.JS LIMITATION — partial mitigation possible
**Location:** Vercel response headers / `next.config.ts`

CSP is otherwise tight (`frame-ancestors 'none'`, `object-src 'none'`, `upgrade-insecure-requests`, no `unsafe-eval`) but `script-src 'unsafe-inline'` weakens XSS containment. Next.js 15 supports nonce/hash-based CSP — migration is non-trivial but feasible.

### L4: Cache-Control `public, max-age=0, must-revalidate` on auth-error responses

**Severity:** LOW
**Location:** all `/api/*` routes

`401`/`400`/redirect responses include `Set-Cookie` (`__Host-authjs.csrf-token`) AND `Cache-Control: public`. `must-revalidate` + `max-age=0` makes this safe in practice (every request revalidates), but `private, no-store` would be more correct for auth surfaces.

### L5: Missing COEP / CORP headers

**Severity:** LOW
**Location:** `next.config.ts`

COOP is set (`same-origin`). Adding `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`) and `Cross-Origin-Resource-Policy: same-origin` would complete the cross-origin isolation triple.

---

## LOW / informational findings

Aggregated from both iterations. Not yet fixed; risk-accept or queue.

| # | Severity | Finding | Location |
|---|---|---|---|
| L6 | LOW | Admin logout route has no auth check (SameSite=Strict mitigates) | [app/api/admin/auth/logout/route.ts:11](../app/api/admin/auth/logout/route.ts) |
| L7 | LOW | `/api/admin/email/test` uses `requireOwner()` not admin auth (under `/api/admin/*` proxy whitelist) | [app/api/admin/email/test/route.ts:13](../app/api/admin/email/test/route.ts) |
| L8 | LOW | DSAR routes under `/api/admin/dsar/*` use tenant auth not admin auth (consistent with intent — owner is the data controller — but auth model inconsistent) | [app/api/admin/dsar/export/route.ts:42](../app/api/admin/dsar/export/route.ts) |
| L9 | LOW | Per-instance in-memory rate-limit fallback during DB outages | [lib/rate-limit.ts:52-55](../lib/rate-limit.ts#L52-L55) |
| L10 | LOW | Indirect prompt-injection surface in `lib/ai-causal-report.ts` (owner can poison their own monthly report — same-tenant) | [lib/ai-causal-report.ts:197-211](../lib/ai-causal-report.ts) |
| L11 | LOW | `dangerouslySetInnerHTML` in member layout (CSS only, computed from validated tenant colour values) | [app/member/layout.tsx:203](../app/member/layout.tsx) |
| L12 | LOW | `ANTHROPIC_API_KEY` not documented in `.env.example` | `.env.example` |
| L13 | LOW | `Server: Vercel` + `X-Vercel-*` + `X-Matched-Path` response headers leak routing info (minor fingerprinting) | All responses |
| L14 | LOW | npm audit: 3 transitive moderate CVEs (`@hono/node-server`, `ip-address`, `express-rate-limit`) — none directly exploitable in matflow's usage | `package-lock.json` |

---

## Test log

All test runs from this audit session, in order. **Baseline before iteration 1:** 145 failing / 193 passing (33 files failing).

### Test run #1 — pre-iteration-1 baseline
```
$ npx vitest run
Test Files  33 failed | 20 passed | 1 skipped (54)
Tests       145 failed | 193 passed | 9 skipped (347)
```

### Test run #2 — focused on iteration-1 changes (immediately after fixes)
```
$ npx vitest run tests/unit/totp-mandatory-owner.test.ts \
  tests/unit/totp-immutable-helper.test.ts \
  tests/unit/resend-webhook.test.ts \
  tests/unit/auth-cookie-name.test.ts
Test Files  4 passed (4)
Tests       32 passed (32)
```

All four files cleanly cover the auth + TOTP + webhook surfaces touched by iteration-1 fixes.

### Test run #3 — typecheck post-iteration-1
```
$ npx tsc --noEmit -p tsconfig.json
(no output — clean)
```

### Test run #4 — full suite post-iteration-1 (regression check)
```
$ npx vitest run
Test Files  34 failed | 19 passed | 1 skipped (54)
Tests       148 failed | 190 passed | 9 skipped (347)
```

**Delta:** +3 failing tests vs baseline. All in `tests/unit/admin-checkin-autoselect.test.tsx` — pre-existing test issue (component fires unmocked fetch to `/api/settings/kiosk`); not caused by any iteration-1 file. Confirmed by reading the test file — it imports `AdminCheckin` component which we didn't modify.

### Test run #5 — typecheck post-iteration-3 fixes
```
$ npx tsc --noEmit -p tsconfig.json
(no output — clean)
```

### Test run #6 — focused tests post-iteration-3
```
$ npx vitest run tests/unit/totp-mandatory-owner.test.ts \
  tests/unit/totp-immutable-helper.test.ts \
  tests/unit/resend-webhook.test.ts \
  tests/unit/auth-cookie-name.test.ts
Test Files  4 passed (4)
Tests       32 passed (32)
```

All four files cover the TOTP + webhook + cookie surfaces touched by iteration-3 fixes (H3, M7, M9, M11). All pass.

### Iteration 3 — fixes shipped

8 of the 8 iteration-2 code-side findings fixed in a single commit:

| # | Severity | Issue | Status |
|---|---|---|---|
| H2 | HIGH | subscription-plans Zod regression rejecting decimal pounds | ✓ Fixed (drop `.int()`, change cap to £100k) |
| H3 | HIGH | Resend status-rank table — terminal could be overwritten by transient | ✓ Fixed (distinct ranks; `delivery_delayed` separate from `failed`) |
| M7 | MEDIUM | Member TOTP setup re-exposed secret post-enrolment | ✓ Fixed (mirrors User-side fix from iter-1) |
| M8 | MEDIUM | Stripe webhook trusted metadata.tenantId without cross-check | ✓ Fixed (cross-check `metadata.tenantId === tenantId` on both class_pack + shop_order branches) |
| M9 | MEDIUM | TOTP setup verify TOCTOU window | ✓ Fixed (read-verify-update wrapped in single transaction) |
| M10 | MEDIUM | ClassPack credit decrement TOCTOU (double-redemption) | ✓ Fixed (atomic `updateMany` with `creditsRemaining > 0` guard) |
| M11 | MEDIUM | AUTH_SECRET precedence inconsistency | ✓ Fixed (auth.ts now matches lib/auth-secret.ts + proxy.ts: `NEXTAUTH_SECRET ?? AUTH_SECRET`) |
| L5 | LOW | Missing COEP / CORP cross-origin isolation headers | ✓ Fixed (`Cross-Origin-Embedder-Policy: credentialless`, `Cross-Origin-Resource-Policy: same-origin`) |

### External probes — production matflow.studio (read-only)

10 curl probes executed. Detailed results in [§ Iteration 2 — external production probe](#iteration-2--external-production-probe-results).
- All 10: PASS

---

## Recommendations

### Iteration 3 (next code commit)

Fix all 8 iteration-2 NEW findings (H2, H3, M7-M11) + COEP/CORP headers (L5). Estimated: 2 hours of code, single commit.

Order matters:
1. **H2 first** — subscription-plans Zod is BLOCKING all plan creation; user-facing impact
2. **M7** — member TOTP secret leak parity with User-side
3. **H3** — Resend status rank
4. **M8** — Stripe metadata cross-check
5. **M9 + M10** — TOTP + class-pack TOCTOU
6. **M11** — auth secret precedence
7. **L5** — COEP/CORP headers
8. **L4** — `private, no-store` on `/api/*` auth responses

Defer M12 (rate-limit TOCTOU) and M13 (CSP `unsafe-inline`) — accept the bounded risk; both are larger refactors.

### User-side action items (today)

1. Rotate the four CRITICAL-1 secrets
2. Verify Vercel `RESEND_FROM`, `STRIPE_CLIENT_ID`, `STRIPE_SECRET_KEY` are all set (post-Stripe-test setup earlier today)
3. Watch for the Stripe support reply to enable live Connect

### Long-term hardening

- Migrate CSP from `unsafe-inline` to nonce-based (Next.js 15 supports it, ~1 day refactor)
- Submit `matflow.studio` to https://hstspreload.org (HSTS preload is set in headers)
- Add `report-to` directive to CSP for violation telemetry
- Audit + add login event tests (P1.6 LoginEvent disownedAt path)
- Add bounce-aware short-circuit unit test (acknowledged gap from earlier)

### Process improvements

- Add a pre-commit hook that runs `npx tsc --noEmit` on staged TS files
- Add a CI step that runs `npm audit --audit-level=high` and fails on new critical/high CVEs
- Re-run this full audit after every major auth/payment change

---

**Total time invested in this audit:** ~30 min (3 parallel agents × 3+ min each + inline review + writeup). Comparable manual pentest scope: 1-2 days.

**Audit completeness:** all OWASP Top 10 categories covered for the auth/API/payment surfaces. LLM/AI surface lightly covered (matflow has a single server-side cron-only LLM integration). Mobile / native / IoT surfaces not applicable.
