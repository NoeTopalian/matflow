# MatFlow — Pending TODOs

Source-of-truth for everything that's not yet done. Two halves: things only you can do (credentials, accounts), and things I can pick up next session.

---

## 2026-08-18 — money-path + honesty pass (branch `feat/dashboard-desktop-system`)

Six commits. All four static gates green at the end: `tsc` 0, `npm run lint` 0 errors,
701/701 unit tests, `next build` exit 0 (148/148 static pages).

**Fixed — each confirmed against live Stripe test mode, not from documentation:**

| What | Evidence it was broken |
|---|---|
| Subscription signup returned `clientSecret: null` every time | Invoice on apiVersion `2026-03-25.dahlia` has no `payment_intent` field; Stripe accepts the expand silently and returns nothing. Recurring billing could never complete — subs sat `incomplete` until Stripe cancelled them. |
| Every subscription payment stored null Stripe ids | Same class of bug at 4 webhook sites, hidden behind `Record<string, unknown>` casts. Proven on a **paid** invoice: `inv.charge` and `inv.payment_intent` both `undefined`. Refunds/voids/disputes had nothing to match on. |
| `mandate.updated` never fired | `Stripe.Mandate` has no `customer` property at all — asserting it is a compile error. |
| `payment_method.detached` never wrote its audit row | Real Stripe event shows `object.customer: null`, id lives in `previous_attributes.customer`. |
| Ad-hoc charge could double-charge | Card declines were indistinguishable from transport failures; the drawer dropped its idempotency key on retry. |
| Refunds could race past the payment total | Read-modify-write on `refundedAmountPence`; now an optimistic lock returning 409. |
| API auth failures rendered as "you have no data" | `lib/authz` redirected route handlers (307 → HTML login page), so `.json()` threw and the UI showed an empty state. ~40 routes now return JSON 401/403 via `lib/api-authz`. |
| Three shipped falsehoods | Push checkbox, demotion-banner reminder copy, and a Notifications card with two inert switches. Push cannot deliver at all: no registered service worker handler, no client ever subscribes. |
| Suspended/deleted clubs kept serving branding at HTTP 200 | The DEMO_TENANTS fallback sat in a `catch` that also caught the deliberate not-found throw. |
| UI ratchet had never run on this branch | `lint` was `eslint && check-ui-rules`; one eslint error skipped the whole governance gate. Both halves now always run (`scripts/lint-all.mjs`). |
| CI did not gate | `DATABASE_URL` pointed at a Postgres that did not exist, so ~74 DB tests *errored* into a `continue-on-error` bin. Real Postgres service added; lint and the full suite now gate. |

Also: primary buttons rendered white-on-white for any tenant with a light accent
(`--tx-on-accent` was never set on the staff shell); destructive buttons failed AA at
3.76:1; `readableOn` picked by luma and chose the *less* readable colour across a wide
mid-tone band. Ratchet lowered: hex 773→768, textGray 269→266, whiteAlphaDash 12→11.
Dependencies: 32 vulnerabilities (3 critical) → 4 high, 0 critical; `sharp` → 0.35.3.

**Still open:**

- [ ] **Recurring subscription signup still cannot complete.** The server now returns a real
      `confirmation_secret` client secret (P0-2), but **nothing consumes it**: `@stripe/stripe-js`
      is imported nowhere and no component calls `confirmPayment`. Until that client step exists,
      a new subscription stays `incomplete` and Stripe cancels it. The UI no longer *claims*
      otherwise — `subscriptionState` shows `pending` rather than a green "Active" — but the
      feature is not working. This is the single biggest gap before a club can self-serve billing.
- [ ] `scripts/backfill-invoice-payment-ids.mjs` — repairs Payment rows written with null
      Stripe ids before the fix. Dry-run verified; **not yet run against production**.
      `node scripts/backfill-invoice-payment-ids.mjs` then `--apply --i-know-this-is-production`.
- [ ] Webhook `processedAt` reprocessability (P1-4) — needs a migration, not done.
- [ ] `.github/workflows/e2e.yml` has never had a green CI run; first scheduled run is the proof.
- [ ] Branch protection with required checks — your click, in GitHub settings.
- [ ] `TESTING_MODE=true` in production defeats mandatory 2FA. Turn it off before onboarding another gym.

---

## Things only you can do (need credentials I don't have)

### 1. Set 5 Vercel environment variables

Path: https://vercel.com/noetopalians-projects/matflow/settings/environment-variables → **Add New** for each, environment **Production**, then **Redeployments → Redeploy latest** when finished.

> **Why via dashboard, not CLI:** the Vercel CLI on Windows has a bug where `vercel env add` accepts input via stdin but silently stores it as empty string. It corrupted `DATABASE_URL` once already. Use the dashboard for env vars.

| # | Variable | Value source | Effect when set |
|---|---|---|---|
| 1 | `CRON_SECRET` | Use this generated value: `18ddde488d98ca8d36730abcfcd74c4a6988094c3eafaa011e6684a56836119e` | Monthly cron fires on the 1st of each month at 02:00 UTC |
| 2 | `RESEND_API_KEY` | resend.com → API keys → Create | Outbound email starts working: forgot-password OTP, payment-failed alerts, monthly report email |
| 3 | `RESEND_WEBHOOK_SECRET` | resend.com → Webhooks → add endpoint `https://matflow-nine.vercel.app/api/webhooks/resend` (tick all 6 events) → reveal Signing Secret | EmailLog status updates flow back |
| 4 | `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys → Create | Claude AI causal monthly report generates real content (cron currently no-ops) |
| 5 | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | console.cloud.google.com → APIs & Services → Credentials → OAuth 2.0 Client ID. Authorized redirect URI: `https://matflow-nine.vercel.app/api/drive/callback` | Google Drive integration (skip if not using; UI throws otherwise) |

### 2. Resend account setup (steps for #2 and #3 above)

1. Sign up at https://resend.com (free tier = 3,000 emails/month)
2. Skip "Add Domain" for now — code falls back to `MatFlow <onboarding@resend.dev>` (works, but spam-flagged)
3. **API Keys** → Create → name `matflow-prod`, permission **Sending access**, all domains → copy the `re_...` value → paste as `RESEND_API_KEY` in Vercel
4. **Webhooks** → Add Endpoint → URL `https://matflow-nine.vercel.app/api/webhooks/resend` → tick events: `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.delivery_delayed`, `email.failed` → save → click endpoint → Signing Secret → Reveal → copy `whsec_...` value → paste as `RESEND_WEBHOOK_SECRET` in Vercel

### 3. (Optional, when you buy a domain) Resend domain verification

When you own a domain (e.g. `matflow.com`):
1. Resend → Domains → Add Domain → enter your domain
2. Resend gives 3 DNS records (1 SPF + 2 DKIM TXT). Add them at your registrar (Cloudflare/Namecheap/etc).
3. Wait until Resend marks "Verified".
4. Add Vercel env var `RESEND_FROM="MatFlow <noreply@yourdomain.com>"`.

Result: emails stop landing in spam folders.

### 4. (Optional) Stripe smoke test

Each gym owner connects their own Stripe — you don't need an account for the platform to work. But for testing:
1. https://stripe.com/connect → create a sandbox connected account
2. Click `/dashboard/settings → Revenue → Connect with Stripe` from a logged-in owner session
3. In Stripe Dashboard → Developers → Webhooks → "Send test event" → `invoice.payment_succeeded` → confirm 200 from MatFlow

---

## Things I can pick up next session (no credentials needed)

### Feature work
- **WP1 Magic-link login** — schema is in place. Add `/api/auth/magic-link/request` + `/api/auth/magic-link/verify` endpoints, the `magic_link` email template in `lib/email.ts`, and a "Email me a link" mode on the login page. ~half day.
- **WP3 Owner-supervised waiver flow** — new page `/dashboard/members/[id]/waiver` for handing the iPad to a walk-in member. Reuses the SignaturePad component already in place. ~half day.
- **`Tenant.memberSelfBilling` flag** — schema migration + gate `/api/stripe/portal` and the member-side billing UI behind it. Per saved memory: owner-managed billing is the default. ~couple hours.
- **`/apply` spam protection** — currently unauthenticated form with no rate limit or captcha. Add either a Cloudflare Turnstile or a simple Resend-verified email loop. ~half day.

### Polish from the audit backlog
- **Audit P2 batch 1** — defensive tenant-scope sweep on 4 routes + ESLint rule, error-shape standardisation, missing Stripe event handlers (`subscription.updated`, `invoice.voided`, `payment_intent.succeeded`, `customer.deleted`, `payment_method.detached`), refund delta vs cumulative, currency fallback flip. ~1 day.
- **Audit P2 batch 2** — optimistic concurrency on `/api/members/[id]` and `/api/staff/[id]` PATCH (`updatedAt` precondition + 409 on conflict) + SWR invalidation in dashboard list views. ~half day.
- **Audit P3 batch 1** — mobile / a11y polish (E.164 phone validation, DOB bounds, OTP `inputMode="numeric"` + countdown, aria-labels on icon buttons, MembersList mobile column hiding). ~half day.
- **Audit P3 batch 2** — schema cleanup (`Payment.status` enum, `deletedAt` on `RankSystem`/`Class`) + log correlation IDs + drop dead Sidebar `plan?` prop. ~half day.

### Tech debt
- **CSP tightening** — drop `unsafe-eval` from `next.config.ts`, plan a nonce pattern for `unsafe-inline` removal. ~half day.
- **Bump next-auth off beta** when 5.0.0 stable lands; pin exact version. (Watch upstream releases.)
- **Test coverage push** — target 40+ integration tests (Stripe webhook branches, dispute paths, Drive token refresh, password reset transaction, refund clamping, signed-waiver decode). Gated on extracting a service layer first. ~2 days.

### Known smaller fixes
- Fix 4 pre-existing test failures (`checkin-duplicate.test.ts` + `security.test.ts`) — update mocks for US-009 `tenantId` field + US-012 `401`-not-`404` change. ~1 hour.
- DashboardStats post-deploy visual review — `b811589` was a WIP redesign with no browser test. ~1 hour to walk through and tighten.
- Verify dashboard list-view consumers handle the new `{members, nextCursor}` shape from `/api/members` — the response shape changed in US-010. ~1 hour.

---

## Reference

| Doc | Purpose |
|---|---|
| [docs/AUDIT-2026-04-27.md](docs/AUDIT-2026-04-27.md) | 115-finding code audit (security/concurrency/perf) — 59 P0/P1 fixed, 56 P2/P3 deferred |
| [PRODUCTION_QA_AUDIT.md](PRODUCTION_QA_AUDIT.md) | Live-probe production audit (proxy gaps, env config) — all P0s closed except RESEND_API_KEY |
| [OWNER_SITE_SUMMARY.md](OWNER_SITE_SUMMARY.md) | Owner-side page-by-page inventory with current open/closed status |
| [.claude/projects/.../memory/MEMORY.md](C:/Users/NoeTo/.claude/projects/c--Users-NoeTo-Desktop-matflow/memory/MEMORY.md) | Project memories (billing default, etc) |

---

## Closed beta launch checklist

In rough order of importance once env vars are set:

- [ ] Set the 5 Vercel env vars above
- [ ] Click Redeploy in Vercel
- [ ] Smoke-test login as seeded owner (`alex@example.com` / `password123` won't work in prod — that's the seeded local member; actually need to seed prod or have your own owner)
- [ ] Send test Resend email (e.g. trigger a forgot-password) and confirm it arrives
- [ ] Walk through Stripe Connect with a real or sandbox account
- [ ] Reach the apply page, complete the form, watch a tenant get created
- [ ] Hand the URL to your first real gym
