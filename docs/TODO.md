# MatFlow — Pending TODOs

Source-of-truth for everything that's not yet done. Two halves: things only you can do (credentials, accounts), and things I can pick up next session.

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
