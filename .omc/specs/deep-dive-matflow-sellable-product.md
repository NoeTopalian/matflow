# MatFlow — Sellable-Product Readiness Assessment & Launch Plan

**Date:** 2026-08-14 · **Method:** /deep-dive (3 parallel read-only trace lanes → interview → this plan) · **Mode:** plan-mode (no repo writes; trace synthesis lives here instead of `.omc/specs/`)

## Context

Noe wants a full assessment of everything standing between the current MatFlow build and a **usable, sellable product** — functionality, Stripe/refunds, legal, ops. The deliverable is this plan: the gap map plus the ordered work to close it.

**The bar (locked with Noe, 2026-08-14):**
- **Sellable = concierge sale.** One paying gym; Noe onboards them personally, imports their data, holds their hand. Self-serve polish explicitly NOT required. (Q35 verdict context: 1 paying non-Sean customer by 1 Sept 2026; Sean/TotalBJJ = beta gym #1 on TeamUp.)
- **SaaS fee stays manual.** £99/£149/£199 per month collected via Stripe Payment Link / invoice; `Tenant.subscriptionStatus` flipped by hand. No automated tenant billing before first sale.
- **Seller = Noe as UK sole trader** for now; **MatFlow Ltd to be incorporated on UK return (~27 Aug)**. Interim: strip the "Ltd" claim from live pages.
- **matflow.io is not safely owned** (lapsed/unsure; parked on GoDaddy) — all references move to matflow.studio.

**Baseline already established (prior audits, verified where possible):**
- 2026-07-06 re-verify: launch readiness ~7.5/10 — "blocked-by-config, not blocked-by-code". Stripe webhook reachable in prod (400 w/o signature); legal pages 200; payments path live. `RESEND_WEBHOOK_SECRET` proven unset in prod (Resend webhook 503).
- Since then on `main`: `stripeAccountId` schema drift reconciled (db0c578), per-tenant GET `Cache-Control: no-store` (a17d1c5), legacy `/checkin/:slug` → `/login` redirect (110e06f).
- 2026-06-25 Playwright audit: app features working; ~62 failures were test-drift, not defects. Profile pictures verified end-to-end.
- Marketing landing page + pricing + apply section EXISTS at `/` (app/page.tsx). Stripe Connect payouts operational (LIVE) since 2026-07-06.
- In-flight on branch `fix/audit-reverify-followups-2026-07` (uncommitted): kids-waiver work (US-F8), Vercel Blob private-access migration (US-B3), class-form validation toast (US-B4), `app/api/members/[id]/waiver-link/`, blob-diagnosis + owner-recovery scripts. `.omc/prd.json` shows all 4 stories `passes: false`.

## Trace lanes (confirmed by Noe)

1. **Product completeness** — every journey end-to-end at the concierge bar. → findings below
2. **Money path** — Connect health, refunds/disputes/dunning, subscription lifecycle, what `subscriptionStatus` actually gates, TESTING_MODE blast radius. → findings below
3. **Sellability shell** — legal content quality, UK GDPR processor duties (DPA, ICO fee), email system truth, ops (crons, Sentry, backups, runbook), apply→onboard funnel, offboarding/export. → findings below

## Lane findings

_(pending — 3 background agents running)_

### Lane 1 — Product completeness ✅ (complete)

**Journeys verdict:** nearly everything a gym touches daily **works**, verified at file level: onboarding wizard (9 steps + TOTP), timetable CRUD, dashboard check-in incl. walk-ins (C6 fixed), kiosk + multi-kid picker, attendance, ranks/promotions, announcements, tasks, reports (real Prisma data), payments inbox, member home/schedule/profile (C1/C2/C3/C5 all fixed), self-serve billing behind `memberSelfBilling`, shop, parent/child accounts, kids waiver (Feature 8 **done** end-to-end despite stale prd.json). CSV import **works** — owner-gated, dry-run preview, dedupe, per-row errors, 25-row batching, post-import blob delete (`lib/importers/index.ts`, `app/api/admin/import/*`, `components/dashboard/ImportPanel.tsx`), plus a purpose-built **white-glove handoff** route (`app/api/onboarding/csv-handoff/route.ts`) that emails the CSV to MatFlow for concierge import. The May "no import = blocker" claim is stale. No TeamUp preset, but the `generic` adapter maps the headers a TeamUp export carries.

**The #1 product blocker: imported members are permanently locked out.** Import commit creates rows with null `passwordHash` and mints no invite (`app/api/admin/import/[id]/commit/route.ts:71-87`); magic-link (`app/api/magic-link/request/route.ts:49`) and forgot-password (`app/api/auth/forgot-password/route.ts:66-69`) both filter `passwordHash: { not: null }`, closing both self-service doors; no resend-invite route exists (docs admit delete-and-recreate). Import 200 TotalBJJ members → all 200 locked out, owner must hand-record everything (stacking into Lane 2's manual-payment defects). Fix is M-sized: bulk-invite action reusing the proven token block at `app/api/members/route.ts:284-314` (single staff-create invites work fine — H8 closed).

**In-flight branch truth:** Bug 4 (class-form toast + API error surfacing) **DONE**. Feature 8 **DONE**. waiver-link route **code-complete but untracked** — the committed UI button (`components/dashboard/MemberProfile.tsx:289`) 404s in any build until `git add`. Bug 3 **half-done**: auth-gated proxy + helper exist (`app/api/blob-image/route.ts`, `lib/blob-url.ts`), but uploads are still `access: "public"` at all three `put()` sites — profile pics (`app/api/upload/route.ts:212`), waiver signatures (`lib/waiver-signature-upload.ts:25`), import CSVs (`app/api/admin/import/upload/route.ts:83`, whose "no private mode" comment is disproven by `app/api/initiatives/[id]/attachments/route.ts:57` already using private). Playwright specs from prd.json: untouched.

**Other notable gaps:** push notifications are dead code advertised as a feature (`app/sw.ts:4-12` dormant, never registered; subscribe endpoints accept subscriptions delivered to nobody); PWA manifest `start_url: "/dashboard"` strands installing members on a staff route; progress page flashes fake `DEMO_MEMBER` "Alex Johnson · Blue Belt · 47 classes" before fetch resolves (`app/member/progress/page.tsx:28-44,114,146`); ranks/belts don't import (no field in `MemberDraft`); imported `membershipType` is free text, not a plan FK — plan/revenue reporting blank until relinked.

**Critical unknown:** whether existing prod blob URLs (logos, member photos) still resolve — determines if flipping uploads to private is clean or breaks every existing image. The read-only probe script is already written (`scripts/inspect-blob-urls.mjs`, prints hosts only); run it against prod. Companion: unauthenticated `GET /api/blob-image?url=…` should 401.

### Lane 2 — Money path ✅ (complete)

**Money flow map.** All member charges are **direct charges on the gym's connected account** (`{stripeAccount}` option everywhere: `lib/stripe/subscriptions.ts:67-159`, `app/api/member/checkout/route.ts:200`, `app/api/member/class-packs/buy/route.ts:120`, `app/api/members/[id]/charge/route.ts:75`) — the **gym is merchant of record and eats disputes**; MatFlow takes **zero platform fee** (no `application_fee`/`transfer_data`/`on_behalf_of` anywhere). Four rails: subscriptions (default_incomplete, card or BACS), class packs (Checkout), shop orders (Checkout), owner ad-hoc off-session charge. Plus manual/cash ledger + pay-at-desk orders. **SaaS-fee billing code doesn't exist at all** (matches the manual decision); `Tenant.subscriptionStatus` is decorative except `"suspended"` (blocks login `auth.ts:180`, 404s branding); `"cancelled"` blocks nobody; `"trial"` gates nothing, no trial-expiry field/cron. The admin **suspend** lever is nuclear: cancels every member subscription at period end + kills all JWTs (`app/api/admin/customers/[id]/suspend/route.ts:73-115`) — never use it for a missed SaaS invoice.

**Webhook layer** (`app/api/stripe/webhook/route.ts`): hygiene is strong — signature verify, `StripeEvent.eventId` claim-before-process idempotency with rollback-on-failure, emails deferred post-commit. Coverage is good (payment_failed/succeeded, sub deleted/updated, checkout completed, PI succeeded/processing, charge.refunded, dispute created/updated, account.updated, mandate.updated, invoice.voided). **Requires `event.account`** — endpoint must be registered as a Connect endpoint or the whole layer silently no-ops (400s).

**Refunds** (`app/api/payments/[id]/refund/route.ts`): owner-only, CSRF, rate-limited, partial amounts, live cumulative-cap check, idempotency key, class-pack void, honest 500-with-refundId on Stripe-ok-DB-fail, tested. Missing: see gaps 2, 5, 7 below; no refund email template exists; BACS refund delay not modelled.

**Dunning**: `invoice.payment_failed` → member `overdue` + member email + every-owner email + `/dashboard/payments` Failed tab. Retries = Stripe Smart Retries only. **`overdue` does not revoke kiosk access** (`lib/checkin.ts:136-140` — kiosk falls through as `uncovered_kiosk`). Emails fire-and-forget (`.catch(() => {})`); member-with-no-email means owner is never told either (owner loop nested inside member-email guard, webhook `:227`).

**Gap list ranked by financial risk** (S/M/L = size):

| # | Gap | Consequence | Evidence | Size |
|---|---|---|---|---|
| 1 | **Chargebacks silent to the gym** — Dispute row + `evidenceDueAt` written, zero notification; only surfaced on platform-admin page | Gyms miss evidence deadlines → lose disputes by default | webhook `:564-644`; `app/admin/billing/page.tsx:53-58` only UI | S email / M UI |
| 2 | **Subscription refunds don't touch the subscription** — no cancel/proration/pause; member re-billed next cycle, keeps training | Refund ≠ resolution; angry members, chargeback risk | refund route has zero `stripeSubscriptionId` refs | M |
| 3 | **Ad-hoc charge lacks idempotency key** (`confirm:true`) | Double-click/retry = real double charge | `app/api/members/[id]/charge/route.ts:65-76` (pattern exists at refund `:110`) | S |
| 4 | **`charge.dispute.closed` unhandled** | Dispute stuck `under_review`; lost-dispute credit-void may never run | webhook `:45-46` | S |
| 5 | **Dashboard-issued refunds don't void class-pack credits** | Refunded member still burns credits | webhook `:440-449` vs refund route `:133-148` | S |
| 6 | **Cash class-pack purchase can never be fulfilled** — pending Payment; only `MemberClassPack.create` site is the webhook | Member pays cash, gets zero credits | `app/api/payments/intent/route.ts:42-73` | M |
| 7 | **Partial refund is one-shot** — status `refunded` + 409 on retry locks the remainder | £10 of £50 refunded → £40 unrefundable in-app | refund `:58,125-131` | S |
| 8 | **Currency hardcoded `gbp`** on shop checkout + subscription-plan creation despite EUR/USD tenants | Wrong-currency charges for non-GBP gyms | `checkout/route.ts:171`; `subscription-plans/route.ts:110` | S |
| 9 | Currency case drift (`"gbp"` vs `"GBP"`) breaks grouping | Ledger inconsistency | `charge/route.ts:95` vs webhook `:215` | S |
| 10 | Owner payments page hardcodes `£`, row type lacks `currency` | Wrong symbols for non-GBP gyms | `app/dashboard/payments/page.tsx:20-30,60-62` | S |
| 11 | Pay-at-desk shop fallback unreachable in prod (gated on platform key absence) | Unconnected gym's sale → flat 400, no Order | `checkout/route.ts:102-150` | S |
| 12 | Class-pack expiry lazy (member-triggered only, no cron) | Reporting wrong; check-in itself safe | `member/class-packs/route.ts:27-33` | S |
| 13 | Class-pack Checkout doesn't pin `payment_method_types` → BACS grants credits ~4 days pre-settlement | Credit risk if gym enables BACS | `class-packs/buy/route.ts:104-121` vs `checkout/route.ts:192` | S |
| 14 | `/api/payments/intent` only money route without CSRF guard | CSRF-created pending payments | `payments/intent/route.ts:9-13` | S |
| 15 | No receipts from MatFlow (`receipt_email` = 0 hits) | Members get receipts only if gym enabled Stripe's | grep | S |
| 16 | `orders/mark-paid` writes no Payment row | Cash sales missing from ledger/CSV | `orders/[id]/mark-paid/route.ts:63-71` | S |
| 17 | Connect disconnect doesn't cancel live subscriptions | Orphaned billing MatFlow can't see/refund | `stripe/disconnect/route.ts:22-38` | M |

**TESTING_MODE verdict:** inert in prod for 2FA — `lib/testing-mode.ts:14` hard-guards `VERCEL_ENV === "production"`; RUNBOOK claim is stale. Caveat: `auth.ts:157` (rate-limit skip) and `auth.ts:218-224` (`E2E_BYPASS_TOKEN` bcrypt bypass) read the RAW env var guarded only by `isLocalhost`, whose predicate treats unresolvable IP (`"unknown"`) as localhost — not currently exploitable (Vercel always sets `x-forwarded-for`) but a latent password-bypass primitive; keep both vars OUT of prod env. DEMO_MODE throws at boot in prod — safe.

**Critical unknown:** whether the live Stripe webhook endpoint is registered as a **Connect** endpoint with the right event types ticked — handlers are dead code otherwise (route hard-400s events lacking `event.account`).
**Discriminating probe:** logged-in owner GET `/api/stripe/connect/health` (pure read) — returns key mode (live/test), webhook-secret presence, platform account ok, and `stripeAccountStatus.refreshedAt`; a recent `refreshedAt` proves Connect events are arriving. Pair with Stripe Dashboard → Webhooks event-list vs `HANDLED_EVENT_TYPES`.

### Lane 3 — Sellability shell ✅ (agent summary + direct verification)

**THE hard config blocker: email doesn't deliver.** `matflow.studio` has **no SPF, no DKIM, no DMARC, no MX** (externally verified against 8.8.8.8 with an A-record control). Every email — invites, owner activation, magic links, dunning, application notifications — falls back to Resend's sandbox sender `onboarding@resend.dev` (`lib/email.ts:331`), which only delivers to the Resend account owner's own inbox and is spam-flagged elsewhere. Concrete kill: application approval creates the tenant and mints a 30-min magic link (`app/api/admin/applications/[id]/approve/route.ts:126-180`) but prod deliberately withholds the link from the API response (`:193`) — so **a new gym owner can never be activated**. The fix is `docs/EMAIL-SETUP-RUNBOOK.md` (written 2026-05-07, never executed): ~75 min of Resend + Vercel-DNS clicks, doable from Bali.

**Legal pages: strong substance, wrong party, live draft banner.** All four pages (`/legal/terms`, `/legal/privacy`, `/legal/aup`, `/legal/subprocessors`) ship a visible "draft pending legal review" banner (`app/legal/layout.tsx:20`). Terms + privacy name **"MatFlow Ltd"** (doesn't exist; Noe: incorporation happens on UK return ~27 Aug) and give contact addresses on **matflow.io** (Noe: not safely owned — parked on GoDaddy, no MX; publishing legal/privacy contacts on an unowned domain is a hijack risk). The substance is genuinely good: correct merchant-of-record clause (gym eats chargebacks — matches Lane 2's code reality), correct controller/processor split, UK GDPR lawful bases, retention schedule, IDTA/SCCs, honest subprocessor table (Neon eu-west-2, Vercel, Stripe, Resend, Vercel Blob, Anthropic + Google Drive as opt-in). **Missing: a children's-data section** (kids accounts are a core feature; parental-consent flow exists in product but the policy is silent). Minor overstatements: subprocessor table claims "Stripe Tax" (unused) and "anonymised" for the AI report (gym name + owner free-text notes do go to Anthropic — `lib/ai-causal-report.ts:190,197`; aggregates otherwise, no member PII).

**Two shipped claims the system can't back (misrepresentation risk):** Terms §8 promises deletion 30 days after cancellation — **no purge job exists** (one cron total: `monthly-reports`, `vercel.json`); and the landing page's "RLS-isolated — another gym's data cannot touch yours" claim vs `docs/RUNBOOK.md:165` recording the app's DB role retains **BYPASSRLS**, making the RLS policies no-ops (app-layer `where: {tenantId}` filters are the real isolation — they exist, but the claim oversells).

**Verified clean (unusual and good):** no invented testimonials (landing strip = three factual capability pillars), no analytics/trackers at all (so no cookie banner needed), no member PII to Anthropic, apply funnel real and hardened (zod + fail-closed rate limit + DB write + dual notification — though the internal default recipient is `hello@matflow.io` when `MATFLOW_APPLICATIONS_TO` unset), approve→activation chain fully wired in code, Sentry wiring present (`sentry.*.config.ts`, `instrumentation.ts`, 5xx forwarding in `lib/api-error.ts:27`) pending DSN in prod, 17 email templates (none for refunds/disputes — matches Lane 2), default adult + kids waivers coherent for a UK gym (though the blanket liability release overreaches UCTA s.2(1) for personal-injury negligence — needs a "not legal advice" note), DSAR export + payments CSV exist; no general member-export (offboarding gap, M); `Tenant.customDomain` is a dormant field (not wired — fine, don't sell it).

## Synthesis: the verdict

**The product is closer than the folklore says.** Every daily-use journey works; the June Playwright audit's "features work" conclusion held up under file-level re-verification; most of the April criticals and the prd.json stories are already fixed (prd.json flags are stale). What stands between this and a paying gym is **not a rewrite — it's 1 config afternoon + ~a week of targeted code + a legal tidy-up**:

1. **Email DNS was never set up** → nothing the product sends can reach anyone. Single biggest unlock, zero code, ~75 min.
2. **Imported members can't ever log in** → the concierge onboarding dead-ends after import. One M-sized bulk-invite action.
3. **Legal shell says the wrong things** → non-existent Ltd, unowned domain, draft banner, two promises code can't back, no children's-data section. Mostly S-sized edits + user actions on UK return.
4. **Money path has a short list of real exposures** → silent chargebacks, subscription refunds that keep billing, a double-charge primitive, public PII blobs. All S/M.

## The plan

### Phase 0 — User actions, no code (do from Bali; ~2h total)
| # | Action | Why / evidence |
|---|---|---|
| 0.1 | **Run `docs/EMAIL-SETUP-RUNBOOK.md`** end-to-end: verify matflow.studio in Resend (SPF+DKIM+DMARC in Vercel DNS), set `RESEND_API_KEY`, `RESEND_FROM=MatFlow <no-reply@matflow.studio>`, `EMAIL_FROM`, `RESEND_WEBHOOK_SECRET` in Vercel prod env | Everything (invites, activation, dunning) is dead until this. Runbook is step-by-step, ~75 min |
| 0.2 | Set remaining prod env: `MATFLOW_APPLICATIONS_TO=<your real inbox>`, confirm `SENTRY_DSN`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`, `ANTHROPIC_API_KEY` (or accept the monthly-report cron failing) | July audit: only Resend secret provably missing; rest unverified |
| 0.3 | Stripe dashboard (10 min): confirm webhook endpoint is **Connect-type** ("listen to connected accounts") and its ticked events ⊇ `HANDLED_EVENT_TYPES` (`app/api/stripe/webhook/route.ts:32-48`); then as owner GET `/api/stripe/connect/health` and check `stripeAccountStatus.refreshedAt` is recent + key mode = live | Lane 2's critical unknown — handlers are dead code if endpoint is account-type |
| 0.4 | Run `node scripts/inspect-blob-urls.mjs` (read-only, prints hosts only) against prod | Answers whether Bug 3's private-flip breaks existing images |
| 0.5 | **On UK return (~27 Aug):** incorporate MatFlow Ltd → then ICO data-protection fee registration (~£52/yr) → then first invoice. Meanwhile: professional indemnity + cyber insurance quote (~£15-30/mo). VAT: nothing to do until £90k turnover. DPA: terms+privacy already embed processor commitments; generate a proper Art-28 DPA template for signature with gym #1 (flag "have it reviewed" — not legal advice) | Entity decision as answered; don't invoice before the entity exists |

### Phase 1 — Launch-blocking code (before onboarding TotalBJJ; ~3-5 days)
| # | Change | Size | Key files |
|---|---|---|---|
| 1.1 | **Bulk-invite + resend-invite for imported/existing members**: post-import "Send invites" action + per-member resend button; reuse the proven token block | M | `app/api/admin/import/[id]/commit/route.ts`, new bulk route reusing `app/api/members/route.ts:284-314`, `MemberProfile.tsx` |
| 1.2 | **Commit the waiver-link route** (currently untracked; committed UI button 404s) | XS | `git add app/api/members/[id]/waiver-link/` |
| 1.3 | **Finish Bug 3**: flip 3 `put()` sites to `access:"private"` (pattern proven at `initiatives/[id]/attachments/route.ts:57`), migrate/verify existing URLs per probe 0.4, delete stale comment | S | `app/api/upload/route.ts:212`, `lib/waiver-signature-upload.ts:25`, `app/api/admin/import/upload/route.ts:83` |
| 1.4 | **Dispute alerting**: owner email on `charge.dispute.created` (new template + `pendingEmails` in webhook), handle `charge.dispute.closed`, surface disputes on `/dashboard/payments` | S+S | `app/api/stripe/webhook/route.ts:564-644`, `lib/email.ts` |
| 1.5 | **Subscription-aware refunds**: refund route detects subscription payments → require explicit choice (refund-only / refund+cancel at period end / refund+cancel now), notify member (new template) | M | `app/api/payments/[id]/refund/route.ts` |
| 1.6 | **Idempotency key on ad-hoc charge** (copy refund pattern) | XS | `app/api/members/[id]/charge/route.ts:65-76` |
| 1.7 | **Legal/content pass**: "MatFlow Ltd"→"MatFlow" (until incorporation, then flip back), matflow.io→matflow.studio everywhere (legal pages, `hello@` default in `app/api/apply/route.ts:79`), remove draft banner after Noe reads the pages, add children's-data section to privacy, drop "Stripe Tax" + fix "anonymised" wording, reword Terms §8 deletion promise to match reality (purge cron = fast-follow), soften landing "RLS-isolated" pillar, add "template — not legal advice" note to default waivers | S | `app/legal/*`, `app/legal/layout.tsx:20`, `components/landing/SocialProofStrip.tsx` |
| 1.8 | **Kill the DEMO_MEMBER flash** on member progress (loading state instead of fake data) | S | `app/member/progress/page.tsx:28-44,114` |
| 1.9 | **PWA honesty**: manifest `start_url` → `/member/home` (role-appropriate), hide push-notification UI until SW is actually registered | XS+S | `app/manifest.ts`, member settings |
| 1.10 | **Refund correctness pair**: allow repeated partial refunds up to cap (drop one-shot 409), make webhook `charge.refunded` respect partials + void class-pack credits (parity with API route) | S | `app/api/payments/[id]/refund/route.ts:58,125-131`, webhook `:428-449` |
| 1.11 | Small money fixes: CSRF on `/api/payments/intent`; `Tenant.currency` instead of hardcoded `"gbp"` (checkout + subscription-plans); uppercase-normalise currency; hide cash option for class packs until fulfilment exists (or build `mark-paid→grant credits`, M) | S | per Lane 2 gaps 8/9/11/14/6 |
| 1.12 | Housekeeping: update stale `.omc/prd.json` flags; commit the two audit docs + spec sitting untracked | XS | — |

### Phase 2 — The TotalBJJ concierge sale (the actual revenue event)
1. Export members from TeamUp → map columns to the `generic` importer (name/email/phone/dob/membership/status/joined). Optional S-sized nicety first: add `rank` column support to the importer so ~200 belts don't need hand-setting.
2. Import on prod (dry-run preview → commit) → **bulk-invite (1.1)** → members set passwords via invite email (now deliverable after 0.1).
3. Sean connects Stripe (Revenue tab OAuth), decides `memberSelfBilling` on/off, sets tiers/prices; waivers reviewed (adult + kids defaults + his edits); kiosk token minted for the front desk.
4. Commercials: agree tier (£99/£149/£199), send Stripe Payment Link invoice **after incorporation (~27 Aug)**, flip `subscriptionStatus` to `active` by hand. Never use admin **suspend** for non-payment of the SaaS fee (it cancels all his member subscriptions — Lane 2).
5. Support channel: a named email on matflow.studio + your phone; add it to the terms contact section.

### Phase 3 — Fast-follow (first month with a paying gym)
Receipts (`receipt_email`), payout-failure visibility, `checkout.session.expired`/async-failed Order cleanup, `orders/mark-paid` Payment-ledger row, class-pack expiry cron, Connect-disconnect subscription handling, cancellation-data purge cron (then restore Terms §8 wording), non-BYPASSRLS DB role (then restore the landing pillar), CSP `unsafe-inline` removal via nonces, `/apply` captcha, member/attendance CSV export (offboarding), proper TeamUp importer preset, real Serwist registration + push delivery, overdue-member kiosk policy decision (Lane 2: `uncovered_kiosk` currently admits overdue members — make it a per-tenant setting), Playwright specs from prd.json + one for bulk-invite.

## Verification

- **Gate on every Phase-1 PR**: `npm run lint && npm test && npm run build` (CI already gates unit + lint).
- **Import→invite E2E** on a **seeded Neon test branch** (never local `.env` prod URL — e2e specs reset TOTP on whatever `DATABASE_URL` points at): CSV of 5 members incl. 1 kid → commit → bulk invite → accept-invite page sets password → login → kiosk check-in.
- **Stripe test-mode walk** (Stripe CLI `stripe trigger` against a test connected account): `charge.dispute.created` → owner email lands; subscription refund → member notified + subscription cancelled per choice; partial refund twice → second succeeds, cap enforced; `charge.refunded` from dashboard → credits voided.
- **Blob privacy**: after 1.3, unauthenticated blob URL fetch fails; `GET /api/blob-image?url=…` unauthenticated → 401; existing prod logos/photos still render (probe 0.4 list re-checked).
- **Email**: after 0.1, send test invite to a Gmail address → lands in inbox (not spam), From = matflow.studio; Resend webhook 200s (EmailLog advances past `sent`).
- **Live prod probes**: `/legal/terms` shows no "Ltd", no draft banner, matflow.studio contacts; landing pillar updated; `POST /api/stripe/webhook` unauth → 400; `/api/stripe/connect/health` all-green.
- **Playwright**: the three prd.json specs + settings-waiver + timetable-create toast, run `--project=chromium` against the test branch.

## Deviations from the deep-dive skill (noted)
Plan mode forbade repo writes: trace synthesis + spec live in this plan file instead of `.omc/specs/deep-dive-*.md`; no `state_write` checkpoints. Two lane agents lost their reports to a Stop-hook/529 failure chain — Lane 1 recovered from its transcript, Lane 3 reconstructed from its failure-summary + direct verification of every load-bearing claim (legal pages, crons, apply route, email templates, importers, Sentry, waiver defaults read first-hand).
