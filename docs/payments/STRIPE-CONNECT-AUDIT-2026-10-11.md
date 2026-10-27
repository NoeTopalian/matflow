# Stripe Connect audit — MatFlow, 11 Oct 2026

Read-only inspection at documentation head `1a36655` (executable candidate `1ca92c0`; production serves `e8afb6a`). No charge, refund, subscription change, production mutation or deployment was made. Three lanes produced the evidence in `evidence/` (S1 code and controls, S2 money and product, S3 official Stripe documentation read on 11 Oct 2026); two headline code findings were re-checked by the coordinator. Status vocabulary: IMPLEMENTED (code present) · FIXTURE-TESTED (unit, mocked) · INTEGRATION-TESTED (real route and test database, locally signed events) · TEST-MODE (script against Stripe test mode, Custom accounts, events replayed locally) · PRODUCTION-EVIDENCED · MISSING · UNKNOWN. Environment variables and green unit tests are never counted as readiness.

**Required outcome:** club owners connect their own Stripe accounts under their own clubs, collect member payments, and MatFlow's payment and membership records stay synchronised. The MatFlow fee is paid by bank transfer and checked manually. Commercial model fixed on 17 Sep 2026: Standard Connect, direct charges, gyms carry their own losses. This audit does not change it.

**Decision context (11 Oct):** Noe deferred member payments through the app "for the moment". This milestone is distinct from Sean's email correction and from the security release; shared dependencies are listed in §22.

---

## The short answer

- **Owners can connect:** partly. The OAuth connect flow exists and is owner-only, but it has never completed on a live account, the live platform setup is unverified, and an account opened inside another platform's onboarding cannot be attached at all.
- **Payments can be collected:** no, not as a product. One-off Checkout (shop, class packs) and the migration path can take money; the in-app recurring membership flow creates subscriptions nobody can pay, so they expire and cancel the member.
- **Synchronisation is reliable:** no. Webhooks are signed, deduplicated and transactional, but the handlers act on objects MatFlow did not create, apply events out of order, check nothing about live mode, and the reconciliation job never runs in production.
- **Ready for a live pilot:** no.

---

## 1. What exists today

| Workflow | Code | Tests | Evidence beyond mocks |
|---|---|---|---|
| OAuth connect start + callback | IMPLEMENTED (`app/api/stripe/connect/route.ts`, `connect/callback/route.ts`) | owner-only refusal only (e2e `le-3-webhooks-and-billing.spec.ts:402`); state/HMAC/expiry/code exchange: MISSING | one undated OAuth handshake on the test branch (`docs/runbooks/GO-LIVE-2026-09.md:131-137`); the 26 Sep customer-journey attempt was refused at the production callback. PRODUCTION: none |
| Connection health | IMPLEMENTED (`connect/health/route.ts`, `lib/stripe/key-mode.ts`) | FIXTURE | none |
| Account-status gate | IMPLEMENTED, fails OPEN on permission errors (`lib/stripe-account-status.ts:68-84`) | FIXTURE | none |
| Disconnect + deauthorised webhook | IMPLEMENTED | FIXTURE; INTEGRATION (locally signed) | not producible on the Custom test accounts used |
| Shop checkout (one-off) | IMPLEMENTED, order persisted before Stripe | FIXTURE; completion INTEGRATION | no real card recorded |
| Class-pack checkout | IMPLEMENTED | FIXTURE; INTEGRATION; pack race DB test | none |
| Recurring subscription, staff / parent / member self | IMPLEMENTED server-side; **first payment cannot be taken in the product** (§9, F1) | FIXTURE | TEST-MODE runs bypassed this path (`scripts/stripe-lifecycle-e2e.mjs:100-101`) |
| Migration (adopt / replace / create) | IMPLEMENTED (`lib/stripe/migrate-memberships.ts`) | FIXTURE (38 cases) | TEST-MODE PASS 24 Sep (adopt+create 00:59, replace 21:23 UTC) on Custom accounts; never against Sean's account |
| Plan change | MISSING (no `subscriptions.update` with items) | — | — |
| Hold / resume, cancel at period end | IMPLEMENTED | FIXTURE; e2e cancel-on-delete | TEST-MODE 24 Sep (cancel → deleted) |
| Ad-hoc card charge | IMPLEMENTED; sends no `payment_method` (`app/api/members/[id]/charge/route.ts:166-177`) | FIXTURE | none |
| Refund (full/partial + subscription action) | IMPLEMENTED | FIXTURE | TEST-MODE 24 Sep |
| Manual cash/bank payments, desk orders | IMPLEMENTED | FIXTURE; INTEGRATION | not Stripe |
| Customer portal (member, guardian) | IMPLEMENTED | FIXTURE | none |
| Webhooks (19 types) | IMPLEMENTED (`app/api/stripe/webhook/route.ts`) | FIXTURE (~60 cases); INTEGRATION (locally signed, 15 Sep) | TEST-MODE replay 24–25 Sep; **no delivery by Stripe to a deployed endpoint recorded** |
| Reconciliation | IMPLEMENTED, detection only (`lib/stripe/reconcile.ts`) | logic untested (mocked) | **never runs in production** (§14) |

Production evidence of any kind: **none**. Total BJJ production on 7 Oct: 0 payments, 0 Stripe ids, every member billed by TeamUp (count held privately). All behavioural evidence is test mode on Custom accounts created by API, events replayed by script into a local server. None used the Standard OAuth flow the product ships.

## 2. How a club connects its account

OAuth only: `connect.stripe.com/oauth/authorize` with `scope=read_write`, no `redirect_uri` (the dashboard default is used), code exchanged with `oauth.token`, `stripe_user_id` stored (`connect/route.ts:25-32`, `callback/route.ts:56-67`). No Account Links, Account Sessions or `accounts.create` anywhere. An owner can connect an **existing** account; MatFlow never creates one (Stripe's hosted page lets the owner sign up). Provider side: OAuth is the only documented way to connect an account the owner already has, and Stripe now marks the Standard type and OAuth as legacy ("not recommended for new Connect platforms") while keeping them functional. **Limit:** since June 2021 a `read_write` OAuth platform cannot connect to a Standard account that was created inside another platform's onboarding; Stripe steers the owner into a new, empty account. Whether Sean's account was opened directly at stripe.com is unknown (§20 Q-S1).

## 3. What platform setup remains

Provider requirements (Stripe dashboard, live mode, owner only): the platform profile at `settings/connect/platform-profile` (the docs name it as the entry step for any Connect platform; the two "platform is responsible" screens declined on 17 Sep are consistent with Standard and are not the same thing as the profile being submitted — its live state is unverified); OAuth enabled in live Connect settings with the live `client_id`; the production HTTPS `redirect_uri` registered exactly as the callback URL; a live **Connected accounts** webhook endpoint pointing at `/api/stripe/webhook` with the 19 handled events and its own signing secret; the restricted live key holding the scopes the code uses (OAuth exchange, accounts read, connected-account writes). Missing application code (not provider): see §21 plan items P1–P6.

## 4. Where the money goes

Every money call passes `{ stripeAccount }`: direct charges on the club's account. No `application_fee`, `transfer_data`, `on_behalf_of`, transfer or payout code exists, so **no platform fee is taken in code**, matching the bank-transfer model. Per the docs: the club is merchant of record, pays Stripe processing, Billing and dispute fees, and refunds and disputes debit the club's balance. One exception, code-certain: shop checkout passes `stripeAccount` only when `stripeConnected` is true (`app/api/member/checkout/route.ts:220, :294`); after a deauthorisation the id is kept and the flag cleared, and once the 24-hour status cache expires a permission error on `accounts.retrieve` fails open (`lib/stripe-account-status.ts:68-84`), so a member could pay **MatFlow's own account** with an order that is never fulfilled (F2). Whether Stripe answers a revoked account with a permission error needs a test-mode run.

## 5. Which credentials are required

| Credential | Purpose | State |
|---|---|---|
| `STRIPE_SECRET_KEY` (platform; `rk_live_` in production per code comments) | every API call; ~49 inline `new Stripe(...)` sites, no shared factory | deployed value dates from 7 May and matches the leaked prefix (SF-14); **roll outstanding** as of this audit; scopes UNKNOWN |
| `STRIPE_CLIENT_ID` (OAuth `ca_`) | connect and disconnect | live id and redirect registration UNKNOWN; mode never compared with the key's |
| `STRIPE_WEBHOOK_SECRET` (one) | signature verification | must belong to the single Connected-accounts endpoint in each mode; a second endpoint at the same URL would fail; which endpoint it belongs to UNKNOWN |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | boolean only (shop rail); never passed to Stripe.js | `.env` holds a differently named variable no code reads |
| Connected-account ids | `Tenant.stripeAccountId @unique` | none live |
| `CRON_SECRET` | reconcile cron | not set in production; the local value matches the leak and is to be deleted locally |

Outstanding checks: roll the Stripe key (containment checklist step 7, immediate expiry since nothing depends on it), confirm the restricted key's scopes via the owner health endpoint on production, record which live endpoints and secrets exist.

## 6. How the connection is authorised

Owner role checked inline in connect, callback and disconnect (not via `requireOwner`); support sessions refused; owner TOTP enrolment enforced centrally in production; **no per-action step-up** on connect, replace or disconnect; disconnect has a same-origin check. The OAuth `state` is HMAC-signed with the raw `AUTH_SECRET`, tenant-bound, 15-minute expiry, constant-time compare — but **not bound to the user and not single-use**, and the code exchange has **no test**. The callback cannot verify the account "belongs" to the club; OAuth proves only that the person at Stripe authorised it. Replay: a fresh Stripe `code` is still required, and Stripe revokes the connection if a code is consumed twice. Cross-club: the callback writes only the session tenant; no admin route writes an account id.

## 7. How accounts map to clubs

`Tenant.stripeAccountId @unique` (migration `20260628004500`). The database refuses one account on two clubs; the code does not pre-check, swallows the unique-violation as `exchange_failed` and **leaves the fresh OAuth grant in place with no tenant recording it** (`callback/route.ts:81-83`, F7). Re-running OAuth while connected silently overwrites the id without deauthorising the old account, without clearing the cached status, and leaves members pointing at customers on the old account (F6). Policy needed: one club per Stripe account (a gym with two clubs must use Locations or two accounts); whether a soft-deleted club releases its id is unconfirmed.

## 8. What MatFlow can access after connection

Everything `read_write` allows on the club's account (create/update customers, charges, invoices, subscriptions; refund; read), by the docs. Limits: MatFlow **cannot update or cancel a subscription another platform created**, cannot add fees to invoices it did not create, and cannot reach payment methods held on a different Stripe account (for example TeamUp's own). The code reads foreign objects deliberately in the migration preview (`customers.list` with subscriptions) and **implicitly in every webhook handler**, which matches by customer only and never filters on MatFlow metadata; in-app subscriptions carry no metadata at all (F4).

## 9. Which payment types are supported

| Type | Card path | Status |
|---|---|---|
| Recurring membership | subscription via `default_incomplete`; client secret returned and **never consumed** (no Stripe.js in the product; `components/dashboard/SubscribeDrawer.tsx:131-180`; `KidBillingCard.tsx:138-157` tells the parent to "speak to gym staff") | server IMPLEMENTED; end-to-end MISSING (F1) |
| Plan change | — | MISSING |
| Drop-in | desk only | card MISSING |
| Class packs | Checkout Session; pack created by webhook | IMPLEMENTED; cash sale MISSING |
| Shop | Checkout Session or desk order | IMPLEMENTED (see §4 defect) |
| Events, private lessons | — | MISSING (no model) |

Product decisions before a first release: scope (memberships only, or packs and shop too); who mints tier prices (today an owner pastes a `price_…` id that nothing validates against the tier; migration mints correctly via `lib/stripe/tier-price.ts`); whether staff may subscribe a member to any price or only a tier's; whether plan change is cancel-and-restart; whether shop card checkout is offered at all until F2 is fixed.

## 10. How payments are linked to people

`Member.stripeCustomerId` (unique per tenant, partial index), `Member.stripeSubscriptionId`, `Payment.stripeInvoiceId` / `stripePaymentIntentId` unique, `stripeChargeId` indexed. Customers are created lazily on the club's account with the member's email and name and **never updated afterwards** (no `customers.update`). Guardian-paid children get a **separate customer per child** on the child's synthesised no-inbox address; no code attaches the parent's payment method (the comment claiming it defaults to the parent's card is wrong). Duplicates: a lost race leaves an orphan Stripe customer; migration matching is by lower-cased email with silent preference for the live-subscription customer; the cutover manifest refuses email as proof of payer. Ambiguity is resolved by the owner in the preview, not by code. After a reconnect to a different account, member ids point at customers that no longer exist and nothing detects it.

## 11. What is authoritative for each field

| Field | Source as coded | Conflict |
|---|---|---|
| Card payment status, amount, currency, refunds, disputes | Stripe, via webhooks | shop Payment row uses the Order total, Order currency defaults GBP |
| Subscription state | Stripe | `customer.subscription.updated` is **not scoped** to the member's own subscription: it re-points `stripeSubscriptionId` to whatever changed on that customer (`webhook/route.ts:756-766`) |
| `Member.paymentStatus` | mixed: Stripe for subscribers, MatFlow for desk members | a manual cash payment flips a Stripe-billed member to paid with no warning (`payments/manual/route.ts:190-193`) and is overwritten by the next event |
| Membership tier | MatFlow only | never set on subscribe, never updated from a Stripe plan change |
| `Member.status` | MatFlow, Stripe cancels only | an abandoned first payment (`incomplete_expired`) cancels the **whole member** (`lib/stripe/subscription-status.ts:16`; `webhook/route.ts:751-768`) |
| Holds | MatFlow initiates, mirrored both ways | — |
| Check-in access | derived from paymentStatus + tier + packs (`lib/checkin.ts:423-442`) | kiosk and card doors never require coverage |

## 12. How synchronisation works

One endpoint, raw body, `constructEvent` with the single secret, 300 s tolerance; `event.account` required and resolved to a tenant (409 otherwise); unhandled types acknowledged without being claimed. Provider facts: member payment events arrive **only** on a Connected-accounts endpoint; each endpoint and each mode has its own secret; production Connect endpoints receive **both live and test events** and Stripe recommends checking `livemode` — **the code never checks `livemode`** and the key-mode policy is enforced only on the health endpoint (F8). The live endpoint's API version governs payload shape, and the handler assumes the `dahlia` Invoice shape; the live endpoint's version is unknown.

## 13. What prevents duplicate or stale processing

Good: `StripeEvent.eventId @unique` claimed inside the same transaction as the handler, so a duplicate returns 200 `alreadyProcessed` and a crash mid-handler rolls the claim back for Stripe's retry (FIXTURE and INTEGRATION tested). Deterministic idempotency keys on subscription create, ad-hoc charge, refund and migration; manual payments deduplicated on `requestId` in the database. Gaps: **no ordering check** — a late `invoice.payment_failed` overwrites a success with overdue/failed (`webhook/route.ts:263-288`, F5); no keys on `customers.create`, `checkout.sessions.create`, `products.create`, `prices.create`; post-commit emails, audit rows and the status refresh are fire-and-forget (no outbox); the OAuth token exchange is not idempotent and the callback has no single-use guard; the SDK's automatic retry key covers one call only, as the docs state.

## 14. How synchronisation recovers

There is **no durable failed-event state** (a failed claim leaves no row), **no replay tool** in the app, and no owner or operator view of drift. `lib/stripe/reconcile.ts` lists each connected club's events for 72 hours and reports missing ids to Sentry and logs — detection only, id-matching only, skips deauthorised clubs, logic untested. It is not scheduled in `vercel.json`; it runs only as the first step of the retention cron behind `CRON_SECRET` (unset in production) and `RETENTION_CRON_ENABLED` (off by default). **Net: reconciliation never runs in production** (F3). Stripe's own guidance makes a reconcile job mandatory: retries last three days, order is not guaranteed, duplicates happen, events can fail to be created, and the Events API only covers 30 days.

## 15. What owners can manage inside MatFlow

Connect/disconnect (owner), create plan price (owner, **no audit, no idempotency**), tiers (owner, audited), class packs (owner, audited, Stripe objects created before the DB row), start subscription for a member (owner or manager, **no audit**), cancel (owner/manager/admin, audited), hold/resume (owner, audited), refund (owner, audited, idempotent, rate-limited), ad-hoc charge (owner, audited, idempotent, 5/hour), manual cash/bank/comp payment (owner or manager, audited, idempotent), desk order mark-paid (owner or manager, audited, reason required; **accepts card orders**, which then never reach the ledger), payment history (club: owner; per member: owner, manager, admin **and coach**), outstanding/chase, CSV export (audited, capped), saved-card view, member and guardian portal, TeamUp migration (owner, audited per member). No per-action step-up on any club money action; step-up exists only on operator routes. Desk-paid orders create no Payment row, so desk shop revenue is absent from the ledger and the export.

## 16. How money and access states are distinguished

| State | Mapping | Access effect | Decision needed |
|---|---|---|---|
| subscription `incomplete` | unmapped; previous paymentStatus kept | a previously paid member reads as an active subscriber | set `pending` on create? |
| `requires_action` on renewal | event not handled; no hosted-invoice link surfaced | nothing until a failure arrives | — |
| `incomplete_expired` | member `cancelled` | whole record cancelled, even a desk payer | cancel the link only? |
| `processing` (Bacs) | `pending` | subscriber refused at self check-in | — |
| `past_due` / failed renewal | `overdue`, failed Payment, emails | self check-in refused; kiosk and card admit | refuse on first failure or after retries? |
| cancelled | `cancelled` | no coverage | — |
| partial / full refund | Payment adjusted; pack credits revoked | none | — |
| dispute open / lost | Payment `disputed`/`refunded`, member `overdue` | self check-in refused; lost leaves overdue until staff act | who clears it? does a lost chargeback end membership? |
| payout states | not modelled | none | — |

## 17. How TeamUp billing coexists or migrates

Evidence of the current provider: every document asserts TeamUp bills through Sean's own Stripe account, but **no document records anyone looking inside Sean's account**, and his Stripe sign-in has not happened. Bridge phase: `Member.billedBy = "teamup"` and `refuseIfBilledElsewhere` on every card path (FIXTURE-tested); manual cash is not refused and flips paymentStatus for a member TeamUp owns. Transition engine: `replace` is the default — a MatFlow subscription on the same customer and saved method, anchored to the old `current_period_end`, no proration, nothing charged at creation; `create` for a saved method without a subscription; `adopt` gated off. Renewal dates are preserved by the anchor (TEST-MODE evidence 24 Sep). **Double collection is prevented only by Sean ending each TeamUp membership in time**; nothing alerts automatically. Code defect inside the replace window: one customer carries two live subscriptions, and the unscoped `subscription.updated` handler can re-point the member to TeamUp's subscription or cancel the member while MatFlow's replacement keeps billing (F4). Cannot be assumed: that TeamUp's subscriptions are on Sean's account rather than TeamUp's; that ending a TeamUp membership cancels its subscription, and when; that members' card and Bacs authorisations cover a new subscription created by different software; payer identity for children and shared emails; the 16 tier prices (unconfirmed by Sean; `replace` bills the tier's minted price, not the old one). Per the docs, MatFlow cannot cancel subscriptions TeamUp created as a platform; Sean or TeamUp must.

## 18. If Stripe is unavailable or disconnected

API outage: routes return 500/502 with redacted messages; the ad-hoc charge separates a decline from an unknown outcome and records `pending`; the status gate fails closed on generic errors only when its cache is stale; **no Stripe-outage test exists** (`sec-f-provider-outage` covers the database). Loss of authorisation: `account.application.deauthorized` sets `stripeConnected=false`, keeps the id, stamps the status closed for 24 hours, audits and emails owners. Per the docs, **subscriptions keep running on the club's account after a disconnect**; MatFlow loses API and event access, so hold, cancel-on-delete and refund silently stop working for that club and member paymentStatus freezes; nothing warns at disconnect about live subscriptions. In-app disconnect nulls the id, so every later event from that account, including its own deauthorise event, gets 409 until Stripe stops retrying (F6). Reconnect to the same account restores access to the same objects (docs inference); reconnect to a different account strands member ids.

## 19. What the admin hub should expose

Today: a read-only billing rollup (labels every currency GBP, mixes cash with card, flags a TeamUp-bridge club as "Stripe disconnected"), the connected flag per tenant, no secrets, no financial edits (soft-delete sets cancel-at-period-end behind step-up and audit). Missing: per-club connection health (account id, charges/payouts enabled, requirements due, last `account.updated`), webhook health (last event per club, 409/500 counts, last reconcile result), failed-event list with an audited **replay** action, Payment-versus-Stripe and member-versus-subscription drift report, and an audited "mark billing unmanaged" action for disconnected clubs. Keep: no generic record editing, no key material, every financial override behind step-up with a reason and an audit row.

## 20. What proves readiness

Sandbox acceptance (a test-mode Standard account connected through the real OAuth flow, a deployed Connect endpoint receiving real deliveries, at least two isolated clubs): connect, replace-refused-while-live, disconnect and reconnect; first payment of a recurring membership completed in the product (adult, and guardian for a child); failed renewal → overdue → retry success without regression; refund full and partial; a redelivered and an out-of-order event; a deauthorised club whose shop checkout is refused rather than misrouted; reconciliation finding a dropped event and the replay fixing it; cross-club: events for club A never touch club B. Only after that, and only with explicit authorisation: a live pilot with Sean's account as the first connection, one real membership, one real failed payment, one real refund, Sean confirming each in his own dashboard.

---

## 21. Capability-and-evidence table

| Capability | Status | Strongest evidence | Gap to live |
|---|---|---|---|
| Owner connects an existing Stripe account (OAuth) | IMPLEMENTED | undated test-branch handshake | no test of state/exchange; live client id, redirect, platform profile unverified; platform-created accounts cannot attach |
| Replace / disconnect | IMPLEMENTED | FIXTURE, INTEGRATION (local signing) | silent overwrite; stranded events after disconnect; swallowed duplicate-account error |
| One-off card checkout (shop, packs) | IMPLEMENTED | INTEGRATION (local signing) | platform-account misroute after deauthorisation (F2); no real card ever |
| Recurring membership, in product | MISSING end-to-end | TEST-MODE bypassed it | no client confirmation (F1); member cancelled on expiry |
| Migration from existing subscriptions | IMPLEMENTED | TEST-MODE PASS 24 Sep on Custom accounts | never on a Standard account or Sean's; unscoped handler breaks the replace window (F4) |
| Refund, hold, cancel | IMPLEMENTED | TEST-MODE 24 Sep | none beyond test mode |
| Webhook verification and dedup | IMPLEMENTED | INTEGRATION 15 Sep | no livemode check; single secret; no ordering (F5, F8) |
| Reconciliation and replay | detection only / MISSING | — | never runs in production (F3); no failed-event store; no replay |
| Owner and operator visibility | partial | — | no sync or drift views |
| Platform fee | none in code (by design) | search | matches bank-transfer model |
| Any live-mode behaviour | PRODUCTION-EVIDENCED: none | — | everything |

## 22. Blockers, dependencies and owners

| Blocker | Depends on | Owner |
|---|---|---|
| Deployed Stripe key is the leaked one (SF-14) | containment checklist step 7 | Noe, today, independent of everything else |
| Live platform setup unverified (profile, OAuth live client id, redirect, Connected-accounts endpoint + secret, key scopes) | Stripe dashboard reads | Noe |
| F1 first-payment confirmation missing | application code + sandbox acceptance | engineering (after the security release is decided, or on a separate branch) |
| F2 platform-account misroute | code + test-mode run | engineering |
| F3 reconciliation never runs; no replay | code + a cron slot and secret separate from retention | engineering + Noe (Vercel plan) |
| F4/F5 unscoped and unordered handlers | code | engineering |
| Sean's account provenance and TeamUp's billing location | Sean's Stripe sign-in; TeamUp's written answer | Sean, TeamUp |
| Members' authorisation to be billed by a new subscription | club's legal position | Sean |
| 16 tier prices unconfirmed | Sean | Sean |
| Shared with the security release: `main` is 153 commits behind the candidate; any Stripe fix lands on top of a branch that is itself not merge-ready (review gap D-9) | ITERATION-2-REPORT §12 | Noe (review route) |
| Shared with Sean's email correction: none technically; sequencing only (the hub release must precede both) | — | — |

## 23. Questions only Noe or a club owner can answer

1. Noe: in live mode, is the platform profile submitted, with which responsibility choices? Is OAuth enabled with a live client id and the production redirect registered? Which webhook endpoints exist, with what scope, events and API version? Which scopes does the restricted key hold?
2. Sean: was the Stripe account opened directly at stripe.com or inside another software's onboarding? Is TeamUp connected as a platform or an extension? Do the current member subscriptions live on that account or on TeamUp's?
3. Sean / TeamUp: does ending a membership in TeamUp cancel its Stripe subscription, and when?
4. Sean: do the members' existing card and Direct Debit authorisations permit a new subscription created by MatFlow? What are the 16 tier prices?
5. Noe (product): scope of payment types for the first release; who mints prices; staff-any-price or tier-only; plan change policy; shop card checkout on or off; access effects of overdue, dispute and abandoned first payment; manager versus owner refund split; coach visibility of payment history; one club per Stripe account; whether a replace is allowed while subscriptions are live.

## 24. Prioritised implementation plan (using existing work)

- **P0 Containment (today, no code):** roll the Stripe key; delete the local `CRON_SECRET`; record the live dashboard facts from §23 Q1.
- **P1 Make the product able to take a first payment (F1):** add a Payment Element step that consumes the existing `clientSecret` in `SubscribeDrawer` and `KidBillingCard`, plus a UI for the adult self-subscribe route that already exists; set `paymentStatus = pending` on create; on `incomplete_expired` drop the subscription link, not the member. Reuse `lib/stripe/subscriptions.ts` as is.
- **P2 Make webhooks safe (F4, F5, F8):** scope `subscription.updated` and invoice handlers to the member's stored subscription id or MatFlow metadata (add metadata on in-app creates, as migration already does); ignore events older than the stored state for the same object; refuse `livemode` mismatches against the key mode; keep the single secret but document that exactly one Connected-accounts endpoint may exist per mode.
- **P3 Stop the misroute (F2):** shop checkout refuses unless `stripeConnected`, like every other card route; make the permission-error branch fail closed when `disabledReason` is `deauthorized`.
- **P4 Reconciliation that runs (F3):** give `stripe-reconcile` its own schedule and secret, decoupled from retention; persist failed and 409 events in a table with an audited replay action; add a state comparison (member paymentStatus versus subscription status, Payment ledger versus charges) and an operator page.
- **P5 Connection hygiene (F6, F7):** single-use state bound to the user; pre-check the unique account and deauthorise on failure; explicit replace flow that refuses while subscriptions are live and deauthorises the old account; disconnect warns about live subscriptions and marks billing unmanaged.
- **P6 Ledger consistency:** `mark-paid` refuses card orders; desk orders write Payment rows; manual payment warns on a Stripe-billed member; audit rows on staff and self subscribe; idempotency keys on customer, product and price creation; one Stripe client factory.
- **P7 Acceptance (§20) in sandbox, then the authorised live pilot with Sean.**

## 25. Verdicts

| Question | Verdict |
|---|---|
| Owners can connect | **NOT YET** — flow exists; live setup unverified; no live connection ever made; provenance limit on existing accounts |
| Payments can be collected | **NO** as a product — recurring memberships cannot take their first payment; one-off checkout works only in mocks and local signing |
| Synchronisation is reliable | **NO** — unscoped and unordered handlers, no livemode check, reconciliation never runs, no replay |
| Ready for a live pilot | **NO** |

Evidence: `evidence/S1-code-and-controls.md`, `evidence/S2-money-and-product.md`, `evidence/S3-stripe-docs.md` (all 11 Oct 2026).
