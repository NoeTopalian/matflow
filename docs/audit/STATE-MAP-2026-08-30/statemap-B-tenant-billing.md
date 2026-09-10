# STATE MAP B — TENANT (CLUB) STATE & BILLING STATE
_MatFlow · read-only exhaustive trace · repo c:\Users\NoeTo\Desktop\matflow · generated 2026-08-30_

Two billing planes exist in this codebase and they are **completely disconnected**:

| Plane | Who pays whom | Implemented in code? |
|---|---|---|
| **Plane A — Club → MatFlow** (the SaaS fee) | Gym owner pays Noe | **NO.** Zero billing code. One `Tenant.subscriptionStatus` string, hand-flipped by an operator. No price, no invoice, no Stripe object, no trial clock, no dunning. |
| **Plane B — Member → Club** (membership dues) | Member pays the gym | **YES**, extensively. Stripe Connect **direct charges on the gym's own connected account**, webhook-driven, with a member-level `paymentStatus` state machine. MatFlow takes **zero platform fee** (no `application_fee` / `transfer_data` / `on_behalf_of` anywhere in the repo). |

---

## 0. HEADLINE TRUTHS (each proven below)

1. **There is no `trialEndsAt`, no `plan`, no `suspendedAt`, no `isDemo`, no price field on `Tenant`.** The whole club-side billing state is *one* free-text string column, `Tenant.subscriptionStatus` (`prisma/schema.prisma:23`), plus a decorative `subscriptionTier` (`:24`) and `deletedAt` (`:64`).
2. **`subscriptionStatus` has no CHECK constraint and no enum.** Migration `20260430000001_schema_check_constraints` constrains `Member.status`, `Member.paymentStatus`, `Payment.status`, `User.role`, `MembershipTier.billingCycle` — but **not** `Tenant.subscriptionStatus`/`subscriptionTier`. Confirmed by `docs/audit/iter-1-database.md:101`. Any string is writable.
3. **Nothing in the codebase ever writes `subscriptionStatus = "cancelled"`.** It is a read-only ghost value: the login gate (`auth.ts:194`) does not check it; only the public branding endpoint does (`app/api/tenant/[slug]/route.ts:79`). It is reachable only by hand-SQL.
4. **`trial` gates nothing and expires never.** No cron, no writer, no field. The landing page sells a "30-day free trial" (`components/landing/Hero.tsx:232`, `components/landing/ApplySection.tsx:21`) that the database cannot express. The admin dashboard fakes trial ageing off `Tenant.createdAt` (`app/admin/page.tsx:105-111`).
5. **The SaaS fee is collected out-of-band.** `.omc/specs/deep-dive-matflow-sellable-product.md:11` and `:131`: "£99/£149/£199 per month collected via Stripe Payment Link / invoice; `Tenant.subscriptionStatus` flipped by hand. No automated tenant billing before first sale." `/admin/billing` confirms it in the UI: `app/admin/billing/page.tsx:146` renders **Platform MRR = "-"**, hint **"Wired when platform pricing tier table lands"**.
6. **An owner whose club stopped paying MatFlow sees NOTHING.** There is no non-payment state, no banner, no degradation, no grace period — until an operator manually presses "Suspend", at which point everything dies at once *and every one of that gym's member subscriptions gets cancelled at Stripe*. There is no middle gear.
7. **Two session-minting paths bypass the suspend/soft-delete login gate entirely** — magic-link verify (`app/api/magic-link/verify/route.ts:55-58,109-135`) and Google OAuth (`auth.ts:455-487`). Neither reads `deletedAt` or `subscriptionStatus`.
8. **The kiosk ignores tenant state completely** (`app/api/kiosk/[token]/checkin/route.ts:58-66` selects only `{id}`). A suspended or soft-deleted gym's front-door iPad keeps checking members in until the retention cron physically deletes the rows.
9. **`Tenant.featureFlags` (`prisma/schema.prisma:62`) is a dead column** — added by migration `20260506000000`, read by **zero** lines of application code.
10. Member-side has **no `Membership`/`Subscription` model at all**. `Member.stripeSubscriptionId` is a bare nullable string; there is **no `currentPeriodEnd`, no `cancelAt`, no local subscription status**. `ClassSubscription` (`schema.prisma:445`) is class-*notification* subscriptions, not billing.

---

## 1. TENANT MODEL STATE — every column that encodes state

Model: `prisma/schema.prisma:11-77`.

### 1.1 Billing / lifecycle columns

| Column | Line | Type / default | DB constraint | Values actually used |
|---|---|---|---|---|
| `subscriptionStatus` | `schema.prisma:23` | `String @default("trial")` | **none** (init migration `20260424205716_init/migration.sql:13` sets the default only) | `trial`, `active`, `suspended`; `cancelled` documented (`:23` comment, `docs/MATFLOW-PIPELINES.md:370`) but **never written** |
| `subscriptionTier` | `schema.prisma:24` | `String @default("pro")` | **none** | `starter \| pro \| elite \| enterprise` — enforced only in zod at `app/api/admin/applications/[id]/approve/route.ts:30` and `app/api/admin/create-tenant/route.ts:32` |
| `deletedAt` | `schema.prisma:64` | `DateTime?` | — | `null` = live; timestamp = soft-deleted, 30-day grace |
| `createdAt` | `schema.prisma:63` | `DateTime @default(now())` | — | doubles as the *de facto* trial clock (`app/admin/page.tsx:107-110`) |
| **`trialEndsAt`** | — | **DOES NOT EXIST** | — | — |
| **`suspendedAt` / `suspendReason`** | — | **DOES NOT EXIST** (reason lives only in `AuditLog.metadata`, `suspend/route.ts:125`) | — | — |
| **`plan` / `pricePence` / platform-side `stripeSubscriptionId`** | — | **DO NOT EXIST** | — | — |

### 1.2 Stripe Connect columns (Plane B rail health)

| Column | Line | Meaning |
|---|---|---|
| `stripeAccountId` | `schema.prisma:27` | `String? @unique` — one connected account per club (comment: prevents webhook/refund mis-routing across tenants) |
| `stripeConnected` | `schema.prisma:28` | `Boolean @default(false)` |
| `stripeAccountStatus` | `schema.prisma:29` | `Json?` cached `{chargesEnabled, payoutsEnabled, requirementsPastDue, disabledReason, refreshedAt}` — shape at `lib/stripe-account-status.ts:16-22` |
| `acceptsBacs` | `schema.prisma:36` | gates `bacs_debit` at `lib/stripe/subscriptions.ts:61-63` |
| `memberSelfBilling` | `schema.prisma:37` | gates member self-subscribe / self-cancel (`app/api/member/subscriptions/start/route.ts:68`, `.../cancel/route.ts:43`) |
| `billingContactEmail` / `billingContactUrl` | `schema.prisma:38-39` | shown to members on `/member/billing` when self-billing is off |

### 1.3 Onboarding / config / branding

`onboardingCompleted` `:25`, `onboardingAnswers` `:26`, `currency` `:30` (CHECK GBP|EUR|USD via `20260503000001`), `timezone` `:31`, `address` `:32`, `country` `:33` (CHECK UK|IE|US|EU|OTHER), `checkinWindowBeforeMin/AfterMin` `:34-35` (CHECK 0-180 via `20260513000003`), `kioskTokenHash`/`kioskTokenIssuedAt` `:59-60`, `slug` `:14` `@unique`, `customDomain` `:22` `@unique` (**dormant — never read anywhere**), branding `:15-21`, waivers `:51-54`, socials `:42-50`.

### 1.4 WRITER INVENTORY — who mutates tenant state

**`subscriptionStatus` — 6 writers total, all human-initiated. No cron, no webhook, no Stripe.**

| Writer | file:line | New value | Guard |
|---|---|---|---|
| Application approve | `app/api/admin/applications/[id]/approve/route.ts:101` | `"trial"` | operator cookie/HMAC `:42-45`, 20/hr rate limit `:47` |
| Direct create-tenant | `app/api/admin/create-tenant/route.ts:75` | `"trial"` | operator, 10/IP/hr |
| Operator **suspend** | `app/api/admin/customers/[id]/suspend/route.ts:113` | `"suspended"` | `isAdminAuthed` `:28`, reason >= 5 chars `:41-42`, 409 if already suspended `:51` |
| Operator **reactivate** (`DELETE`) | `app/api/admin/customers/[id]/suspend/route.ts:157` | `"active"` | `isAdminAuthed` `:139`; **no guard that it was suspended** — a `trial` tenant silently becomes `active` |
| Seed | `prisma/seed.ts:49` | `"active"` | dev only |
| Test-account script | `scripts/setup-test-accounts.mjs:68` | `"active"` | script |

> `PATCH /api/settings` (the owner-facing settings write) **cannot** touch it: the zod schema at `app/api/settings/route.ts:26-60` has no `subscriptionStatus` key; it is `select`-ed read-only at `:87` and rendered at `app/dashboard/settings/page.tsx:113` -> `components/dashboard/SettingsPage.tsx:2242`.

**`deletedAt`**

| Writer | file:line | Effect |
|---|---|---|
| Operator soft-delete | `app/api/admin/customers/[id]/soft-delete/route.ts:100` | `deletedAt = now`; requires typed `confirmName` match `:54` |
| Operator restore (`DELETE`) | `app/api/admin/customers/[id]/soft-delete/route.ts:146` | `deletedAt = null` (409 if not deleted `:143`) |
| Retention cron **hard purge** | `app/api/cron/retention/route.ts:708` (`tx.tenant.delete`) | row physically destroyed 30 days after soft-delete (`TENANT_SOFT_DELETE_GRACE_MS`, `:92`) |

**`stripeAccountId` / `stripeConnected` / `stripeAccountStatus`**

| Writer | file:line | Effect |
|---|---|---|
| Connect OAuth callback | `app/api/stripe/connect/callback/route.ts:60-65` | sets `stripeAccountId`, `stripeConnected=true` |
| Disconnect | `app/api/stripe/disconnect/route.ts:34-42` | nulls all three (`stripeAccountStatus: Prisma.DbNull`) — **does not cancel live member subscriptions** |
| `account.updated` webhook | flagged at `app/api/stripe/webhook/route.ts:191-204`, dispatched post-commit `:1092-1095` -> `lib/stripe-account-status.ts:97-103` | refreshes cached capability JSON |
| Lazy refresh on checkout | `lib/stripe-account-status.ts:132-149` (`ensureCanAcceptCharges`, 24h staleness) | same |

**`onboardingCompleted`** — written only via `PATCH /api/settings` (`app/api/settings/route.ts:35` schema -> `:133` `tx.tenant.update`) by the wizard's final step. Read at `app/dashboard/layout.tsx:29,33`, `app/onboarding/page.tsx:20,27`, `app/dashboard/page.tsx:28,36`.

**`featureFlags`** — created by `prisma/migrations/20260506000000_operator_platform_config_feature_flags/migration.sql:7`. **No reader, no writer in `app/`, `lib/` or `components/`.** Dead column.

---

## 2. TENANT LIFECYCLE STATE MACHINE

### 2.1 Shape of the machine as it actually exists

```
  POST /api/apply  ->  GymApplication.status = "new"
                       (schema.prisma:991; CHECK new|contacted|approved|rejected via 20260430000004)
        |                                   |
        | reject -> status="rejected"       | approve
        |  (console.warn only, NO AuditLog) |
        v                                   v
      [dead]              Tenant.subscriptionStatus = "trial"   <- approve/route.ts:101
                          Tenant.onboardingCompleted = false     (schema:25)
                          User(role="owner"), random 24-char pw
                          MagicLinkToken purpose="first_time_signup", 30 min
                          email templateId="owner_activation"
                                            |
                     owner clicks link      |  magic-link/verify -> /dashboard
                                            v
                          dashboard/layout.tsx:33 -> redirect("/onboarding")
                                            |  9-stage wizard
                                            v
                          onboardingCompleted = true  (PATCH /api/settings)
                                            |
                          ====== trial ======   <- NO EXPIRY. NO CLOCK. NO CRON. FOREVER.
                                            |
             operator hand-flip after       |  DELETE /api/admin/customers/[id]/suspend
             Stripe Payment Link paid       |  (the "reactivate" verb — the ONLY route
                                            v   that can ever write "active")
                          ====== active ======
                                            |
                                            |  POST /api/admin/customers/[id]/suspend
                                            v
                          ==== suspended ====  --DELETE same route-->  active
                          + every member Stripe sub -> cancel_at_period_end
                          + User.sessionVersion++ AND Member.sessionVersion++
                                            |
              POST .../soft-delete          |  (orthogonal — applies from ANY status)
                                            v
                          deletedAt = <ts>   --DELETE same route-->  deletedAt = null
                          + same Stripe cancel fan-out + both sessionVersions++
                                            |  +30 days, daily 03:30 UTC cron
                                            v
                          PURGED (row deleted)  app/api/cron/retention/route.ts:388-712
                          AuditLog rows deliberately survive (:527-531)

  "past_due" / "unpaid"  -- DO NOT EXIST
  "cancelled"            -- declared in schema comment (:23) and docs/MATFLOW-PIPELINES.md:370,
                            read by app/api/tenant/[slug]/route.ts:79 — NO CODE PATH WRITES IT.
```

### 2.2 Transition table

| # | From | To | Trigger (file:line) | Guards | Side-effects |
|---|---|---|---|---|---|
| T1 | *(none)* | `GymApplication="new"` | `POST /api/apply` | zod + fail-closed rate limit | `application_received` + `application_internal` emails |
| T2 | `new`/`contacted` | `approved` + Tenant(`trial`) | `app/api/admin/applications/[id]/approve/route.ts:94-146` | operator auth `:42-45`; 20/hr `:47`; 409 if already approved `:74` | Tenant + owner User created `:94-116`; 30-min magic link `:126-138`; `owner_activation` email `:170-180`; AuditLog `admin.application.approve` `:149-163`. **In production the activation link is withheld from the response (`:193`)** — so if email delivery is broken the owner can never be activated |
| T3 | `new` | `rejected` | `app/api/admin/applications/[id]/reject/route.ts` | operator | **no AuditLog row** (`docs/MATFLOW-PIPELINES.md:128`; audit A6I1-V-4) |
| T4 | *(none)* | Tenant(`trial`) | `app/api/admin/create-tenant/route.ts:70-90` | operator, 10/IP/hr `:35-41` | operator-set password, no magic link, AuditLog `admin.tenant.create` |
| T5 | `onboardingCompleted=false` | `true` | wizard final step -> `PATCH /api/settings:35,133` | owner session | dashboard stops redirecting to `/onboarding`; `SetupBanner` (`app/dashboard/page.tsx:23-52`) then nags about Stripe / tiers / classes / members |
| T6 | `trial` | `active` | `DELETE /api/admin/customers/[id]/suspend:157` | `isAdminAuthed` only — **no state guard** | AuditLog `admin.tenant.reactivated` with `previousStatus` `:166`. **No UI exposes this for a non-suspended tenant** (`app/admin/tenants/[id]/page.tsx:113` passes `isSuspended` to DangerZone), so in practice it needs a raw API call |
| T7 | `trial`/`active` | `suspended` | `POST .../suspend:113` | reason >= 5 `:41-42`; 20/hr `:31`; 409 if already suspended `:51` | **cancels EVERY member Stripe subscription at period end** `:73-102` (parallel `allSettled`, best-effort, failures recorded as `stripeFailedIds`); `User.sessionVersion++` `:114`; `Member.sessionVersion++` `:115`; AuditLog `admin.tenant.suspended` `:118-133`. **No email to owner. No email to members.** |
| T8 | `suspended` | `active` | `DELETE .../suspend:157` | as T6 | **member subscriptions are NOT re-created** — the cancel is one-way and irreversible from MatFlow |
| T9 | any status | `deletedAt=now` | `POST .../soft-delete:100` | reason >= 5 + `confirmName === tenant.name` `:54`; 409 if already deleted `:52` | same Stripe-cancel fan-out `:67-92`; both sessionVersions++ `:101-102`; AuditLog with `hardDeleteAfter = now+30d` `:114` |
| T10 | `deletedAt != null` | `deletedAt=null` | `DELETE .../soft-delete:146` | 409 if not soft-deleted `:143` | AuditLog `admin.tenant.restored`. **Stripe subs stay cancelled**; members must re-subscribe |
| T11 | `deletedAt < now-30d` | **PURGED** | `app/api/cron/retention/route.ts:228` -> `purgeSoftDeletedTenants:388` -> `purgeTenant:540` -> `tx.tenant.delete:708` | daily 03:30 UTC (`vercel.json`); **max 2 tenants/run** (`MAX_TENANT_PURGES_PER_RUN`, `:65`); 240s deadline `:63`; **refuses to purge if a live member subscription cannot be cancelled** (`cancelTenantSubscriptions:470-492`) | members drained 10 at a time `:59`; blobs deleted; **AuditLog rows deliberately retained** `:527-531` |
| — | `trial` | `cancelled` | **NO TRIGGER EXISTS** | — | — |
| — | `active` | `past_due` / `unpaid` | **STATES DO NOT EXIST** | — | — |

### 2.3 How the club's own fee to MatFlow is actually collected — the truth

**It is not collected by this application at all.** Three independent proofs:

1. **Code.** Every writer of `subscriptionStatus` is listed in §1.4 — all six are operator-triggered admin routes, a seed, or a test script. There is no Stripe Price/Product for MatFlow tiers, no platform-side subscription model, no `application_fee_amount`, no `transfer_data`, no `on_behalf_of` anywhere in the repo. `/admin/billing` aggregates only **Plane-B** money (`app/admin/billing/page.tsx:36-72` — `Payment` and `Dispute` rows, which belong to the gyms), and its Platform MRR card is a hardcoded dash: `app/admin/billing/page.tsx:146`.
2. **Decision log.** `.omc/specs/deep-dive-matflow-sellable-product.md:11` — "SaaS fee stays manual. £99/£149/£199 per month collected via Stripe Payment Link / invoice; `Tenant.subscriptionStatus` flipped by hand. No automated tenant billing before first sale." Launch step `:131` — "agree tier, send Stripe Payment Link invoice after incorporation (~27 Aug), flip `subscriptionStatus` to `active` by hand. **Never use admin suspend for non-payment of the SaaS fee (it cancels all his member subscriptions)**." And `:46` — "`Tenant.subscriptionStatus` is decorative except `"suspended"`; `"cancelled"` blocks nobody; `"trial"` gates nothing, no trial-expiry field/cron."
3. **Runbook.** `docs/RUNBOOK.md:174-178` documents suspend purely as an access lever ("No data is touched. Reversible"). There is no tenant dunning / non-payment runbook entry at all.

**Real-world flow today:** Stripe Payment Link (entirely outside the app) -> Noe opens `/admin/tenants/[id]` -> the only status-writing controls are Suspend / Reactivate. Marking a paying trial gym as `active` requires firing `DELETE /api/admin/customers/[id]/suspend` on a tenant that was never suspended, or hand-SQL. **There is no "record SaaS payment" or "set plan" surface anywhere.**

---

## 3. WHAT TENANT STATE ACTUALLY GATES

### 3.1 Complete enforcement-point inventory

There are exactly **four** places in the entire codebase that read `Tenant.subscriptionStatus` or `Tenant.deletedAt` for an access decision, plus three cron filters. Everything else that reads them is a *display* surface.

| # | Enforcement point | file:line | Reads | Behaviour |
|---|---|---|---|---|
| E1 | Password login (`Credentials.authorize`) | `auth.ts:193-194` | `deletedAt`, `subscriptionStatus === "suspended"` | `return null` -> generic "invalid credentials". **Does NOT check `"cancelled"`.** |
| E2 | Public tenant branding lookup | `app/api/tenant/[slug]/route.ts:76-87` | `deletedAt`, `"cancelled"`, `"suspended"` | 404 "Gym not found", deliberately indistinguishable from a non-existent slug `:76-86`; response strips both fields `:91` |
| E3 | Monthly-report cron | `app/api/cron/monthly-reports/route.ts:46-49` | `subscriptionStatus IN ("active","trial")`, `deletedAt: null` | suspended/cancelled tenants get no AI monthly report |
| E4 | Class-instance generation cron | `app/api/cron/class-instances/route.ts:96` | same filter | suspended tenants stop getting future class instances generated |
| E5 | Retention / purge cron | `app/api/cron/retention/route.ts:396` | `deletedAt: { not: null, lt: cutoff }` | selects purge candidates |
| — | Session-version invalidation | `auth.ts:670-695` | `User/Member.sessionVersion` only | **10-minute recheck interval**; skipped in edge runtime `:664-666` |

**Notably absent:** `proxy.ts` (edge middleware) never reads tenant state at all — its only checks are MAINTENANCE_MODE `:108`, admin cookie `:139-155`, public prefixes `:165`, `req.auth` presence `:171`, TOTP-pending `:187`, role/route mismatch `:198-205`. `app/dashboard/layout.tsx` reads only `logoUrl, logoSize, onboardingCompleted` (`:29`). `app/member/layout.tsx` is a pure client component with **no gating whatsoever**. `lib/authz.ts` and `lib/api-authz.ts` check session + role only. This is known audit finding **O3** in `docs/MATFLOW-RANK-ACCESS-SPEC-2026-05-09.md:156` — "Suspended-tenant JWTs continue to work mid-session; `withTenantContext` doesn't re-check `subscriptionStatus`".

### 3.2 The gating matrix

| Surface | `trial` | `active` | `suspended` | `cancelled` | `deletedAt != null` | PURGED |
|---|---|---|---|---|---|---|
| **(a) Owner login (password)** | works | works | **blocked** `auth.ts:194` | **WORKS** (unchecked) | **blocked** `auth.ts:193` | no row -> blocked |
| (a2) Owner login (magic link) | works | works | **WORKS — BYPASS** `magic-link/verify/route.ts:55-58,109-135` | works | **WORKS — BYPASS** | blocked (token gone) |
| (a3) Owner login (Google OAuth) | works | works | **WORKS — BYPASS** `auth.ts:455-487` | works | **WORKS — BYPASS** | blocked |
| (a4) Owner dashboard once inside | full | full | full (no layout gate) | full | full | n/a |
| (a5) Owner JWT live at suspend time | — | — | killed within <=10 min via `sessionVersion++` (`suspend:114`) + `auth.ts:690` | — | same | — |
| **(b) Staff (manager/coach/admin)** | identical to owner in every respect — E1 is tenant-wide and `suspend:114` bumps every `User` row | | | | | |
| **(c) Member portal login** | works | works | **blocked** (password) / **BYPASS** (magic link, Google) | works | **blocked** (password) / **BYPASS** | blocked |
| (c2) Member JWT already live | — | — | killed <=10 min (`suspend:115`) | — | same | — |
| **(d) Kiosk** (`/kiosk/[token]`, `/api/kiosk/*`) | works | works | **STILL WORKS** — `kiosk/[token]/checkin/route.ts:58-66` selects only `{id}` by `kioskTokenHash`; `kiosk/[token]/members/route.ts:47-48` likewise. Excluded from the `proxy.ts` matcher `:223` | works | **STILL WORKS** | rows gone -> 404 |
| **(e) Public tenant pages** (`/api/tenant/[slug]`, login branding) | works | works | 404 `:80` | **404** `:79` | 404 `:78` | 404 |
| (e2) Public waiver `/waiver`, `/api/waiver/open` | works | works | **works** (no tenant-state check; public prefix `proxy.ts:33-34`) | works | **works** | gone |
| (e3) `/apply`, `/legal`, `/preview` | platform-level, unaffected | | | | | |
| **(f) Cron — monthly-reports** | runs `:47` | runs | **skipped** | skipped | skipped `:48` | n/a |
| (f2) Cron — class-instances | runs `:96` | runs | **skipped** | skipped | skipped | n/a |
| (f3) Cron — retention / stripe-reconcile | runs | runs | runs | runs | runs; purges at +30d | n/a |
| (f4) **Stripe webhooks** | processed | processed | **STILL PROCESSED** — `webhook/route.ts:158-165` resolves the tenant by `stripeAccountId` and checks existence only, never `deletedAt`/`subscriptionStatus` | processed | **STILL PROCESSED** | tenant row gone -> `WebhookRetryableError` `:164` -> **409, Stripe retries until it gives up** |
| (f5) Stripe reconcile sweep | included | included | included | included | **included** — `lib/stripe/reconcile.ts:78-83` filters only `stripeConnected: true` | n/a |
| **(g) Emails** | all send | all send | **all still send** — `lib/email.ts` `sendEmail` has no tenant-state gate; only per-recipient bounce/complaint suppression (`schema.prisma:850-855`) | all send | **all still send** | n/a |

### 3.3 Explicit answers to the questions asked

**Q: An OWNER logs into a club that stopped paying MatFlow — what exactly do they see today?**

**Nothing different. The full product, indefinitely.** There is no state that represents "stopped paying". Only a manual operator suspend changes anything. Concretely:

- **Before an operator acts:** the club sits in `trial` (if never hand-flipped) or `active` (if it was). Both render the identical dashboard. `components/dashboard/SettingsPage.tsx:2238-2247` shows a "Subscription" card with the tier label and a `capitalize`-d status string — that is the entire billing UI an owner ever sees. No amount, no next-invoice date, no payment method, no invoice history, no "update card" button, no dunning banner. **There is nowhere for an owner to pay MatFlow from inside MatFlow.**
- **After an operator suspends:** within at most 10 minutes the live JWT is invalidated (`suspend/route.ts:114`, then `auth.ts:690` returns `null`, then `auth.ts:719-725` returns a user-less session), the dashboard bounces to the login page, and a fresh password login returns the generic invalid-credentials failure (`auth.ts:194`). **There is no explanatory screen, no "your account is suspended, contact billing" message, and no email.** The suspend route sends none (`suspend/route.ts:104-135` contains no `sendEmail`), and `lib/email.ts:27` — the full `TemplateId` union — contains no `tenant_suspended`, `trial_ending`, `invoice_due` or `account_reactivated` template.
- **But:** if that owner still has an unexpired magic-link email in their inbox, or uses Google sign-in, they get straight back in (matrix rows a2 and a3), with a freshly minted token carrying the current `sessionVersion`, so the recheck passes.

**Q: A MEMBER of that club?**

- **Before an operator acts:** nothing changes. Members keep training, keep booking, and **keep being charged by the gym** — Plane B is entirely independent of Plane A.
- **The moment the operator suspends:** their JWT dies within 10 minutes (`suspend/route.ts:115`), password login fails with generic invalid-credentials, and, silently and permanently, **their Stripe subscription is cancelled at period end** (`suspend/route.ts:73-102`). Nothing tells them: `cancelSubscriptionAtPeriodEnd` (`lib/stripe/subscriptions.ts:206-233`) sends no email, and the later `customer.subscription.deleted` webhook that flips them to `cancelled` (`webhook/route.ts:238`) sends no member email either.
- **Except:** the kiosk at the gym front desk keeps working (matrix row d), so a member can still physically check in at a suspended or soft-deleted club.

**Q: Is there a grace period?**

- **For non-payment of the MatFlow fee: no. There is no timer of any kind.** No `trialEndsAt`, no dunning schedule, no `past_due`. The "grace period" is however long Noe waits before manually pressing Suspend.
- **After soft-delete: yes, 30 days**, and it is real: `TENANT_SOFT_DELETE_GRACE_MS = 30 * DAY_MS` (`app/api/cron/retention/route.ts:92`), stamped into the audit row as `hardDeleteAfter` (`soft-delete/route.ts:114`), enforced by `purgeSoftDeletedTenants` (`:388-396`). Restore inside the window is one `DELETE` call (`soft-delete/route.ts:146`).
- **Suspend has no timer** — a suspended tenant stays suspended forever and is never purged, because the purge cron keys on `deletedAt`, not on status.

**Q: Is data retained, and for how long?**

| Data | Window | Enforced by |
|---|---|---|
| Soft-deleted tenant plus all members, classes, history | **30 days**, then irreversibly purged | `retention/route.ts:92, 228, 388-712` |
| AuditLog | 12 months (`AUDIT_LOG_RETENTION_MS`, `:68`) — **deliberately survives tenant purge** because `AuditLog.tenantId` has no FK (`:527-531`) | `retention/route.ts:172` |
| EmailLog | 12 months (`:69`) | `:181` |
| Expired magic-link and password-reset tokens | expiry plus 24h grace (`EXPIRED_TOKEN_GRACE_MS`, `:75`) | `:75` |
| RateLimitHit | 1 day (`:77`) | `:208` |
| StripeEvent (idempotency ledger) | 90 days (`:79`) | `:219` |
| ImportJob | 30 days (`:81`); `complete` jobs kept but PII diagnostics scrubbed at 30 days (`:90`, `scrubImportJobDiagnostics:355`) | `:223-226` |
| Payment, AttendanceRecord, SignedWaiver after DSAR erasure | **kept** (tax, class history, liability legal hold) | `docs/MATFLOW-PIPELINES.md:348-351` |

**Published-vs-real check.** `app/legal/privacy/page.tsx:77` promises "Closed gyms — a gym marked for deletion is recoverable for 30 days, after which its records are permanently erased" — **this is now TRUE** (the retention cron exists; the deep-dive spec claim at `:87` that "no purge job exists" is stale). `app/legal/terms/page.tsx:92-95` promises "On cancellation, your data is retained for 30 days ... after which it is deleted **on request to legal@matflow.studio while automated post-cancellation deletion is rolled out**" — honest, because **cancellation is not a state the product has**; only operator soft-delete starts the clock. Two residual mismatches: (i) the 2-tenants-per-run cap (`retention:65`) means a mass exit takes weeks to purge; (ii) purge **refuses to run** while any member subscription cannot be cancelled (`:470-492`), so a gym that disconnected Stripe before deletion never purges at all.

---

## 4. MEMBER BILLING STATE (member -> club)

### 4.1 The model surface

There is **no `Membership` and no `Subscription` model.** Full model list (`prisma/schema.prisma`): Tenant, User, Member, PushSubscription, MemberPhoto, RankSystem, MemberRank, RankHistory, RankRequirement, Class, ClassSchedule, ClassInstance, AttendanceRecord, ClassSubscription, ClassRoster, ClassWaitlist, Notification, Announcement, PasswordHistory, LoginEvent, MagicLinkToken, PasswordResetToken, AuditLog, SignedWaiver, StripeEvent, RateLimitHit, Initiative, InitiativeAttachment, GoogleDriveConnection, IndexedDriveFile, ImportJob, ClassPack, MemberClassPack, ClassPackRedemption, EmailLog, Payment, Dispute, MonthlyReport, Order, Product, GymApplication, MembershipTier, Operator, PlatformConfig, Task.

| Field | Line | Default / CHECK |
|---|---|---|
| `Member.status` | `schema.prisma:131` | `"active"`; CHECK active , inactive , cancelled , taster (migration `20260430000001`) |
| `Member.cancelledAt` | `:132` | `DateTime?` — stamped once on the down-to-cancelled edge |
| `Member.paymentStatus` | `:133` | `"paid"`; CHECK paid , overdue , paused , free , pending , cancelled (`20260430000001/migration.sql:21-24`) |
| `Member.stripeCustomerId` | `:146` | nullable |
| `Member.stripeSubscriptionId` | `:147` | nullable — **the only subscription state stored anywhere.** No `currentPeriodEnd`, no `cancelAt`, no local Stripe status mirror |
| `Member.preferredPaymentMethod` | `:148` | `"card"`, also `"bacs"` |
| `MembershipTier` | `:1003-1025` | the **catalogue** (price, `billingCycle` CHECK monthly , annual , none; `stripePriceId` `:1019`) — **not** a per-member link. `Member.membershipType` (`:130`) is free text, not an FK |
| `ClassPack` and `MemberClassPack` | `:785-822` | `creditsRemaining` `:812`, `expiresAt` `:814`, `stripePaymentIntentId @unique` `:815`, `status` `:816` = active , expired , refunded |
| `Payment` | `:860-893` | `status` CHECK succeeded , failed , refunded , disputed , pending |
| `Dispute` | `:895-912` | needs_response , under_review , won , lost , charge_refunded |
| `Order` (shop) | `:938-958` | `status` CHECK pending , paid , cancelled; `paymentMethod` CHECK pay_at_desk , stripe |

Money rail: **all member charges are direct charges on the gym connected account** (the `stripeAccount` option at `lib/stripe/subscriptions.ts:73,135,221`, `app/api/member/checkout/route.ts:167`, `app/api/member/class-packs/buy/route.ts`, `app/api/members/[id]/charge/route.ts`). The gym is merchant of record and eats disputes; MatFlow takes no platform fee.

### 4.2 `Member.paymentStatus` writer inventory — every single writer

| Trigger | file:line | Writes | Notes |
|---|---|---|---|
| `invoice.payment_failed` | `app/api/stripe/webhook/route.ts:262-265` | `overdue` | plus `Payment` upsert with status failed `:266-286`; AuditLog `member.payment.failed` `:294-306`; `payment_failed` email to member `:312-322`; `payment_failed_owner` email to every owner `:328-347` — **but the owner loop is nested inside the member-email guard at `:307`, so a member with no email on file means the owner is never told either** |
| `invoice.payment_succeeded` | `:367-370` | `paid` | plus `Payment` upsert keyed on the resolved PaymentIntent `:388-414` |
| `payment_intent.succeeded` (standalone, BACS settle) | `:768-773` | `paid` | guarded: **skipped when `member.status` is already cancelled** (anti-resurrection, Tier 3.12) |
| `payment_intent.processing` (BACS, about 4 working days) | `:594-597` | `pending` | |
| `mandate.updated` with status inactive | `:603-607` | `overdue` plus `preferredPaymentMethod: "card"` | customer resolved via `resolveMandateCustomerId` `:135` |
| `customer.subscription.updated` | `:670-699` | mapped: active/trialing to `paid`; past_due to `overdue`; paused to `paused`; canceled/incomplete_expired to `cancelled`; unrecognised statuses leave it unchanged `:675` | also writes `Member.status = cancelled` plus `cancelledAt` on the down edge `:682,696`; **anti-resurrection guard `:687`** stops an out-of-order active event reviving a cancelled member |
| `customer.subscription.deleted` | `:226-239` | `paymentStatus: cancelled`, `status: cancelled`, `cancelledAt: now`, `stripeSubscriptionId: null` | scoped to the exact `stripeSubscriptionId` `:234` so a second live sub on the same customer is not collateral |
| `charge.dispute.created / updated / closed` | `:962-969` | `paid` when won and never refunded, otherwise `overdue` | |
| **Manual record payment** (cash, exempt, comp, external, other) | `app/api/payments/manual/route.ts:114-117` | `paid` | owner or manager; CSRF `:64`; 60 per tenant per 5 min `:71-75`; creates a Stripe-less `Payment` row `:103-113`; AuditLog `payment.manual` |
| Staff `PATCH /api/members/[id]` | `app/api/members/[id]/route.ts:390` (field allow-list) | any of the 6 CHECK values (`lib/schemas/member.ts:59`) | free-hand override, no reconciliation with Stripe |
| DSAR erase | `app/api/admin/dsar/erase/route.ts` | `status` to cancelled | `docs/MATFLOW-PIPELINES.md:344` |
| **Refund route** (`app/api/payments/[id]/refund/route.ts`) | — | **NOTHING** | it never touches `Member.paymentStatus` or `Member.status`, and never touches the subscription (deep-dive gap 2) |
| **Class-pack expiry** | — | **NOTHING** | pack `status` only |

`Member.status` writers: webhook `:238` and `:696`; staff PATCH `app/api/members/[id]/route.ts:246-266` (with `cancelledAt` stamped exactly once at `:317`, and **forced live-subscription cancellation at `:267-286`** before the flip is allowed); member delete `:543-619`; DSAR erase; and the create default.

### 4.3 Member billing transition table

| From | To | Trigger | Guard | Collateral |
|---|---|---|---|---|
| new member | `status=active`, `paymentStatus=paid` | `POST /api/members` (Prisma defaults `schema.prisma:131,133`) | owner/manager/admin; kid accounts owner-only | **Members are born paid having paid nothing.** The default is optimistic, so paid never means money arrived |
| `paid` | `pending` | `payment_intent.processing` (BACS) `webhook:596` | — | UI shows a Direct-Debit-pending notice (settles in about 4 working days) |
| `paid` or `pending` | `overdue` | `invoice.payment_failed` `webhook:264`; `mandate.updated` inactive `:606`; dispute opened `:968` | — | 2 emails; Failed tab on the payments page; dashboard action item (`lib/dashboard-action-items.ts:23-26`); member system action `payment_overdue` at weight 5 (`lib/member-actions.ts:114-124`) |
| `overdue` | `paid` | `invoice.payment_succeeded` `:369`; standalone PI `:771`; manual record `payments/manual:116`; staff PATCH; dispute won `:965` | PI path skipped when already cancelled `:768` | Stripe Smart Retries are the **only** automated retry; MatFlow has no dunning ladder of its own |
| any | `paused` | `customer.subscription.updated` status paused `:673`; staff PATCH | — | **paused gates nothing anywhere in the codebase** |
| any | `free` | staff PATCH only | — | **free gates nothing anywhere in the codebase** |
| `paid` or `overdue` | `cancelled` plus `status=cancelled` plus `cancelledAt` | `customer.subscription.deleted` `:238`; `customer.subscription.updated` to canceled/incomplete_expired `:682,696`; staff PATCH to cancelled `:266` (which first calls `cancelSubscriptionAtPeriodEnd` `:274`); **tenant suspend `suspend:80-87`**; **tenant soft-delete `soft-delete:74-81`**; DSAR erase | anti-resurrection `:687` and `:768` | `stripeSubscriptionId` nulled `:238` |
| `cancelled` | `active` | **staff PATCH only.** The webhook comment at `:680-681` states membership status only flips DOWN to cancelled there, and reaching active requires an explicit staff PATCH (intentional). Blocked outright for DSAR-erased members (`members/[id]/route.ts:260-263`, HTTP 422) | — | does **not** recreate the Stripe subscription |
| member self-cancel | Stripe `cancel_at_period_end = true` | `POST /api/member/subscriptions/cancel` into `lib/stripe/subscriptions.ts:218-222` | `memberSelfBilling` true `:43`; Connect present `:46`; not a sub-account `:57`; has a sub `:60` | **NO local state is written at all.** Until the period closes and Stripe fires `customer.subscription.deleted`, the member is indistinguishable from an active payer — no `cancelAt`, no cancelling badge, no end date shown. AuditLog `member.subscription.cancel` `:72-80` is the only trace |

### 4.4 What member billing state GATES

**The single hard gate in the whole system** is `lib/checkin.ts:195-196` — `hasActiveSubscription` is true only when `stripeSubscriptionId` is non-null AND `paymentStatus === "paid"`. It only bites when the caller passes `requireCoverage: true`. Coverage matrix (documented at `lib/checkin.ts:6-12`):

| Check-in path | `requireCoverage` | Effect when `paymentStatus` is not `paid` |
|---|---|---|
| **Member self check-in** (`POST /api/checkin` as the member) | `true` (`app/api/checkin/route.ts:126`, `requireCoverage: isSelf`) | falls through to class-pack redemption (`checkin.ts:199-260`); with no active, unexpired, credit-bearing pack the result is `no_coverage`, returned as **HTTP 402** (`app/api/checkin/route.ts:151`). **This is the only hard block anywhere in MatFlow.** |
| **Kiosk** (`app/api/kiosk/[token]/checkin`) | `false` (`route.ts:81`, commented "forgiving on subs") | **check-in succeeds** with `coverage: "uncovered_kiosk"` (`checkin.ts:314`). The kiosk member search filters `status IN (active, taster)` (`kiosk/[token]/members/route.ts:59`), so cancelled and inactive members are unsearchable, but **an overdue member is fully searchable and admitted** |
| **Staff / coach register** (`method: "admin"`) | `false` (`checkin.ts:9`; `app/api/checkin/route.ts:123-126` sets all four gates false for staff) | **all gates bypassed** — rank, roster, time window and coverage |
| **Parent checking in a kid** | `false` | same as staff |
| **`auto`** (cron or system) | `false` | all gates off |

**Everything else `paymentStatus` touches is advisory:**

- Member portal: `lib/member-actions.ts:114-124` emits a `payment_overdue` system action at **weight 5, higher priority than the waiver at weight 10**, linking to `/member/billing`. That page (`app/member/billing/page.tsx`) exists only because the action used to 404 — see its own header comment at `:5-16`. That card in a list is the entire member-facing consequence of being overdue.
- Staff dashboard: `app/dashboard/page.tsx:128,192` counts `status IN (active,taster) AND paymentStatus = "overdue"`; `lib/dashboard-action-items.ts` renders named rows; `app/api/payments/outstanding/route.ts:24` plus `lib/billing.ts:33-60` build the accounts-receivable list; `components/dashboard/MembersList.tsx:350-352,404-405` supplies the overdue filter and badges; `components/dashboard/MemberProfile.tsx:764` sets `hasAttention`.
- Reports: `lib/reports.ts:271` (overdue count) and `:392-399` (failed-payment recovery rate).

**Direct answers:**

| Question | Answer | Evidence |
|---|---|---|
| Can an **overdue** member log in? | **Yes.** No login path reads `paymentStatus` at all | `auth.ts:346-379` |
| Can a **cancelled** member log in? | **Yes.** `auth.ts` never reads `Member.status` either — a cancelled member who still has a `passwordHash` signs in normally and sees a fully working portal | `auth.ts:346-379` |
| Check in at the kiosk? | **Overdue: yes.** Cancelled: no (filtered out of the kiosk search) | `kiosk/[token]/members/route.ts:59`; `kiosk/[token]/checkin/route.ts:81` |
| Check in via coach register or staff? | **Always yes**, in any state, including cancelled | `app/api/checkin/route.ts:123-126` |
| Self check-in? | **The only blocked path.** HTTP 402 unless (live sub AND paid) or an unexpired pack with credits | `lib/checkin.ts:199,255`; `app/api/checkin/route.ts:151` |
| Book or join a class? | **Yes**, unconditionally — `ClassRoster`, `ClassWaitlist` and `ClassSubscription` writes read no billing state | `schema.prisma:445-494` |
| See the shop and buy? | **Yes.** `app/api/member/checkout/route.ts` gates on **tenant** Connect health only (`:142-165`, `ensureCanAcceptCharges`), never on member state | — |
| Buy a class pack? | **Yes**, same tenant-only gate | `app/api/member/class-packs/buy/route.ts` |
| Any other hard block? | **No.** | — |

### 4.5 Class packs — credits and expiry

- **Purchase is webhook-only.** `MemberClassPack.create` exists in exactly one place: `webhook/route.ts:453-463`, on `checkout.session.completed` with `metadata.matflowKind === "class_pack"`, a `metadata.tenantId === tenantId` cross-check `:430`, and a tenant-scoped member re-fetch `:441-444`. A **cash class-pack purchase can therefore never be fulfilled** (deep-dive gap 6) — `app/api/payments/intent/route.ts` leaves a pending Payment and nothing mints credits.
- **Redemption is atomic.** Candidate `findFirst` filtered `status active AND creditsRemaining > 0 AND expiresAt > now` (`checkin.ts:206-216`), then a guarded `updateMany` with `creditsRemaining: { gt: 0 }` (`:221-224`) so two concurrent check-ins cannot drive credits negative. The same guard protects the kiosk opportunistic path `:297-301`.
- **Credit restore on attendance deletion:** `restorePackCreditsForAttendance` (`checkin.ts:68-111`). A **refunded** pack is deliberately not restored `:102` (the member already got the money back). An **expired** pack **is** restored `:93-99` (they paid and were not compensated; expiry is re-checked at redemption anyway). Pack `status` is deliberately never resurrected to active `:98-99`.
- **Expiry is lazy and member-triggered only.** `app/api/member/class-packs/route.ts:27-33` flips `status` to `expired` when the member happens to open the packs page. **There is no cron.** Check-in itself is safe (it independently filters `expiresAt > now`), but every reporting surface drifts.
- **Void paths** (credits zeroed, `status` to `refunded`): `charge.refunded` `webhook:646-660`; `invoice.voided` `webhook:716-726`; dispute lost `webhook:934-948`; owner refund route `app/api/payments/[id]/refund/route.ts:314-321`.

### 4.6 Cash and PAY_AT_DESK paths

- **Manual payment ledger:** `app/api/payments/manual/route.ts` — methods cash, exempt, external, comp, other `:18`; comp and exempt may be zero-value `:36-43`; other requires notes `:44-50`; writes a Stripe-less `Payment` with status succeeded and flips the member to `paid` `:103-117`.
- **Shop pay-at-desk:** `Order.paymentMethod = "pay_at_desk"` with `status = "pending"` (`schema.prisma:947-948`), then staff `orders/[id]/mark-paid`. **That route writes no `Payment` row** (deep-dive gap 16), so cash shop sales are invisible to every revenue and CSV surface, all of which read `Payment` and never `Order`.
- There is **no cash path for class packs** (see 4.5) and **no cash path for subscriptions**. A cash-paying member is permanently a sequence of manual `payments/manual` entries with no recurring state.

### 4.7 Refunds and disputes — effect on member state

| Event | `Payment` row | `MemberClassPack` | `Member.paymentStatus` | Subscription |
|---|---|---|---|---|
| Owner refund (`app/api/payments/[id]/refund/route.ts`) | partial keeps succeeded with a cumulative `refundedAmountPence`; full flips to refunded `:307-309` | active pack voided `:314-321` | **untouched** | **untouched** — the member keeps training and is re-billed next cycle |
| `charge.refunded` webhook | `:625-638`, partial-aware via `amount_refunded >= amountPence` `:630` | voided `:646-660` | **untouched** | untouched |
| `invoice.voided` | flips to refunded with the full `refundedAmountPence` `:706-712` | voided `:716-726` | **untouched** | untouched |
| `charge.dispute.created` | flips to disputed `:950-953` | — | to `overdue` `:962-969` | untouched. Owner emails `dispute_created` `:892` and `dispute_opened_owner` `:1024` |
| dispute won | back to succeeded **only if never refunded** `:912-917` | — | to `paid` under the same condition `:965` | untouched |
| dispute lost | to refunded `:930-933` | voided `:934-948` | to `overdue` | untouched |
| dispute charge_refunded | to refunded `:918-922` | — | to `overdue` | untouched |

---

## 5. GAPS — state combinations with no handling or contradictory handling

### 5.1 Plane A (club to MatFlow) gaps

| # | State combo | Actual behaviour | Evidence | Risk |
|---|---|---|---|---|
| A1 | **Trial has ended** (whatever "ended" means) | Nothing happens, ever. There is no `trialEndsAt`, no cron, no writer. The tenant keeps full access forever. The landing page sells a "30-day free trial" the schema cannot express | no field on `Tenant` (`schema.prisma:11-77`); `vercel.json` has 3 crons, none touch status; `components/landing/Hero.tsx:232` | **HIGH — revenue leak.** Every gym that never converts keeps the product free indefinitely |
| A2 | **Club stops paying the SaaS fee** | No product state exists to represent it. No banner, no email, no degradation, no read-only mode. The ONLY lever is a nuclear manual suspend | §2.3; `lib/email.ts:27` (no tenant-billing templates) | **HIGH — commercial.** Collection depends entirely on Noe remembering |
| A3 | **`subscriptionStatus = "cancelled"`** | Documented in the schema comment `:23` and in `docs/MATFLOW-PIPELINES.md:370`; **read** by `app/api/tenant/[slug]/route.ts:79` (404s the branding lookup); but **`auth.ts:194` does not check it, so login still works.** And no code ever writes it | grep: zero writers | **MED — contradictory.** If it is ever hand-set, the club is half-dead: members cannot resolve branding at the login page (so the club code lookup 404s), yet a direct login with a known slug still succeeds |
| A4 | **Suspend used for SaaS non-payment** | Cancels **every member Stripe subscription** at period end (`suspend:73-102`), irreversibly. Reactivating (`:157`) does **not** restore them | explicitly warned against in `.omc/specs/deep-dive-matflow-sellable-product.md:131` | **CRITICAL — the club loses its entire recurring revenue book because it was late paying MatFlow.** The only documented mitigation is "remember not to press the button" |
| A5 | **Suspended tenant, member subscriptions still live at Stripe** | The cancel loop is best-effort `Promise.allSettled` (`suspend:80-101`). Failures increment `stripeFailed` and are recorded as `stripeFailedIds` in the audit metadata `:127-129` — and then **nothing retries them**. There is no reconciliation job for this | `suspend/route.ts:88-101` | **HIGH — members of a locked-out gym keep being charged.** Chargeback and FCA/consumer-rights exposure (the original audit finding A6I1-S-4, `docs/audit/iter-1-operator-admin.md:58`) |
| A6 | **Tenant suspended, kiosk token still minted** | Kiosk keeps taking check-ins, minting member tokens, and reading the roster. Nothing in `app/api/kiosk/**` reads tenant status, and the whole `/api/kiosk` prefix is excluded from the edge middleware | `kiosk/[token]/checkin/route.ts:58-66`; `kiosk/[token]/members/route.ts:47-48`; `proxy.ts:223` | **MED — access-control.** A locked-out gym still has a working front door |
| A7 | **Tenant suspended or soft-deleted, magic-link email still in an inbox** | Session minted with no tenant check. Full access restored | `magic-link/verify/route.ts:55-58,109-135` | **HIGH — the suspend gate is bypassable.** `sessionVersion` is read fresh at mint time, so the 10-minute recheck also passes |
| A8 | **Tenant suspended or soft-deleted, user signs in with Google** | Same — `signIn` callback checks email-verified, pending-tenant slug and account existence, but never tenant state | `auth.ts:455-487` | **HIGH — same bypass** (only when `GOOGLE_CLIENT_ID` is configured) |
| A9 | **Tenant soft-deleted, Stripe webhooks still arriving** | Fully processed. The webhook resolves the tenant by `stripeAccountId` and checks existence only. So a "deleted" gym still gets `Payment` rows written, members flipped between paid/overdue, and dunning emails sent to members and owners | `webhook/route.ts:158-165`; no `deletedAt` filter anywhere in the file | **HIGH — a deleted gym is still visibly operating to its members** (emails) while its owner cannot log in |
| A10 | **Tenant PURGED, Stripe webhooks still arriving** | `tenant.findFirst` returns null, `WebhookRetryableError` is thrown, the tx rolls back and the route returns **409 so Stripe retries** — forever, until Stripe exhausts its retry schedule. Meanwhile `lib/stripe/reconcile.ts` cannot flag it either (the tenant row it enumerates from is gone) | `webhook/route.ts:163-165, 1052-1058` | **MED — permanent webhook error noise** plus real member charges landing nowhere |
| A11 | **Retention purge blocked forever** | `cancelTenantSubscriptions` refuses to purge a tenant whose members hold subscriptions it cannot cancel, e.g. because the gym disconnected Stripe first (`stripe/disconnect/route.ts:40` nulls `stripeAccountId` without cancelling anything). The tenant then sits soft-deleted indefinitely | `retention/route.ts:470-492`; `disconnect/route.ts:34-42` | **MED — the published 30-day erasure promise (`app/legal/privacy/page.tsx:77`) silently fails** for exactly the gyms most likely to be leaving |
| A12 | **Mass exit** | `MAX_TENANT_PURGES_PER_RUN = 2` and one run per day, so 20 departing gyms take 10 days minimum, more if any partial | `retention/route.ts:65` | **LOW** |
| A13 | **`trial` to `active` has no UI** | The only route that can write `active` is `DELETE .../suspend`, and the operator UI only renders that control when `isSuspended` is true | `app/admin/tenants/[id]/page.tsx:113`; `suspend/route.ts:157` | **MED — the single most important commercial action (mark a gym as paying) has no button.** Requires curl or hand-SQL |
| A14 | **No CHECK constraint on `subscriptionStatus`** | Any string is storable. A typo (`"Active"`, `"suspend"`) silently disables every gate that compares by equality — login would keep working while branding 404s, or vice versa | `20260430000001` covers Member/Payment/User but not Tenant; `docs/audit/iter-1-database.md:101` | **MED** |
| A15 | **`Tenant.featureFlags` is dead** | Column exists, migration shipped, zero readers | `20260506000000/migration.sql:7`; grep returns only schema + docs | **LOW — dead weight**, but it is the natural home for a per-tenant read-only/grace mode that does not exist |
| A16 | **`Tenant.customDomain` is dead** | `@unique` column, never read | `schema.prisma:22`; deep-dive `:89` "dormant field (not wired — do not sell it)" | **LOW** |
| A17 | **No operator email on any tenant lifecycle event** | Suspension, reactivation, soft-delete and impending purge all send zero email to the owner | `lib/email.ts:27` template union | **MED — support burden.** A locked-out owner has no idea why |

### 5.2 Plane B (member to club) gaps

| # | State combo | Actual behaviour | Evidence | Risk |
|---|---|---|---|---|
| B1 | **Member cancelled, class-pack credits remain** | `customer.subscription.deleted` sets `status`/`paymentStatus` to cancelled `:238` but **never touches `MemberClassPack`**. The credits stay `active` with credits remaining. Self check-in still redeems them (`checkin.ts:206-216` filters only pack status, credits and expiry — never `Member.status`) | `webhook:226-252`; `checkin.ts:206-216` | **LOW-MED — arguably correct** (they paid for the pack), but it means "cancelled" members can still train, which no surface communicates |
| B2 | **Member cancelled, can still log in and use the portal** | `auth.ts` reads neither `Member.status` nor `paymentStatus`. Full portal, shop, class booking, waitlist | `auth.ts:346-379` | **MED — no offboarding.** A cancelled member is indistinguishable from an active one everywhere except the kiosk search and self check-in |
| B3 | **Member self-cancelled, UI shows nothing** | `cancel/route.ts` writes **no local state**. No `cancelAt`, no `currentPeriodEnd` column exists (`schema.prisma:122-216`). The member portal cannot show "your membership ends on X"; staff cannot see a pending cancellation; churn dashboards see nothing until the period actually closes | `app/api/member/subscriptions/cancel/route.ts:64-87` | **MED — churn is invisible until it has already happened** |
| B4 | **Refund issued, subscription keeps billing** | The refund route has zero `stripeSubscriptionId` references — it refunds the charge and stops. The member is charged again next cycle | `app/api/payments/[id]/refund/route.ts`; deep-dive gap 2 | **HIGH — refund is not resolution.** Direct chargeback driver |
| B5 | **Refund issued, `paymentStatus` unchanged** | Member stays `paid` after a full refund. Self check-in still succeeds; AR and revenue reporting are unaffected | refund route never writes Member | **MED — ledger and access diverge** |
| B6 | **`paused` and `free` are inert** | Both are legal CHECK values, both settable by staff PATCH and (for `paused`) by Stripe, and **neither is read by any gate, banner, report filter or action item.** Only `overdue` and `paid` do anything | `lib/checkin.ts:196`; `lib/member-actions.ts:114`; `app/dashboard/page.tsx:128` | **MED — a "paused" member is treated exactly like an unpaid one at self check-in (402), and exactly like a paid one everywhere else** |
| B7 | **`paid` is the birth default** | Every member created by staff, invite or CSV import starts `status=active, paymentStatus=paid` with zero payment on file. `hasActiveSubscription` still needs `stripeSubscriptionId`, so self check-in fails at 402 with a confusing message; but every dashboard and report counts them as paid | `schema.prisma:131,133` | **MED — AR is structurally understated.** "Overdue" only ever means "Stripe told us a charge failed" |
| B8 | **Class-pack expiry has no cron** | `status` flips to expired only when the member opens the packs page. Reporting, the tenant purge scan and any future expiry email all read stale rows | `app/api/member/class-packs/route.ts:27-33` | **LOW — check-in is safe; reporting is not** |
| B9 | **Cash class-pack purchase impossible** | `MemberClassPack.create` exists only in the Stripe webhook. A cash-paying member gets a pending Payment and zero credits | `webhook:453-463`; `app/api/payments/intent/route.ts` | **MED — money taken, goods not delivered** |
| B10 | **Cash shop sale invisible to the ledger** | `orders/[id]/mark-paid` flips `Order.status` but writes no `Payment` row; every revenue/CSV surface reads `Payment` | deep-dive gap 16 | **MED — revenue understated** |
| B11 | **Owner never learns of a failed payment when the member has no email** | The `payment_failed_owner` fan-out at `webhook:328-347` sits **inside** `if (memberFull?.email)` at `:307` | `webhook:307,328` | **MED — silent dunning failure** for imported/kid/email-less members |
| B12 | **Dunning ladder does not exist** | One email on failure, then nothing. Retries are Stripe Smart Retries only. No day-3/day-7 escalation, no access consequence, no auto-pause | grep: no dunning scheduler | **MED** |
| B13 | **Overdue does not revoke kiosk access** | Kiosk passes `requireCoverage: false`, and the member search admits `status IN (active, taster)` regardless of `paymentStatus` | `kiosk/[token]/checkin/route.ts:81`; `kiosk/[token]/members/route.ts:59` | **MED — the club's own enforcement lever is off by default** and there is no per-tenant setting to turn it on |
| B14 | **Staff check-in bypasses everything** | `admin` method disables rank, roster, window and coverage. A coach ticking the register admits a cancelled, overdue, unranked, off-roster member with no warning shown | `app/api/checkin/route.ts:123-126`; `lib/checkin.ts:9` | **MED — by design, but the UI surfaces no "this member owes money" signal at the register** |
| B15 | **`Member.membershipType` is free text** | Not an FK to `MembershipTier`. CSV-imported members carry an unlinked string, so plan/revenue reporting is blank until someone relinks by hand | `schema.prisma:130` vs `:1003`; deep-dive `:40` | **MED** |
| B16 | **Disconnect Stripe leaves orphaned billing** | `stripe/disconnect` nulls `stripeAccountId` without cancelling any live member subscription. MatFlow can then neither see nor refund them, and (per A11) the tenant can never be purged | `disconnect/route.ts:34-42`; deep-dive gap 17 | **HIGH — money keeps moving on a rail the product has forgotten** |
| B17 | **Webhook depends on `event.account`** | Any event without a connected-account id throws `WebhookRetryableError` and 409s. If the Stripe endpoint is registered as an account-type rather than a Connect-type endpoint, **the entire payment layer silently no-ops** | `webhook/route.ts:155-157`; deep-dive `:48,78` | **CRITICAL until verified in the live Stripe dashboard** |

### 5.3 Cross-plane contradictions (the ones that bite hardest)

| # | Contradiction | Why it matters |
|---|---|---|
| X1 | **The only lever MatFlow has against a non-paying club destroys that club's revenue.** Suspend cancels every member subscription (`suspend:73-102`) and reactivate does not restore them (`:157`). The two planes are wired together in exactly one direction, and it is the destructive one | The commercial escalation path is unusable. In practice this means MatFlow has **no enforcement mechanism at all** for its own fee |
| X2 | **Tenant state gates humans but not machines.** Login is gated (`auth.ts:193-194`); webhooks, kiosk, emails, waiver pages and the Stripe reconcile sweep are not | A suspended or soft-deleted gym is simultaneously "locked out" and "fully operational" depending on which door you knock on |
| X3 | **Session invalidation is the real gate, and it is eventually-consistent.** `sessionVersion` is rechecked at most every 10 minutes (`auth.ts:670-675`) and never at the edge (`:664-666`) | Up to a 10-minute window where a suspended tenant's staff still have full write access to the API |
| X4 | **`trial` is both "new customer" and "free rider" and the system cannot tell them apart.** The only signal is `Tenant.createdAt` bucketed in the admin UI (`app/admin/page.tsx:105-111`) | Operationally this is the whole product's commercial blind spot |
| X5 | **Member `paid` means two different things.** For a Stripe member it means "the last invoice succeeded". For everyone else it means "nobody has said otherwise since the row was created" (`schema.prisma:133` default) | AR, revenue reporting and the self-check-in gate all silently mix the two populations |
| X6 | **The published legal position and the code disagree about who can cancel.** `app/legal/terms/page.tsx:92` says the club "may cancel at any time"; there is **no self-serve cancel for a club anywhere in the product** — the only exit is emailing legal@matflow.studio and an operator soft-deleting them | Consumer/contract exposure, and a manual offboarding burden |

### 5.4 The smallest set of changes that would close the commercial hole

Ordered by leverage, all derived from the evidence above (not a plan, an observation):

1. **Add `Tenant.trialEndsAt` + a `grace` / `read_only` status**, so there is a non-nuclear gear between `active` and `suspended`. `featureFlags` (`schema.prisma:62`) is already there and unused.
2. **Add a CHECK constraint on `subscriptionStatus`** in the same style as `20260430000001`.
3. **Split the "lock the club out" lever from the "cancel every member subscription" lever.** Today `suspend` and `soft-delete` both fan out to Stripe (`suspend:73-102`, `soft-delete:67-92`). Only the second one needs to.
4. **Add the two missing tenant-state checks** to `magic-link/verify/route.ts:55-58` and `auth.ts:471-474`, so the login gate is actually a gate.
5. **Add a `deletedAt`/`suspended` check at `webhook/route.ts:158-165`**, or at minimum stop sending member-facing emails for a tenant in those states.
6. **Give the operator UI a "mark as paying" control** — currently the only path from `trial` to `active` is an undocumented `DELETE` on the suspend route (`:157`).

---

## APPENDIX — quick file index

| Concern | File |
|---|---|
| Tenant + Member schema | `prisma/schema.prisma:11-77`, `:122-216` |
| CHECK constraints | `prisma/migrations/20260430000001_schema_check_constraints/migration.sql` |
| Login gate (the only real tenant gate) | `auth.ts:187-194` |
| Google OAuth gate (missing tenant check) | `auth.ts:455-487` |
| Magic-link session mint (missing tenant check) | `app/api/magic-link/verify/route.ts` |
| Edge middleware (no tenant state at all) | `proxy.ts` |
| Staff shell (only onboarding check) | `app/dashboard/layout.tsx:26-35` |
| Member shell (no gating) | `app/member/layout.tsx` |
| Operator suspend / reactivate | `app/api/admin/customers/[id]/suspend/route.ts` |
| Operator soft-delete / restore | `app/api/admin/customers/[id]/soft-delete/route.ts` |
| Tenant creation (approve) | `app/api/admin/applications/[id]/approve/route.ts` |
| Tenant creation (direct) | `app/api/admin/create-tenant/route.ts` |
| Hard purge | `app/api/cron/retention/route.ts:388-712` |
| Cron tenant filters | `app/api/cron/monthly-reports/route.ts:46-49`, `app/api/cron/class-instances/route.ts:96` |
| Stripe webhook (all member billing state) | `app/api/stripe/webhook/route.ts` |
| Connect health cache | `lib/stripe-account-status.ts` |
| Subscription create / cancel helpers | `lib/stripe/subscriptions.ts` |
| Webhook drop detector | `lib/stripe/reconcile.ts` |
| Check-in gate | `lib/checkin.ts:186-321` |
| Member action items | `lib/member-actions.ts` |
| Owner AR list | `lib/billing.ts`, `app/api/payments/outstanding/route.ts` |
| Manual/cash payments | `app/api/payments/manual/route.ts` |
| Refunds | `app/api/payments/[id]/refund/route.ts` |
| Platform billing rollup (no MRR) | `app/admin/billing/page.tsx` |
| Owner-visible subscription card | `components/dashboard/SettingsPage.tsx:2237-2247` |
| Email templates (none for tenant billing) | `lib/email.ts:27` |
| Runbook | `docs/RUNBOOK.md:173-184` |
| Lifecycle documentation | `docs/MATFLOW-PIPELINES.md:93-197`, `:225-387` |
| Commercial decision record | `.omc/specs/deep-dive-matflow-sellable-product.md:11,44-79,131` |
| Prior audit of these routes | `docs/audit/iter-1-operator-admin.md:55-62` |
