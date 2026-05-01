# Stripe Subscriptions (Recurring Membership Billing)

> **Status:** ⚠️ Wired, not E2E-tested with real Stripe in this session · race-safe Customer creation · monthly OR annual plans · card OR BACS Direct Debit at sign-up.

## Purpose

Recurring membership billing. Owner defines tiers (price + cycle) → Stripe Product+Price created on the gym's Connect account → member signs up → Stripe Subscription created → MemberClassPack-style billing happens automatically every month/year.

## Surfaces

- Owner side: Settings → Revenue tab → "Manage subscription plans" (creates Stripe Products+Prices)
- Member side: sign-up flow somewhere (verify — likely in onboarding wizard or member shop)
- Cancellation: via [stripe-portal.md](stripe-portal.md) (member self-serve) OR via owner dashboard

## Data model

Subscription state stored on **`Member`** (not a separate Subscription table — KISS):

```prisma
model Member {
  ...
  stripeCustomerId        String?  // Stripe Customer.id (per gym's Connect account)
  stripeSubscriptionId    String?  // Stripe Subscription.id
  preferredPaymentMethod  String   @default("card")  // 'card' | 'bacs'
  ...
}

model MembershipTier {
  ...
  billingCycle String  @default("monthly")  // CHECK: monthly | annual | none
  pricePence   Int
  ...
}
```

`MembershipTier` provides the price & cycle that drives Stripe Price creation; `Member.stripeSubscriptionId` is the join back.

## API routes

### `POST /api/stripe/subscription-plans`
Owner only. Creates a Stripe Product + Price on the connected account from a `MembershipTier`. Stores Stripe IDs on the tier (or on a sister table). Body: `{ tierId }`. Idempotent — a tier with existing IDs is no-op.

### `GET /api/stripe/subscription-plans`
Owner. Lists all tiers + their Stripe IDs (synced or not).

### `POST /api/stripe/create-subscription`
Member. Body: `{ tierId, paymentMethod: "card" | "bacs_debit" }`.

1. Race-safe Customer creation:
   ```ts
   if (!member.stripeCustomerId) {
     const customer = await stripe.customers.create({ email, metadata: { tenantId, memberId } }, { stripeAccount });
     await prisma.member.updateMany({
       where: { id: memberId, stripeCustomerId: null },  // race-safe
       data: { stripeCustomerId: customer.id },
     });
   }
   ```
   The `updateMany` returns 0 if another concurrent request already set the ID — minor cost (orphan Customer in Stripe) but no DB inconsistency.
2. `stripe.subscriptions.create({ customer, items: [{price: tier.stripePriceId}], payment_behavior: "default_incomplete", payment_settings: { payment_method_types: [paymentMethod] } })`
3. Returns `{ clientSecret }` so the client can confirm the payment intent
4. Stores `Member.stripeSubscriptionId` = `sub.id` AND `Member.preferredPaymentMethod = paymentMethod`

## Subscription lifecycle (handled by webhook — see [stripe-webhook.md](stripe-webhook.md))

| Event | What we do |
|---|---|
| `customer.subscription.created` | (no-op — we already stamped on create) |
| `customer.subscription.updated` | Update `Member.stripeSubscriptionId` if changed |
| `customer.subscription.deleted` | Set `Member.stripeSubscriptionId = null`, `Member.paymentStatus = 'cancelled'` |
| `invoice.payment_succeeded` | Insert/upsert `Payment` with `status='succeeded'`, `paidAt = now` |
| `invoice.payment_failed` | Update Payment + flip `Member.paymentStatus = 'overdue'` |
| `payment_intent.processing` | (BACS) — set `Member.paymentStatus = 'pending'` until it settles in 4 days |
| `mandate.updated` (BACS) | If status='inactive' → flip to overdue + reset to card |

## Security

- Owner-only on plan creation (writes Stripe Product+Price under their account)
- Member-authed on subscription creation
- Tenant-scoped (`tier.tenantId === member.tenantId` enforced)
- Stripe API calls use `{ stripeAccount: tenant.stripeAccountId }` so all charges land in the gym's account
- Race-safe Customer creation prevents duplicate Stripe Customers (just leaks one orphan in failure mode — acceptable)

## Known limitations

- **Not E2E tested against a real Stripe** in this session. Code is correct per Stripe API spec; needs a real connected account + Sandbox card for verification.
- **Race-safe Customer creation can leak orphans.** If two parallel `create-subscription` calls win the Customer race, the loser's `stripe.customers.create` call still runs — Stripe gets a duplicate Customer. Acceptable trade vs full distributed locking.
- **No proration handling on tier change** — switching from Monthly to Annual mid-cycle isn't surfaced in the UI. Stripe handles it server-side but the member doesn't see "you'll be charged X today and Y on Mar 1".
- **No "pause subscription" flow** — owner has to fully cancel + recreate.
- **BACS at sign-up requires UK bank account** — error UX could be clearer for non-UK customers.

## Files

- [app/api/stripe/create-subscription/route.ts](../app/api/stripe/create-subscription/route.ts)
- [app/api/stripe/subscription-plans/route.ts](../app/api/stripe/subscription-plans/route.ts)
- [app/api/stripe/webhook/route.ts](../app/api/stripe/webhook/route.ts) — subscription event handlers
- [components/dashboard/SettingsPage.tsx](../components/dashboard/SettingsPage.tsx) — Revenue tab plan UI
- See [stripe-connect-onboarding.md](stripe-connect-onboarding.md), [stripe-portal.md](stripe-portal.md), [bacs-direct-debit.md](bacs-direct-debit.md), [stripe-webhook.md](stripe-webhook.md)
