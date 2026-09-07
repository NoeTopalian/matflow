# MatFlow — State Map F: global modes & environment conditions

Read-only audit of `c:/Users/NoeTo/Desktop/matflow`. Every claim carries a
`file:line`. Anything I could not prove by reading code is marked
**UNVERIFIED**. Nothing was executed: no dev server, no tests, no database.

---

## 0. HEADLINE TRUTHS

These are the findings that change how you should read the rest.

**T1 — `NODE_ENV=production` does NOT disable `TESTING_MODE`. Only
`VERCEL_ENV=production` or a production-Neon `DATABASE_URL` does.**
`lib/testing-mode.ts:23-36` gates on `VERCEL_ENV` and on the connection
string, never on `NODE_ENV`. The repo's own unit test asserts this on purpose:
`tests/unit/testing-mode.test.ts:26-30` is titled *"honours TESTING_MODE=true
even in production"* and stubs `NODE_ENV=production`. So any deploy that is
production-by-behaviour but not Vercel-production-by-label — a self-host, a
container, a `vercel dev`, a preview promoted by DNS — silently honours the
2FA bypass and the bcrypt bypass. The refusal is a Vercel-label refusal plus a
hardcoded Neon endpoint string, not a semantic one.

**T2 — the production refusal is a hardcoded endpoint literal, duplicated in
four places.** `PROD_NEON_ENDPOINT = "ep-bold-wave-abt39t7x"` at
`lib/testing-mode.ts:16` and again at `scripts/maybe-migrate.mjs:28`. If the
production Neon endpoint is ever rotated (branch reset, project migration,
region move), both guards silently stop matching and both fail **open**:
`isTestingMode()` starts returning `true` against the new prod database, and
`maybe-migrate` stops refusing. There is no assertion anywhere that this
literal still corresponds to reality. This is the single highest-leverage
latent failure in the mode system.

**T3 — the boot env guard can hard-fail the whole server, and it disagrees
with what the code actually tolerates.** `lib/env-guards.ts:52-77` throws on
missing `RESEND_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_CLIENT_ID`, `MATFLOW_ADMIN_SECRET` — but every one of those has a
graceful runtime fallback (503 / no-op / `{card:null}`). Meanwhile
`AUTH_SECRET`/`NEXTAUTH_SECRET`, `DATABASE_URL` correctness, `RESEND_FROM`,
and `BLOB_READ_WRITE_TOKEN` — the vars whose absence actually corrupts
behaviour rather than merely disabling it — are enforced elsewhere, warned
about, or not checked at all. See §2 for the full cross-check.

**T4 — Stripe Connect status fails OPEN on one specific error class.**
`lib/stripe-account-status.ts:68-84`: if `accounts.retrieve` raises a
`StripePermissionError` (platform key lacks `accounts_kyc_basic_read`), the
cached status is written as `chargesEnabled: true, payoutsEnabled: true,
disabledReason: "status_unreadable"`. Every other failure fails closed. This
is a deliberate, documented trade — but it means a *platform-wide key scope
regression* turns the entire "don't take money that can't settle" gate off for
every tenant, and the only signal is one `console.error` line.

**T5 — the rate limiter silently degrades to per-instance memory.**
`lib/rate-limit.ts:63-68`: any DB error in the rate-limit path (Neon
exhaustion, pool timeout) falls back to `checkMemoryRateLimit`, a
module-level `Map` (`lib/rate-limit.ts:3`). On Vercel that Map is per-instance,
so the effective limit becomes `max × instance-count` and resets on every cold
start. Exactly the moment the DB is under stress is the moment login rate
limiting quietly stops being global. `failClosed: true` exists
(`lib/rate-limit.ts:60,66`) and is passed by exactly **5 of 56** call sites —
`app/api/apply/route.ts:27`, `app/api/magic-link/request/route.ts:25`,
`app/api/waiver/kiosk-request/route.ts:30`, `app/api/waiver/open/route.ts:58`,
`app/api/waiver/sign/route.ts:56`. **Login is not one of them**
(`auth.ts:176-181`), so the brute-force limiter is precisely the one that
degrades silently.

**T6 — `MAINTENANCE_MODE` is an undocumented global kill switch.**
`proxy.ts:104-126`. Not in `lib/env-guards.ts`'s list, not mentioned in the
task brief. `MAINTENANCE_MODE=true` returns 503 from every route except
`/api/health`, `/api/auth`, `/_next` and `/login`. Note the matcher at
`proxy.ts:222-223` excludes webhooks, cron and kiosk from middleware
**entirely** — so maintenance mode does **not** stop Stripe webhooks, cron
runs, or kiosk check-ins. It is a front-door switch, not a system switch.

**T7 — the declared cron count exceeds the Vercel Hobby cap.**
`vercel.json:3-17` declares three crons. Hobby allows two (and daily-only
granularity). A fourth cron route exists in code with no schedule at all:
`app/api/cron/stripe-reconcile/route.ts` is not in `vercel.json`. Whether the
deploy is Hobby or Pro is not determinable from the repo — see §5 for how to
tell which state production is in.

**T8 — a revoked operator session still renders admin page shells for up to
8 hours.** `proxy.ts:128-155` verifies the operator cookie's HMAC and expiry
at the edge but explicitly cannot check `sessionVersion` (no Prisma at edge).
The comment at `proxy.ts:136-138` states the consequence plainly. Same shape
for tenant sessions: `auth.ts:669-695` caches the `sessionVersion` check for
**10 minutes**, so a force-logout propagates with up to a 10-minute lag.

**T9 — email failure is durably recorded but never surfaced.** With
`RESEND_API_KEY` unset, `lib/email.ts:387-397` writes an `EmailLog` row with
`status:"failed", errorMessage:"RESEND_API_KEY not configured"` and returns
`{ok:false}`. Of **18** `sendEmail` call sites outside `lib/email.ts`, only
**3** check the result — `app/api/auth/forgot-password/route.ts:117`,
`app/api/magic-link/request/route.ts:110`,
`app/api/members/bulk-invite/route.ts:107`. The other 15 discard it, so
member invites, rank-change notices, receipts, refund notices, dispute alerts
and CSV handoffs all report success to the user while sending nothing. The
only evidence is a database row nobody reads.

**T10 — Vercel Blob absence is a silent storage-class downgrade, not an
outage.** Two independent fallbacks write base64 data URLs into Postgres:
`lib/waiver-signature-upload.ts:19-35` (signatures) and
`app/api/upload/route.ts:231-250` (images). Both return HTTP 200. The image
path at least records `storage: "blob" | "inline"` in the audit log
(`app/api/upload/route.ts:266`); the signature path records nothing. Legally
significant waiver signatures can end up inline in the DB with no signal.

---

## 1. GLOBAL MODES

### 1.1 TESTING_MODE

**Definition:** `lib/testing-mode.ts:23-36`.

```
isTestingMode() =
     process.env.TESTING_MODE === "true"               // exact, case-sensitive (:24)
  && process.env.VERCEL_ENV !== "production"           // (:26)
  && !DATABASE_URL.includes("ep-bold-wave-abt39t7x")   // (:20, :33)
```

Case-sensitivity is asserted deliberately — `"TRUE"`, `"1"`, `"yes"` all
return false (`tests/unit/testing-mode.test.ts:41-48`). Good property: no
accidental half-enabled state.

**What it bypasses — the complete list:**

| Bypass | Branch | Extra condition |
|---|---|---|
| Login rate limit (IP 30/30min + email 5/15min) | `auth.ts:171`, `auth.ts:173-182` | AND `isLocalhost` |
| bcrypt password verification entirely | `auth.ts:234-238` | AND `isLocalhost` AND password equals `E2E_BYPASS_TOKEN` |
| Owner TOTP challenge (`totpPending`) | `auth.ts:335` | none |
| Owner TOTP setup prompt (`requireTotpSetup`) | `auth.ts:339`, `:404`, `:507` | none |
| Member TOTP challenge | `auth.ts:376`, `:523` | none |
| Owner TOTP challenge, Google path | `auth.ts:506` | none |

The `isLocalhost` qualifier is `ip === "127.0.0.1" || ip === "::1" || ip ===
"unknown"` (`auth.ts:170`). The code is explicit that this is **not** a
security boundary (`auth.ts:156-163`): `"unknown"` is what you get when both
`x-forwarded-for` and `x-real-ip` are absent, which is also true of any
request arriving through a proxy that strips them.

**Consequence of the two-part gate:** the TOTP bypasses (rows 3-6) carry **no**
localhost qualifier — they fire for any request on any host. A preview
deployment with `TESTING_MODE=true` therefore has 2FA disabled for every user
reaching it over the public internet, not just for Playwright. That is the
documented intent (`lib/testing-mode.ts:8-9`), but it means a preview URL is a
2FA-free door to whatever database the preview points at. The
`isProductionDatabase()` check (`lib/testing-mode.ts:19-21`, `:33`) is the only
thing standing between that and real member data.

**Production refusal — two layers, one weak:**

1. `lib/testing-mode.ts:26` and `:33` — the functional refusal. **Silent:**
   returns `false`, logs nothing.
2. `auth.ts:53-55` — `console.warn("[auth] TESTING_MODE=true ignored in
   production")` at module load. Fires **only** when `NODE_ENV === "production"`
   and `NEXT_PHASE !== "phase-production-build"` (`auth.ts:44-47`) **and**
   `VERCEL_ENV === "production"`. It does **not** fire for the
   production-DATABASE-but-not-production-VERCEL_ENV case — exactly the case
   `lib/testing-mode.ts:27-32` says actually mattered. The more dangerous
   misconfiguration is the one with no log line.

**How you would know which state production is in:** you cannot tell from any
endpoint. `/api/health` (`app/api/health/route.ts:43-56`) returns only
`{status, db, timestamp}` and deliberately excludes env details
(`app/api/health/route.ts:10-11`). `/api/stripe/connect/health` reports Stripe
vars only. The only positive signal is the absence of a 2FA prompt for a user
known to have `totpEnabled=true` — i.e. you discover it by observing the bypass.

### 1.2 DEMO_MODE

**Production refusal:** `auth.ts:44-50` — a module-load
`throw new Error("DEMO_MODE must not be enabled in production")`. The loudest
guard in the codebase: the auth module fails to load, so every route importing
`@/auth` fails. Gated on `NODE_ENV === "production"` and
`NEXT_PHASE !== "phase-production-build"`, so the build still succeeds and the
failure surfaces at first request.

**What it enables:** a hardcoded credential map reached **only** from the
`catch` block of the credentials `authorize()` — i.e. only when the database
lookup already threw (`auth.ts:412-445`).

- `auth.ts:421` — `if (NODE_ENV === "production") return null;` placed first as
  a dead-code-elimination hint (rationale at `auth.ts:414-420`).
- `auth.ts:422` — `if (DEMO_MODE !== "true") return null;`
- `auth.ts:424-445` — four accounts on tenant `totalbjj` with the literal
  password `password123`, yielding `tenantId: "demo-tenant"`,
  `sessionVersion: 0`.

**Downstream behaviour of a `demo-tenant` session** (reachable independently of
`DEMO_MODE` once such a token exists):

- `auth.ts:588-611` — the jwt callback tries to upgrade the stale demo token to
  real DB ids on the next request; on failure it silently keeps the demo token
  (`auth.ts:609`).
- `auth.ts:670-672` — the `sessionVersion` revocation check is **skipped
  entirely** for `tenantId === "demo-tenant"`. A demo token cannot be revoked.
- `app/api/member/me/route.ts:73-82` — fabricated member payload.
- `app/api/member/home/route.ts:143-145` — fabricated home data. The condition
  is `session.user.tenantId === "demo-tenant" || !memberId`, so **a real
  session with no `memberId` also receives demo data here**, whereas
  `app/api/member/me/route.ts:86-91` deliberately returns 404 for that same
  case and documents why fabricating it was a UI-RULES violation. **The two
  routes disagree on the same condition.**

Demo badges are derived from a synthetic history rather than authored
(`lib/demo-member.ts:29-50`), so the fixtures are at least self-consistent.

### 1.3 DEMO_TENANTS branding fallback (distinct from DEMO_MODE)

`app/api/tenant/[slug]/route.ts:15-27` and `:110-112`. On a **lookup failure**
(database unreachable — not "no such slug"), a non-production process serves
fabricated branding for the slug `totalbjj`. Gated on
`NODE_ENV !== "production"` only — not on `VERCEL_ENV`, not on `DEMO_MODE`.
Production returns 503 with an honest message (`:114-119`). The reasoning at
`:100-117` is sound and the 404-vs-503 split is correct.

Separate always-on state machine above it: a tenant that is soft-deleted,
`cancelled`, or `suspended` is rendered indistinguishable from "does not exist"
— same 404, same body (`app/api/tenant/[slug]/route.ts:76-87`). Deliberate
anti-enumeration, but an owner whose gym was suspended sees "Gym not found" at
the login screen with no other signal.

### 1.4 MAINTENANCE_MODE

`proxy.ts:104-126`. `MAINTENANCE_MODE === "true"` returns 503 with
`retry-after: 120` for everything except `/api/health`, `/api/auth/*`,
`/_next/*`, and exactly `/login`.

**Critical scope limitation:** the middleware `matcher` (`proxy.ts:222-223`)
already excludes `api/webhooks`, `api/stripe/webhook`, `api/cron`,
`api/health`, `api/kiosk`, `kiosk`, and `api/magic-link` from the middleware
entirely. Maintenance mode therefore **does not stop**: Stripe webhooks (money
still moves and is still recorded), cron jobs (retention deletion still runs —
see §5.4), kiosk check-ins, or magic-link issuance. It is a front-door switch,
not a system switch. If the reason for engaging it is a data problem, the write
paths most likely to compound that problem are the ones still open.

Loud/silent: **loud to humans** (503 JSON body), **silent to instrumentation**
— nothing logs that maintenance mode is engaged, and `/api/health` keeps
returning 200 because it is excluded. An uptime monitor pointed at
`/api/health` shows the system green throughout a maintenance window.

### 1.5 ENABLE_GOOGLE_OAUTH — split-brain with its NEXT_PUBLIC twin

`auth.ts:34-37`: the provider is registered only when `ENABLE_GOOGLE_OAUTH ===
"true"` **and** both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are
non-empty. The button is rendered on a **different** variable:
`app/login/page.tsx:715` reads `NEXT_PUBLIC_ENABLE_GOOGLE_OAUTH === "true"`.

Two variables, no cross-check. Set the public one without the server one (or
with a missing client secret) and the login page shows a Google button routing
to a provider that was never registered. Neither `lib/env-guards.ts` nor
`auth.ts` warns about the mismatch. **Silent.**

### 1.6 NEXT_PUBLIC_ENABLE_LOGIN_NOTIFICATIONS

`lib/login-event.ts:35-39`. Off unless exactly `"true"`. When off, new-device
login alert emails are not sent. Silent by design.

### 1.7 NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY — implicit "pay at desk" mode

`app/member/shop/page.tsx:44`:
`const PAY_AT_DESK = !process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;`

Absence of a **client** variable silently switches the member shop into a
non-card-payment mode. This variable is **not** in `.env.example` and **not**
in `lib/env-guards.ts`. The repo `.env` sets `STRIPE_PUBLISHABLE_KEY` — no
`NEXT_PUBLIC_` prefix — a name this code does not read. Being a
`NEXT_PUBLIC_*` var it is inlined at **build** time, so setting it in Vercel
without redeploying changes nothing. **Silent**, and the failure mode is "the
gym quietly stops taking money online".

---

### 1.8 NODE_ENV vs VERCEL_ENV — complete branch inventory

Two different variables, used for different purposes, and the distinction is
the source of most of the subtlety in this system.

- **`NODE_ENV`** is `"production"` on **both** Vercel production **and**
  Vercel preview (Next sets it for any `next build`). It is therefore a
  *build-mode* signal, not an *environment* signal.
- **`VERCEL_ENV`** is `"production" | "preview" | "development"`, and unset
  locally. It is the only real environment signal.

Only **four** places in the whole app read `VERCEL_ENV`:

| Site | Branch | Effect |
|---|---|---|
| `lib/testing-mode.ts:26` | `=== "production"` | refuses the 2FA/bcrypt bypass |
| `auth.ts:53` | `=== "production"` | warns that TESTING_MODE was ignored |
| `auth.ts:66` | `=== "production"` | throws if auth secret shorter than 32 chars |
| `scripts/maybe-migrate.mjs:34` | `=== "production"` | permits `prisma migrate deploy` against prod DB |

Everything else branches on `NODE_ENV`, which means **preview behaves exactly
like production** for all of it. Full inventory:

**Security-relevant (preview == production):**

| Site | Branch | Effect when `NODE_ENV==="production"` |
|---|---|---|
| `lib/auth-cookie.ts:18-23` | ternary | cookie name becomes `__Secure-authjs.session-token`; `SESSION_COOKIE_SECURE=true` |
| `lib/admin-auth.ts:92`, `:109` | conditional | `Secure` flag on `matflow_admin` cookie |
| `lib/operator-auth.ts:120`, `:135`, `:150`, `:161` | conditional | `Secure` flag on operator session + TOTP challenge cookies |
| `lib/impersonation.ts:102` | `secure:` | `Secure` flag on impersonation cookie |
| `lib/pending-tenant-cookie.ts:42` | `secure:` | `Secure` flag on pending-tenant cookie |
| `lib/auth-secret.ts:6` | throw | refuses empty signing key (also gated on `NEXT_PHASE`) |
| `auth.ts:44-47` | guard block | enables the DEMO_MODE throw, secret-length check, RESEND_FROM warning |
| `lib/env-guards.ts:53` | early return | the entire boot guard runs only here |
| `next.config.ts:3,11,18,27` | `isProd` | drops `unsafe-eval`, drops localhost `connect-src`, adds `upgrade-insecure-requests` |

**Behaviour / data-honesty:**

| Site | Branch | Effect |
|---|---|---|
| `app/api/tenant/[slug]/route.ts:110` | `!== "production"` | serves fabricated `DEMO_TENANTS` branding on DB failure |
| `auth.ts:421` | `=== "production"` | disables the DEMO_MODE credential map |
| `app/api/auth/forgot-password/route.ts:100-108` | `=== "production"` | 503 vs **printing the reset OTP to stdout** |
| `app/api/magic-link/request/route.ts:92-96` | `=== "production"` | 503 vs **printing the magic link to stdout** |
| `app/api/webhooks/resend/route.ts:48-50` | `=== "production"` | 503 vs accepting **unsigned** webhook events |
| `app/api/admin/applications/[id]/approve/route.ts:193` | `=== "production"` | omits `activationLink` from the API response |
| `lib/csrf.ts:45-48` | `!== "production"` | adds `localhost:3000` / `localhost:3847` to the CSRF origin allow-list |
| `app/api/upload/route.ts:11-16` | `!== "production"` | boot warning that Blob is unconfigured |
| `lib/prisma.ts:44`, `:73`, `:77`, `:89` | various | pooled-host warning, pool `max` 5 vs 20, log level, dev global caching |
| `components/pwa/RegisterSW.tsx:11` | `!== "production"` | skips service-worker registration |
| `components/layout/Sidebar.tsx:29` | `!== "production"` | dev-only warning on an unrecognised role |
| `components/ui/data-table.tsx:212` | `=== "production"` | skips the clipping-ancestor dev warning |

**The consequential asymmetries:**

1. **Preview deployments are `NODE_ENV=production`.** So on a preview:
   `lib/env-guards.ts` runs and can **hard-throw the server**; the DEMO_MODE
   throw is armed; `Secure` cookies are set; the `DEMO_TENANTS` branding
   fallback is **off**; the OTP/magic-link console fallbacks are **off** (they
   503 instead). But `TESTING_MODE` is **on**. A preview is thus "production
   strictness everywhere except authentication".

2. **`app/api/admin/applications/[id]/approve/route.ts:185`** logs the owner
   activation link — a credential — with `console.warn` **unconditionally**
   when `RESEND_API_KEY` is unset. No `NODE_ENV` gate on that line, unlike the
   response field two lines below at `:193`. In production with Resend
   unconfigured, activation links land in Vercel logs.

3. **A non-Vercel production host** (`VERCEL_ENV` unset, `NODE_ENV=production`)
   gets: env guards ON, DEMO_MODE throw ON, secure cookies ON — but the
   32-char secret check OFF (`auth.ts:66` requires `VERCEL_ENV==="production"`)
   and `TESTING_MODE` HONOURED (§1.1). That combination is the T1 hazard.

---

## 2. ENV-ABSENCE MATRIX

### 2.1 The boot guard, and what it actually checks

`lib/env-guards.ts:20-50` declares nine variables. It runs from
`instrumentation.ts:18`, once per Node/edge runtime, and **only** when
`NODE_ENV === "production"` and `NEXT_PHASE !== "phase-production-build"`
(`lib/env-guards.ts:53-54`). Missing `error`-severity vars produce a single
thrown `Error` listing all of them (`:70-77`); `warn`-severity produce
`console.warn` lines (`:66-68`).

REQUIRED list as declared:

| Var | Severity | Stated reason (`lib/env-guards.ts`) |
|---|---|---|
| `DATABASE_URL` | error | `:23` |
| `RESEND_API_KEY` | error | `:27` |
| `STRIPE_SECRET_KEY` | error | `:32` |
| `STRIPE_WEBHOOK_SECRET` | error | `:33` |
| `STRIPE_CLIENT_ID` | error | `:34` |
| `MATFLOW_ADMIN_SECRET` | error | `:38` |
| `SENTRY_DSN` | warn | `:42` |
| `CRON_SECRET` | warn | `:48` |
| `RESEND_WEBHOOK_SECRET` | warn | `:49` |

### 2.2 Cross-check: REQUIRED list vs what the code actually tolerates

**Over-strict (guard throws; runtime would have coped fine):**

| Var | Guard | Actual runtime tolerance |
|---|---|---|
| `RESEND_API_KEY` | throws | `lib/email.ts:19-25` returns a `null` client; `:388-397` writes an `EmailLog` row `status:"failed"` and returns `{ok:false}`. Password reset and magic link 503 explicitly (`forgot-password:100-106`, `magic-link/request:92-94`). Nothing crashes. |
| `STRIPE_SECRET_KEY` | throws | Every consumer already guards: 503 at `class-packs/route.ts:55`, `member/class-packs/buy:63`, `payments/[id]/refund:111`, `stripe/portal:52`, `members/[id]/charge:108`, `cron/stripe-reconcile:27`; `{card:null}` at `members/[id]/payment-method:17`; **pay-at-desk Order** at `member/checkout:102-115`; safe-deny status at `lib/stripe-account-status.ts:35-43`. |
| `STRIPE_WEBHOOK_SECRET` | throws | `app/api/stripe/webhook/route.ts:29-31` returns 400 "Missing signature". Clean refusal. |
| `STRIPE_CLIENT_ID` | throws | `app/api/stripe/connect/route.ts:12-15` returns 503 "Stripe Connect not configured". Clean refusal. |
| `MATFLOW_ADMIN_SECRET` | throws | `lib/admin-auth.ts:41-42`, `:50-51` return `false` on missing env; the v1.5 operator path (`lib/operator-auth.ts`) works entirely without it. **The guard makes an obsolete v1 secret mandatory.** |

**Under-covered (guard silent; absence changes behaviour):**

| Var | Guard | What actually happens when unset |
|---|---|---|
| `RESEND_FROM` | **not in list** | `lib/email.ts:387` falls back to `"MatFlow <onboarding@resend.dev>"` — the Resend sandbox sender. Mail sends, is accepted, and lands in spam. Warned at `auth.ts:75-82` (also matches any address ending `resend.dev`), but only when `NODE_ENV==="production"`. **Silent at the API level: `sendEmail` returns `{ok:true}`.** |
| `BLOB_READ_WRITE_TOKEN` | **not in list** | Split behaviour. Three routes return a clean 503: `admin/import/upload:59-61`, `initiatives/[id]/attachments:32-34`, `onboarding/csv-handoff:42-44`. Two routes **silently downgrade to base64-in-Postgres**: `lib/waiver-signature-upload.ts:19-35` and `app/api/upload/route.ts:231-250`. Boot warning exists but is gated `NODE_ENV !== "production"` (`app/api/upload/route.ts:11`) — i.e. **the warning is off precisely in production**. |
| `NEXTAUTH_URL` | **not in list** | `lib/env-url.ts:15-27` falls back to the request origin, else `""`. `auth.ts:69` warns. An empty base URL yields malformed links in every transactional email and both Stripe return URLs. Trailing-newline defence at `lib/env-url.ts:18` exists because this has bitten before. |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | **not in list** | Enforced twice elsewhere: `auth.ts:56` throws if both absent; `lib/auth-secret.ts:6-8` throws at import. Length check (>=32) only when `VERCEL_ENV==="production"` (`auth.ts:66`). A short-but-present secret on a non-Vercel prod host is accepted, and it signs kiosk tokens (`lib/kiosk-token.ts:46`), impersonation tokens (`lib/impersonation.ts:48`), operator sessions (`lib/operator-auth.ts:44`) and Stripe Connect OAuth state (`app/api/stripe/connect/route.ts:19`). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | **not in list** | `lib/push.ts:11` — `sendPushToMember` returns immediately. Every push notification is a **silent no-op**. No log, no error, no record. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | **not in list** | §1.7 — silent pay-at-desk mode. |
| `NEXT_PUBLIC_SENTRY_DSN` | **not in list** | `sentry.client.config.ts:13` — client-side Sentry never initialises. `SENTRY_DSN` (server) being set does **not** cover the browser. Two separate variables, one warn. |
| `E2E_BYPASS_TOKEN` | **not in list** | `auth.ts:236` — absence disables the bcrypt bypass (fail-safe direction). Not documented in `.env.example`. |
| `MAINTENANCE_MODE` | **not in list** | Documented at `.env.example:57`; nothing reports its state at boot. |

**Correctly matched:** `DATABASE_URL` (error, and `lib/prisma.ts:22` throws on
first use anyway), `SENTRY_DSN` (warn — `sentry.server.config.ts:11` /
`sentry.edge.config.ts:14` are genuine no-ops), `CRON_SECRET` (warn — all four
cron routes return a clean 503, `cron/monthly-reports:19-21`,
`cron/retention:133-135`, `cron/class-instances:72-74`,
`cron/stripe-reconcile:20-22`), `RESEND_WEBHOOK_SECRET` (warn —
`webhooks/resend:45-50`, 503 in production, unsigned-accept in dev).

### 2.3 The net effect

The guard is calibrated backwards. It hard-fails the server for five variables
whose absence produces clean, well-handled 503s, and stays quiet for the four
whose absence produces **silent wrong behaviour**: `RESEND_FROM` (mail to
spam), `BLOB_READ_WRITE_TOKEN` (signatures into Postgres),
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (no online payments), and the VAPID pair
(no push at all). A Vercel deploy missing `MATFLOW_ADMIN_SECRET` — a secret the
v1.5 operator login does not need — takes the whole app down.

---

## 3. TENANT-LEVEL MODES

Per-tenant state that changes behaviour for everyone in that gym.

### 3.1 Tenant.onboardingCompleted (default false, `prisma/schema.prisma:25`)

**The only redirect** is `app/dashboard/layout.tsx:33-35`:
`role === "owner" && tenant && !tenant.onboardingCompleted` redirects to
`/onboarding`. The reverse gate is `app/onboarding/page.tsx:27`: if
`onboardingCompleted` and `resume !== "1"`, redirect to `/dashboard`. No loop,
and the `?resume=1` escape hatch (`components/dashboard/SetupBanner.tsx:11`)
lets a completed owner re-enter.

Two things worth noting:

1. The tenant read at `app/dashboard/layout.tsx:26-31` ends in
   `.catch(() => null)`. On a DB error `tenant` is `null`, the condition
   `tenant && !tenant.onboardingCompleted` is false, and **the owner is let
   through to the dashboard**. A deliberate fail-open on a non-security gate,
   but a transient DB fault can put an un-onboarded owner on a dashboard that
   assumes setup is done.
2. Only **owners** are redirected. A manager, coach or admin on a tenant that
   never completed onboarding lands straight on the dashboard.

Separately, `app/dashboard/page.tsx:37` suppresses the entire setup-gaps
banner while `!onboardingCompleted`, with the stated reason at `:35-36`.

There is a **second, unrelated** `onboardingCompleted` on `Member`
(`prisma/schema.prisma:135`). It gates the member wizard client-side at
`app/member/home/page.tsx:1278` and is flipped by
`app/api/member/me/route.ts:362` with server-side trio enforcement at
`:404-419`. Same field name, different table, different meaning.

### 3.2 Tenant.stripeConnected and Tenant.stripeAccountStatus

`stripeConnected` (`prisma/schema.prisma:28`, default `false`) is set true only
at `app/api/stripe/connect/callback/route.ts:63` and cleared at
`app/api/stripe/disconnect/route.ts:40`, which also sets
`stripeAccountStatus: Prisma.DbNull` — correctly, so a stale `chargesEnabled`
verdict from the old account cannot survive (comment at `:39`).

**Blocked when `stripeConnected === false`** — all 503 with a member-readable
message: `app/api/class-packs/route.ts:52`,
`app/api/member/class-packs/buy/route.ts:60`,
`app/api/member/subscriptions/start/route.ts:71-73`,
`app/api/member/subscriptions/start-for-kid/route.ts:75`,
`app/api/member/subscriptions/cancel/route.ts:46`,
`app/api/member/subscriptions/cancel-for-kid/route.ts:58`,
`app/api/member/family/[id]/billing/portal/route.ts:43`,
`app/api/stripe/create-subscription/route.ts:44`.

**Not blocked:** `app/api/member/checkout/route.ts:167` treats it as optional
(`tenant.stripeConnected ? tenant.stripeAccountId : undefined`), and `:102-115`
writes a **pay-at-desk `Order`** when `STRIPE_SECRET_KEY` is absent. The shop
degrades gracefully while subscriptions hard-refuse — two surfaces, two
philosophies.

**Staleness.** `lib/stripe-account-status.ts:132-148` — `ensureCanAcceptCharges`
refreshes only when the cache is missing or `refreshedAt` is older than **24
hours** (default at `:136`). Normal freshness comes from the `account.updated`
webhook (`app/api/stripe/webhook/route.ts:62`, `:188`).

**The stale window that matters:** if the webhook endpoint is down or
misconfigured (§5.3), a gym whose Stripe account has lost `charges_enabled`
keeps passing the gate for up to 24 hours, because the cached
`chargesEnabled: true` is inside the staleness window and is never re-read.
Charges taken in that window are the exact failure the gate exists to prevent.

**The fail-open.** `lib/stripe-account-status.ts:68-84` — on a
`StripePermissionError`, or any error message matching
`/does not have the required permissions/i`, the persisted status becomes
`{chargesEnabled: true, payoutsEnabled: true, disabledReason:
"status_unreadable"}`, then serves every gate check for 24 hours. Signal: one
`console.error` at `:72-77`. Every other error path fails closed with
`disabledReason: "refresh_error"` (`:87-93`). Detection: query tenants whose
`stripeAccountStatus->>'disabledReason'` is `status_unreadable` or
`stripe_not_configured`.

Also `lib/stripe-account-status.ts:97-106`: if the **persist** fails, the
function still returns the fresh status to its caller while the cache keeps the
old value. Logged at `:105`, otherwise invisible.

### 3.3 Kiosk enabled / disabled / regenerated

State lives in `Tenant.kioskTokenHash` and `kioskTokenIssuedAt`
(`prisma/schema.prisma:55-60`); `null` means disabled.

`app/api/settings/kiosk/route.ts` — owner-only (`:45-47`), CSRF-checked (`:41`):

- `disable` (`:63-79`) nulls both fields; audited as `tenant.kiosk.disabled`.
- `enable` (`:89`) returns **409** if already enabled, forcing `regenerate`.
- `regenerate` mints a fresh 24-byte base64url token (`:34-38`) and stores only
  its HMAC (`lib/token-hash.ts`).

**Old-URL behaviour after disable or regenerate:** lookups are by
`kioskTokenHash` (`app/api/kiosk/[token]/checkin/route.ts:58-66`), so an old
printed QR returns a flat **404 "Not found"** — indistinguishable from a typo.
There is no "this kiosk was disabled" state. For a wall-mounted tablet that is
the most likely real-world confusion: the screen simply stops working with a
generic error.

The raw token is returned **once**, at mint time (`:6-10`). No recovery path.

Second-layer token: `lib/kiosk-token.ts` issues a 10-minute HMAC envelope
binding `memberId` to `tenantId` and `exp` (`:22`, `:36-48`) so the member list
cannot be replayed as arbitrary check-ins. Verified at
`app/api/kiosk/[token]/checkin/route.ts:68-70`; four distinguishable internal
failure reasons (`lib/kiosk-token.ts:55`) collapse to one 400 message. Signed
with `AUTH_SECRET_VALUE` — so **rotating the auth secret instantly invalidates
every in-flight kiosk token, every impersonation cookie and every operator
session** (`lib/kiosk-token.ts:46`, `lib/impersonation.ts:48`,
`lib/operator-auth.ts:44`).

Kiosk routes are excluded from middleware (`proxy.ts:223`), so
`MAINTENANCE_MODE` does not disable the kiosk.

### 3.4 Waiver template missing

`Tenant.waiverTitle` and `waiverContent` are both nullable
(`prisma/schema.prisma:51-52`). Absence is handled by a **content fallback,
not an error**:

- `app/api/waiver/route.ts:19-21` — falls back to
  `buildDefaultWaiverTitle(tenant?.name)` / `buildDefaultWaiverContent(...)`,
  and exposes an honest `isCustom: !!(waiverTitle || waiverContent)`.
- `app/api/waiver/open/route.ts:51-52` (read) and `:113-114` (sign) — same
  fallback, and the signing path snapshots the resolved text into
  `titleSnapshot` / `contentSnapshot`, so the evidence record is complete even
  when the tenant never customised anything.

`lib/default-waiver.ts:11-22` interpolates the gym name, defaulting to
`"the gym"` when blank (`:12`). A tenant with no name and no template therefore
produces a signed waiver naming "the gym" — consistent, but odd.
`lib/default-waiver.ts:1-4` is explicit that these are starting templates, not
legal advice, with a UCTA 1977 caveat baked into the wording.

This is the best-behaved fallback in the codebase: it degrades to a defensible
default, records what was actually shown, and surfaces `isCustom` so the UI can
tell the owner. **Loud enough.**

### 3.5 Tenant lifecycle states (subscriptionStatus, deletedAt)

- **Login refused** for `deletedAt !== null` and `subscriptionStatus ===
  "suspended"` (`auth.ts:193-194`). Returns `null`, which the login UI renders
  as generic invalid credentials. **Silent to the owner.**
- **Branding lookup 404s** for `deletedAt`, `cancelled`, or `suspended`
  (`app/api/tenant/[slug]/route.ts:76-87`) — "Gym not found".
- **Asymmetry:** `cancelled` blocks the branding lookup but is **not** in the
  `auth.ts:193-194` refusal list. Users of a cancelled tenant who already hold
  valid JWTs keep working until token expiry (30 days, `auth.ts:123`), while
  new logins fail at the club-code step with "Gym not found".

---

## 4. REQUEST-LEVEL MODES

### 4.1 RLS context: withTenantContext vs withRlsBypass vs raw prisma

**`withTenantContext(tenantId, fn)`** — `lib/prisma-tenant.ts:36-57`. Opens an
interactive transaction and sets the transaction-local GUC
`app.current_tenant_id` (`:46`). Budgets raised from Prisma defaults to
`maxWait 10s / timeout 15s` (`:34`) because the defaults P2028-ed under pool
contention (rationale at `:26-32`). Errors are stamped with the tenant id on
the way out (`:49-56`) via a non-enumerable property, so it cannot leak into a
response. **149 files use it.**

**`withRlsBypass(fn)`** — `lib/prisma-tenant.ts:67-75`. Sets
`app.bypass_rls = 'on'`. Documented as an escape hatch for webhooks, cron, the
auth flow and public form processing (`:59-66`). **41 files use it.** The list
is defensible: every one is a pre-session or cross-tenant path —
`auth.ts:187-189` (resolve tenant by slug before a session exists),
`app/api/tenant/[slug]/route.ts:55` (public branding, justified at `:52-54`),
the three kiosk routes, both webhook routes, all three cron routes, the admin
routes, magic-link and invite.

**Raw `prisma`** — 12 files import it. Model calls outside a wrapper:

| File | Models | Assessment |
|---|---|---|
| `lib/rate-limit.ts:17,30,33,83` | `RateLimitHit` | Not tenant-scoped. Fine. |
| `lib/push.ts:12,21` | `PushSubscription` | Keyed by `memberId`, no tenant filter. Relies on `memberId` being unguessable. |
| `lib/operator-auth.ts:183,218,235,254,279` | `Operator` | Platform table, no `tenantId`. Fine. |
| `app/api/admin/auth/operator-totp/route.ts:72,97,103`; `.../setup/route.ts:40,52,84,97` | `Operator` | Same. Fine. |
| `app/api/health/route.ts:32` | `$queryRaw SELECT 1` | Deliberately unwrapped, rationale `:26-29`. Fine. |
| `app/api/settings/route.ts:131` | type-only | Not a call. Fine. |
| `auth.ts:591,595,624,681,685` | `Tenant`, `User`, `Member` | **Tenant-scoped tables read with no RLS context.** |

The `auth.ts` raw reads are the demo-token upgrade (`:591-597`), the
impersonation target lookup (`:624-635`), and the `sessionVersion` recheck
(`:681-688`). All are by primary key or by a `(tenantId, email)` pair the
caller already holds, so not enumeration vectors — but they are where RLS does
no work.

**The critical unknown — is RLS actually on in production?**

`prisma/migrations/20260503200000_activate_rls_enforcement/migration.sql:1-8`
states the intended posture: an uncontexted query returns zero rows or fails.
Policies are `ENABLE` + `FORCE ROW LEVEL SECURITY` (`:31-32` onward), so table
ownership alone does not bypass them.

**However**, `scripts/create-restricted-role.ts:1-2` reads: *"Create a
restricted, non-BYPASSRLS application role on the test branch so RLS actually
enforces (proves the prod remediation)"*, and `:8` refuses production with
*"create the role manually on prod when you cut over"*. That wording means
that, when the script was written, **the production connection role still had
BYPASSRLS and RLS was not actually enforcing in production**.

Whether the manual prod cutover has since happened is **UNVERIFIED** — it
cannot be determined from the repository. The check is
`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles;` against the production
database, or running the read-only `scripts/probe-rls-uncontexted.mjs`, which
exists specifically to answer this (`:1-5`).

If it has not happened, every `withTenantContext` call is application-layer
filtering only and the `withRlsBypass` distinction is cosmetic. **This is the
single most important unknown in this report.**

### 4.2 Impersonation cookie present

`lib/impersonation.ts`. Cookie `matflow_impersonation`, HMAC-SHA256 over
`{adminUserId, targetUserId, targetTenantId, reason, exp}` with
`AUTH_SECRET_VALUE` (`:34-50`), 60-minute TTL (`:17`), `httpOnly`,
`sameSite: "strict"`, `secure` only when `NODE_ENV === "production"`
(`:100-106`).

**What changes when present** — `auth.ts:613-660`, inside the `jwt` callback,
skipped on the edge runtime (`:620`):

- Identity wholly swapped: `id`, `tenantId`, `tenantSlug`, `tenantName`, brand
  colours, `role`, `sessionVersion` (`:637-645`).
- `memberId` forced to `null` (`:646`).
- **`totpPending = false`, `requireTotpSetup = false`, `totpEnabled = true`**
  (`:647-652`). TOTP bypassed entirely; rationale at `:618-619` is that the
  admin secret already authorised access. `totpEnabled: true` also suppresses
  the recommend-2FA banner (`:649-651`).
- `sessionVersionCheckedAt` reset (`:654`) — the target revocation window
  restarts.
- `impersonatedBy` / `impersonationReason` stamped (`:655-656`), propagated to
  the session at `auth.ts:739-746`.

Guard: the swap happens only if `target.tenantId === imp.targetTenantId`
(`:636`), so a token cannot be re-pointed at another tenant.

**Failure handling:** the whole block is `catch { /* best-effort */ }`
(`:659`). If the target lookup throws, the operator silently continues as
**themselves** rather than the target. No log line.

**Visibility:** `components/layout/ImpersonationBanner` is mounted at
`app/dashboard/layout.tsx:49`, so the banner shows on `/dashboard/**`. There is
no equivalent mount in the member layout, and API responses carry no marker.
Whether writes during impersonation are attributed to the operator or the
target in `AuditLog` is **UNVERIFIED**; `auth.ts:637` sets `token.id` to the
target, which suggests the target.

### 4.3 Operator challenge cookie

`lib/operator-auth.ts:30-32`. `matflow_op_challenge`, 5-minute TTL (`:32`),
`Path=/api/admin/auth` (`:147`) so it is not sent to the rest of the app,
`SameSite=Strict`, `Secure` only in production (`:150`).

Domain-separated from the session cookie by prefixing the HMAC payload with
`"operator-totp."` (`:67`, `:100`) — a challenge cookie cannot be replayed as a
session cookie. Correct.

Consumption at `app/api/admin/auth/operator-totp/route.ts`: rate-limited
per-IP (`:40-44`) **and** per-operator (`:60-70`, 5 per 10 min); requires the
challenge (`:56-58`); re-checks `sessionVersion`, `totpEnabled`, `totpSecret`
(`:77-84`); and on a wrong code increments `Operator.failedLoginCount`, locking
at 5 for 15 minutes (`:95-108`). The comment at `:88-94` documents the bypass
this closed — password-success, five TOTP attempts, ten-minute wait, repeat
with a rotated IP.

### 4.4 Rate-limited state

`lib/rate-limit.ts:56-78`. Primary store is the `RateLimitHit` table
(`:17-35`) — a single `groupBy` returning count and `min(hitAt)` together
(rationale `:11-16`). Opportunistic pruning at 5% probability (`:31-34`),
fire-and-forget.

**The degradation:** `:63-68` — any exception from the DB path falls through to
`checkMemoryRateLimit`, backed by a module-level `Map` (`:3`). Per-instance,
lost on cold start. `failClosed: true` overrides this and rethrows (`:66`), but
only 5 of 56 call sites pass it: `app/api/apply/route.ts:27`,
`app/api/magic-link/request/route.ts:25`,
`app/api/waiver/kiosk-request/route.ts:30`, `app/api/waiver/open/route.ts:58`,
`app/api/waiver/sign/route.ts:56`.

**Login is not among them** (`auth.ts:176-179`). Under database stress the
brute-force limiter silently becomes per-instance and effectively
`max × instance-count`. Signal when a limit *is* hit: `console.warn` at
`lib/rate-limit.ts:71-76`. Signal when the limiter *degrades*: **none**.

Client IP is `x-forwarded-for` first value, else `x-real-ip`, else the literal
`"unknown"` (`:87-91`). Every request lacking both headers shares one bucket —
and `"unknown"` is also one of the three values satisfying `isLocalhost` in the
TESTING_MODE bypass (`auth.ts:170`).

### 4.5 sessionVersion mismatch window

**Tenant sessions** — `auth.ts:662-695`. The DB recheck is gated behind
`SESSION_VERSION_RECHECK_INTERVAL_MS = 10 * 60 * 1000` (`:669`), so a force
sign-out (password change, admin revoke, "wasn't me" disown) propagates within
**up to 10 minutes**, not immediately. On mismatch the callback returns `null`
(`:691`) and `session()` yields no user (`auth.ts:721`).

Three carve-outs:

- Skipped entirely on the edge runtime (`:671`) — Prisma is Node-only. So
  `proxy.ts` never enforces revocation; the Node-runtime layout `auth()` call
  does.
- Skipped for `tenantId === "demo-tenant"` (`:672`).
- `catch { /* DB transient — keep token */ }` (`:694`) — **a database outage
  extends the revocation window indefinitely**, silently.

**Operator sessions** — checked properly at `lib/operator-auth.ts:275-286`:
`resolveOperatorFromCookie` compares `op.sessionVersion !==
verified.sessionVersion` on **every** call, no caching. But the edge gate
cannot (`proxy.ts:47-80`, comments at `:43-45` and `:136-138`), so a revoked
operator still renders `/admin/*` page shells until the cookie's 8-hour expiry
while every API call underneath returns 401.

### 4.6 CSRF origin allow-list

`lib/csrf.ts:33-59`. Allowed origins: `NEXTAUTH_URL`, `VERCEL_URL`,
`NEXT_PUBLIC_VERCEL_URL`, the localhost pair when `NODE_ENV !== "production"`
(`:45-48`), plus **`https://<host>` and `http://<host>` derived from the
request's own `Host` header** (`:52-56`). The justification at `:50-51` is that
the browser, not the attacker, sets `Origin` — true for browser traffic, but it
does make the allow-list effectively self-referential, so the env vars
contribute little. Applied only to the multipart / `text/plain` upload routes
listed at `:15-16`; webhooks, cron and `/api/apply` are deliberately excluded
(`:18-23`).

---

## 5. INFRASTRUCTURE STATES

### 5.1 Instrumentation boot-throw

`instrumentation.ts:17-26` calls `runProductionEnvGuards()` **first**, before
Sentry init. So if the env guard throws (§2.1), **Sentry is never initialised**
and the boot failure is reported only to Vercel's own runtime log. The one
failure you most want in Sentry is structurally excluded from it.

`onRequestError` (`instrumentation.ts:38-87`) is the catch-all for unhandled
route and render failures. It derives a stable reference from Next's `digest`
(`:40-44`) so the browser boundary and the server log agree, logs a structured
`[unhandled-error]` line (`:64`), and forwards to Sentry **only if
`process.env.SENTRY_DSN` is set** (`:66`). The whole body is wrapped in
`catch {}` (`:83-86`) — deliberate, documented at `:84-85`.

### 5.2 maybe-migrate on deploy

`scripts/maybe-migrate.mjs`, wired into `npm run build` via
`"build": "node scripts/maybe-migrate.mjs && next build"` in `package.json`.

Three states:

1. **No `DATABASE_URL`** — `:16-20` warns twice and `exit(0)`. Build proceeds,
   migrations unapplied. The warning text admits the ambiguity itself: *"If
   this is production, fix the env var. If preview, this is fine."*
2. **Prod endpoint but not a prod deploy** — `:35-42` refuses loudly and
   `exit(0)`. Guard is `DATABASE_URL.includes("ep-bold-wave-abt39t7x") &&
   VERCEL_ENV !== "production"`. Rationale at `:22-33`: a local build once
   migrated production because "unset" was treated as production.
3. **Otherwise** — `npx prisma migrate deploy`; failure is `exit(1)`
   (`:45-50`), which fails the build. Correct.

**The weakness is state 2's dependence on the endpoint literal (T2).** If the
production Neon endpoint id ever changes, this refusal silently stops matching
and a preview build pointed at production will migrate it.

### 5.3 Stripe webhook down or misconfigured

**Signature layer.** `app/api/stripe/webhook/route.ts:29-31` — missing
signature **or** missing `STRIPE_WEBHOOK_SECRET` returns 400 "Missing
signature". `:38-40` — verification failure returns 400 "Invalid signature".
Stripe records both as failed deliveries and retries, but **MatFlow logs
nothing** on either path. A rotated signing secret is therefore invisible from
inside the app; you see it only in Stripe's webhook attempt log.

**Unhandled types.** `:46-67` — `HANDLED_EVENT_TYPES` is a 16-entry set;
anything else is acked with `{received:true, ignored:true}` **without claiming
the event id**. The reasoning at `:42-45` is good: claiming an unknown type
would permanently skip it if a later deploy added a handler.

**Idempotency.** `:147-149` — the claim (`stripeEvent.create`) and the
processing run in **one** transaction, so a mid-flight crash rolls back the
claim too and Stripe's redelivery reprocesses cleanly. `:140-146` documents the
earlier design that orphaned claims and dropped payment events permanently.

**`WebhookRetryableError`** — declared `:22`, thrown at `:156` (event has no
connected account) and `:164` (connected account not yet linked to a tenant).
Caught at `:1052-1059`: warns, returns **409** so Stripe retries rather than
acking-and-dropping. Correct shape for the disconnect-then-reconnect window.

| Condition | Status | Stripe retries | MatFlow signal |
|---|---|---|---|
| No/bad signature, or secret unset | 400 (`:30`, `:39`) | yes | **none** |
| Unhandled event type | 200 ignored (`:66`) | no | none (intended) |
| Duplicate delivery (P2002) | 200 (`:1047`) | no | none (intended) |
| Not yet attributable | 409 (`:1058`) | yes | `console.warn` (`:1053`) |
| Processing failure | 500 (`:1073`) | yes | `console.error` + **Sentry** (`:1064-1072`) |

Only the last row reaches Sentry. `maxDuration = 15` (`:16`) is set
deliberately inside Stripe's 20s ack budget (`:12-15`).

**If the endpoint is down entirely:** Stripe retries on its own schedule and
eventually disables it. Inside MatFlow nothing changes except that
`Tenant.stripeAccountStatus` stops being refreshed — and per §3.2 that cache is
trusted for 24 hours, so the first day of a dead webhook is completely silent.
`app/api/cron/stripe-reconcile/route.ts` is the intended backstop but **is not
scheduled** (§5.4).

### 5.4 Cron scheduling — declared vs capped vs existing

`vercel.json:3-17` declares three:

| Path | Schedule | Route file |
|---|---|---|
| `/api/cron/monthly-reports` | `0 2 1 * *` | `app/api/cron/monthly-reports/route.ts` |
| `/api/cron/retention` | `30 3 * * *` | `app/api/cron/retention/route.ts` |
| `/api/cron/class-instances` | `40 2 * * *` | `app/api/cron/class-instances/route.ts` |

A **fourth** route exists with no schedule at all:
`app/api/cron/stripe-reconcile/route.ts` — the reconciliation backstop for
missed webhook events. It can only be triggered by hand with an
`Authorization: Bearer $CRON_SECRET` header (`:19-25`).

The Vercel Hobby plan caps cron jobs at two, with daily-only granularity; Pro
does not. Which plan this project is on is **UNVERIFIED** — `.vercel/project.json`
records the project link, not the plan. If Hobby, at least one of the three
declared crons is not running, and there is **no in-app signal**: each route
reports success only when invoked, and nothing anywhere records a last-run time.

**What silently stops if a cron does not fire:**

- `retention` — `app/api/cron/retention/route.ts:5-9` states plainly that this
  route is what makes the published `/legal/privacy` retention policy true. If
  it never runs, the policy is fiction again: audit logs, email logs, expired
  auth tokens (carrying email + IP + user-agent), and soft-deleted tenants
  persist indefinitely. **A compliance failure with no alarm.**
- `class-instances` — the rolling generation window stops advancing and the
  timetable quietly runs out of future classes.
- `monthly-reports` — owners stop receiving reports.

The internal design of these routes is genuinely good: independent per-rule
try/catch so one failure cannot stop the others, chunked batch deletes at
committed transaction boundaries, a 240s soft stop inside the 300s
`maxDuration`, and explicit `{partial:true}` / `{skipped:true}` reporting
(`app/api/cron/retention/route.ts:11-28`, `:42-43`). The weakness is entirely
in **observability of whether they ran at all**.

### 5.5 Neon connection exhaustion

`lib/prisma.ts:57-74`. The pg `Pool` `max` is **5 in production, 20 otherwise**
(`:73`). Reasoning at `:57-72`: Vercel Fluid serves many concurrent requests
per instance, so `instances x max` must stay inside Neon's ceiling; outside
production there is one long-lived process, so 5 became a bottleneck that
pushed `withTenantContext`'s 10s `maxWait` past its limit and produced P2028 as
HTTP 503 under `playwright --workers=2`.

**Pooled-endpoint warning** — `:43-56`. In production, if the `DATABASE_URL`
hostname does not contain `-pooler`, a long `console.warn` fires explaining
that roughly 10-11 concurrent instances exhaust Neon's ~112 direct connections.
The previous version of this check tested for `pgbouncer=true` in the URL, which
`:26-36` correctly identifies as **inert** under `@prisma/adapter-pg` — both
`pgbouncer` and `connection_limit` are Prisma native-engine params, silently
ignored by the pg driver, so the old check both false-passed and false-alarmed.

Worth flagging: `lib/prisma-tenant.ts:22-24` still carries a **stale comment**
asserting production runs `DATABASE_URL?pgbouncer=true&connection_limit=1`, and
`:29` repeats it. Per `lib/prisma.ts:26-36` those params do nothing. The code is
right; two comments are now misleading.

**What exhaustion looks like:** `withTenantContext` exceeds `maxWait` (10s,
`lib/prisma-tenant.ts:34`), Prisma raises **P2028**, routes surface 503.
`/api/health` (2s ping timeout, `app/api/health/route.ts:24`) flips to
`{status:"degraded", db:"down"}` with HTTP 503 — so this **is** externally
detectable, provided an uptime monitor is pointed at it. Simultaneously
`lib/rate-limit.ts:63-68` silently switches to memory (§4.4): exhaustion and
rate-limit degradation arrive together, and only one of them is visible.

### 5.6 Resend webhook unset

`app/api/webhooks/resend/route.ts:41-64`. If `RESEND_WEBHOOK_SECRET` is unset:
`console.warn` at `:47`, then **503 in production** (`:48-50`), or **accept the
event unsigned** in dev (fall-through from `:45`). With the secret set, svix
verification failure returns 401 (`:60-63`).

Downstream consequence of a dead pipeline: `EmailLog.status` never advances
past `sent`, so the bounce-suppression short-circuit in `lib/email.ts:350-372`
— a 30-day lookback for `bounced` / `complained` that refuses to send — never
fires, and MatFlow keeps mailing addresses that hard-bounced. The `STATUS_RANK`
precedence table (`app/api/webhooks/resend/route.ts:31-39`), which stops
out-of-order events downgrading a terminal status, is careful work that is
simply unreachable if the webhook was never wired up. Signal: the boot warn
from `lib/env-guards.ts:49`, and nothing else.

### 5.7 Sentry scrubbing

One shared scrubber, `lib/sentry-scrub.ts:29-36`, imported by all three configs
(`sentry.server.config.ts:9`, `sentry.client.config.ts:11`,
`sentry.edge.config.ts:12`). It drops `request.headers.cookie` and
`user.email` / `user.username`; `user.id` is deliberately kept, reasoning at
`lib/sentry-scrub.ts:16-21`.

The header comment (`:5-8`) records why this matters: the edge copy went
missing once, and edge middleware sees the `matflow_admin` cookie **whose value
IS `MATFLOW_ADMIN_SECRET`** (`lib/admin-auth.ts:8-10`, `:88`). An unscrubbed
edge event would hand super-admin access to anyone with Sentry access.

**Residual gaps:**

- Server and edge init on `SENTRY_DSN`; the client inits on
  `NEXT_PUBLIC_SENTRY_DSN` (`sentry.client.config.ts:13`). Setting only the
  former — the only one `lib/env-guards.ts:42` mentions — leaves browser errors
  unreported. **Silent.**
- The scrubber removes `cookie` from `request.headers` only. Nothing scrubs
  secrets appearing in an exception **message** or a **URL**.
  `lib/email.ts:399-401` has its own `redactSecrets` for `sk_` / `whsec_`
  prefixes, but it is applied only to `EmailLog.errorMessage`, never to a
  Sentry payload.
- `tracesSampleRate: 0.1` on all three; client adds
  `replaysSessionSampleRate: 0`, `replaysOnErrorSampleRate: 0.1`.
- Per-event tagging uses `Sentry.withScope` rather than a global `setTag`,
  because the app does not run `withSentryConfig` and therefore has no
  per-request isolation scope (`lib/sentry-scrub.ts:17-21`,
  `instrumentation.ts:67-81`). That is the correct call and it is applied
  consistently at `lib/api-error.ts`, `instrumentation.ts` and the
  `error.tsx` boundaries.

### 5.8 Region pinning

`vercel.json:2` pins `["lhr1"]`; `app/api/health/route.ts:19` sets
`preferredRegion = "lhr1"` explicitly so the region pin has an unambiguous test
signal (`:17-18`). If the pin were ever lost, the symptom would be latency
against Neon `eu-west-2`, not an error — which is exactly why the deliberate
probe is worth keeping.

---

## 6. SILENT-VS-LOUD TABLE

Every degraded state found, and the signal it emits. "Signal" means something
an operator could actually observe. `NONE` means no log, no metric, no status
field, no user-visible difference.

### 6.1 LOUD — refuses to start or refuses the request

| State | Where | Signal |
|---|---|---|
| `DEMO_MODE=true` in production | `auth.ts:48-50` | Module-load throw; every `@/auth` route fails |
| Missing error-severity env var in production | `lib/env-guards.ts:70-77` | Boot throw listing all missing vars — **but Sentry not yet initialised (§5.1)** |
| No `AUTH_SECRET`/`NEXTAUTH_SECRET` in production | `auth.ts:56`, `lib/auth-secret.ts:6-8` | Throw at import |
| Auth secret under 32 chars, Vercel prod only | `auth.ts:66-68` | Throw |
| `DATABASE_URL` unset / SQLite | `lib/prisma.ts:22-25` | Throw on first DB use |
| `prisma migrate deploy` failure | `scripts/maybe-migrate.mjs:47-49` | `exit(1)`, build fails |
| Migrate refused (prod DB, non-prod deploy) | `scripts/maybe-migrate.mjs:35-42` | Loud build warning |
| `CRON_SECRET` unset | 4 cron routes, e.g. `cron/retention:133-135` | 503 `"CRON_SECRET not configured"` |
| `STRIPE_SECRET_KEY` unset (most routes) | e.g. `stripe/portal:52` | 503 `"Stripe not configured"` |
| `STRIPE_CLIENT_ID` unset | `stripe/connect/route.ts:12-15` | 503 |
| `STRIPE_WEBHOOK_SECRET` unset | `stripe/webhook/route.ts:29-31` | 400 to Stripe (visible in Stripe dashboard only) |
| `RESEND_WEBHOOK_SECRET` unset, production | `webhooks/resend:48-50` | 503 + boot warn |
| `RESEND_API_KEY` unset, password reset | `forgot-password:100-106` | 503 + `console.error` |
| `RESEND_API_KEY` unset, magic link | `magic-link/request:92-94` | 503 + `console.error` |
| `BLOB_READ_WRITE_TOKEN` unset, 3 upload routes | `admin/import/upload:59`, `initiatives/[id]/attachments:32`, `onboarding/csv-handoff:42` | 503 |
| `MAINTENANCE_MODE=true` | `proxy.ts:115-125` | 503 + `retry-after` |
| DB unreachable | `app/api/health/route.ts:46-55` | 503 `{status:"degraded"}` |
| Stripe webhook processing failure | `stripe/webhook:1064-1072` | `console.error` + **Sentry** |
| Rate limit hit | `lib/rate-limit.ts:71-76` | `console.warn` with bucket |
| Unhandled route/render error | `instrumentation.ts:64,66-81` | Structured log + Sentry (if `SENTRY_DSN`) |

### 6.2 WARN-ONLY — logged, easy to miss

| State | Where | Signal |
|---|---|---|
| `TESTING_MODE=true` on Vercel production | `auth.ts:53-55` | One `console.warn` at boot. Does **not** fire for the prod-DB-non-prod-env case |
| `RESEND_FROM` unset or `resend.dev` | `auth.ts:75-82` | One `console.warn` at boot |
| `NEXTAUTH_URL` unset | `auth.ts:69` | One `console.warn` at boot |
| Non-pooled Neon host in production | `lib/prisma.ts:49-55` | One `console.warn` at boot |
| `SENTRY_DSN` unset | `lib/env-guards.ts:67` | Boot warn |
| `CRON_SECRET` unset | `lib/env-guards.ts:67` | Boot warn (plus the 503 above) |
| `RESEND_WEBHOOK_SECRET` unset | `lib/env-guards.ts:67` | Boot warn |
| Stripe key lacks accounts read scope (**fail-OPEN**) | `lib/stripe-account-status.ts:72-77` | One `console.error`, then 24h of `chargesEnabled:true` |
| Stripe status persist failed | `lib/stripe-account-status.ts:105` | One `console.error`; cache silently stale |
| Webhook not yet attributable | `stripe/webhook:1053-1057` | `console.warn`, 409, Stripe retries |
| Blob unavailable on image upload | `app/api/upload/route.ts:244-247` | `console.warn` + `storage:"inline"` in `AuditLog` (`:266`) |
| Activation link when Resend unset | `admin/applications/[id]/approve:185` | `console.warn` **containing the credential** — logged in production too |
| Reset OTP printed to stdout | `forgot-password:107` | `console.log` with the OTP — non-production only |
| Magic link printed to stdout | `magic-link/request:96` | `console.log` with the link — non-production only |
| Unrecognised role in sidebar | `components/layout/Sidebar.tsx:29-34` | Dev-only warn; in production the nav renders empty with no signal |
| `BLOB_READ_WRITE_TOKEN` unset at boot | `app/api/upload/route.ts:11-16` | Warn gated `NODE_ENV !== "production"` — **off in production** |

### 6.3 SILENT — no signal at all

Ordered by consequence.

| # | Degraded state | Where | Signal |
|---|---|---|---|
| 1 | RLS not actually enforcing (BYPASSRLS role in prod) | `scripts/create-restricted-role.ts:1-2,8` | **NONE** — every wrapper still "works" |
| 2 | Prod Neon endpoint id rotated, both prod guards stop matching | `lib/testing-mode.ts:16`, `scripts/maybe-migrate.mjs:28` | **NONE** — guards fail open |
| 3 | `TESTING_MODE` honoured on a non-Vercel production host | `lib/testing-mode.ts:23-36` | **NONE** — `auth.ts:53` needs `VERCEL_ENV==="production"` |
| 4 | 2FA silently disabled for all users on a preview | `auth.ts:335,339,376,506,507,523` | **NONE** — absence of a prompt is the only tell |
| 5 | Rate limiter degraded to per-instance memory | `lib/rate-limit.ts:63-68` | **NONE** — degradation itself is unlogged |
| 6 | A declared cron never fired (Hobby cap) | `vercel.json:3-17` | **NONE** — no last-run record anywhere |
| 7 | Retention sweep not running, privacy policy untrue | `app/api/cron/retention/route.ts:5-9` | **NONE** |
| 8 | `stripe-reconcile` never scheduled | `app/api/cron/stripe-reconcile/route.ts` | **NONE** — route exists, absent from `vercel.json` |
| 9 | Stripe webhook secret rotated / signature failing | `stripe/webhook:29-31,38-40` | **NONE in-app** — Stripe dashboard only |
| 10 | `stripeAccountStatus` stale up to 24h while webhook dead | `lib/stripe-account-status.ts:143` | **NONE** |
| 11 | Waiver signature stored as base64 in Postgres | `lib/waiver-signature-upload.ts:19-35` | **NONE** — no log, no audit field, HTTP 200 |
| 12 | `RESEND_FROM` at sandbox sender, all mail to spam | `lib/email.ts:387` | Boot warn only; `sendEmail` returns `{ok:true}` |
| 13 | Every email failing (`RESEND_API_KEY` unset) on the 15 non-checking senders | `lib/email.ts:388-397` | `EmailLog.status="failed"` row nobody reads; 15 of 18 call sites discard the return value |
| 14 | Push notifications a total no-op (VAPID unset) | `lib/push.ts:11` | **NONE** — early `return`, no log, no record |
| 15 | Shop in pay-at-desk mode (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` unset) | `app/member/shop/page.tsx:44` | **NONE** |
| 16 | Google button shown for an unregistered provider | `auth.ts:34-37` vs `app/login/page.tsx:715` | **NONE** — no cross-check |
| 17 | Client-side Sentry off (`NEXT_PUBLIC_SENTRY_DSN` unset) | `sentry.client.config.ts:13` | **NONE** — server DSN warn does not cover it |
| 18 | Impersonation swap failed, operator acting as self | `auth.ts:659` | **NONE** — empty catch |
| 19 | Revoked session live for up to 10 min | `auth.ts:669` | **NONE** |
| 20 | Revoked session live indefinitely during a DB outage | `auth.ts:694` | **NONE** — empty catch keeps the token |
| 21 | Revoked operator renders `/admin` shells up to 8h | `proxy.ts:136-138` | **NONE** in the UI; APIs 401 underneath |
| 22 | Un-onboarded owner let onto the dashboard after a DB error | `app/dashboard/layout.tsx:31` | **NONE** — `.catch(() => null)` |
| 23 | Real member with no `memberId` served demo data | `app/api/member/home/route.ts:144` | **NONE** — and `/api/member/me` 404s on the same input |
| 24 | Kiosk disabled or regenerated; old QR now 404 | `app/api/kiosk/[token]/checkin/route.ts:64-66` | **NONE** — indistinguishable from a typo |
| 25 | Tenant suspended / soft-deleted; owner cannot log in | `auth.ts:193-194` | **NONE** — generic invalid-credentials |
| 26 | Tenant cancelled: new logins blocked, existing JWTs valid 30d | `app/api/tenant/[slug]/route.ts:79` vs `auth.ts:193-194` | **NONE** |
| 27 | `MAINTENANCE_MODE` engaged | `proxy.ts:108` | Users see 503; **no log**, and `/api/health` still returns 200 |
| 28 | Webhooks / cron / kiosk still live during maintenance | `proxy.ts:222-223` | **NONE** |
| 29 | `NEXTAUTH_URL` unset: malformed links in every email | `lib/env-url.ts:27` returns `""` | Boot warn only; emails still send `{ok:true}` |
| 30 | Stale pgbouncer comments contradict live behaviour | `lib/prisma-tenant.ts:22-24,29` | Documentation-only, but misleads the next reader |

---

## 7. HOW TO DETERMINE WHICH STATE PRODUCTION IS IN

No single endpoint answers this. There is no `/api/status` reporting mode
flags — `/api/health` deliberately excludes them
(`app/api/health/route.ts:10-11`), and `/api/stripe/connect/health` is
owner-scoped and Stripe-only (`app/api/stripe/connect/health/route.ts:9-16`).

Ordered checks, cheapest first — all read-only:

1. **Vercel env vars** (dashboard or `vercel env ls`): the presence and exact
   value of `TESTING_MODE`, `DEMO_MODE`, `MAINTENANCE_MODE`, `RESEND_FROM`,
   `BLOB_READ_WRITE_TOKEN`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
   `NEXT_PUBLIC_SENTRY_DSN`, `VAPID_*`, and whether `DATABASE_URL` contains
   both `ep-bold-wave-abt39t7x` and `-pooler`.
2. **Boot log of the most recent deploy**: grep for `[auth]`, `[env-guards]`,
   `[prisma]`, `[upload]`. Their absence is as informative as their presence —
   e.g. no `[auth] RESEND_FROM…` line means the sender is configured.
3. **`SELECT rolname, rolbypassrls, rolsuper FROM pg_roles;`** on production,
   or run the read-only `scripts/probe-rls-uncontexted.mjs`. This is the only
   way to settle §4.1, and it is the highest-value check in this list.
4. **Vercel cron tab**: how many of the three in `vercel.json` are actually
   registered, and their last invocation times. Settles T7 and silent-row 6.
5. **Stripe dashboard → Webhooks**: recent delivery success rate. Settles
   silent-row 9, which has no in-app signal.
6. **Query `Tenant.stripeAccountStatus`** for `disabledReason IN
   ('status_unreadable','stripe_not_configured')` and for `refreshedAt` older
   than 24h. Settles T4 and silent-row 10.
7. **Query `EmailLog`** grouped by `status` over the last 7 days. A population
   of `failed` with `errorMessage = 'RESEND_API_KEY not configured'` settles
   silent-row 13; zero rows advancing past `sent` settles §5.6.
8. **Query `SignedWaiver.signatureImageUrl LIKE 'data:%'`** — counts signatures
   that took the base64 fallback. Settles silent-row 11.
9. **`AuditLog` where `metadata->>'storage' = 'inline'`** — image uploads that
   took the fallback (`app/api/upload/route.ts:266`).
10. **Log in as a user known to have `totpEnabled=true`.** If no second factor
    is requested, `isTestingMode()` is returning true. This is the only test
    for T1/T3 and it requires actually exercising the bypass.

**The gap worth closing:** an authenticated operator-only `/api/admin/status`
returning the resolved booleans — `isTestingMode()`, `DEMO_MODE`,
`MAINTENANCE_MODE`, `VERCEL_ENV`, `isProductionDatabase()`, whether each
optional integration key is present, and the last successful run of each cron —
would collapse checks 1, 2, 4 and 10 into one request. Every value needed
already exists in process memory; nothing currently exposes it.

---

*End of state map F.*
