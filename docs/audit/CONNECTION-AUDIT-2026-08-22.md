# Connection-Point Audit — 2026-08-22

Three parallel lanes swept every pathway: member portal (Lane A), staff + super-admin (Lane B), integrations + background machinery (Lane C). Static analysis only — **nothing was fixed**; this is the issue register and the plan to prove the rest at runtime. Full evidence with file:line in the three companion lane reports beside this file.

Coverage: 171 API route files, ~300 fetch() call sites cross-checked (path + method + zod payload + response shape + role gate), all nav targets, all crons, all `put()`/env/webhook surfaces. **Zero missing-route/missing-method failures anywhere** — every defect is one level deeper: wrong table behind a shared endpoint, guards that reject the caller the UI sends, flows with no exit, silent fallbacks.

| Severity | Lane A (member) | Lane B (staff/admin) | Lane C (integrations) | Total |
|---|---|---|---|---|
| BROKEN | 4 | 1 | 3 | **8** |
| RISK | 9 | 4 | 8 | **21** |
| DEBT | 8 | 6 | 8 | **22** |

## The eight BROKEN, ranked for the launch

| # | Finding | Why it ranks here | Lane |
|---|---|---|---|
| 1 | **Emergency-contact wall blocks waiver signing** — `/api/waiver/sign` (+ sign-for-child) 400s without emergency-contact fields, which are editable **only** in the one-shot onboarding wizard. Imported members fill the form, draw a signature, and hit an error naming fields that exist nowhere in the app. | **Direct Total BJJ onboarding blocker**: CSV-imported members can't self-serve the waiver — the exact population of the concierge sale. Both their action items sit unresolvable forever. | A-B4 |
| 2 | **White-glove CSV import preview/commit 403s** — three routes fetch private blobs via `head().downloadUrl`, a pattern blob-image's own comments document as credential-less and broken. Also 502s every blob-stored **waiver signature image** (the gym's liability evidence is unviewable). | Second direct onboarding blocker + legal-evidence display. Masked in dev by data-URL fallbacks. | C-B2 |
| 3 | **Member with 2FA enabled is locked out of password login, permanently** — `/login/totp` posts to the staff-only verify route for all roles; the member mirror endpoint has zero callers *and* the middleware redirects the POST anyway. Only escape is magic link. Masked by TESTING_MODE in every test env — **live in production**, where TESTING_MODE is refused. | Any member who taps the live "Set up 2FA" promo bricks their password login. | A-B1 |
| 4 | **Kiosk waiver-gate self-destructs after 10 s** — the idle-reset timer covers the very step that emails a signing link and polls for completion ("this screen will advance automatically" — impossible inside 10 s). Auto-check-in path unreachable. | Kiosk's unsigned-member flow is theatre. | A-B2 |
| 5 | **Recovery codes are issued but redeemable nowhere** — both recover endpoints (staff + member) have zero UI callers; `/login/totp` offers no "lost your device?" path. UI-AUDIT follow-up #3, verified still open. | With #3, the 2FA promise chain is broken at both links, for both roles. | A-B3 / B-R3 |
| 6 | **Push delivery has never worked** — `lib/push.ts` reads `PushSubscription` (FORCE RLS) through the raw Prisma client, which never sets the tenant GUC → lawful empty result, every time, no error. Three live call sites believe they're pushing. | Root cause found for CLAUDE.md's "push not live". Consequence: with the `rank_promoted` email an orphan (C-D2), **promoted members hear nothing at all** — while demoted members get an email. | C-B1 |
| 7 | **Add Staff's "leave blank to auto-generate" password is a lie** — server requires ≥8 chars (the auto-generate fallback was deliberately removed server-side; the client was never updated). Blank submits 400; the "share these credentials" panel is unreachable dead code. | First thing an owner does when adding a coach. | B-B1 |
| 8 | **Every chargeback emails each owner twice** — two near-identical templates fire from the same `charge.dispute.created` branch. | Trains owners to ignore the one time-boxed email that matters. | C-B3 |

## RISK highlights (full lists in lane reports)

Money: inert "standalone-only" guard on `payment_intent.succeeded` (the `invoice` field doesn't exist on the pinned API version) → duplicate revenue rows whenever the invoice-id resolver hiccups (C-R1); `checkout.session.completed` trusted without `payment_status`, async payment events unhandled — latent until a gym enables a delayed method on class-packs (C-R2); ad-hoc charge leaves the member's Payments tab stale on the same page (B-R2); platform-account charge possible on inconsistent tenant state (C-R6).
Security: `reset-password` has **no rate limit on a 6-digit, 2-minute code** (C-R3); `delete-orphan` lets any member delete any tenant blob they learn the URL of (C-R7); webhook Payment lookups skip the tenant filter the codebase's own A8I1-S-4 defence demands (C-R5).
Honesty: sign-in sheet says "Signed in!" without recording attendance when today's instance is missing (A-R1); onboarding steps 2–4 collect answers that are never sent anywhere (A-R2); "Rank updated" toast while the discipline edit is silently stripped (B-R1); parent kid-photo upload 401s against `/api/upload` and silently base64s into Postgres instead (A-R3); `RESEND_FROM` sandbox fallback turns unset-env into undeliverable production mail with no signal (C-R4); shop CTA promises card payment the tenant can't take (A-R6, known).

## Silent-failure theme (Lane C's list — nothing here reaches a human)

Push (nothing, ever) · webhook-queued emails (`.catch(() => {})`) · invoice resolver failures (console only) · upload's inline-base64 fallback during Blob outages · shop's cash-only downgrade when one undocumented env var is missing · a possibly-unscheduled third cron (two code comments still say "Hobby allows 2") · monthly-report cron failures never reaching Sentry. The pattern: **every background failure needs a signal**; today none have one.

## Runtime verification plan (what static analysis cannot prove)

**Noe, dashboards (~15 min):** Vercel plan tier + which of the 3 crons are actually scheduled (settles the stale-comment contradiction *and* whether class instances materialise daily) · `CRON_SECRET`, `RESEND_FROM`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` present in prod env · Stripe dashboard: webhook endpoint subscribed to all 16 handled event types · Resend dashboard: webhook + secret configured, plan tier (100/day cap vs ~200-member invite day).

**Scripted probes (I run, read-only, ~30 min):** blob `downloadUrl` credential test — `head()` one private blob, curl the URL; settles finding #2's remaining uncertainty in two minutes · prod-config member-TOTP probe on the Neon test branch with TESTING_MODE off — confirms #3's lockout end-to-end · `prisma migrate diff` against the test branch for schema/DB drift.

**Playwright matrix (test branch only — specs hard-refuse `ep-bold-wave`):** the existing `ui-audit` projects at 375/1440 as owner and member, plus new mutation specs for the top BROKEN flows once fixed: import → member signs waiver; kiosk waiver-gate survives past 10 s; member TOTP round-trip; add-staff with typed password.

**Then the fix pass** — items 1–5 are the launch-relevant cluster (waiver + import + 2FA); 6–8 plus RISKs ranked after. Not started: this audit's instruction was identify, not solve.

## Known in-flight (excluded from findings by brief)

Announcement expiry half-built in the working tree (schema + migration + POST + role-filtered GET done; `[id]` PATCH extend, `lib/member-home.ts` filter, composer UI pending) · member layout scroll fix · milestones maxNext=1 · both waiting on the resumed fix pass.
