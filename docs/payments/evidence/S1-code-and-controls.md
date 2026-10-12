# Lane S1 — Stripe code and control inventory (read-only)

Repository: C:\Users\NoeTo\Desktop\matflow, branch security/assurance-2026-10. Inspected 11 Oct 2026 (UK). No edits, no DB, no Stripe API calls.
Status vocabulary: IMPLEMENTED / FIXTURE-TESTED / INTEGRATION-TESTED / PRODUCTION-EVIDENCED / MISSING / UNKNOWN.

Test tiers used below: "unit" = tests/unit (Vitest, mocked Prisma/Stripe = FIXTURE-TESTED); "e2e campaign" = tests/e2e/campaign/** Playwright specs that hit a running server + a test DB branch (counted as INTEGRATION-TESTED only where they drive a DB; they never reach Stripe with a live key — tests/e2e/global-setup.ts:90-149).

## Basics: SDK, API version, client construction

- `stripe` resolved **22.0.1** (package-lock.json:14648-14650; package.json:53). SDK default API version is `2026-03-25.dahlia` (node_modules/stripe/cjs/apiVersion.js:5), and every call site also pins that string explicitly.
- **No central Stripe client factory.** About 25 call sites each run `new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" })`, e.g. app/api/stripe/webhook/route.ts:42, lib/stripe/subscriptions.ts:78, lib/stripe/reconcile.ts:63, app/api/payments/[id]/refund/route.ts:145, app/api/members/[id]/charge/route.ts:143 (full list via grep `new Stripe(`). Changing the key or version means touching every site.
- `@stripe/stripe-js` ^9.1.0 is declared (package.json:30) but **nothing imports it**: grep for `stripe-js` / `loadStripe` across app/, components/ and lib/ finds nothing. No browser code confirms a PaymentIntent. This matters for subscriptions (see §1).

## 2. Connect: account type and onboarding method actually used

- **Method: the OAuth `authorize` URL (Standard-style).** app/api/stripe/connect/route.ts:25-32 builds `https://connect.stripe.com/oauth/authorize?response_type=code&client_id=<STRIPE_CLIENT_ID>&scope=read_write&state=...`. It sends no `redirect_uri`, so Stripe uses the dashboard-registered default (the health route says as much at app/api/stripe/connect/health/route.ts redirectUriRegistrationHint). It sends no `stripe_user[...]` prefill and no `stripe_landing`.
- **Code exchange:** app/api/stripe/connect/callback/route.ts:56-60 calls `stripe.oauth.token({ grant_type: "authorization_code", code })` and stores `response.stripe_user_id`. It does not read `livemode`, `scope` or `stripe_publishable_key`, and does not compare them with the platform key mode.
- **Not used anywhere:** Account Links, Account Sessions, `accounts.create` (any `type`), `controller` properties. Grep for `accountLinks|accountSessions|accounts.create` across app/ and lib/ returns nothing. The only `accounts.*` calls are `accounts.retrieve` (lib/stripe-account-status.ts:47) and `accounts.list({limit:1})` in the health probe (app/api/stripe/connect/health/route.ts:118).
- **Can an owner connect an EXISTING account?** Yes. That is the normal OAuth path: the owner signs in to their own Stripe account on Stripe's page. **Is one created when needed?** Not by MatFlow. Creation is left to Stripe's hosted OAuth page, where the owner can sign up. Status: IMPLEMENTED; MatFlow has no account-creation code.
- **Stored state:**
  - `Tenant.stripeAccountId String? @unique` (prisma/schema.prisma:27).
  - `Tenant.stripeConnected Boolean` (schema.prisma:28).
  - `Tenant.stripeAccountStatus Json?`, which caches `{chargesEnabled, payoutsEnabled, requirementsPastDue, disabledReason, refreshedAt}` (schema.prisma:36; type at lib/stripe-account-status.ts:16-22).
  - The callback writes `{stripeAccountId, stripeConnected: true}` (callback/route.ts:62-67) and an audit row `stripe.connect` with the account id in metadata (callback/route.ts:69-78).
- **Status cache:** refreshed on the `account.updated` webhook after commit (webhook/route.ts:180-193, 1289-1292), and lazily when the cache is null or older than 24 h (lib/stripe-account-status.ts:132-149).
- Tests:
  - tests/unit/stripe-account-status.test.ts and tests/unit/stripe-connect-health-readiness.test.ts: FIXTURE-TESTED.
  - The e2e campaign checks only that connect and health are owner-only (tests/e2e/campaign/assess/le-3-webhooks-and-billing.spec.ts:402) and that disconnecting a club with no account is an honest refusal (same file :413).
  - **No test drives the callback's code exchange or state verification.** A grep for `connect/callback` and `oauth.token` in tests/ finds only the support-session route lists.
  - Callback state handling: IMPLEMENTED, test MISSING.

## 5. Credentials (names only)

| Variable | Read at | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | about 49 reads, all `process.env` at call time (e.g. webhook/route.ts:42, lib/stripe/subscriptions.ts:72-79) | Platform secret. Restricted `rk_` keys are accepted as usable (lib/stripe/key-mode.ts:46-68). Code comments say production holds an `rk_live_` (key-mode.ts:14-16); not verified here. |
| `STRIPE_CLIENT_ID` | app/api/stripe/connect/route.ts:14; app/api/stripe/disconnect/route.ts:30 (non-null asserted `!`); connect/health | OAuth client id (`ca_`). If it is unset at disconnect time, `oauth.deauthorize` throws and the throw is swallowed (disconnect/route.ts:33). |
| `STRIPE_WEBHOOK_SECRET` | app/api/stripe/webhook/route.ts:33; connect/health:46 | **The only webhook signing secret read.** There is no second secret. The handler refuses any event without `event.account` (webhook/route.ts:144-146), so this secret must belong to a **Connect** endpoint ("events on connected accounts"). Platform-account events would be 409-retried until Stripe gives up. Health checks only that the variable is present (health/route.ts:146), not which kind of endpoint it belongs to. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | app/member/shop/page.tsx:53 only | Used only as a boolean "platform has Stripe" fallback for the shop rail; never passed to Stripe.js. `.env` holds `STRIPE_PUBLISHABLE_KEY`, a name no code reads; `.env.test` holds the `NEXT_PUBLIC_` name. |
| `CRON_SECRET` | app/api/cron/stripe-reconcile/route.ts:22 | Bearer secret for the reconcile cron. |

- Variable names per env file (names only, values not read):
  - `.env`: STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_CLIENT_ID, STRIPE_WEBHOOK_SECRET.
  - `.env.test`: STRIPE_SECRET_KEY, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, STRIPE_CLIENT_ID, STRIPE_WEBHOOK_SECRET.
  - `.env.example`: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_CLIENT_ID.
  - `.env.local`: no Stripe names.
- Boot env guard: lib/env-guards.ts:35-37 lists the three server Stripe variables at severity `error`; CRON_SECRET is `warn` (env-guards.ts:69).
- Key-mode policy: lib/stripe/key-mode.ts:102-127 refuses a test key in production and a live key outside production. It is wired **only** into the owner health endpoint's `ready` verdict (connect/health). **Money paths do not enforce it**: no charge, checkout or subscribe route calls `assessKeyForEnvironment`. Status: FIXTURE-TESTED (tests/unit/stripe-key-mode.test.ts).
- E2E key guard: `assertNoLiveStripeKeys` (tests/e2e/global-setup.ts:90-93, invoked at :149) refuses `sk_live_`, `rk_live_` and `pk_live_`. Status: FIXTURE-TESTED (tests/unit/e2e-stripe-key-guard.test.ts:23-60). That test file contains a literal `ca_` client id (line 20). A client id is not secret, but it is a real-looking identifier committed to the repo.
- Nothing compares the OAuth client id's mode (test vs live `ca_`) with the secret key's mode.

## 6. Authorisation of connect / replace / disconnect

- **Guard:** connect start, callback and disconnect each check `session.user.role !== "owner"` inline. They do not call `requireOwner` or `requireApiOwner` (connect/route.ts:10, callback/route.ts:11, disconnect/route.ts:14). Owner TOTP enrolment is mandatory in production via the proxy (proxy.ts, block "Mandatory TOTP for owners (re-introduced 1 Oct 2026)", around lines 423-440). There is **no per-action step-up or re-authentication** on connect, replace or disconnect.
- **Support (impersonation) sessions:** refused in each route (connect/route.ts:9, callback/route.ts:10, disconnect/route.ts:13). The proxy also refuses them: GET connect and callback are listed as non-plain reads in lib/support-session.ts (route list near line 77: `/^\/api\/stripe\/connect(\/callback)?\/?$/`).
- **CSRF:** disconnect calls `assertSameOrigin` (disconnect/route.ts:10). Connect start is a GET that only returns a URL. The callback is a GET protected by `state`.
- **OAuth `state`:** built as `HMAC-SHA256(AUTH_SECRET_VALUE, "<tenantId>:<timestamp>") + ":" + payload` (connect/route.ts:19-23).
  - Signed: yes, with the raw AUTH_SECRET and no domain-separation prefix. lib/key-contexts.ts:19 lists "Stripe Connect state" among the remaining raw signers.
  - Expiry: 15 min, and a non-numeric timestamp is rejected (callback/route.ts:50-53).
  - Constant-time compare with a length pre-check (callback/route.ts:35-40).
  - Tenant binding: the state's `tenantId` must equal the session tenant (callback/route.ts:42-45).
  - **Not bound to the user.** Any owner of the same tenant could complete it.
  - **Not single-use.** No nonce is stored, so the state can be replayed within 15 min for the same tenant. Each replay still needs a fresh one-time Stripe `code`, so the practical risk is low.
- **Verification of the returned account:** only that `stripe_user_id` is present (callback/route.ts:59-60). The code cannot check that the account "belongs to" the tenant; OAuth proves only that the person at Stripe authorised it.
- **Replace:** there is **no explicit replace flow.** Re-running OAuth while connected silently overwrites `stripeAccountId` (callback/route.ts:62-67). When that happens:
  - the previous account is **not deauthorised**;
  - `stripeAccountStatus` is not cleared, although disconnect does clear it (disconnect/route.ts:42), so a stale `chargesEnabled` from the old account can be trusted for up to 24 h;
  - existing `Member.stripeCustomerId` and `stripeSubscriptionId` (objects on the old account) are left pointing at ids the new account does not have;
  - every later event from the old account gets a 409 at the webhook (§12).

  Nothing gates a replace while subscriptions are live. This is a policy gap.
- **Disconnect:** calls `stripe.oauth.deauthorize`, then clears `stripeAccountId`, `stripeConnected` and `stripeAccountStatus` (disconnect/route.ts:25-44), then writes audit `stripe.disconnect` (disconnect/route.ts:46-53).
  - A deauthorise failure is swallowed (disconnect/route.ts:33), so MatFlow can record "disconnected" while Stripe still grants access.
  - Disconnect does not check for live MatFlow-created subscriptions. Those keep billing on the gym's account, which is correct for Standard, but MatFlow stops seeing their webhooks (§18).
- **Cross-club paths:**
  - The callback writes only `session.user.tenantId`. No route lets an owner of club A write club B's `stripeAccountId`.
  - Operator/admin routes read `stripeAccountId` to cancel subscriptions (app/api/admin/customers/[id]/soft-delete/route.ts:74,150-160; app/api/admin/dsar/erase/route.ts:260-274; lib/tenant-purge.ts:195-231).
  - No admin route writes `stripeAccountId`: grep for writes finds only callback/route.ts:65 and disconnect/route.ts:42.
- Status: connect, callback and disconnect are IMPLEMENTED.
  - Owner-only refusal is exercised by the e2e campaign (le-3-webhooks-and-billing.spec.ts:402,413).
  - Support refusal is FIXTURE-TESTED (tests/unit/support-session-routes.test.ts, support-session-readonly.test.ts).
  - State and exchange logic is test MISSING.

## 7. Account to tenant mapping

- The mapping exists only as `Tenant.stripeAccountId` (prisma/schema.prisma:27), declared `@unique`. The migration is prisma/migrations/20260628004500_unique_tenant_stripe_account/migration.sql:11 (`CREATE UNIQUE INDEX "Tenant_stripeAccountId_key"`); multiple NULLs are allowed.
- **The database refuses one Stripe account on two tenants. The code does not pre-check.** When the callback's `tenant.update` hits the unique constraint (P2002), the generic `catch {}` swallows it and redirects to `?error=exchange_failed` (callback/route.ts:81-83). As a result:
  - the owner gets no specific message (for example, that the account is already connected to another club);
  - nothing is audited and the operator gets no signal;
  - **the OAuth grant just made at Stripe is not deauthorised**, so the platform keeps access to that account with no tenant recording it.
- Webhook routing depends on this uniqueness: `tenant.findFirst({ where: { stripeAccountId } })` (webhook/route.ts:147-150).
- Policy implications the owner must decide:
  - A gym running two clubs on one Stripe account cannot connect both. Choose one tenant per account, or use Locations.
  - Operator soft-delete (app/api/admin/customers/[id]/soft-delete/route.ts) reads `stripeAccountId` but I found no code that nulls it. A soft-deleted tenant therefore keeps holding the unique slot, and the same gym could not connect that account to a new tenant until the row is hard-purged. Whether lib/tenant-purge.ts hard-deletes the Tenant row is not confirmed (UNKNOWN).

## 8. App side: calls MatFlow makes on connected accounts

Pattern: there is no shared client. Each call passes `{ stripeAccount: tenant.stripeAccountId }` as the request option, which becomes the `Stripe-Account` header. Full inventory (grep of `stripe.<resource>.<method>(` across app/ and lib/):

| Call | Site | On connected account? |
|---|---|---|
| `customers.create` | lib/stripe/subscriptions.ts:90-93; app/api/member/class-packs/buy/route.ts:111-113 | yes; **no idempotency key** (a lost race leaves an orphan customer, as acknowledged at subscriptions.ts:83-87) |
| `subscriptions.create` | lib/stripe/subscriptions.ts:124-152 (key `matflow_sub_<member>_<requestId>`); lib/stripe/migrate-memberships.ts:647-671 (key `matflow_migrate_<member>`) | yes |
| `subscriptions.update` | cancel-at-period-end lib/stripe/subscriptions.ts:234-238; hold app/api/members/[id]/hold/route.ts:76; resume app/api/members/[id]/resume/route.ts:63; refund-linked app/api/payments/[id]/refund/route.ts:264 | yes, no idempotency keys (the updates are naturally idempotent) |
| `subscriptions.cancel` | app/api/payments/[id]/refund/route.ts:261 | yes |
| `subscriptions.list` | lib/stripe/migrate-memberships.ts:640 (recovery lookup by `metadata.matflowMemberId`) | yes |
| `paymentIntents.create` (off_session, confirm) | app/api/members/[id]/charge/route.ts:166-177 (key `matflow_adhoc_<member>_<requestId>`) | yes |
| `refunds.create` | app/api/payments/[id]/refund/route.ts:191-206 (key `matflow_refund_<payment>_<amount>_<alreadyRefunded>`) | yes |
| `charges.retrieve` | refund/route.ts:155, :232 | yes |
| `checkout.sessions.create` (mode payment) | app/api/member/checkout/route.ts:280-295; app/api/member/class-packs/buy/route.ts:130-146 | class packs: yes. **Shop checkout: only `if tenant.stripeConnected`**, otherwise `undefined`, which means **the platform account** (checkout/route.ts:220 and :294). See section 18 for the danger. No idempotency key on either. |
| `billingPortal.sessions.create` | app/api/stripe/portal/route.ts:59-61; app/api/member/family/[id]/billing/portal/route.ts:83-88 | yes |
| `customers.listPaymentMethods` | app/api/members/[id]/payment-method/route.ts:39-42; lib/stripe/migrate-memberships.ts:290-293 | yes |
| `paymentMethods.retrieve` | lib/stripe/migrate-memberships.ts:347; lib/stripe/invoice-payment.ts:104 | yes |
| `invoices.retrieve`, `paymentIntents.retrieve` | lib/stripe/invoice-payment.ts:43, :67 (webhook pre-transaction resolution) | yes |
| `products.create` / `prices.create` | app/api/class-packs/route.ts:65-89; app/api/stripe/subscription-plans/route.ts:109-123; lib/stripe/tier-price.ts:44-48 | yes, no idempotency keys (a retry can mint duplicate products or prices) |
| `prices.list` | app/api/stripe/subscription-plans/route.ts:48-50 | yes. Lists **all** prices on the gym's account, including ones MatFlow did not create |
| `customers.list` (expand subscriptions + default PM) | lib/stripe/migrate-memberships.ts:214-240 | yes. Enumerates **every customer on the account**, up to 100 pages of 100 |
| `events.list` | lib/stripe/reconcile.ts:83-86 | yes |
| `accounts.retrieve` | lib/stripe-account-status.ts:47 | platform call about the connected account |
| `accounts.list`, `balance.retrieve` | app/api/stripe/connect/health/route.ts:118-120 | platform account (diagnostic) |
| `oauth.token`, `oauth.deauthorize` | callback/route.ts:58; disconnect/route.ts:29 | platform |

Reading foreign objects (not created by MatFlow):
- **Deliberate, migration only.** lib/stripe/migrate-memberships.ts:1-60 assumes the club connects "the SAME Stripe account its old platform billed through". It then lists all customers, matches them to members, and offers ADOPT (point the member at an existing subscription, behind `allowAdopt`), REPLACE (the default) or CREATE. Owner-only (app/api/stripe/migrate-memberships/route.ts:61, :87 `requireApiOwner`). Status: IMPLEMENTED, FIXTURE-TESTED (tests/unit/migrate-memberships.test.ts). Test-mode script evidence is recorded in docs/runbooks/TEAMUP-MIGRATION.md:81 and docs/readiness/TEN-CLUB-AUDIT-2026-09-25.md:25 (lane S2 owns that).
- **Implicit, through webhooks.** A Connect endpoint receives events for **every object on the account**, whoever created it. The handlers do not filter by MatFlow metadata. They match only on `customer` plus tenant (webhook/route.ts:155-175):
  - `customer.subscription.updated` **overwrites `Member.stripeSubscriptionId` with whatever subscription changed on that customer** (webhook/route.ts:756-766). A subscription the gym created in its own dashboard, or one still run by TeamUp on the same customer, would re-point the member and drive `paymentStatus` and `status`.
  - `invoice.payment_succeeded` / `invoice.payment_failed` for any invoice on a matched customer write Payment rows and flip `paymentStatus` (webhook/route.ts:255-436).

  Lane S2 should decide whether this is the intended field authority.
- MatFlow-created subscriptions from the in-app path carry **no metadata** (lib/stripe/subscriptions.ts:124-152 sets none). Only migration-created ones carry `matflowMemberId` and `matflowTenantId` (migrate-memberships.ts:663-668). Events therefore cannot tell MatFlow's own in-app subscriptions apart from foreign ones.

## 12. Webhook

- **One endpoint:** `POST /api/stripe/webhook` (app/api/stripe/webhook/route.ts:30). It is excluded from the auth proxy matcher (proxy.ts:549 `api/stripe/webhook`) and from CSRF (lib/csrf.ts:19). `runtime = "nodejs"` and `maxDuration = 15` (webhook/route.ts:17, 22).
- **Signature:** reads the raw body with `req.text()`, then calls `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)` with the SDK default tolerance of 300 s (webhook/route.ts:31-46). A missing header or secret returns 400; a bad signature returns 400.
  - FIXTURE-TESTED: tests/unit/sec-d-stripe-webhook-signature.test.ts.
  - INTEGRATION-TESTED with locally-signed events against a real route and test DB: tests/e2e/campaign/stripe-webhooks.spec.ts:158-215 and tests/e2e/campaign/assess/le-3-webhooks-and-billing.spec.ts:72-140. docs/runbooks/GO-LIVE-2026-09.md:126 records the stripe-webhooks spec passing on 15 Sep ("13 tests, real signatures, real route, real database").
- **Which secret:** a single `STRIPE_WEBHOOK_SECRET`; there is no separate Connect secret (section 5). The runbook instructs one endpoint with "Connected accounts ticked" and 19 events (docs/runbooks/GO-LIVE-2026-09.md:90-100, status table :124), and a separate live endpoint and secret (:166-176).
- **`event.account` check:**
  - Required. A missing value throws `WebhookRetryableError` and returns **409** (webhook/route.ts:144-146).
  - The tenant is resolved by `tenant.findFirst({ where: { stripeAccountId } })` (:147-150).
  - An account linked to no tenant also returns **409** (:151-154, :1249-1256).
  - Shop and class-pack checkout handlers also require `metadata.tenantId === tenantId` (webhook/route.ts:449-451, :533-535).
  - FIXTURE-TESTED (tests/unit/stripe-webhook-handlers.test.ts:1005-1053) and INTEGRATION-TESTED with local signing (stripe-webhooks.spec.ts:217-252).
- **Livemode:** **not checked anywhere.** Grep for `livemode` in app/ and lib/ finds nothing. The only separation between test and live is which endpoint secret is deployed.
- **Event types handled** (single list, lib/stripe/handled-events.ts:24-50): `customer.subscription.deleted|updated`, `invoice.payment_failed|payment_succeeded|voided`, `checkout.session.completed|expired`, `payment_intent.processing|succeeded|payment_failed`, `mandate.updated`, `charge.refunded`, `customer.deleted`, `payment_method.detached`, `charge.dispute.created|updated|closed`, `account.updated`, `account.application.deauthorized`. Branches are at webhook/route.ts:180, 194, 255, 359, 437, 610, 620, 630, 726, 783, 819, 866, 878, 910-913, 1112, 1144, 1182.
- **Unhandled types:** acknowledged with 200 and **not claimed** (webhook/route.ts:48-56).
- **Unknown or unlinked account:** 409, and Stripe retries. Stripe's retry window is finite; S3 should confirm its length. The consequences:
  - Platform-account events (no `account`) are never processed.
  - **After an in-app disconnect** (which nulls `stripeAccountId`, disconnect/route.ts:42), **every later event from that account returns 409 until Stripe gives up.** That includes the `account.application.deauthorized` event that disconnect itself triggers, and events for MatFlow-created subscriptions still billing there.
  - The same applies to the old account after a silent replace (section 6).
  - Persistent 409s can get the endpoint flagged by Stripe (S3 to confirm the policy).
- **No `event.created` ordering check** (section 13).

## 13. Duplicate and stale handling

- **Ledger:** `StripeEvent { id, eventId @unique, type, processedAt }` (prisma/schema.prisma:913-918). It has no tenantId, no status or processed flag, no payload and no error column.
- **Claim plus process in one transaction:** `tx.stripeEvent.create` is the first statement inside `withRlsBypass(async tx => ...)` (webhook/route.ts:136-138, 1239). Any throw rolls the claim back. A P2002 on the claim means a duplicate and returns 200 `alreadyProcessed` (:1243-1245). Two concurrent deliveries of the same id serialise on the unique index: the second sees P2002 once the first commits, or proceeds if the first rolls back.
  - FIXTURE-TESTED: stripe-webhook-handlers.test.ts:1055-1123.
  - INTEGRATION-TESTED with local signing: stripe-webhooks.spec.ts:274-309 "a redelivered event is processed exactly once"; a0-4-money.spec.ts:476.
  - Test-mode redelivery was replayed in docs/readiness/STRIPE-LIFECYCLE-EVIDENCE-2026-09-24.md (row "Redelivery").
- **Side effects happen after commit and are not durable.** Emails and audit rows are queued during the transaction and dispatched fire-and-forget after commit (webhook/route.ts:1276-1281). If the function dies between commit and dispatch, the event is recorded as processed and the email or audit row is lost. There is no outbox. The `account.updated` status refresh is also fire-and-forget after commit (:1289-1292).
- **Network before the transaction:** the `invoice.*` and `mandate.updated` branches call Stripe before opening the transaction (webhook/route.ts:87-125), inside a 15 s `maxDuration`. A failure falls back to null ids (FIXTURE-TESTED, stripe-webhook-handlers.test.ts "still records the payment when Stripe cannot resolve the ids").
- **Ordering:**
  - There is **no general `event.created` or `previous_attributes` staleness check**.
  - The only guards: `customer.subscription.updated` and `payment_intent.succeeded` will not resurrect a cancelled member (webhook/route.ts:752-756; tests at stripe-webhook-handlers.test.ts:974-1003); `payment_intent.payment_failed` leaves a settled payment alone (stripe-webhooks.spec.ts:350); disputes do not resurrect a refunded payment (test B5, stripe-webhook-handlers.test.ts:768).
  - **Gap:** `invoice.payment_failed` unconditionally sets `Member.paymentStatus = "overdue"` and upserts the Payment row to `failed` (webhook/route.ts:263-288). A failed attempt delivered **after** the success for the same invoice (a retried payment) flips a paid member back to overdue and a succeeded row to failed. Likewise, an out-of-order `subscription.updated` (past_due after active) for a non-cancelled member is applied as-is.
- **Idempotency keys on Stripe calls:**

  | Call | Key | Status |
  |---|---|---|
  | create-subscription | `matflow_sub_<memberId>_<requestId>`, requestId required (app/api/stripe/create-subscription/route.ts:83-88; lib/stripe/subscriptions.ts:123) | FIXTURE-TESTED: create-subscription-duplicate-guard.test.ts, member-subscribe-duplicate-guard.test.ts |
  | ad-hoc charge | `matflow_adhoc_<memberId>_<requestId>` (charge/route.ts:165) | |
  | refund | `matflow_refund_<paymentId>_<amount>_<alreadyRefundedLocal>` (refund/route.ts:190) | FIXTURE-TESTED: refund-lock-and-validation.test.ts, refund-atomicity.test.ts |
  | migration create | `matflow_migrate_<memberId>`, plus metadata recovery beyond the roughly 24 h key lifetime (migrate-memberships.ts:634-671) | |
  | manual (cash/bank) payments | no Stripe call; DB `@@unique([tenantId, requestId])` (schema.prisma:1182-1186; app/api/payments/manual/route.ts:66, :219-228) | FIXTURE-TESTED: manual-payment-idempotency.test.ts. INTEGRATION-TESTED: a0-4-money.spec.ts:240 "the same requestId twice writes one row; two at once write one row" |

  **No key** on `customers.create`, `checkout.sessions.create`, `products.create`, `prices.create` or `subscriptions.update`.
- **Crash mid-handler:** the transaction rolls back, Stripe redelivers, and processing is clean (design at webhook/route.ts:129-135). A crash after commit loses only the post-commit side effects (above).
- **Retention:** the StripeEvent rows are pruned at 90 days by the retention cron (app/api/cron/retention/route.ts:78, :294-297). That cron is gated off (section 14).

## 14. Recovery

- **No durable failed-event state.** A failed event leaves **no row**, because the claim is rolled back. It exists only as a Stripe retry, a `console.error`, and a Sentry `captureException` for 500s (webhook/route.ts:1261-1270). A 409 retry gets only a `console.warn`, **not Sentry** (:1250-1255).
- **No replay tool in the app.** The reconcile module says so itself: "raises it to Sentry + the logs so an operator can resend it from the Stripe dashboard. (Auto-reprocessing is a deliberate follow-up...)" (lib/stripe/reconcile.ts:10-12).
- **Reconciliation** (lib/stripe/reconcile.ts:49-135):
  - For each tenant with `stripeConnected: true` and an account id (:67-72), it lists the account's events from the last 72 h (:37, :83-86) and reports handled-type event ids missing from StripeEvent to Sentry and the logs (:100-116).
  - It is detection only.
  - **It skips tenants with `stripeConnected: false`**, so it cannot see drops for a deauthorised club.
  - It compares event ids only. It does **not** compare state (member paymentStatus against subscription status, or the Payment ledger against charges).
  - Status: IMPLEMENTED. **Not tested**: tests/integration/cron-smoke.test.ts:74-75 mocks `runStripeReconciliation`, and no unit test exercises its logic. The handled-list sharing is FIXTURE-TESTED (stripe-webhook-handlers.test.ts "the handled-event list is one list").
- **Scheduling:**
  - vercel.json crons are `monthly-reports`, `retention` and `class-instances` (vercel.json:3-16). **`/api/cron/stripe-reconcile` is not scheduled** (confirmed).
  - Its header comment claims "Vercel's Hobby plan allows 2 cron entries and this project already uses both" (app/api/cron/stripe-reconcile/route.ts:4-8). That is stale: vercel.json lists three.
  - Reconciliation runs as the first step of `/api/cron/retention` (app/api/cron/retention/route.ts:234-240), but only **after** two gates:
    1. `CRON_SECRET` must be set (:175-178).
    2. `RETENTION_CRON_ENABLED` must be exactly `"true"`, or the call must be a `?dryRun=1` (:192-197).
  - docs/security/FINDINGS.md:36 (SF-17) records CRON_SECRET **unset in production** ("Stripe reconciliation ... never run[s]"). FINDINGS.md:33 (SF-14, as of 11 Oct 17:15 UK) records "CRON_SECRET is NOT set on any Vercel environment (cron routes answer 503)". The plan is "do not set CRON_SECRET in production (checklist step 5, retention gate)". FINDINGS.md:146 (SF-127) records the retention gate defaulting OFF.
  - **Net: in production today the reconciliation never runs.** Even once CRON_SECRET is set, it stays coupled to the retention kill-switch. Status: MISSING operationally.
- **How an owner or operator sees a mismatch:**
  - No owner surface shows webhook health, failed events or drift. A grep of app/dashboard and components/dashboard for StripeEvent or reconcile finds only TeamUp import reconciliation.
  - The operator page app/admin/billing/page.tsx:29-64 shows failed payments (7 and 30 days), open and lost disputes, and a count of active tenants with `stripeConnected: false` ("stripeBroken"). Nothing about dropped events.
  - The owner learns of trouble only through emails (payment failed, chargeback, Stripe disconnected), which are themselves post-commit fire-and-forget.
  - The connection-health endpoint is owner-only JSON (app/api/stripe/connect/health/route.ts:39-40), not a page.

## 18. Outage and disconnect

- **Stripe API down:**
  - Request paths catch the error and return 500 or 502 to the caller. Examples: lib/stripe/subscriptions.ts:207-210, where `err.message` is returned as the response error via apiError, which redacts per lib/api-error.ts:117; member/checkout/route.ts:312-314.
  - The ad-hoc charge separates a decline from an unknown outcome and records an unknown outcome as a `pending` Payment (app/api/members/[id]/charge/route.ts:180-215). FIXTURE-TESTED: charge-outcome-classification.test.ts, card-charge-guards.test.ts.
  - Refund: a refund that succeeds followed by a subscription-action failure is logged and reported (refund/route.ts:255-270).
  - `ensureCanAcceptCharges` fails **closed** on generic errors, but only when the cache is stale (lib/stripe-account-status.ts:85-94, :143-146).
  - tests/unit/sec-f-provider-outage.test.ts covers a **database** outage (rate limiter, audit writes, lines 78-120), **not Stripe**. No Stripe-outage test exists. Status: IMPLEMENTED in part; Stripe-outage tests MISSING.
- **`account.application.deauthorized`:**
  - Handled at webhook/route.ts:1182-1238. It sets `stripeConnected=false`, stamps `stripeAccountStatus.chargesEnabled=false` with `disabledReason: "deauthorized"`, **keeps `stripeAccountId`** (deliberately, :1188-1190), audits `stripe.account.deauthorized`, and emails the owners (`stripe_disconnected_owner`).
  - FIXTURE-TESTED: stripe-webhook-handlers.test.ts "account.application.deauthorized". INTEGRATION-TESTED with local signing: stripe-webhooks.spec.ts:434-460.
  - **Not test-mode or production evidenced.** STRIPE-LIFECYCLE-EVIDENCE-2026-09-24.md "Not covered" says it "cannot be produced on a Custom test account by API".
- **Fail-open path after deauthorisation:** risk HIGH, needs a run.
  1. The deauthorised stamp has `refreshedAt = now` (webhook/route.ts:1206). After 24 h, `ensureCanAcceptCharges` treats it as stale and calls `accounts.retrieve` on an account the platform no longer has access to (lib/stripe-account-status.ts:143-147).
  2. stripe-node maps **any HTTP 403 to `StripePermissionError`** (node_modules/stripe/cjs/Error.js:24-25).
  3. `refreshStripeAccountStatus` treats `StripePermissionError` as "platform key lacks a read scope" and **fails OPEN** with `chargesEnabled: true` (lib/stripe-account-status.ts:68-84).
  4. The webhook comment (webhook/route.ts:1191-1196) knows the branch fails open but protects only the first 24 h.
  5. The shop checkout then checks only `tenant.stripeAccountId` (present) and `acceptCheck.ok` (now true), and passes `stripeAccount` **only if `stripeConnected`**, which is false. **The Checkout Session is therefore created on MatFlow's platform account** (app/api/member/checkout/route.ts:194-221, :294). The member would pay MatFlow, not the gym. The resulting `checkout.session.completed` has no `account`, so the webhook returns 409 and never fulfils the order.
  6. Whether Stripe returns 403 for `accounts.retrieve` on a revoked Standard account is **UNKNOWN**. It needs a test-mode run.
  7. Other routes pass `stripeAccount` unconditionally, so they would hit the revoked account and fail rather than mis-route: class-pack buy (class-packs/buy/route.ts:78 requires `stripeConnected`), create-subscription (route.ts:55 requires `stripeConnected`), and ad-hoc charge (charge/route.ts requires only `stripeAccountId`, with no `stripeConnected` or `ensureCanAcceptCharges`).
- **Effect on subscriptions:**
  - MatFlow-created subscriptions live on the gym's account and keep billing after a deauthorise or disconnect (Standard). MatFlow stops receiving their events.
  - After a deauthorise (id kept), events from a revoked account are not delivered; S3 to confirm. After an in-app disconnect (id nulled), they get 409.
  - Member `paymentStatus` then freezes at its last value. Check-in or access effects follow from paymentStatus (lane S2/S16).
  - No code warns at disconnect about live subscriptions.
- **Reconnection:**
  - Same account: OAuth again rewrites `stripeAccountId` and `stripeConnected=true`. It does **not** clear the `disabledReason: "deauthorized"` stamp, so the gate stays closed until the next `account.updated` or the 24 h staleness refresh (callback/route.ts:62-67 writes only two fields). That is safe but surprising.
  - Different account: see the replace gap in section 6.

## 1. What exists, per workflow

Evidence tiers in the "Test-mode / production" column:
- **TM-script**: a script in scripts/ drove real Stripe **test mode**. Events were fetched from Stripe and replayed into the local route, signed with the local secret. Stripe itself never delivered to a deployed endpoint.
- **PRODUCTION-EVIDENCED**: a live run. I found **no** document recording a live-mode connected account, a live payment, or a live webhook delivery. docs/readiness/TEN-CLUB-AUDIT-2026-09-25.md:221 lists "Stripe live platform (keys, Connect client id, live webhook endpoint)" as blocked on Noe.

| Workflow | Code | Tests | Test-mode / production evidence |
|---|---|---|---|
| Onboarding: OAuth connect start + callback | IMPLEMENTED (app/api/stripe/connect/route.ts; connect/callback/route.ts) | Owner-only refusal: e2e campaign (le-3-webhooks-and-billing.spec.ts:402). State, HMAC, expiry and code exchange: **MISSING** | The OAuth handshake cannot run locally (redirect registered only for matflow.studio, docs/runbooks/GO-LIVE-2026-09.md:123). The test branch's account `acct_1U5G...` was "created by a genuine OAuth handshake at some point", undated, with onboarding unfinished (GO-LIVE-2026-09.md:131-137). No dated OAuth run on record. Production: none. |
| Connection health / readiness | IMPLEMENTED (app/api/stripe/connect/health/route.ts; lib/stripe/key-mode.ts) | FIXTURE-TESTED (stripe-connect-health-readiness.test.ts, stripe-key-mode.test.ts) | none |
| Account status gate (`ensureCanAcceptCharges`) | IMPLEMENTED (lib/stripe-account-status.ts:132-149), fails **open** on 403 (:68-84) | FIXTURE-TESTED (stripe-account-status.test.ts) | none |
| Disconnect | IMPLEMENTED (app/api/stripe/disconnect/route.ts) | e2e "no account" refusal only (le-3...spec.ts:413). Deauthorise call: MISSING | none |
| Deauthorised webhook | IMPLEMENTED (webhook/route.ts:1182-1238) | FIXTURE-TESTED; INTEGRATION-TESTED with local signing (stripe-webhooks.spec.ts:434) | Not producible on the Custom test account (STRIPE-LIFECYCLE-EVIDENCE-2026-09-24.md "Not covered") |
| Shop checkout (Checkout Session, mode payment) | IMPLEMENTED (app/api/member/checkout/route.ts:61-315). Order persisted before Stripe (:243-262) | FIXTURE-TESTED (checkout-order-before-stripe.test.ts, member-checkout-payment-rail.test.ts). Webhook completion INTEGRATION-TESTED with local signing (stripe-webhooks.spec.ts:371-432 expired; unit stripe-webhook-handlers.test.ts:639-711 completed) | No real card checkout recorded. Production: none |
| Class-pack checkout | IMPLEMENTED (app/api/member/class-packs/buy/route.ts) | Fulfilment webhook INTEGRATION-TESTED with local signing (a0-4-money.spec.ts:476); partial-refund packs (refunds-packs.spec.ts:349-457; partial-refund-keeps-pack-credits.test.ts) | none recorded for a real card |
| Subscription create, **staff** (`/api/stripe/create-subscription`, UI components/dashboard/SubscribeDrawer.tsx:120) | IMPLEMENTED, but **cannot collect the first payment** (see finding F1) | FIXTURE-TESTED (create-subscription-duplicate-guard.test.ts, stripe-subscription-confirmation-secret.test.ts, subscribe-drawer.test.tsx); "inert rail" e2e (le-3...spec.ts:373) | The 2026-08-18 notes in lib/stripe/subscriptions.ts:141-148 say the secret shape was verified live in test mode. The 24 Sep lifecycle run **bypassed this helper**: scripts/stripe-lifecycle-e2e.mjs:100-101 creates subscriptions directly with `default_payment_method` and `off_session`. |
| Subscription create, **parent for kid** (`start-for-kid`, UI components/member/KidBillingCard.tsx:128) | IMPLEMENTED, same F1 defect. The UI admits "Payment hasn't been taken yet — speak to gym staff" (KidBillingCard.tsx:155-157) | FIXTURE-TESTED (member-self-billing*.test.ts, member-subscribe-duplicate-guard.test.ts) | none |
| Subscription create, **member self** (`/api/member/subscriptions/start`) | IMPLEMENTED. **No UI caller found** (grep `api/member/subscriptions` outside app/api finds only the kid routes) | FIXTURE-TESTED (member-self-billing*.test.ts) | none |
| Subscription create, **migration** (adopt / replace / create) | IMPLEMENTED (lib/stripe/migrate-memberships.ts), off_session with a saved PM, so collection works | FIXTURE-TESTED (migrate-memberships.test.ts); e2e owner-only (le-3...spec.ts:450-510) | TM-script PASS 24 Sep 00:59 (adopt+create) and 21:23 UTC (replace) per docs/readiness/TEN-CLUB-AUDIT-2026-09-25.md:25 and docs/runbooks/TEAMUP-MIGRATION.md:81 (S2 to detail) |
| Subscription change (tier change / proration) | **MISSING.** No `subscriptions.update` with `items` anywhere (section 8 inventory) | n/a | n/a |
| Hold / resume (pause_collection) | IMPLEMENTED (app/api/members/[id]/hold/route.ts:76, resume/route.ts:63) | FIXTURE-TESTED (member-hold.test.ts; webhook pause tests stripe-webhook-handlers.test.ts:1579+) | none |
| Subscription cancel (at period end) | IMPLEMENTED (lib/stripe/subscriptions.ts:222-249). Callers: member cancel, cancel-for-kid, member DELETE (app/api/members/[id]/route.ts:312, :753), child DELETE, operator soft-delete, DSAR erase, tenant purge | FIXTURE-TESTED (member-delete-stripe-cancel.test.ts); e2e tests/e2e/stripe-cancel-on-delete.spec.ts | Cancel-at-period-end then `subscription.deleted`: TM-script PASS 24 Sep 22:20 UTC (STRIPE-LIFECYCLE-EVIDENCE-2026-09-24.md) |
| Ad-hoc card charge (off_session PI) | IMPLEMENTED (app/api/members/[id]/charge/route.ts). **No `payment_method` is passed** (:166-177), only `customer`. Whether Stripe falls back to the customer's default is UNKNOWN (S3) | FIXTURE-TESTED (card-charge-guards.test.ts, charge-outcome-classification.test.ts) | none recorded |
| Refund (full / partial, with subscription action) | IMPLEMENTED (app/api/payments/[id]/refund/route.ts) | FIXTURE-TESTED (refund-atomicity.test.ts, refund-lock-and-validation.test.ts) | TM-script PASS 24 Sep 22:20 UTC: app refund route, full refund + `cancel_at_period_end` (STRIPE-LIFECYCLE-EVIDENCE-2026-09-24.md "Refund via the app") |
| Manual cash / bank payments | IMPLEMENTED (app/api/payments/manual/route.ts) | FIXTURE-TESTED (manual-payment-*.test.ts); INTEGRATION-TESTED (a0-4-money.spec.ts:240-314) | not Stripe |
| Customer portal (member, guardian) | IMPLEMENTED (app/api/stripe/portal/route.ts; app/api/member/family/[id]/billing/portal/route.ts) | FIXTURE-TESTED (member-self-billing*.test.ts) | none |
| Webhooks (19 types) | IMPLEMENTED (section 12) | FIXTURE-TESTED (stripe-webhook-handlers.test.ts, about 60 cases; sec-d-stripe-webhook-signature.test.ts); INTEGRATION-TESTED with local signing (stripe-webhooks.spec.ts, passed 15 Sep per GO-LIVE-2026-09.md:126; le-3...spec.ts; a0-4-money.spec.ts) | TM-script: real test-mode events replayed and locally signed, 24 Sep (invoice succeeded/failed, dispute created, charge.refunded, subscription.deleted, redelivery). Dispute closed: 25 Sep per TEN-CLUB-AUDIT-2026-09-25.md:24. **No delivery by Stripe to a deployed endpoint is recorded.** |
| Reconciliation | IMPLEMENTED, detection only (lib/stripe/reconcile.ts) | **Logic untested** (mocked in tests/integration/cron-smoke.test.ts:74-75) | **Never runs in production**: CRON_SECRET unset, retention gate off (docs/security/FINDINGS.md:33, :36, :146) |
| Test-mode entitlement run (SEC-090) | n/a | n/a | **NOT RUN / BLOCKED** (docs/security/FINDINGS.md:62, SF-43) |

### Headline findings (S1)

- **F1. In-app recurring subscriptions cannot take their first payment.** Status: HIGH, code-evident; S3 to confirm Stripe semantics.
  1. `createSubscriptionForMember` uses `payment_behavior: "default_incomplete"` and returns `clientSecret` (lib/stripe/subscriptions.ts:124-152, :201-206).
  2. **No client code confirms it.** `@stripe/stripe-js` is never imported. SubscribeDrawer discards `clientSecret` and toasts "Membership created" (components/dashboard/SubscribeDrawer.tsx:131-180). KidBillingCard tells the parent to "speak to gym staff" (KidBillingCard.tsx:155-157).
  3. The subscription therefore stays `incomplete` and Stripe expires it after about 23 h (acknowledged in subscriptions.ts:170-173).
  4. On expiry, `customer.subscription.updated` with `incomplete_expired` maps to `cancelled` (lib/stripe/subscription-status.ts:16), and the webhook sets **`Member.status = "cancelled"`** (webhook/route.ts:751-768).
  5. Net effect: the member is first shown as subscribed, then a day later flipped to cancelled with no payment ever taken.

  Only the migration path (off_session, saved PM) and Checkout Sessions (one-off) can actually collect.
- **F2. Possible platform-account checkout after deauthorisation.** Section 18. The 403 fail-open at lib/stripe-account-status.ts:68-84 combines with the conditional `stripeAccount` at app/api/member/checkout/route.ts:220, :294. Needs a test-mode run.
- **F3. Reconciliation never runs in production, and does state-less id matching only.** Section 14.
- **F4. Webhook handlers act on objects MatFlow did not create.** `subscription.updated` re-points `Member.stripeSubscriptionId` to any subscription on the matched customer (webhook/route.ts:756-766). In-app subscriptions carry no metadata to tell them apart. Section 8.
- **F5. Ordering gap.** A late `invoice.payment_failed` overwrites success with overdue/failed (webhook/route.ts:263-288). Section 13.
- **F6. Replace and disconnect strand webhooks.** Silent re-connect overwrites the account without deauthorising the old one. An in-app disconnect nulls the id, so later events from that account (including its own deauthorise event) get 409 until Stripe stops retrying. Sections 6 and 12.
- **F7. The callback swallows the duplicate-account P2002 as "exchange_failed" and leaves the new Stripe grant in place.** Section 7.
- **F8. Livemode is never checked; one webhook secret only; key-mode policy is enforced only on the health endpoint.** Sections 5 and 12.

## UNKNOWN — needs a run or an owner answer

1. Does Stripe return HTTP 403, and therefore `StripePermissionError` and the fail-open path, for `accounts.retrieve(acct)` after the account has deauthorised the platform? Needs a test-mode run with a Standard account deauthorised from its dashboard. This decides F2.
2. Does a `default_incomplete` subscription for a customer who already has a default payment method still require client confirmation? Is `customer.subscription.updated` (rather than `.deleted`) the event sent on `incomplete` to `incomplete_expired`? Needs a test-mode run of `/api/stripe/create-subscription`. This decides the severity of F1.
3. Does an off_session `paymentIntents.create` with `customer` and no `payment_method` (members/[id]/charge) succeed against the customer's `invoice_settings.default_payment_method`? Needs a test-mode run or S3 docs.
4. Which endpoint the production `STRIPE_WEBHOOK_SECRET` belongs to (Connect endpoint or account endpoint; live or test) and which events it subscribes to. This needs the owner's Stripe dashboard. Nothing in the repo proves a live endpoint exists. docs/readiness/TEN-CLUB-AUDIT-2026-09-25.md:221 says live platform setup was blocked as of 25 Sep.
5. Whether the production `STRIPE_CLIENT_ID` is the live-mode `ca_` and whether its OAuth redirect is registered. Owner dashboard.
6. Production key state: FINDINGS.md:33 (SF-14) says the deployed Stripe key dates from 7 May and matches the leaked prefix. Whether it has been rolled since 11 Oct 17:15 UK is UNKNOWN. Whether it is `rk_live_` with Connect and `accounts_kyc_basic_read` scopes is UNKNOWN; code comments assert `rk_live_` (lib/stripe/key-mode.ts:14-16).
7. Owner decision: should webhooks act on subscriptions and invoices MatFlow did not create (F4), or should handlers filter on MatFlow metadata or the stored `stripeSubscriptionId`?
8. Owner decision: allow replacing a connected account while members have live subscriptions? Require deauthorise of the old account? What happens to the old account's customers and subscriptions (sections 6 and 7)?
9. Owner decision: one Stripe account to many clubs (unique constraint today, section 7). Does a soft-deleted club release its account id? Not found in code; whether the tenant purge hard-deletes the row is unconfirmed.
10. Operational: reconciliation needs its own schedule and secret, decoupled from the retention kill-switch, before any live payments (section 14). That is an owner and plan decision (Vercel plan cron limits).
11. Whether any test-mode run has ever exercised the real OAuth handshake end to end, with a date. GO-LIVE-2026-09.md:131-137 implies it happened once, undated.
12. Stripe's retry window and endpoint-disable policy for persistent 409s (section 12). S3 docs.
