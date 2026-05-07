# MatFlow Signup Pipeline Assessment

**Date:** 2026-05-07
**Scope:** owner signup pipeline + member signup pipeline (deep)
**Method:** code-trace + live Playwright walk against local dev server (port 3847)
**Source-of-truth docs reviewed:** [MATFLOW-PIPELINES.md](MATFLOW-PIPELINES.md), [MATFLOW-MASTER-PLAN.md](MATFLOW-MASTER-PLAN.md)

---

## Executive summary

Both signup pipelines are **substantially implemented and largely conformant** with the pipeline spec. The owner pipeline is the most carefully engineered surface in the repo — magic-link tokens are HMAC-hashed, atomic single-use, audit-stamped, and operator-attributable. The member pipeline reuses the same primitives well.

That said, **five categories of issues warrant attention**:

1. **One P1 security finding**: `/api/magic-link/verify` mints a session for owners with `totpPending: false` and no `requireTotpSetup` flag, so an owner with TOTP enrolled who uses the "Email me a sign-in link" affordance bypasses the TOTP gate entirely. ([api/magic-link/verify/route.ts:71-101](../app/api/magic-link/verify/route.ts#L71-L101))

2. **One P1 documentation contradiction**: MATFLOW-PIPELINES.md describes a 9-stage onboarding wizard; MATFLOW-MASTER-PLAN.md §5 says the current wizard collects 4 things. The two source-of-truth docs disagree — the master plan is stale (the pipelines doc reflects what's actually shipped).

3. **Asymmetric `first_time_signup` token handling**: same `purpose` value, two TTLs (30 min for owners, 7 days for members), two different consumption paths (`/api/magic-link/verify` vs `POST /api/members/accept-invite`). Works today; brittle to future changes.

4. **Several doc-drift points** in MATFLOW-PIPELINES.md: required-field list for member create is overstated; public-prefix list is incomplete; dashboard layout's wizard redirect is unmentioned; the wizard-v2 `?resume=1` SetupBanner feature is undocumented.

5. **A handful of P2/P3 UX and friction issues**: non-functional legal links on `/apply`, no captcha/honeypot on the public application form, `/login/accept-invite` is a dead-end when the token is missing, apply-form field names don't match DB column names (so callers copying from the doc would get a 400).

The two pipelines are **safe to ship and operate**; the recommendations below are hardening, not blocker-grade fixes (with the exception of the magic-link-bypasses-TOTP question, which depends on whether that's a deliberate design choice).

---

## 1. Owner signup pipeline

### 1.1 Conformance audit (against MATFLOW-PIPELINES.md §1)

| Section | Doc claim | Code | Verdict |
|---|---|---|---|
| §1.1 | `POST /api/apply` rate-limit 5/hour/IP | [api/apply/route.ts:7-8,25](../app/api/apply/route.ts#L7-L25) | ✅ |
| §1.1 | Captures `gymName, contactName, email, phone, discipline, memberCount, notes` | API actually accepts `gymName, ownerName, email, phone, sport, memberCount, message`. DB stores under doc's names. | ⚠️ Doc names ≠ API names |
| §1.1 | Audit: none (no tenant context) | confirmed | ✅ |
| §1.1 | Two emails: `application_received` + `application_internal` | [api/apply/route.ts:83-106](../app/api/apply/route.ts#L83-L106) | ✅ |
| §1.2 | `/admin/applications` gated by `isAdminPageAuthed()` | [app/admin/applications/page.tsx:9](../app/admin/applications/page.tsx#L9) | ✅ |
| §1.3 | Slug generation, 5-retry collision suffix | [approve/route.ts:64-70](../app/api/admin/applications/[id]/approve/route.ts#L64-L70) | ✅ |
| §1.3 | Random 24-char temp password owner never sees | line 74 (`randomBytes(18).toString("base64").slice(0, 24)`) | ✅ |
| §1.3 | 30-min magic-link, HMAC-hashed, `purpose="first_time_signup"` | [approve/route.ts:112-124](../app/api/admin/applications/[id]/approve/route.ts#L112-L124) | ✅ |
| §1.3 | Audit `admin.application.approve`, operator attribution via `actAsUserId` | [approve/route.ts:135-149](../app/api/admin/applications/[id]/approve/route.ts#L135-L149) | ✅ |
| §1.3 | `activationLink` returned in non-production | line 179 | ✅ |
| §1.4 | Reject sets status, console-warns (no AuditLog) | [reject/route.ts:36-48](../app/api/admin/applications/[id]/reject/route.ts#L36-L48) | ✅ |
| §1.5 | `/api/admin/create-tenant` bypass, 10/hour rate-limit, owner-supplied password | [create-tenant/route.ts:36](../app/api/admin/create-tenant/route.ts#L36) | ✅ but file's own docstring at line 4 is **stale** (claims `MATFLOW_ADMIN_SECRET` header — actually `getOperatorContext`) |
| §1.6 | 9-stage wizard at `/onboarding` | [OwnerOnboardingWizard.tsx](../components/onboarding/OwnerOnboardingWizard.tsx) (~1380 lines) | ✅ but **MASTER-PLAN.md §5 says 4 stages** — internal contradiction |
| §1.6 | Edge proxy pins `requireTotpSetup` owners to `/login/totp/setup` (allowed during onboarding) | [proxy.ts:173-197](../proxy.ts#L173-L197) | ✅ |
| §1.6 | TOTP enrolment sub-flow: GET secret/QR → POST verify → recovery codes | [api/auth/totp/setup/route.ts](../app/api/auth/totp/setup/route.ts) + [TotpEnrollmentStep.tsx](../components/onboarding/TotpEnrollmentStep.tsx) | ✅ |

### 1.2 Live UX walk

The walk was performed on 2026-05-07 against `http://localhost:3847` with TESTING_MODE on (per CLAUDE.md memory).

**Step 1 — `/apply` (public form):** loaded cleanly, white theme distinct from dark product. Fields: gym name, owner name, email, phone, discipline (dropdown of 9 sports), member count (5 ranges), optional message. Screenshot: `apply-form-empty.png`.

**Step 2 — Submit:** filled with `assess-2026-05-07-owner@example.com` and submitted. Got the success screen "Application received — we'll be in touch within 1 business day". Screenshot: `apply-form-submitted.png`.

**Step 3 — DB verification (via [scripts/assess-check-application.mjs](../scripts/assess-check-application.mjs)):** `GymApplication` row created with `status: "new"`, `discipline: "Brazilian Jiu-Jitsu (BJJ)"` (full label, not a normalised code), `memberCount: "20–50"`, `notes: ""` (empty string, not null), `ipAddress: "::1"`. ✅ Persistence works. ⚠️ no `MagicLinkToken` exists yet (correct: token only minted at approve time).

**Step 4 — `/login` flow:** club-code-first design. After "totalbjj" → step 2 shows tenant-branded login (Total BJJ logo + slug subtitle), email + password, "Sign in" + "Email me a sign-in link" + "Forgot password?" — three login modalities surfaced clearly. Screenshot: `login-step2-credentials.png`.

**Step 5 — `/admin/login`:** loaded, white theme as expected. Tabbed form (Account / Bootstrap). Did not log in (no creds attempted in this walk). Screenshot: `admin-login.png`.

**Couldn't walk end-to-end:** the operator approval → activation-link click → wizard sequence requires authenticated operator session. Code-trace confirms this path is wired correctly; live walk would need either operator credentials or a one-shot DB script to mint a token.

### 1.3 Design critique (owner pipeline)

**A. TOTP enrolment is stage 8 of 9.** An attacker who compromises the owner's email between activation (30-min link) and stage 8 could complete the wizard, set branding, and connect Stripe under the owner's identity. The 30-min link window is tight, but there's no second factor until the owner chooses to enrol. Reasonable today but worth re-considering.

**B. The 9-stage wizard is long.** Master plan §5 wants it longer (legal contact, class types, tiers, member import expansion). Walking it cold is several minutes. Stage 4 "Timetable" requires the owner to know their schedule before they have any members — an acceptance-of-pre-fill step (templates per discipline) would lower this floor. The code already has `CLASS_TEMPLATES` per discipline ([OwnerOnboardingWizard.tsx:87-97](../components/onboarding/OwnerOnboardingWizard.tsx#L87-L97)) but they're suggestions, not pre-filled.

**C. Discipline never round-trips from `/apply` to wizard.** The application stores `discipline: "Brazilian Jiu-Jitsu (BJJ)"`. The wizard re-asks for sport using IDs like `"BJJ"`, `"MMA"`. The owner re-types information they've already given. Either normalise at apply time or pre-select in wizard from the application row.

**D. The `/api/admin/create-tenant` bypass route is production-reachable** with operator auth. Master plan suggests it's "for testing or known-good gyms". If it's intended only as a back-channel, gate it behind `NODE_ENV !== "production"` or a feature flag. If it's a deliberate ops tool, document that explicitly in PIPELINES §1.5 (currently the doc treats it as equal to the standard apply→approve flow).

**E. No captcha/honeypot on `/apply`.** Only a 5/hour-per-IP rate-limit. Botnets defeat per-IP limits trivially. A simple invisible honeypot field would block 95% of scripted spam without UX cost.

### 1.4 Gaps & doc drift (owner pipeline)

| ID | Gap | Severity |
|---|---|---|
| O-1 | MATFLOW-MASTER-PLAN.md §5 claims wizard collects 4 things; PIPELINES.md and code agree on 9 stages. **Master plan is stale.** | P1 doc |
| O-2 | `app/api/admin/create-tenant/route.ts:4` docstring says "Protected by MATFLOW_ADMIN_SECRET header" — actual auth is via `getOperatorContext` (v1 OR v1.5). Stale. | P3 |
| O-3 | Apply route silently swallows DB write failure ([api/apply/route.ts:68-72](../app/api/apply/route.ts#L68-L72)) — user sees success even if `GymApplication.create` threw. Application lost. | P2 |
| O-4 | `notes` stored as `""` not null when message field is empty. Cosmetic but breaks "is there a message?" queries. | P3 |
| O-5 | Apply page Terms of Service / Privacy Policy are non-clickable `<span>` ([apply/page.tsx:218-221](../app/apply/page.tsx#L218-L221)). Compliance & trust signal. | P2 |
| O-6 | Pipeline doc §1.6 doesn't mention the dashboard-layout redirect at [dashboard/layout.tsx:29-31](../app/dashboard/layout.tsx#L29-L31) that sends `!onboardingCompleted` owners to `/onboarding`. | P3 doc |
| O-7 | Pipeline doc §1.6 doesn't mention `/onboarding?resume=1` (wizard v2) or the dashboard `SetupBanner` ([dashboard/page.tsx:12-48](../app/dashboard/page.tsx#L12-L48)). | P3 doc |
| O-8 | Pipeline doc §3.5 public-prefix list omits `/api/admin`, `/api/webhooks`, `/api/cron`, `/api/account/pending-tenant`, `/.well-known`, `/robots.txt`, `/sitemap.xml`, `/icons`, `/manifest.webmanifest` — all real public prefixes per [proxy.ts:14-48](../proxy.ts#L14-L48). | P3 doc |
| O-9 | Pipeline doc §3.1 audit-action list omits `auth.account.locked` (emitted by [auth.ts:230-238](../auth.ts#L230-L238)). | P3 doc |

---

## 2. Member signup pipeline

### 2.1 Conformance audit (against MATFLOW-PIPELINES.md §2)

| Section | Doc claim | Code | Verdict |
|---|---|---|---|
| §2.1 | "No public self-serve signup exists" | confirmed (no `/[tenantSlug]/signup` route) | ✅ deliberate |
| §2.2 | `POST /api/members` owner/manager/admin only | [api/members/route.ts:102-103](../app/api/members/route.ts#L102-L103) | ✅ |
| §2.2 | Required fields `tenantId, email, name, accountType, status, paymentStatus` | **Actual `memberCreateSchema` only requires `name`** ([lib/schemas/member.ts:6-14](../lib/schemas/member.ts#L6-L14)). `status` and `paymentStatus` aren't in the schema at all — Prisma defaults handle them. | ⚠️ Doc overstates required fields |
| §2.2 | Adult flow: 7-day token, `purpose="first_time_signup"`, `invite_member` email, `inviteUrl` returned | [api/members/route.ts:181-220](../app/api/members/route.ts#L181-L220) | ✅ |
| §2.2 | Kid flow: synthesised `kid-{nanoid}@no-login.matflow.local` email, no invite, parent must be top-level | [api/members/route.ts:32-35,125-141,156](../app/api/members/route.ts#L32-L35) | ✅ |
| §2.2 | Audit `member.create` (adult) or `member.create.kid` | [api/members/route.ts:168](../app/api/members/route.ts#L168) | ✅ |
| §2.2 | Auth: owner/manager/admin | Code restricts **kids creation to owners only** ([line 120](../app/api/members/route.ts#L120)). Doc doesn't mention this. | ⚠️ Doc imprecise |
| §2.11 | Magic-link request: 3/15min rate-limit, silent on rate-limit, anti-stockpile, kids excluded via `passwordHash IS NOT NULL` | [api/magic-link/request/route.ts:25-64](../app/api/magic-link/request/route.ts#L25-L64) | ✅ |
| §2.11 | Verify: hash lookup, atomic single-use, mints NextAuth JWT, 30-day session | [api/magic-link/verify/route.ts:24-122](../app/api/magic-link/verify/route.ts#L24-L122) | ✅ |
| §2.11 | Verify redirects User → `/dashboard`, Member → `/member/home` | line 113 | ✅ |
| §2.12 | `Member.status` enum `active|inactive|cancelled|taster` | DB constraint allows all 4; **`memberUpdateSchema.status` only allows 3** ([lib/schemas/member.ts:26](../lib/schemas/member.ts#L26)) — staff can't PATCH a member into `taster`. | ⚠️ Schema/DB mismatch |

### 2.2 Live UX walk

**Step 1 — `/login/accept-invite` (no token):** navigated directly. Page shows "Set up your account" heading and password fields, but with disabled inputs and a red error: "Missing invite token. Check the link in your email." Screenshot: `accept-invite-no-token.png`.

⚠️ **UX dead-end:** no "Back to sign in" link, no "Resend invite" option, no help text. A confused member with a stale or malformed link is stranded.

**Couldn't walk end-to-end:** the staff invite → email → click → password set sequence requires owner login + email reading. Code-trace confirms `/login/accept-invite` correctly POSTs to `/api/members/accept-invite` ([accept-invite/page.tsx:47-73](../app/login/accept-invite/page.tsx#L47-L73)), then auto-signs the member in via `signIn("credentials", ...)` and redirects to `/member/home`. Pipeline doc §2.1 calls out the "POST /api/members/accept-invite" entry point but doesn't mention the page's auto-signin behaviour.

### 2.3 Design critique (member pipeline)

**F. Same `purpose="first_time_signup"` for two flows with different TTLs and consumption paths.** Owner activation token: 30 min, consumed by `/api/magic-link/verify` (auto-login, sets cookie). Member invite token: 7 days, consumed by `/api/members/accept-invite` (sets password, page calls `signIn` separately). The shared purpose value invites bugs — a token validator that checks `purpose === "first_time_signup"` accepts either, but the routes are intentionally separate. Recommend splitting into `first_time_signup_owner` and `first_time_signup_member`, with each route asserting its own purpose.

**G. Magic-link verify mints a JWT with `totpPending: false` for users.** ([api/magic-link/verify/route.ts:82-84](../app/api/magic-link/verify/route.ts#L82-L84)) An owner with TOTP enrolled who clicks "Email me a sign-in link" at /login bypasses the TOTP challenge. **This is a P1 security finding if unintentional, or a P1 doc finding if intentional** (the design choice should be explicit in §2.11 — magic-link is a strong factor on its own, but stolen email = stolen owner account). The same issue applies to `requireTotpSetup` — the flag is never set, so a fresh owner consuming a magic-link doesn't trigger the proxy gate (the wizard handles it via the dashboard-layout redirect, but only because `Tenant.onboardingCompleted=false`).

**H. Self-serve member signup is absent by design.** Pros (per CLAUDE.md and pipeline doc): gym owns the relationship, ensures waiver/medical info is captured by staff. Cons: friction for tasters, walk-ins, online-curious customers; gym can't run an awareness campaign that ends in a signup. Possible middle: a per-tenant signup link (token-gated, opt-in per tenant, off by default). Not recommending a change today — flagging the design for re-litigation when the product targets self-serve segments.

**I. Owner-only kids creation** is correct, but masking it as "owner/manager/admin" in the pipeline doc misleads. Manager/admin attempts to create a kid will hit a 403 they didn't expect.

### 2.4 Gaps & doc drift (member pipeline)

| ID | Gap | Severity |
|---|---|---|
| M-1 | Magic-link verify bypasses TOTP for owners (no `requireTotpSetup`, hardcoded `totpPending: false`). Either P1 fix or P1 doc. | P1 |
| M-2 | `memberCreateSchema` only requires `name`; pipeline doc says required fields are `tenantId, email, name, accountType, status, paymentStatus`. Doc is wrong. | P2 doc |
| M-3 | `memberUpdateSchema.status` enum is `[active, inactive, cancelled]` — DB allows `taster` too. Staff can't PATCH a member to `taster`. | P2 |
| M-4 | Pipeline doc §2.2 says auth is "owner/manager/admin" without noting kids are owner-only. | P3 doc |
| M-5 | Pipeline doc §2.1 lists `POST /api/members/accept-invite` as an entry point but doesn't describe the `/login/accept-invite` page's auto-signin behaviour. | P3 doc |
| M-6 | `/login/accept-invite` no-token state is a dead end (no nav, no help). | P2 UX |
| M-7 | Same `purpose="first_time_signup"` for owner (30 min) and member (7 days) tokens. Brittle. | P2 |
| M-8 | `/api/members/accept-invite` route docstring says "member can then sign in via the normal credentials flow" — actually the page auto-signs them in. Stale. | P3 |

---

## 3. Cross-cutting findings

| ID | Finding | Severity |
|---|---|---|
| X-1 | `DEMO_MODE=true` + DB unavailable activates a hardcoded credential set in [auth.ts:339-361](../auth.ts#L339-L361) (`{owner,coach,admin,member}@totalbjj.com`, password `password123`, slug `totalbjj`). Production-runtime guards exist but the credential map is in the codebase. Slight risk if `DEMO_MODE` accidentally becomes true in prod. Consider environment-gating to `NODE_ENV !== "production"` at compile time. | P2 |
| X-2 | Edge proxy public-prefix list and pipeline doc disagree on what's public. Doc is incomplete. | P3 doc |
| X-3 | Apply form `discipline` is free-text label ("Brazilian Jiu-Jitsu (BJJ)"); wizard uses ID ("BJJ"). No round-trip — owner re-enters discipline. | P2 |
| X-4 | Field name divergence: `/apply` form sends `ownerName, sport, message`; DB stores `contactName, discipline, notes`; pipeline doc uses DB names. Anyone reading the doc to call the API will get a 400. | P2 doc |
| X-5 | `apply` route's IP-extraction normalises `"::1"` to `null` for `ipAddress` — confirmed in DB. Useful for not poisoning analytics with localhost. | ✅ |

---

## 4. Prioritised backlog

| # | Sev | Area | Finding | Proposed fix | Effort |
|---|---|---|---|---|---|
| 1 | **P1** | Auth | Magic-link verify bypasses TOTP for owners with TOTP enrolled. JWT minted with `totpPending: false` and no `requireTotpSetup`. | If unintentional: in `/api/magic-link/verify`, when `user.totpEnabled === true` AND user is owner, set `totpPending: true` so the proxy pins to `/login/totp` challenge. If intentional: document explicitly in PIPELINES.md §2.11 with the threat-model rationale. | M (security review) |
| 2 | **P1** | Docs | MATFLOW-MASTER-PLAN.md §5 claims wizard has 4 stages; reality is 9. | Rewrite §5 to reflect current state, then split "current vs proposed redesign" into two clearly-labelled subsections. | XS |
| 3 | P2 | Auth | `DEMO_MODE` fallback ships hardcoded credentials. | Wrap the demo-user block in `process.env.NODE_ENV !== "production"` at module top so the code is removed at build time in prod, not just runtime-guarded. | XS |
| 4 | P2 | Docs | `memberCreateSchema` required-field list overstated in PIPELINES.md §2.2. | Replace with the actual `lib/schemas/member.ts` shape; note that `status`/`paymentStatus` use Prisma defaults at create. | XS |
| 5 | P2 | Code/data | Apply route silently swallows DB write failure. | If `gymApplication.create` throws, return 503 to the user (don't show success). Email-only fallback should be opt-in via env var, not the default behaviour. | S |
| 6 | P2 | UX | `/login/accept-invite` no-token state is a dead end. | Add "Back to sign in" link and "Need a new invite? Contact your gym" copy when token missing or invalid. | XS |
| 7 | P2 | UX/Compliance | `/apply` Terms of Service and Privacy Policy are non-clickable spans. | Convert to `<Link>` with `/legal/terms` and `/legal/privacy` hrefs (those routes are public per proxy). | XS |
| 8 | P2 | UX/Security | No captcha or honeypot on `/apply`. | Add an invisible honeypot field (`<input name="website" tabIndex={-1} autoComplete="off">` + server check). 30 mins. | XS |
| 9 | P2 | Schema | `memberUpdateSchema.status` enum doesn't include `"taster"`. | Add `"taster"` to the union to match DB CHECK constraint. | XS |
| 10 | P2 | Code | Apply form `discipline` doesn't round-trip into wizard. | Either normalise apply form to wizard IDs at submission, or pre-select wizard discipline from `GymApplication.discipline` when wizard loads. | S |
| 11 | P2 | Code | Apply form field names diverge from DB column names; doc uses DB names. | Either rename API params (`contactName, discipline, notes`) or rewrite doc to use API names with a "stored as" column. Either is fine; pick one. | XS |
| 12 | P2 | Code | Same `purpose="first_time_signup"` for two flows with different TTLs and routes. | Split into `first_time_signup_owner` (30 min) and `first_time_signup_member` (7 days); each consumption route asserts its purpose. Migration-safe with a deprecation window. | M |
| 13 | P3 | Docs | `app/api/admin/create-tenant/route.ts:4` docstring is stale ("Protected by MATFLOW_ADMIN_SECRET header" — actually `getOperatorContext`). | One-line fix. | XS |
| 14 | P3 | Docs | `/api/members/accept-invite` route docstring claims "member signs in via normal credentials flow" — actually page auto-signs them in. | One-line fix. | XS |
| 15 | P3 | Docs | PIPELINES.md §2.2 doesn't note kids are owner-only. | One-line addition. | XS |
| 16 | P3 | Docs | PIPELINES.md §3.5 public-prefix list incomplete. | Sync with [proxy.ts:14-48](../proxy.ts#L14-L48). | XS |
| 17 | P3 | Docs | PIPELINES.md §1.6 doesn't mention `/onboarding?resume=1` or dashboard `SetupBanner`. | Add a "post-onboarding re-entry" subsection. | XS |
| 18 | P3 | Docs | PIPELINES.md §1.6 doesn't mention dashboard-layout's `!onboardingCompleted → /onboarding` redirect. | One-paragraph addition. | XS |
| 19 | P3 | Docs | `auth.account.locked` audit action emitted by code but missing from §3.1 list. | One-line addition. | XS |
| 20 | P3 | Code | `notes` stored as `""` (not null) when apply message is empty. | `data: { notes: message?.trim() || null }` in apply route. | XS |
| 21 | P3 | Design | `/api/admin/create-tenant` bypass route ships in production with operator auth. | Either gate to `NODE_ENV !== "production"` (if it's only for testing) or document the production use case in §1.5. | XS doc OR S code |

---

## 5. Verification & limitations

**Walked end-to-end:**
- ✅ `/apply` form fill + submit + DB persistence (verified via [scripts/assess-check-application.mjs](../scripts/assess-check-application.mjs))
- ✅ `/login` two-step (club code → credentials) UX
- ✅ `/login/accept-invite` no-token error state
- ✅ `/admin/login` page-load only (no auth attempted)

**NOT walked end-to-end (would need live operator and owner sessions):**
- Operator approval → activation-link click → 9-stage wizard
- Owner invites member → email → token claim → first member login

Code-trace covers these flows comprehensively; the live walks above suffice to ground the UX critique. A more complete live walk would require either (a) a one-shot script that mints both operator session and member invite token, or (b) interactive credentials. Both are doable in a future session if any of the P1/P2 findings need behavioural reproduction.

**Tests not run as part of this assessment:** the 147-test baseline is unchanged (assessment is read-only — created one `GymApplication` test row and one helper script under `scripts/`).

**Data hygiene:** assessment created `GymApplication` row with email `assess-2026-05-07-owner@example.com` (id `cmoup4ekp0006j8tghr0a3jx7`). Safe to leave; trivially deletable via `DELETE FROM "GymApplication" WHERE email LIKE 'assess-2026-05-07-%'`.

---

## Appendix A — Screenshots

| File | Stage |
|---|---|
| `apply-form-empty.png` | `/apply` initial render (full page) |
| `apply-form-submitted.png` | `/apply` success state ("Application received") |
| `login-page.png` | `/login` step 1 (club code) |
| `login-step2-credentials.png` | `/login` step 2 (email/password/magic-link) for `totalbjj` |
| `admin-login.png` | `/admin/login` operator console gate |
| `accept-invite-no-token.png` | `/login/accept-invite` dead-end state |

All screenshots saved at repo root by Playwright run on 2026-05-07.

---

## Appendix B — Files touched by this assessment

- **Created:** `docs/MATFLOW-SIGNUP-ASSESSMENT-2026-05-07.md` (this file)
- **Created:** `scripts/assess-check-application.mjs` (DB verification helper)
- **DB:** one `GymApplication` row (cleanable via the SQL above)
