# MatFlow Payments — Architecture, Safety & Liability Spec

Date: 2026-04-26
Status: design / planning
Author: spec for owner review

---

## TL;DR

You are building **MatFlow** as a SaaS platform, not a payments processor. The right model is:

- The **gym** holds its own Stripe account (Stripe Connect Standard, OAuth — already wired up).
- The **gym** is the merchant of record. Customers contract with the gym, not with you.
- Stripe holds the regulated relationship, the gym holds the customer relationship, you hold the software.
- You optionally take a small **application fee** per transaction (e.g. 1%) on top of Stripe's fees.

This pushes payments-related liability — chargebacks, refunds, KYC, AML, taxes, dispute losses, customer service — onto the gym and Stripe, where it belongs. MatFlow stays a software vendor.

The job of this spec is to:
1. Lock in that liability separation and the legal package that supports it.
2. Define what is already built vs. what's still missing.
3. Set guardrails so a future contributor cannot accidentally make MatFlow the merchant of record.
4. Pick a defensible cost structure.

---

## 1. Liability model — the most important section

### 1.1 Three-party model

| Party | Role | Liability they hold |
|---|---|---|
| **Gym (tenant)** | Merchant of record | Refunds, chargebacks, customer disputes, tax, AML, terms with their members |
| **Stripe** | Regulated payments processor | Card processing, PCI, payouts, regulatory reporting |
| **MatFlow** | Software platform | Software defects, data security, service availability — *not* payment outcomes |

This is exactly the same shape as Shopify, Squarespace, or Mindbody. It is a well-understood, well-defended model.

### 1.2 Why Stripe Connect Standard, not Express or Custom

| Variant | Who owns the account | Who handles disputes | Onboarding | Fit for MatFlow |
|---|---|---|---|---|
| **Standard** | Gym signs up directly with Stripe | Gym | Gym does Stripe's full onboarding | ✅ Best for liability separation — picked |
| Express | Stripe-managed | Mostly Stripe via dashboard | Stripe-hosted, branded MatFlow | ❌ Pulls more responsibility onto you |
| Custom | You own the account end-to-end | You | You build the UI | ❌ You become the de-facto MoR |

**Already in place:** `app/api/stripe/connect/route.ts` does OAuth `client_id` + `read_write` scope + HMAC-signed `state`. That's Connect Standard. Keep it.

**Hard rule for the codebase:** every Stripe API call for a customer/subscription/payment intent **must** be made with `{ stripeAccount: tenant.stripeAccountId }` (i.e. on behalf of the gym). The platform Stripe key is only used for OAuth, the application fee, and platform-level operations. There must never be a path where MatFlow's own Stripe key creates a customer-facing charge.

> Compliance check today: `app/api/stripe/create-subscription/route.ts:42, 51` correctly uses `{ stripeAccount }`. Keep this invariant — add a code comment near the secret-key import warning future contributors.

### 1.3 Legal package the platform must publish

You need at minimum:

| Document | What it does | Who agrees |
|---|---|---|
| **Platform Terms of Service** | MatFlow ↔ gym contract. Establishes gym as MoR, indemnifies MatFlow against gym/customer disputes, limits liability, no warranties on payment outcomes. | Gym at sign-up |
| **Acceptable Use Policy** | Bans illegal/fraudulent businesses, prohibited categories per Stripe Restricted Businesses list. | Gym at sign-up |
| **Privacy Policy** | GDPR/UK-DPA notice. Explains MatFlow only stores payment metadata (Stripe IDs, status), never card data. | Gym + member |
| **Sub-processor list** | Names Stripe, Neon, Vercel, Vercel Blob. | Public page |
| **Data Processing Agreement (DPA)** | GDPR Article 28 contract for B2B customers. | Auto-accepted at sign-up or signed |
| **Stripe Connected Account Agreement (acknowledgement)** | Stripe requires you to surface this to the gym during Connect onboarding. Stripe's hosted onboarding does this for you with Express; with Standard, the gym signs Stripe's TOS directly during OAuth. ✅ | Gym (with Stripe directly) |

**Indemnification clause** is the load-bearing one. Sample clause skeleton (review with a UK lawyer before going live):

> The Gym indemnifies and holds MatFlow harmless from any claim, loss, or liability arising from:
> (a) the goods or services the Gym sells through MatFlow,
> (b) any dispute between the Gym and its customers,
> (c) any chargeback, refund, tax obligation, or fine assessed against the connected Stripe account,
> (d) any breach of applicable consumer-protection, anti-money-laundering, or sanctions law by the Gym.

Pair this with a **mutual limitation of liability** capped at fees paid to MatFlow in the prior 12 months, and an exclusion of indirect/consequential damages.

### 1.4 Tax

Tax is a place where liability bleeds back to the platform if you are not careful.

| Region | Default approach | When it bleeds back to MatFlow |
|---|---|---|
| UK VAT (20%) | Gym registers and charges its own VAT via Stripe Tax or manually | If MatFlow charges the *member* directly — never do this |
| EU VAT B2B reverse charge | Standard Stripe invoicing handles | Only if MatFlow becomes MoR |
| US sales tax | Gym handles via Stripe Tax | Same |

Recommend: enable **Stripe Tax** on each connected account (per-tenant toggle in Settings). Stripe charges 0.5% per calculated transaction. The gym pays it, not you.

**MatFlow's own SaaS subscription** (the gym paying you) is a separate concern — *that* one MatFlow does charge VAT on. Use a single platform Stripe account or Paddle/Lemon Squeezy as a Merchant of Record for the SaaS layer if you want to sidestep VAT registration. Paddle costs 5% + £0.50 but removes EU/UK/US tax hassle entirely. Lemon Squeezy is 5% + 50¢. For a UK-based founder, **Paddle as MoR for the SaaS subscription** is probably worth the extra fee until you cross the £85 k VAT threshold.

---

## 2. Cost structure

### 2.1 Stripe's fees the gym pays

| Method | Fee (UK) | Fee (US) | Notes |
|---|---|---|---|
| Standard cards (UK/EEA) | 1.5% + 20p | n/a | Cheapest |
| Standard cards (international) | 2.5–3.25% + 20p | 2.9% + 30¢ | Currency conversion adds 2% |
| BACS Direct Debit | 1% (capped £2) | n/a | Best for monthly memberships ≥ £20 |
| SEPA Direct Debit | 0.8% (capped €5) | n/a | EU equivalent |
| Apple Pay / Google Pay | Same as card | Same as card | No extra |
| Stripe Tax | 0.5% per calc | Same | Optional |
| Stripe Connect Standard | 0% platform fee | 0% | You pay no platform fee, only the gym's fees |

### 2.2 MatFlow's monetisation options on top

You have three independent levers:

| Lever | How | Effect | Recommended |
|---|---|---|---|
| **SaaS subscription** | Charge gyms a monthly fee (e.g. £49 / £99 / £199 by tier — already exposed in `subscriptionTier`) | Predictable MRR | ✅ Primary |
| **Application fee** | Stripe `application_fee_amount` on each payment routed via the connected account | Variable revenue tied to transaction volume | ✅ Secondary, conservative (1%) |
| **Per-feature charges** | e.g. SMS notifications passed through at cost + small markup | Tied to actual usage | Optional |

A safe combined model: **£49–£199/mo + 1% application fee, capped at SaaS tier or 0% on Elite tier**. The application fee is set per-transaction in the API call — it's *your* additional take on top of Stripe's fees, deducted automatically before payout.

> Currently your `create-subscription` route sets no `application_fee_percent`. To turn this on later: add `application_fee_percent: 1` to the subscription create call. This is a single-line change once the SaaS terms allow it.

### 2.3 Cost-cutting recommendations

1. **Push members onto Direct Debit (BACS)** for monthly memberships. 1% capped at £2 vs 1.5% + 20p uncapped means a £100/mo membership costs £1 vs £1.70 — 41% cheaper. Stripe handles BACS mandates.
2. **Use Stripe Checkout (hosted)** rather than building card forms. Cuts your PCI scope to SAQ-A (the lightest) and removes any fraud-handling burden.
3. **Avoid Stripe Tax until you have ≥ 50 paying gyms.** Until then, gyms can self-handle VAT in their own Stripe dashboard.
4. **Stripe Radar** is included for free — leave it on.
5. **Don't build a "members wallet" / pre-paid balance.** It would create stored value, which triggers e-money licensing in many jurisdictions.

---

## 3. PCI, security, and data handling

### 3.1 PCI DSS scope

Your goal: **stay in PCI SAQ-A scope**. That means MatFlow's servers never see, store, or transmit raw card data.

Hard requirements:

| Requirement | How to enforce | Already true? |
|---|---|---|
| All card capture via Stripe Checkout or Stripe Elements (iframe) | No `<input>` with `name="card_number"` etc. anywhere in the codebase | ✅ Currently no card UI |
| Webhook signatures verified | `stripe.webhooks.constructEvent` | ✅ `app/api/stripe/webhook/route.ts:19` |
| Webhook idempotency | `StripeEvent` unique on `eventId` | ✅ Added in Phase 1 |
| Server logs scrubbed of card data | Never log request body of webhook | ✅ Currently doesn't |
| TLS everywhere | Vercel default | ✅ |

**Codebase guard:** add an ESLint or grep CI check that fails if a PR introduces `card_number`, `cvc`, `cardCvv`, `card_exp`, etc. as form field names. Cheap and protects against drift.

### 3.2 GDPR / UK-DPA

| Data | Location | Lawful basis | Retention |
|---|---|---|---|
| Member name, email, phone | Neon (Postgres) | Contract (gym's processing) | Until gym deletes |
| Date of birth | Neon | Contract — junior/safeguarding | Until gym deletes |
| Medical conditions | Neon | Explicit consent (waiver flow) | Until gym deletes |
| Stripe customer/subscription IDs | Neon | Contract | Until gym deletes |
| Card data | **Stripe only — never MatFlow** | n/a | n/a |
| Signed waiver snapshot | Neon (`SignedWaiver` model) | Legitimate interest — proof of agreement | 6 years (UK limitation) |
| Audit logs | Neon (`AuditLog`) | Legitimate interest — security | 12 months default |

**Member-initiated GDPR rights** (delete me, export me) need an owner-side workflow. Phase 2 work, not blocking.

### 3.3 Operational security guardrails

These should be turned into code-level invariants:

1. Never make a customer-facing Stripe call without `{ stripeAccount }`. Add a comment on `STRIPE_SECRET_KEY` import.
2. Webhook handler must complete inside 5 seconds or Stripe retries. Push slow work to a queue or background revalidation. Currently fast — keep it that way.
3. Webhook handler must be idempotent. ✅ Phase 1.
4. Never expose `stripeAccountId`, `stripeCustomerId`, or `stripeSubscriptionId` to non-staff API responses.
5. Connected account ID alone is not a secret, but it is a high-value pivot — treat it like one.
6. Application fee changes must run through the SaaS plan upgrade flow, not arbitrary owner-side toggles.
7. No `Stripe-Account` HTTP header from the client. All Stripe calls originate server-side.

---

## 4. What is already in place

| Concern | File | State |
|---|---|---|
| OAuth Connect onboarding | [app/api/stripe/connect/route.ts](app/api/stripe/connect/route.ts) | ✅ HMAC state + Standard scope |
| OAuth callback | [app/api/stripe/connect/callback/route.ts](app/api/stripe/connect/callback/route.ts) | ✅ Verifies state, stores `stripeAccountId`, audit-logged (Phase 1) |
| Disconnect | [app/api/stripe/disconnect/route.ts](app/api/stripe/disconnect/route.ts) | ✅ Revokes OAuth + clears DB + audit-logged |
| Subscription creation | [app/api/stripe/create-subscription/route.ts](app/api/stripe/create-subscription/route.ts) | ✅ Connected-account scoped; `default_incomplete` + client_secret pattern |
| Subscription plans listing | [app/api/stripe/subscription-plans/route.ts](app/api/stripe/subscription-plans/route.ts) | Likely OK |
| Webhook handler | [app/api/stripe/webhook/route.ts](app/api/stripe/webhook/route.ts) | ✅ Signed + idempotent (Phase 1). Handles `subscription.deleted`, `invoice.payment_failed`, `invoice.payment_succeeded` |
| Member payment status fields | `Member.paymentStatus`, `Member.stripeCustomerId`, `Member.stripeSubscriptionId` | ✅ Stored |
| Tenant connection status | `Tenant.stripeAccountId`, `Tenant.stripeConnected` | ✅ Stored |

---

## 5. Gaps to close (in priority order)

### Critical — block live payments until done

1. **Publish Platform ToS, Privacy Policy, AUP, sub-processor list.** Hosted on `matflow.io/legal/*`. Owner must check a tickbox before connecting Stripe. Without this, the indemnity is unenforceable.
2. **Customer Portal.** Stripe's hosted billing portal lets members update card / cancel — without it, every cancellation request hits the gym manually, and members will chargeback instead. One API call: `stripe.billingPortal.sessions.create({ customer, return_url }, { stripeAccount })`. New endpoint `app/api/stripe/portal/route.ts`.
3. **Invoice / payment ledger.** Add a `Payment` model that mirrors Stripe invoices: `id, tenantId, memberId, stripeInvoiceId, stripePaymentIntentId, amount, currency, status, paidAt, refundedAt, createdAt`. Update from `invoice.*` and `payment_intent.*` webhooks. This is what owners will actually want to see, and it's the audit trail in case Stripe data is ever lost.
4. **Refund endpoint.** `POST /api/stripe/refund/{paymentId}` (owner-only) — calls `stripe.refunds.create({ payment_intent }, { stripeAccount })`. Audit-logged. Updates the local `Payment.refundedAt`.
5. **Failed-payment notifications.** When `invoice.payment_failed` fires, write a `Notification` row for the gym so they can chase. Currently the webhook flips `paymentStatus: "overdue"` silently.

### Important — needed before scaling

6. **Stripe Tax toggle per tenant.** Owner Settings → Revenue tab, "Calculate tax automatically." Saves the gym from manual VAT.
7. **Application-fee-on-by-default for new sign-ups** at chosen rate per SaaS tier. Existing gyms grandfathered at 0%.
8. **Dispute / chargeback webhook handlers.** Listen for `charge.dispute.created`, `charge.dispute.updated`. Write a `Dispute` row, notify the gym, expose a panel where they upload evidence.
9. **Member-side payment status visibility.** Member app shows "next payment due", "card expiring", "payment overdue". Pulls from local `Payment` ledger.
10. **Decline & dunning flow.** Stripe's Smart Retries are on by default; the gym just needs visibility. The `Notification` row from #5 covers it.

### Nice-to-have

11. **One-off charges / pay-at-desk shop.** Persist orders in a `ShopOrder` model (audit Phase 4 item).
12. **Manual bank-transfer reconciliation.** For gyms whose members pay by bank transfer outside Stripe, allow owner to mark a member's `paymentStatus` paid for the current period. Audit-logged.
13. **CSV export of payments.** For gym accountants.
14. **Multi-currency support.** Each connected account picks its own currency at onboarding — Stripe enforces. Surface it in the UI but don't try to convert.

---

## 6. Implementation roadmap

### P0 — go-live blockers (≈ 1 week)
1. Draft and publish ToS, Privacy, AUP, sub-processor list, DPA. (Lawyer-reviewed.)
2. Add legal-acceptance gate on Stripe Connect (existing `onboardingCompleted` flag is the right hook).
3. `Payment` model + ledger writes from webhooks.
4. Customer Portal endpoint + member-app link.
5. Refund endpoint.

### P1 — scaling readiness (≈ 1 week)
6. Dispute handler + owner-side UI.
7. Stripe Tax toggle.
8. Failed-payment notifications.
9. Member-app payment-status surface.

### P2 — monetisation switch (≈ 2 days)
10. Application fee per SaaS tier — single-line change in subscription creation, plus a Settings → Billing readout for the gym.
11. SaaS subscription billing for *MatFlow itself* via Paddle (separate from Connect).

### P3 — operations (ongoing)
12. CSV export.
13. Manual bank-transfer reconciliation.
14. Quarterly Stripe / legal review.

---

## 7. Operational runbook (one-page)

### Webhook events you must handle

| Event | Action | Notify gym? |
|---|---|---|
| `invoice.payment_succeeded` | Mark `Payment.status = paid`, `Member.paymentStatus = paid` | No |
| `invoice.payment_failed` | Mark `Payment.status = failed`, `Member.paymentStatus = overdue` | **Yes** |
| `customer.subscription.deleted` | `Member.paymentStatus = cancelled` | Yes |
| `charge.dispute.created` | Create `Dispute` row, freeze any further actions | **Yes — urgent** |
| `charge.dispute.updated` | Update dispute status | If outcome |
| `charge.refunded` | Mark related `Payment` refunded | Yes |
| `payout.paid` | Optional — for owner dashboard "last payout" | No |
| `account.updated` | Refresh capabilities flags on tenant | Only if disabled |

### When a chargeback comes in

1. Webhook writes `Dispute` row.
2. `Notification` to gym: "Dispute opened on £X for member Y. Evidence due by Z."
3. Gym uploads evidence via owner UI → MatFlow forwards to `stripe.disputes.update` on the connected account.
4. If lost, dispute fee + amount is debited from gym's Stripe balance (not from MatFlow). MatFlow's books are unaffected. ✅
5. Audit log entry.

### When a refund is requested

1. Owner clicks Refund on a `Payment` row.
2. Confirmation modal shows fee Stripe will / won't return.
3. `stripe.refunds.create` on the connected account.
4. Webhook returns success → `Payment.refundedAt` set.
5. Audit log entry.

### When a member's card fails

1. Stripe Smart Retries auto-retries 4x over 7 days.
2. Each failure fires `invoice.payment_failed` → MatFlow stores it + notifies gym.
3. Customer Portal link in the gym's email lets the member self-update card.
4. After final retry: `subscription.deleted` if no payment method works.

### When a gym disconnects Stripe

1. `stripe.oauth.deauthorize` runs — already implemented.
2. Existing subscriptions on the connected account remain — Stripe still bills them, but MatFlow no longer sees the events.
3. Mark gym's `paymentStatus` for all members as `disconnected` (new status) so the UI shows "billing not active."
4. Audit log entry.

---

## 8. Hard-rules / Do-not list

1. **Never** capture card data on a MatFlow-hosted form. Always Stripe Checkout or Stripe Elements.
2. **Never** make a Stripe API call without `{ stripeAccount }` for customer-facing flows.
3. **Never** charge a member from MatFlow's own Stripe account. That makes you the merchant of record and voids the liability model.
4. **Never** store card numbers, CVV, or full PANs anywhere.
5. **Never** disable webhook signature verification, even in dev.
6. **Never** disable webhook idempotency (the `StripeEvent` table is load-bearing).
7. **Never** offer "stored balance" or "credits" without legal review — they are e-money in the UK.
8. **Never** auto-charge a member without Strong Customer Authentication compliance — Stripe handles this if you use Checkout/Elements.
9. **Never** accept "we'll add the card form later, just collect their details for now" — this is the most common path to a PCI breach.
10. **Never** make MatFlow a party to refunds or disputes. The contract is gym ↔ member; MatFlow is just the software.

---

## 9. Open questions for the founder (answer before P0 work starts)

1. **What jurisdiction is MatFlow Ltd registered in?** Drives applicable law for ToS and data residency.
2. **VAT-registered yet?** If not, Paddle as MoR for the SaaS layer probably wins until £85 k.
3. **Target launch market — UK only, EU, or US?** Determines Stripe Tax priority and the refund window in your ToS (UK 14-day cooling-off vs. nothing in US).
4. **Application fee on day one (1%) or wait?** I'd say wait until ~10 paying gyms — easier to introduce later than to refund.
5. **Are kids/junior memberships ever paid by a third party (parent)?** Affects who is the contracting member and how the waiver/payment relationship is modelled.
6. **Do you want to handle SEPA / BACS Direct Debit at launch, or card-only?** Direct Debit cuts costs ~40% but adds 3 days to first-payment latency.
7. **Do gyms need a "manual mark as paid" path** for cash payments at the door? Most do.

---

## Appendix A — Recommended Stripe products by use case

| Use case | Product |
|---|---|
| Monthly membership | Stripe Subscriptions |
| Drop-in class | Stripe PaymentIntent (one-off) |
| Shop / merchandise | Stripe PaymentIntent + your own order model |
| Annual billing | Stripe Subscriptions (yearly interval) |
| Family / multi-member discount | Single subscription with multiple `items[]` |
| Free trial | Stripe Subscription `trial_period_days` |
| Pause membership | Stripe Subscription pause API |
| Refund | Stripe Refund |
| Dispute response | Stripe Dispute API |
| Self-service card update / cancel | Stripe Customer Portal (Billing Portal) |
| VAT/Sales tax | Stripe Tax |
| Cards in person | Stripe Terminal (later) |

## Appendix B — Hard-coded fee numbers to keep in code

```ts
// lib/stripe-pricing.ts (proposed)
export const STRIPE_FEE_UK_CARD_PCT = 0.015;
export const STRIPE_FEE_UK_CARD_FIXED_GBP = 0.20;
export const STRIPE_FEE_UK_BACS_PCT = 0.01;
export const STRIPE_FEE_UK_BACS_CAP_GBP = 2.00;
export const STRIPE_TAX_FEE_PCT = 0.005;
export const MATFLOW_APPLICATION_FEE_PCT_BY_TIER = {
  starter: 0.01,
  pro: 0.005,
  elite: 0,
  enterprise: 0,
} as const;
```

These exist solely so the Settings → Revenue page can show gyms an honest **estimated take-home per £100 collected**, including all four layers (Stripe %, Stripe fixed, Stripe Tax if on, MatFlow application fee). Honest pricing transparency builds owner trust and reduces support load.
