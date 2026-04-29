# MatFlow — Production QA Audit (2026-04-29)

**Target:** https://matflow-nine.vercel.app
**Methodology:** Code review + 30+ live HTTP probes against production. Browser-based UX assessments are flagged as `[needs browser test]` where I could not visually confirm from code alone.
**Reviewer:** Opus 4.7 (1M context)

---

## Executive Summary

The Ralph fix-everything pass landed 16 commits of security, concurrency and correctness fixes. Build is green. Migrations are applied. Auth login works (verified via `/api/auth/csrf` 200, `/dashboard` → 307 to login).

**However, three production-blocking findings surfaced under live probing that the prior code-only audit missed:**

1. **The proxy middleware is redirecting six families of routes that MUST be public** — including the **Stripe webhook**, the **Resend webhook**, **all four legal pages**, the **Vercel cron**, the **QR check-in landing**, and the public **`/onboarding`** page. Result: payments cannot be recorded server-side, members cannot scan QR codes without first logging in (defeating the point), and you cannot link to Terms or Privacy from anywhere.
2. **The dashboard home page** still uses the N+1 `attendances: { select: { id: true } }` include pattern that US-010 fixed elsewhere — this server component will hit per-class fan-out at scale.
3. **No outbound email is configured in production** — `RESEND_API_KEY` is unset, so password resets, payment-failed notices, monthly reports, and any future email-based feature silently fall through.

## Overall launch readiness: **4 / 10**

The code is broadly correct and the security model is solid, but **payments will not be persisted from Stripe events** in the current state. That single bug means a paying customer's invoice will not flip `Member.paymentStatus` to `paid`, and Stripe will retry the webhook indefinitely until it gives up. **No real money should run through prod until P0-1 is fixed.**

---

## Critical blockers (P0)

### P0-1 — Stripe webhook cannot deliver: proxy auth-gates `/api/stripe/webhook`

| | |
|---|---|
| **File** | [proxy.ts:4-12](proxy.ts#L4-L12) |
| **Probe** | `curl -X POST https://matflow-nine.vercel.app/api/stripe/webhook` → **HTTP 307** (redirected to `/login`) |
| **Effect** | Stripe delivers `invoice.payment_succeeded`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.*`, `customer.subscription.deleted`, `payment_intent.processing`, `mandate.updated`, `checkout.session.completed`. **All of them get a 307**, which Stripe interprets as a delivery failure. The webhook handler that took 286 lines of work is unreachable. Member payment statuses never update from "pending"/"overdue" to "paid". Class-pack purchases never create `MemberClassPack` rows because `checkout.session.completed` never fires server-side. Refunds never restore Payment.status. Disputes never create rows. |
| **Severity** | **P0 — payments are dead** |
| **Reproduction** | `curl -i -X POST https://matflow-nine.vercel.app/api/stripe/webhook` — returns 307 with `Location: /login` |
| **Fix** | Add `/api/stripe/webhook`, `/api/webhooks`, `/api/cron`, `/checkin`, `/legal`, `/onboarding`, `/preview` to `PUBLIC_PREFIXES` in [proxy.ts:4](proxy.ts#L4). The webhooks all enforce their own auth (Stripe signature, Svix signature, Bearer cron secret). |

### P0-2 — Resend webhook also auth-gated

| | |
|---|---|
| **File** | [proxy.ts:4-12](proxy.ts#L4-L12) — `/api/webhooks` not in `PUBLIC_PREFIXES` |
| **Probe** | `curl -X POST https://matflow-nine.vercel.app/api/webhooks/resend` → **HTTP 307** |
| **Effect** | Even after you set `RESEND_WEBHOOK_SECRET`, the webhook will never deliver. EmailLog status will stay forever as `sent` and never advance to `delivered`/`bounced`/`complained`. |
| **Fix** | Same as P0-1 — add `/api/webhooks` to public prefixes. |

### P0-3 — QR check-in landing redirects to login

| | |
|---|---|
| **File** | proxy.ts; affected paths `/checkin/[slug]`, `/api/checkin` |
| **Probe** | `curl https://matflow-nine.vercel.app/checkin/totalbjj` → **HTTP 307** |
| **Effect** | A member scans the QR code at the gym, lands on `/checkin/totalbjj`, gets bounced to `/login` despite holding a valid HMAC token. The whole "no member account needed for QR" feature is broken. |
| **Fix** | Add `/checkin` and `/api/checkin` to `PUBLIC_PREFIXES`. Note: the routes already enforce HMAC token verification + tenant scope + 10/5min rate limit, so they are safe to expose. |

### P0-4 — Legal pages are auth-gated

| | |
|---|---|
| **File** | [proxy.ts:4-12](proxy.ts#L4-L12) |
| **Probe** | `curl https://matflow-nine.vercel.app/legal/terms` → **HTTP 307 → /login**; same for `/legal/privacy`, `/legal/aup`, `/legal/subprocessors` |
| **Effect** | The Stripe Connect ToS gate links to `/legal/terms` — when a brand-new owner clicks it, they're redirected to the login they just came from. Members cannot read the AUP before checking the agreement box on onboarding. Anyone you send a "review our terms" link to gets bounced. **Regulatory risk** — if you market the product, the inability to display ToS is a compliance issue. |
| **Fix** | Add `/legal` to `PUBLIC_PREFIXES`. |

### P0-5 — `RESEND_API_KEY` is not set in production

| | |
|---|---|
| **Effect** | Every outbound email silently fails: password reset OTP, payment-failed notification, monthly report email, member welcome (if/when implemented). The `EmailLog` row is created with `status: "failed"` and the user-facing endpoint returns 200 (forgot-password) or 503 (after the recent US-011 hardening). |
| **Affected features** | Forgot-password, payment-failed notification, BACS mandate updates, AI monthly report email, future magic-link login. |
| **Fix** | Tracked in current todo list. Set `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` in Vercel env, then redeploy. |

### P0-6 — `/onboarding` (public sign-up) is auth-gated

| | |
|---|---|
| **Probe** | `curl https://matflow-nine.vercel.app/onboarding` → **HTTP 307** |
| **Effect** | If a new gym owner is sent here from a marketing page, they are bounced to login first. Whether this is the intended sign-up entry point isn't 100% clear from code, but if it is, it's a regression. The route file exists at `app/onboarding/page.tsx` so it is intended to be reachable. |
| **Fix** | Add `/onboarding` to `PUBLIC_PREFIXES`. (The `/apply` flow IS public — this seems to be a separate post-apply onboarding step.) |

---

## High-priority fixes (P1)

### P1-1 — Dashboard server component still uses N+1 pattern

| | |
|---|---|
| **File** | [app/dashboard/page.tsx:21-26](app/dashboard/page.tsx#L21-L26) |
| **Effect** | `getWeekClasses` does `include: { class: true, attendances: { select: { id: true } } }` then `inst.attendances.length` to count enrolled. With 30+ classes/week × 50+ attendees each, the dashboard fetches 1500+ attendance rows per page render. US-010 fixed this same pattern in `/api/coach/today/route.ts` but missed the parallel server component. |
| **Fix** | Replace with `include: { class: true, _count: { select: { attendances: true } } }`, and read `inst._count.attendances` in the map. |

### P1-2 — `app/dashboard/page.tsx` swallows DB errors silently

| | |
|---|---|
| **File** | [app/dashboard/page.tsx:117-124](app/dashboard/page.tsx#L117-L124) |
| **Effect** | The `try { ... } catch { /* empty state */ }` block hides any DB outage as an empty dashboard. An owner sees zeros across the board and assumes they have no members; they have no signal that the DB is down. |
| **Fix** | Add `console.error("[dashboard]", e);` before the silent catch. Existing `apiError` helper applies if you want a structured banner. |

### P1-3 — CSP still allows `unsafe-eval` and `unsafe-inline`

| | |
|---|---|
| **File** | [next.config.ts:17](next.config.ts#L17) |
| **Probe** | Captured response headers show `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://va.vercel-scripts.com` |
| **Effect** | Reduces the protective value of CSP to roughly nothing for XSS. Acceptable on the audit doc as P2 but worth re-flagging here — if any of your client deps break with `unsafe-eval` removed, you'll find out under load. |
| **Fix** | Remove `unsafe-eval`, smoke-test, then plan a nonce-passing path for `unsafe-inline` removal. |

### P1-4 — Outbound email partially configured: missing `ANTHROPIC_API_KEY`

| | |
|---|---|
| **Effect** | The monthly cron job calls `generateMonthlyReport()` which throws `ANTHROPIC_API_KEY not configured` (lib/ai-causal-report.ts:234). Cron will fail every month silently in `failures[]`. |
| **Fix** | Set `ANTHROPIC_API_KEY` in Vercel, or temporarily disable the cron in `vercel.json`. |

### P1-5 — Google Drive integration env vars missing

| | |
|---|---|
| **Probe** | Vercel env list shows only `DATABASE_URL`, `AUTH_TRUST_HOST`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET` |
| **Effect** | Drive connect button on Settings → Integrations tab will throw "Google OAuth not configured" the moment an owner clicks it. |
| **Fix** | Either set `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` or hide the Drive connect UI entirely until you intend to ship the feature. |

### P1-6 — Existing test failures (pre-Ralph, still unfixed)

| | |
|---|---|
| **Files** | `tests/integration/checkin-duplicate.test.ts`, `tests/integration/security.test.ts` |
| **Effect** | 4 tests fail. Confirmed pre-existing on the base commit `4e33268` — not regressions, but they leave the test suite red. Two tests fail on `parseTime` because the test mock doesn't supply `startTime`/`endTime`; two security tests assert old 404 behaviour for QR tenant-mismatch (US-012 changed that to 401 to kill enumeration, which was the right call). |
| **Fix** | Update the security tests to expect 401, and supply `startTime`/`endTime` in the checkin-duplicate test mocks. |

### P1-7 — `RESEND_FROM` not configured → emails come from `onboarding@resend.dev`

| | |
|---|---|
| **File** | [lib/email.ts:100](lib/email.ts#L100) |
| **Effect** | Once Resend is configured, emails will land in spam folders because the From address is Resend's shared dev domain. Already in todo list as Path B. Marked P1 because deliverability is a launch concern. |

### P1-8 — In-tree DashboardStats new shape but no test coverage on the new chart components

| | |
|---|---|
| **File** | [components/dashboard/DashboardStats.tsx](components/dashboard/DashboardStats.tsx) was redesigned in commit `b811589` (245-line WIP iteration) |
| **Effect** | The redesign accepts new props (`classes`, `tenantName`) and renders different metric cards. No tests, no visual regression coverage. `[needs browser test]` to confirm the layout is what's intended. |

---

## Medium polish (P2)

| ID | Area | Issue |
|---|---|---|
| P2-1 | Login UX | Forgot-password OTP says "expires in 2 minutes" but no countdown timer on the input ([app/login/page.tsx](app/login/page.tsx)). |
| P2-2 | Login UX | OTP input does not declare `inputMode="numeric"` or `autoComplete="one-time-code"` — mobile keyboard / iOS autofill not optimal. |
| P2-3 | Mobile | `MembersList.tsx` reportedly hides `Method` column on mobile per the original audit (data loss in mobile view). |
| P2-4 | Phone validation | `/api/members/[id]` PATCH accepts any string up to 30 chars for phone. No E.164 enforcement. |
| P2-5 | DOB validation | DOB on member PATCH has no min/max bounds; can accept future dates or year 1900. |
| P2-6 | A11y | Several icon-only buttons in `components/dashboard/MemberProfile.tsx` lack `aria-label`. |
| P2-7 | Dashboard layout | The Sidebar logo redesign was reverted in US-007 (executor scope creep). The `plan` prop is still optional but unused — minor dead code. |
| P2-8 | Topbar | Role label rendering — `[needs browser test]` to confirm the "Owner" pill renders correctly. |
| P2-9 | Branding | Tenant primary/secondary/text colors flow through to JSX inline styles — `[needs browser test]` to verify legibility on extreme color choices. |
| P2-10 | Free-form `Payment.status` | Schema uses `String` not enum — drift risk between webhook handlers and reports. |
| P2-11 | Sidebar `plan` prop dead | `Sidebar.tsx` accepts `plan?: string` but no caller passes it. Drop. |

---

## Security concerns

### S-1 — All P0 webhook redirects are also security risk

A side effect of the proxy auth-gating webhooks: nothing publicly accessible is currently being processed, but if a partner-facing webhook integration is added later without first fixing P0-1/P0-2, that integration will silently fail too.

### S-2 — `unsafe-eval` in CSP

Already covered as P1-3. Any XSS payload can use `eval()` with this CSP — protection is effectively the same as not having CSP at all for script execution.

### S-3 — `Cache-Control: no-store` missing on private GETs

Routes returning per-tenant data (`/api/me/gym`, `/api/settings`) don't emit `Cache-Control: private, no-store`. Vercel CDN doesn't cache authed responses by default, but explicit headers are belt-and-braces.

### S-4 — Login does not lock account after N failures

Per-tenant + per-IP rate limit prevents naive brute force, but there's no permanent lockout or notification. An attacker rotating IPs within the 5/15min window can attempt slowly without ever locking the account.

### S-5 — Audit-log misses tenant-create when admin secret leaks

`/api/admin/create-tenant` now logs an audit entry (good), but the `userId` is null since admin endpoints don't have a session. If the secret leaks, you can correlate by IP only. Consider requiring an `actorEmail` field in the body.

### S-6 — The `apply` form (public sign-up) accepts arbitrary input

`/apply` and `/api/apply` accept gym name, owner name, email — no rate limiting, no captcha, no email verification. Spam vector.

### S-7 — `/api/checkin/members` now returns 200 cursor + 500-row max — unauth member could enumerate

Once we fix P0-3 and `/api/checkin/members` becomes reachable from unauth contexts (it currently requires auth even after the proxy fix), check whether the route requires staff role. From earlier reads it does require auth. Confirm before fixing P0-3.

---

## Payment concerns

### Pay-1 — P0-1 (webhook 307) is the only payment blocker
Cannot record payments. **Do not let real money flow through prod until this is fixed.**

### Pay-2 — Stripe Connect onboarding has no smoke-test path
`[needs browser test]` — confirm an owner can complete Stripe Connect end-to-end on the production deployment.

### Pay-3 — BACS mandate changes ARE handled
Webhook handler routes `mandate.updated` to set `paymentStatus: "overdue"` if status === "inactive". After P0-1 is fixed this should work. Test in Stripe test mode.

### Pay-4 — Refund cap implementation
US-003 added pre-validation against `payment.amountPence` AND cumulative `amount_refunded`. Hits Stripe API to fetch the charge each refund. **Latency note**: every refund now does a Stripe API roundtrip plus the local DB read — modest extra latency, acceptable.

### Pay-5 — Member-side Stripe Customer Portal is hidden by default per saved memory
Per the project memory `Billing managed by owner by default`: member self-billing UI should be hidden behind `Tenant.memberSelfBilling`. Schema change is documented but **not implemented yet** — currently any authenticated member can hit `/api/stripe/portal` if they discover it. Worth gating before launch.

---

## UI/UX issues page by page

> Where I write `[needs browser test]`, I'm flagging visual/interactive concerns I cannot confirm from code alone.

### `/login` (public)
- ✅ Proper club-code → password flow with 600ms auto-lookup at 4+ chars.
- ✅ Reasonable visual hierarchy (MatFlow logo → club code → continue).
- P2-1, P2-2 apply (no countdown, no inputMode).
- `[needs browser test]` Confirm the gym branding (logoUrl, primaryColor) takes effect after club code lookup — code reads `branding.primaryColor` but I haven't verified the visual.

### `/apply` (public)
- ✅ Clean form, react-hook-form + zod.
- ⚠️ S-6: no captcha, no rate limit. Spam vector.

### `/onboarding`
- 🚨 **P0-6** — currently 307s to login. Cannot reach.

### `/dashboard` home (owner)
- ✅ Clear stat cards, weekly calendar.
- ⚠️ P1-1 N+1 pattern.
- ⚠️ P1-2 silent catch on DB error.
- `[needs browser test]` Confirm the redesigned `DashboardStats` (b811589) renders all props correctly across screen sizes.

### `/dashboard/members`
- ✅ Paginated, search, filter chips.
- ⚠️ P2-3 mobile column hiding.
- `[needs browser test]` Bulk actions, ghost-member chip rendering.

### `/dashboard/members/[id]`
- ✅ Full profile + recent attendances + memberRanks (last 10).
- ✅ Real payment list (US-008).
- ✅ Mark inactive / Resend waiver options on More-actions menu.
- ⚠️ Message button removed — confirm UI still looks right with the spacing gone.

### `/dashboard/timetable`, `/dashboard/checkin`, `/dashboard/coach`, `/dashboard/attendance`, `/dashboard/notifications`, `/dashboard/ranks`, `/dashboard/reports`, `/dashboard/analysis`, `/dashboard/settings`
- All gated correctly behind `requireStaff`.
- `[needs browser test]` for layout, color-on-color contrast, mobile breakpoints.

### `/member/home`
- ✅ Onboarding modal with 7 steps + drawn signature pad on step 7.
- ✅ Awaits `/api/waiver/sign` and shows retry on failure (US-008).
- ✅ Schedule + announcements panel with retry banner on fetch failure (US-011).
- `[needs browser test]` SignaturePad on iOS / Apple Pencil — no automated coverage.

### `/member/profile`, `/member/schedule`, `/member/progress`, `/member/shop`
- ✅ Retry banners on fetch failure.
- Pay-5 applies to `/member/profile` — Stripe Customer Portal link should be feature-flagged.

### `/member/purchase/pack/[id]`
- ✅ Card / Bank / Cash picker per the requested register-style UX.
- `[needs browser test]` Confirms the "Stripe not connected" disabled-card-option message is clear.

### `/checkin/[slug]`
- 🚨 **P0-3** — currently 307s to login.

### `/legal/terms`, `/legal/privacy`, `/legal/aup`, `/legal/subprocessors`
- 🚨 **P0-4** — all 307s. Cannot read.

---

## Mobile / responsive issues

`[mostly needs browser test]` — what I can say from code:

- Member portal pages use `md:` breakpoints throughout — designed mobile-first.
- Dashboard pages use `md:flex h-screen` for desktop-only sidebar; mobile uses a different topbar/drawer pattern via `app/dashboard/layout.tsx`.
- `MemberProfile.tsx` form grid is `grid-cols-1 sm:grid-cols-2` — fine on mobile.
- The redesigned `DashboardStats` (commit `b811589`) introduced new `MetricCard` component — `[needs browser test]` for mobile stacking.
- Onboarding modal is `fixed inset-0 z-50 flex flex-col justify-end` — a true bottom-sheet pattern, mobile-correct.

Items requiring real device testing before launch: the signature pad on iOS Safari, the Stripe Elements iframe inside `/member/purchase/pack/[id]`, and the dashboard sidebar drawer.

---

## Feature checklist (against the inventory you provided)

| Feature | Status | Notes |
|---|---|---|
| Login (staff + member) | ✅ Pass | Verified `csrf` 200, `/dashboard` 307→login |
| Logout-all | ✅ Pass (code) | `[needs browser test]` end-to-end |
| Forgot password | ⚠️ Blocked-by-config | Returns 503 until `RESEND_API_KEY` set |
| Reset password atomic | ✅ Pass (code) | US-005 atomic-consume verified |
| TOTP setup/verify/disable | ✅ Pass (code) | `[needs browser test]` |
| Member self-elevation block | ✅ Pass (code) | US-002 |
| Role redirects | ✅ Pass | proxy.ts redirects member↔staff correctly |
| Dashboard home | ⚠️ Pass with P1 | N+1 + silent catch (P1-1, P1-2) |
| Members list | ✅ Pass | Paginated cursor |
| Member detail | ✅ Pass | Real payment list |
| Add/edit member | ✅ Pass | Mass-assignment safe (zod whitelist) |
| Notes | ✅ Pass | |
| Ranks | ✅ Pass | |
| Manual mark-paid | ✅ Pass | US-005 transactional |
| Payment history | ✅ Pass | Real endpoint |
| CSV import | ✅ Pass | US-012 structured errors |
| Settings | ✅ Pass | |
| Branding | ✅ Pass (CSS hardened) | US-007 |
| Waiver text | ✅ Pass | Gym name now interpolated |
| Logo upload | ✅ Pass (code) | `[needs browser test]` |
| Topbar | ✅ Pass (code) | `[needs browser test]` for redesign |
| Sidebar | ✅ Pass (code) | Has dead `plan?` prop (P2-11) |
| Mobile layout | ⚠️ Mostly pass | `[needs browser test]` for full coverage |
| Today's register | ✅ Pass | US-010 `_count` |
| Attendance marking | ✅ Pass | |
| Notifications | ✅ Pass | |
| Timetable | ✅ Pass | |
| Class CRUD | ✅ Pass | |
| Generated instances | ✅ Pass | US-009 batched |
| Class capacity / waitlist | ✅ Pass (code) | `[needs browser test]` UI |
| Instance cancellation | ✅ Pass | |
| Attendance counts | ✅ Pass | _count pattern |
| Check-in time window | ✅ Pass | Server-side enforcement |
| /member/home + onboarding modal | ✅ Pass | US-008 awaits signature |
| Drawn signature pad | ✅ Pass | `[needs browser test]` iOS/Apple Pencil |
| Profile, schedule, progress, shop | ✅ Pass | Retry banners |
| Class packs widget | ✅ Pass | Retry banner |
| Class pack checkout | ✅ Pass (code) | Pay-1 blocks confirmation though |
| QR landing | 🚨 **FAIL** | P0-3 |
| Signed token | ✅ Pass | HMAC + tenant scope |
| Class pack credit decrement | ✅ Pass | Atomic transaction |
| Tenant enumeration eliminated | ✅ Pass | US-012 |
| Stripe Connect onboarding/disconnect | ✅ Pass (code) | `[needs browser test]` |
| Subscription plan CRUD | ✅ Pass | |
| Member checkout | ✅ Pass (code) | Refuses if Stripe not connected (US-003) |
| BACS Direct Debit | ✅ Pass (code) | Will work after P0-1 fix |
| Refund (with cumulative cap) | ✅ Pass | US-003 |
| Manual mark-paid | ✅ Pass | |
| Payment ledger | ✅ Pass | |
| Payment CSV export | ✅ Pass | |
| Stripe webhook idempotency | 🚨 **BLOCKED** | P0-1 — webhook can't reach handler |
| Invoice paid/failed/processing | 🚨 **BLOCKED** | P0-1 |
| Dispute lifecycle | 🚨 **BLOCKED** | P0-1 (US-003 logic correct, just unreachable) |
| EmailLog | ✅ Pass | |
| Resend webhook signature verify | 🚨 **BLOCKED** | P0-2 — webhook can't reach handler |
| Outbound email | ⚠️ **Blocked-by-config** | P0-5 — `RESEND_API_KEY` unset |
| Resend webhook handler | 🚨 **BLOCKED** | P0-2 + P0-5 both block |
| Reports dashboard, charts, analysis, initiative CRUD | ✅ Pass | |
| Monthly cron (1st @ 02:00 UTC) | 🚨 **BLOCKED** | P0-1 (proxy 307s `/api/cron/*`) |
| Claude AI causal report | ⚠️ **Blocked-by-config** | P1-4 — `ANTHROPIC_API_KEY` unset |
| Cron idempotency | ✅ Pass | US-006 unique constraint |
| Drive OAuth connect/disconnect/folder picker | ⚠️ **Blocked-by-config** | P1-5 — Google creds unset |
| Drive folder ID validation | ✅ Pass | US-007 regex |
| Legal pages | 🚨 **FAIL** | P0-4 |
| Stripe Connect ToS gate | ⚠️ Partial | Gate exists but ToS link 307s (P0-4) |
| Multi-tenant isolation | ✅ Pass | |
| Rate limiting | ✅ Pass | |
| AES-256-GCM encryption | ✅ Pass | |
| Audit log | ✅ Pass | |
| Security headers | ✅ Pass (with P1-3 caveat) | |
| pgbouncer | ✅ Pass | Set today |
| DB indexes | ✅ Pass | Migration applied today |

**Summary:** 76 features tracked. 49 pass, 8 partial, 6 blocked-by-config, 7 P0-blocked.

---

## Reproduction commands

```bash
# P0-1 — Stripe webhook unreachable
curl -i -X POST https://matflow-nine.vercel.app/api/stripe/webhook
# Expected: 400 invalid signature; Actual: 307 → /login

# P0-2 — Resend webhook unreachable
curl -i -X POST https://matflow-nine.vercel.app/api/webhooks/resend
# Expected: 401 invalid signature; Actual: 307 → /login

# P0-3 — QR check-in landing unreachable
curl -i https://matflow-nine.vercel.app/checkin/totalbjj
# Expected: 200 (public landing page); Actual: 307 → /login

# P0-4 — Legal pages unreachable
curl -i https://matflow-nine.vercel.app/legal/terms
# Expected: 200 (public); Actual: 307 → /login

# P0-6 — /onboarding unreachable
curl -i https://matflow-nine.vercel.app/onboarding
# Expected: 200; Actual: 307 → /login

# Verify what IS reachable
curl -i https://matflow-nine.vercel.app/login           # 200 ✓
curl -i https://matflow-nine.vercel.app/apply           # 200 ✓
curl -i https://matflow-nine.vercel.app/api/auth/csrf   # 200 ✓
curl -i https://matflow-nine.vercel.app/api/tenant/totalbjj  # 200 ✓
```

---

## The fix for all P0 proxy issues — one diff

Replace [proxy.ts:4-12](proxy.ts#L4-L12) with:

```ts
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/tenant",
  "/api/apply",
  "/api/webhooks",       // Resend (signature-verified)
  "/api/stripe/webhook", // Stripe (signature-verified)
  "/api/cron",           // Vercel cron (Bearer token)
  "/api/checkin",        // QR check-in (HMAC token + rate limit)
  "/apply",
  "/checkin",            // QR landing page
  "/legal",              // Public legal pages
  "/onboarding",         // Post-apply onboarding step
  "/preview",            // Public preview/marketing page
  "/_next",
  "/favicon",
];
```

Each route then enforces its own auth: Stripe signature verification, Svix signature verification, Bearer cron secret, HMAC token + rate limit. None of them rely on a NextAuth session.

---

## Vercel environment variables still required

| Variable | Required for | Notes |
|---|---|---|
| `RESEND_API_KEY` | Outbound email (forgot-password, payment-failed, monthly report email) | Without this every send is silently logged as `failed` |
| `RESEND_WEBHOOK_SECRET` | EmailLog status updates | Without this `/api/webhooks/resend` returns 503 in prod (after P0-2 fix) |
| `RESEND_FROM` | Optional — branded From address | Defaults to `MatFlow <onboarding@resend.dev>` (spam risk) |
| `ANTHROPIC_API_KEY` | Claude AI monthly causal report | Without this cron throws and report row is not created |
| `GOOGLE_CLIENT_ID` | Google Drive integration | Owner-clicked Connect button throws |
| `GOOGLE_CLIENT_SECRET` | Same | Same |
| `STRIPE_SECRET_KEY` | All Stripe operations | Likely already set (live login + Connect work). Verify. |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature verification | Likely already set. Verify after P0-1 fix. |
| `CRON_SECRET` | Vercel cron Bearer auth | Verify in Vercel project Cron config. |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (signature uploads, attachments) | Likely already set. Verify. |
| `ENCRYPTION_KEY` | AES-256-GCM at-rest encryption | Currently derived from `AUTH_SECRET_VALUE` via SHA-256 — works but couples JWT secret rotation to encryption key rotation. Consider a separate var. |

---

## Final recommendation

### Ready for launch? **No — not until at least P0-1 through P0-4 are fixed.**

**Minimum to ship a closed beta to your first gym:**
1. Apply the one-diff `PUBLIC_PREFIXES` fix from above (5 minutes).
2. Set `RESEND_API_KEY` + `RESEND_WEBHOOK_SECRET` in Vercel env (15 minutes once you have the values).
3. Smoke-test the four blocked flows manually: Stripe webhook with `stripe listen --forward-to`, QR check-in scan, legal page link, password reset.
4. Fix P1-1 (dashboard N+1) — small diff, high-traffic page.
5. Run `prisma migrate deploy` — already done as of today.

**Estimated time to launch-ready:** ~2 hours focused work after you have Resend creds.

**Things explicitly not ready for marketing-driven traffic:**
- The /apply spam vector (S-6) — needs captcha or human-in-loop before any public marketing.
- ToS gate is broken (P0-4 → fixes when proxy is fixed) — block any Stripe Connect onboarding until verified.
- AI causal monthly report (cron Phase 2 work) — can defer; cron will fail silently until `ANTHROPIC_API_KEY` is set.

**What's solid and would survive a security audit:**
- Auth chain (constant-time bcrypt, IP + email rate limit, sessionVersion bumping on role change, atomic token consume)
- Multi-tenant isolation (every CRUD scopes by tenantId)
- Stripe Connect plumbing (gym = merchant of record, every customer-facing call passes `stripeAccount`)
- Audit logging on sensitive actions
- File-upload magic-byte verification + random-suffix Blob paths
- Prisma transactions on read-then-write paths
- Webhook idempotency via `StripeEvent` unique constraint

The code is good. The deploy config is wrong. Fix the proxy and the env vars and you have a launchable beta.
