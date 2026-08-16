# MatFlow — Audit Re-Verification (2026-07-06)

**Re-verifies:** `PRODUCTION_QA_AUDIT.md` (2026-04-29, Opus 4.7)
**Method:** Read-only re-check of current code (branch `chore/ci-gate-tests`, HEAD `35f1973`) + 7 live HTTP probes against production (`https://matflow-nine.vercel.app`).
**Scope:** No code/config/schema changes. No migrations run. No commits.
**Reviewer:** Opus 4.8, Phase 0 hardening re-verify.

---

## Executive summary

The original audit scored launch readiness **4 / 10**, driven almost entirely by **P0-1: the Stripe webhook was auth-gated (307), so payments could not be recorded**. That single blocker, plus five sibling proxy-gating issues, is the reason the audit said "no real money should run through prod."

**That class of failure is resolved.** The proxy no longer 307s the self-authenticating surfaces. The webhook, cron and kiosk families are now excluded at the middleware `matcher` level (so the NextAuth wrapper never fires), and legal pages were added to `PUBLIC_PREFIXES`. Live probes confirm it in production:

| Surface | Audit (Apr) | Now (Jul probe) | Verdict |
|---|---|---|---|
| `POST /api/stripe/webhook` | 307 → login | **400** "Missing signature" | Reachable — FIXED |
| `POST /api/webhooks/resend` | 307 → login | **503** "secret not configured" | Reachable — proxy FIXED, prod secret still unset |
| `GET /legal/terms` | 307 → login | **200** | FIXED |
| `GET /checkin/totalbjj` | 307 → login | **307** | Legacy dead path — feature re-architected to `/kiosk/[token]` (public) |
| `GET /onboarding` | 307 → login | **307** | Correct — owner-only logged-in wizard, not public sign-up (audit misdiagnosis) |
| `GET /login` (control) | 200 | **200** | — |
| `GET /api/auth/csrf` (control) | 200 | **200** | — |

Two other launch-relevant items the audit flagged as unimplemented are now **done in code**: member Stripe portal is gated behind `Tenant.memberSelfBilling` (Pay-5), and account lockout exists (S-4). The dashboard N+1 and silent-catch (P1-1, P1-2) are fixed. `unsafe-eval` is dropped in production CSP (half of P1-3). The red test suite (P1-6) was restructured and is now CI-gated.

**What is NOT closed** is mostly **config, not code**: production Vercel env for Resend/Anthropic/Google cannot be read from here, but the live `503` on the Resend webhook proves `RESEND_WEBHOOK_SECRET` is still unset in prod. A written `@@unique` migration for `Tenant.stripeAccountId` exists but is **untracked/uncommitted** and the `schema.prisma` model was not updated to match (drift risk). CSP still ships `'unsafe-inline'`. A handful of P2 UI polish items are unverified (need browser).

**Revised launch readiness: ~7.5 / 10 — blocked-by-config, no longer blocked-by-code.** The payment path is live. Remaining work is env-var provisioning + the schema-drift reconciliation + CSP/UX polish.

> Note on prod-vs-code lag: prod already reflects the proxy fixes (legal 200, webhook 400/503). Production Vercel environment variables are not readable from this workstation, so every prod-env item below is marked NOT-VERIFIED unless a live probe implied its state.

---

## Full status table

Legend: **FIXED** · **STILL OPEN** · **PARTIAL** · **NEEDS-DEPLOY** (fixed in code/untracked, prod state unconfirmed) · **NOT-VERIFIED** (cannot confirm from here — prod env or browser-only) · **NOT-A-BUG**

### P0 — Critical blockers

| ID | Original finding | Status | Evidence |
|---|---|---|---|
| P0-1 | Stripe webhook auth-gated (307); payments dead | **FIXED** | `proxy.ts:219` matcher excludes `api/stripe/webhook` (middleware never runs). Route self-auths on signature: `app/api/stripe/webhook/route.ts:15-17` returns 400 "Missing signature". Live probe `POST` → **400** (was 307). |
| P0-2 | Resend webhook auth-gated (307) | **FIXED (proxy)** | `proxy.ts:219` matcher excludes `api/webhooks`. Route reachable: `app/api/webhooks/resend/route.ts:45-49` returns 503 in prod when secret unset. Live probe `POST` → **503** (was 307). Secret provisioning tracked under P0-5. |
| P0-3 | QR check-in landing `/checkin/[slug]` 307 | **FIXED (re-architected)** | No `app/checkin/[slug]` page exists (only `app/api/checkin/…` + `app/dashboard/checkin`). QR feature is now `app/kiosk/[token]/page.tsx`, excluded public at `proxy.ts:219` (`kiosk\|api/kiosk`). `/api/checkin` is intentionally session-gated (staff/self, `app/api/checkin/route.ts:49-53`). Legacy `/checkin/totalbjj` still 307s but is a dead path. |
| P0-4 | Legal pages auth-gated (307) | **FIXED** | `proxy.ts:36` `/legal` in `PUBLIC_PREFIXES`. Live probe `/legal/terms` → **200** (was 307). |
| P0-5 | `RESEND_API_KEY` unset in prod | **PARTIAL / NOT-VERIFIED** | Local `.env` has `RESEND_API_KEY`; `.env.example` documents `RESEND_API_KEY` + `RESEND_WEBHOOK_SECRET` + `RESEND_FROM`. Cannot read prod Vercel env directly, but live Resend probe → **503 "Webhook secret not configured"** proves `RESEND_WEBHOOK_SECRET` is **still unset in production**. `RESEND_API_KEY` prod state unconfirmed. |
| P0-6 | `/onboarding` public sign-up auth-gated (307) | **NOT-A-BUG** | `app/onboarding/page.tsx:11-13` — page requires an authenticated **owner** and self-redirects to `/login` (307) / `/dashboard`. It is the post-signup owner wizard reached from the dashboard SetupBanner `/onboarding?resume=1` (`app/dashboard/page.tsx:40`), not a marketing entry point. Public sign-up is `/apply` (200). Redundantly added to `PUBLIC_PREFIXES` (`proxy.ts:37`) but the page guard makes the 307 correct. |

### P1 — High priority

| ID | Original finding | Status | Evidence |
|---|---|---|---|
| P1-1 | Dashboard N+1 (`attendances: { select: { id } }`) | **FIXED** | `app/dashboard/page.tsx:71` uses `_count: { select: { attendances: true } }`; read at `:84` `inst._count.attendances`. |
| P1-2 | Dashboard silent `catch {}` on DB error | **FIXED** | `app/dashboard/page.tsx:206-208` — `catch (e) { console.error("[dashboard]", e); … }`. |
| P1-3 | CSP allows `unsafe-eval` **and** `unsafe-inline` | **PARTIAL** | `next.config.ts:11` — `'unsafe-eval'` now dropped in production (`${isProd ? "" : " 'unsafe-eval'"}`). `'unsafe-inline'` **still present unconditionally**. unsafe-eval fixed; unsafe-inline STILL OPEN. |
| P1-4 | `ANTHROPIC_API_KEY` unset → monthly cron throws | **NOT-VERIFIED** | Documented in `.env.example` (`ANTHROPIC_API_KEY`); absent from local `.env`. Prod Vercel env not readable from here. |
| P1-5 | Google Drive env vars missing | **NOT-VERIFIED** | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env.example`, absent from local `.env`. Feature is behind `ENABLE_GOOGLE_OAUTH` flag. Prod env not readable. |
| P1-6 | 4 failing tests (checkin-duplicate startTime/endTime; security 404-vs-401) | **FIXED (restructured)** | `tests/integration/checkin-duplicate.test.ts` no longer exists. `tests/integration/security.test.ts` rewritten to boundary tests F8/F5/F10/F4/L1 — no 404 QR-mismatch assertion; only a 401 at `:87` (unauth `dashboard/stats`). Commit `06b7857` "fix 95 pre-existing mock-infrastructure failures"; `35f1973` "ci: gate on the unit suite + add lint". (Suite not run per instruction — inspected only.) |
| P1-7 | `RESEND_FROM` unset → spammy From | **NOT-VERIFIED** | `RESEND_FROM` (and `EMAIL_FROM`) documented in `.env.example`; absent from local `.env`. Prod env not readable. |
| P1-8 | Redesigned `DashboardStats` has no test coverage | **STILL OPEN (low)** | No `DashboardStats`-specific test in `tests/**` glob. Component still un-covered by unit/visual test. Browser/visual test outstanding. |

### P2 — Medium polish

| ID | Original finding | Status | Evidence |
|---|---|---|---|
| P2-1 | Login OTP no countdown timer | **NOT-VERIFIED** | Browser/UI — not inspected this pass. |
| P2-2 | OTP input lacks `inputMode`/`autoComplete` | **NOT-VERIFIED** | Browser/UI — not inspected this pass. |
| P2-3 | `MembersList` hides Method column on mobile | **NOT-VERIFIED** | Browser/UI — not inspected this pass. |
| P2-4 | Member PATCH phone no E.164 enforcement | **NOT-VERIFIED** | `app/api/members/[id]` not read this pass. |
| P2-5 | Member PATCH DOB no min/max bounds | **NOT-VERIFIED** | Not read this pass. |
| P2-6 | Icon-only buttons lack `aria-label` | **NOT-VERIFIED** | Browser/UI — not inspected this pass. |
| P2-7 / P2-11 | `Sidebar` dead `plan?` prop | **NOT-VERIFIED** | `components/…/Sidebar.tsx` not read this pass. |
| P2-8 | Topbar role pill rendering | **NOT-VERIFIED** | Browser-only. |
| P2-9 | Branding contrast on extreme colours | **NOT-VERIFIED** | Browser-only. |
| P2-10 | `Payment.status` is `String` not enum | **STILL OPEN (by design)** | `prisma/schema.prisma:842` — `status String // CHECK: … enforced by 20260430000001`. Codebase-wide convention is CHECK constraints, not Prisma enums (same for `User.role`, `Member.status`). Drift risk remains but is intentional. |

### Security

| ID | Original finding | Status | Evidence |
|---|---|---|---|
| S-1 | Webhook redirects a latent security risk | **RESOLVED** | Falls out of P0-1/P0-2 fix — webhook surfaces reachable + signature-verified. |
| S-2 | `unsafe-eval` in CSP | **PARTIAL** | Same as P1-3 — removed in prod (`next.config.ts:11`); `unsafe-inline` remains. |
| S-3 | `Cache-Control: no-store` missing on private GETs | **PARTIAL** | `next.config.ts:88-106` adds `private, no-store` for `/api/auth/*`, `/api/admin/auth/*`, `/api/magic-link/*`. General per-tenant GETs (`/api/me/gym`, `/api/settings`) still lack explicit no-store. STILL OPEN for those. |
| S-4 | No account lockout after N failures | **FIXED** | `User.failedLoginCount` + `lockedUntil` (`prisma/schema.prisma:93-94`); `Member` equivalents `:153-154`; migration `20260503300000_account_lockout`. |
| S-5 | Admin tenant-create audit `userId` null | **NOT-VERIFIED** | `/api/admin/create-tenant` not read this pass. |
| S-6 | `/apply` spam vector (no captcha / rate limit) | **PARTIAL** | Rate-limit added — `tests/unit/apply-rate-limit.test.ts` exists. No captcha yet. |
| S-7 | `/api/checkin/members` enumeration once public | **NOT-A-RISK** | `/api/checkin/*` stayed session-gated (`app/api/checkin/route.ts:49-53`); public path is the separate HMAC-gated `/kiosk`. Concern's precondition never materialised. |

### Payments

| ID | Original finding | Status | Evidence |
|---|---|---|---|
| Pay-1 | Webhook 307 = sole payment blocker | **FIXED** | See P0-1. Live probe → 400 (reachable + signature-verified). |
| Pay-2 | Stripe Connect onboarding no smoke-test | **NOT-VERIFIED** | Browser/e2e — out of scope this pass. |
| Pay-3 | BACS `mandate.updated` handled | **FIXED (reachable)** | `mandate.updated` in `HANDLED_EVENT_TYPES` (`app/api/stripe/webhook/route.ts:41`); webhook now reachable so handler fires. |
| Pay-4 | Refund cumulative-cap validation | **FIXED** | `tests/unit/refund-atomicity.test.ts`; commit `9098d5d` "harden refunds…". |
| Pay-5 | `/api/stripe/portal` not gated behind `memberSelfBilling` | **FIXED** | `app/api/stripe/portal/route.ts:39-43` returns **403** "Self-service billing is not enabled" when `!tenant?.memberSelfBilling`. Also gated on `stripeConnected` (`:49-51`) and `stripeCustomerId` (`:36-38`). |

### Schema integrity (Phase-0 task item 6)

| Item | Status | Evidence |
|---|---|---|
| `@@unique` on `Tenant.stripeAccountId` | **PARTIAL / NEEDS-DEPLOY** | Migration written: `prisma/migrations/20260628004500_unique_tenant_stripe_account/migration.sql:11` `CREATE UNIQUE INDEX "Tenant_stripeAccountId_key"`. **But** (a) the migration dir is **untracked** in git (`git status` — not committed), and (b) `prisma/schema.prisma:27` still declares `stripeAccountId String?` with **no `@unique`** → schema/DB drift; next `prisma migrate dev` or `db pull` will flag mismatch. Prod-applied state unknown. |
| `Payment.status` enum vs String | **STILL OPEN (by design)** | `prisma/schema.prisma:842` — `String` + CHECK constraint. See P2-10. |
| Recent/untracked migrations | Noted | Only new migration since audit is `20260628004500_unique_tenant_stripe_account` (untracked). `git log -20` shows 20 commits post-audit incl. `9098d5d` payments hardening, `06b7857` test-infra fixes, `35f1973` CI gate. |

### Environment variables (Phase-0 task item 8)

`.env.example` (template, 2026-06-01) now documents a **complete** required-var set: `DATABASE_URL`, `AUTH_SECRET`/`NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CLIENT_ID`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_FROM`, `EMAIL_FROM`, `ANTHROPIC_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `MATFLOW_ADMIN_SECRET`, `MATFLOW_APPLICATIONS_TO`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `SENTRY_DSN` + `NEXT_PUBLIC_*` flags, `MAINTENANCE_MODE`, `DEMO_MODE`, `TESTING_MODE`. (`ENCRYPTION_KEY` from the audit table is **not** present — consistent with the audit's own note that it is derived from the auth secret via SHA-256, not a standalone var.)

Local `.env` (dev only — NOT prod) contains: `DATABASE_URL`, `AUTH_SECRET`, `NEXTAUTH_URL`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CLIENT_ID`, `RESEND_API_KEY`, `CRON_SECRET`, `DEMO_MODE`, `TESTING_MODE`. Absent locally: `RESEND_WEBHOOK_SECRET`, `RESEND_FROM`, `ANTHROPIC_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `GOOGLE_CLIENT_ID/SECRET`.

**Production Vercel env is not readable from this workstation** — the only hard prod signal is the Resend probe (**503**), which confirms `RESEND_WEBHOOK_SECRET` is unset in prod. All other prod-env items are NOT-VERIFIED and must be checked in the Vercel dashboard.

---

## Confirmed remaining work (ordered for later phases)

1. **Provision production email env** — set `RESEND_WEBHOOK_SECRET` (proven missing: prod probe returns 503), plus verify `RESEND_API_KEY`, `RESEND_FROM`/`EMAIL_FROM` in Vercel. Until then EmailLog never advances past `sent` and outbound email deliverability is at risk. *(P0-5, P1-7)*
2. **Reconcile the `stripeAccountId` unique-index drift** — the migration `20260628004500_unique_tenant_stripe_account` is untracked and `schema.prisma` was never updated. Either add `@unique` to `Tenant.stripeAccountId` in `schema.prisma:27` and commit the migration, or drop it — but do not leave schema/DB/git three-way drift. Confirm whether the index is applied in prod. *(Schema integrity)*
3. **Verify remaining prod env vars in Vercel dashboard** — `ANTHROPIC_API_KEY` (monthly cron), `GOOGLE_CLIENT_ID/SECRET` (Drive; or keep hidden behind `ENABLE_GOOGLE_OAUTH`), `BLOB_READ_WRITE_TOKEN`, `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET`. *(P1-4, P1-5)*
4. **Finish CSP hardening** — remove `'unsafe-inline'` from `script-src` (`next.config.ts:11`) via a nonce path; `'unsafe-eval'` is already prod-dropped. *(P1-3 / S-2)*
5. **Add `Cache-Control: private, no-store` to per-tenant private GETs** — `/api/me/gym`, `/api/settings` (auth surfaces already covered in `next.config.ts:88-106`). *(S-3)*
6. **Add `/apply` captcha** — rate-limit exists; captcha/human-in-loop still needed before marketing traffic. *(S-6)*
7. **Test/visual coverage for `DashboardStats`** and the P2 UI-polish backlog (OTP countdown/inputMode, MembersList mobile column, phone E.164, DOB bounds, aria-labels, Sidebar dead `plan` prop) — all NOT-VERIFIED this pass; require reading the specific components / browser test. *(P1-8, P2-1..9, P2-11)*
8. **Decommission the dead `/checkin/[slug]` path** (optional) — it still 307s in prod and no page backs it; the live feature is `/kiosk/[token]`. Cosmetic, but removes a confusing legacy URL. *(P0-3 residue)*

### Items requiring no further action (verified fixed)
P0-1, P0-2 (proxy), P0-3 (re-architected), P0-4, P1-1, P1-2, P1-6, S-4, Pay-1, Pay-3, Pay-4, Pay-5. P0-6 and S-7 were misdiagnoses / non-issues.
