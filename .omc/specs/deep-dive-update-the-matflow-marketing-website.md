# Spec: MatFlow marketing website upgrade

Date: 2026-08-22 (Bali). Source: deep-dive (trace: `.omc/specs/deep-dive-trace-update-the-matflow-marketing-website.md`). Ambiguity at sign-off: ~0.05.

## Goal

Make the public site (matflow.studio) read like a professional product a gym owner can evaluate and trust: every real feature explained, the system made clear, a credible competitor comparison page, and every claim on the site verifiably true. Structure over restyle — the "Dark Precision" visual language stays.

## Locked decisions (Noe, 2026-08-22)

1. **Pricing: custom, no numbers anywhere.** "Priced around your gym — apply and we'll build your package." No £ figures on any page. Consequence: the comparison page must NOT attack Mindbody/Glofox for hidden pricing (we'd be doing the same); the wedge shifts to no-revenue-cut + branded-app-included + UK-native + white-glove.
2. **Positioning: UK martial arts clubs** (broadened from "UK BJJ academies only"). BJJ becomes a first-class example, not the frame. Code supports this: rank systems are per-discipline.
3. **Comparison page: yes, 4 named vendors** — Martialytics, Gymdesk, Zen Planner, Mindbody. PushPress/Glofox/TeamUp deliberately excluded (free-tier price fight; BJJ logos; wrong buyer).
4. **Scope: full** — new `/features`, `/pricing`, `/compare` pages + credibility fix-list + landing copy sharpened.
5. **30-day trial stays** as a service promise (not a product mechanic): "30-day trial from go-live — no card details, you're only invoiced if you stay." Honoured manually.

## Constraints

- **The DO-NOT-CLAIM list is binding** (from verified feature inventory, 2026-08-22): no push notifications; no "works offline" (say "installs to the home screen"); no "RLS-isolated"/"database-level isolation" (say "every query tenant-scoped in an enforced transaction wrapper"); no custom domains; no self-serve trial mechanics; no "kiosk blocks unpaid members"; no per-session seat booking or member-facing waitlist; no "TeamUp import" preset (say "MindBody, Glofox, Wodify or any CSV"); no "MatFlow Ltd" until incorporation is verified; no "Stripe Tax"; AI report is "AI-drafted monthly report", not "AI insights engine"; announcements are in-app, not "push blasts".
- **UI-RULES.md governs**: public surface palette defined **once per surface** (fix the current 9× re-typing); zero NEW hex literals in .tsx (the CI ratchet `scripts/check-ui-rules.mjs` must not regress); new generic UI uses `components/ui/` primitives; text contrast ≥4.5:1; British English, sentence case, no exclamation marks; never render fabricated data.
- **Comparison-page safety rules**: every competitor fact from the vendor's own page, dated "retrieved 22 August 2026", hyperlinked; "Not publicly listed" where true (Mindbody per-tier) — never inferred numbers; no second-hand processing rates; a "when to choose them instead" concession block per vendor; footer disclaimer ("Comparison based on publicly available information as of 22 August 2026. All trademarks property of their respective owners. Verify current pricing with the vendor.").
- **Parallel-session hazard**: another session is active on this repo. Check `git status` before editing; marketing files (`app/page.tsx`, `components/landing/*`, new routes) are disjoint from its member-area work, but do not touch `app/member/**`, `lib/member-stats.ts`, `prisma/schema.prisma`.
- Do not run Playwright e2e locally (prod-DB hazard). Verification = lint + unit tests + build + ratchet + manual visual pass.

## Non-goals

Visual redesign; building trial/tier billing machinery; push delivery; custom domains; migrating the existing landing's 120 inline styles wholesale (only the palette consolidation); blog; self-serve signup; changing the apply funnel mechanics.

## Deliverables

### D1 — Landing page rewrite (`components/landing/*`, `app/page.tsx`)
- Reposition all copy to **UK martial arts clubs** (hero eyebrow, H1/sub, fine print, OG/meta). BJJ/judo/MMA named as examples. Remove "UK BJJ academies only".
- Unify the three product descriptions (layout, page metadata, manifest) to one line, e.g. "The operating system for UK martial arts clubs."
- Pricing section: strip £89, "up to 150 members", tier language → custom-pricing block ("Every club gets a tailored package…") + the included-with-every-package list (kept truthful: drop "Email and chat support" → "direct email support"; keep white-glove migration, no setup fees, cancel anytime, 30-day trial reworded per locked decision 5).
- "Five fields, two minutes" → match the real six-field form ("a two-minute form").
- Fine-print/footnote contrast raised to ≥4.5:1 (alpha ≥0.48 over `#0a0908`).
- Fix stale `{/* gold */}` comments on blue elements (`FinalCTA.tsx:15`, `PricingSection.tsx:60`).
- Hero/HowItWorks mock data: replace invented people ("Alex Reed", "Apex Academy") with the seeded demo tenant's data or neutral illustrative initials; keep the stylised product-shot treatment.
- Nav + footer gain Features / Pricing / Compare links.
- Extract the landing palette to a single shared module (e.g. `components/landing/palette.ts`) consumed by all landing components and the new pages — UI-RULES §1 compliance, zero new hex.

### D2 — `/features` page (new route `app/features/page.tsx`)
All real features explained, grouped for a gym owner, sourced from the safe-to-claim inventory:
1. **Members & families** — profiles, emergency contacts, statuses, notes; kids accounts done properly (parent login, per-child schedule/waiver/billing, DB-enforced invariants).
2. **Timetable & check-in** — recurring classes, capacity, coach, rank-gated sessions; staff desk check-in; coach register with tick-off; **kiosk**: iPad at the door with its own revocable URL, no staff login, never admin access.
3. **Belts & gradings** — per-discipline rank systems with stripes, promotion thresholds (mat-time + months), promotion queue ("the app brings the evidence; you decide"), full history incl. demotions, promotion photos.
4. **Payments** — Stripe Connect into the club's own account, **no cut of revenue**; subscriptions (card/BACS), class packs, shop, ad-hoc charges, manual cash ledger; refunds that auto-void pack credits; overdue chasing; CSV export.
5. **Reports & analysis** — live attendance/churn/retention/net-new/payment-health over a configurable window; AI-drafted monthly report with owner-logged initiatives as causal context.
6. **Member app** — dark, club-branded, installable PWA (logo, colours, font); schedule, self check-in, progress/streaks/badges, waiver signing, optional self-serve billing, shop. "No app store, no per-app fee."
7. **Security & data** — 2FA, account lockout, audit log, tenant-scoped queries, GDPR DSAR export/erase, retention actually enforced by a nightly job, no trackers or analytics (hence no cookie banner).
8. **Switching & setup** — import from MindBody, Glofox, Wodify or any CSV; white-glove migration; bulk member invites; 9-step onboarding wizard.
Each section: 2–4 sentences + concrete detail; use the inventory's defensible one-liners (§11) adapted to martial-arts-wide framing.

### D3 — `/pricing` page (new route `app/pricing/page.tsx`)
Custom-pricing model page: how it works (apply → call → tailored package → 30-day trial from go-live → invoice only if you stay), what every package always includes, no setup fees, cancel anytime, no revenue cut, no per-member metering. Zero £ figures. CTA → `/apply`.

### D4 — `/compare` page (new route `app/compare/page.tsx`)
- Intro: honest framing ("we're new; here's exactly how we differ").
- Comparison axes (MatFlow cell honest, competitor cells dated+linked): true monthly cost after add-ons (their published figures; ours "Custom — tailored on your call"); payment economics (revenue cut / processing markup / whose Stripe account); branded member app included vs +$81–$100/mo add-on; martial-arts depth (belts, stripes, gradings, kids/family); contract & data portability; setup & support model; UK-native (GBP, UK-caveated waiver, GDPR retention).
- Per-vendor sections with **"when to choose them instead"** concessions: Martialytics (grading-engine depth, 1,295 schools), Gymdesk (4,500+ gyms, maturity, door access), Zen Planner (brand recognition, retail/POS, marketing suite), Mindbody (consumer marketplace, enterprise/multi-location, 24/7 support).
- No price-opacity attack anywhere. Dated-source footer disclaimer.
- Facts + URLs are in the trace file's H3 evidence section — use only those, no fresh unverified claims.

### D5 — Credibility & SEO fixes
- `/preview`: add to `robots.ts` disallow + `robots: { index: false }` metadata (do not delete; it's internally useful). Also disallow `/waiver`.
- OG image: static branded 1200×630 card (or `next/og` ImageResponse) wired into layout + per-page metadata; twitter `summary_large_image`.
- `metadataBase`, `title.template` in `app/layout.tsx`; `<html lang="en-GB">`.
- Sitemap: add `/features`, `/pricing`, `/compare`, add `lastModified`.
- JSON-LD `SoftwareApplication` + `Organization` on `/` (no Offer markup — custom pricing).
- Manifest description aligned to unified one-liner.

## Acceptance criteria

1. `npm run lint && npm test && npm run build` pass; `scripts/check-ui-rules.mjs` ratchet does not regress (new pages contribute zero new hex literals — shared palette module only).
2. Grep-level truth audit passes: no "£" on the public surface; no DO-NOT-CLAIM phrase appears; "free trial" copy matches locked wording; "BJJ academies only" gone; single product description used everywhere.
3. Every competitor cell on `/compare` carries a source link + "retrieved 22 August 2026"; the four concession blocks exist; disclaimer footer present.
4. All public-surface text ≥4.5:1 contrast (computed).
5. `/preview` and `/waiver` are robots-disallowed; `/features`, `/pricing`, `/compare` are in the sitemap and return 200 in the production build.
6. OG image renders on a share-debugger check of `/` (or verified in build output).
7. Nav/footer link the three new pages; British English, sentence case, no exclamation marks throughout.

## Trace findings (summary)

- The product is far deeper than the site: 171 API routes, 45 models; distinctive: per-discipline belts/stripes + promotion queue, rank-gated classes, kids/family subsystem, revocable-token kiosk, zero-platform-fee Stripe Connect, live churn/retention reports, AI monthly report, enforced GDPR retention, importers, per-tenant branding, PWA, zero trackers.
- The site's credibility leaks were enumerated and verified per-claim (unbacked trial/chat/150-cap; fabricated hero data; `/preview` crawlable with fake data; contrast failures on trust-critical fine print; metadata gaps; positioning contradictions).
- Competitor research (7 vendors, own-page sources, retrieved 2026-08-22) established the niche is contested and the credible wedge: branded member app included (4 of 7 charge $81–$100/mo extra), no revenue cut, UK-native GBP, white-glove setup, breadth-in-niche vs Martialytics' grading-first depth. Brand trust/maturity/integrations/marketplace are honest losses — conceded on the page.

## Interview transcript (condensed)

- R1: Pricing → **custom, per-owner packages** (rejected £89 and £99/£149/£199). Positioning → **broader martial arts**. Comparison → **yes, 4 vendors**. Scope → **full**.
- R2: Price display → **no numbers at all** (accepted consequence: drop price-opacity attack). Geography → **UK martial arts clubs**. Trial-as-service-promise not vetoed → stands.
