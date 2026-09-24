# Stripe connected-account lifecycle — test-mode evidence, 2026-09-24 22:20 UTC, PASS

Execution prompt §5 / register R1-2. Script: `scripts/stripe-lifecycle-e2e.mjs` (test branch + `sk_test_` only; stamped throwaway club torn down; account deleted on PASS). Connected account: Custom test account `acct_1UJKyKJnyaESWz7b`, created by API with Stripe's test identity, deleted after the run. Application: dev server :3847 at SHA `af783fa`; every application effect below came from replaying the **real Stripe event**, signed with the local webhook secret, into `/api/stripe/webhook`. One test clock; three clocked customers on the club's own 4-weekly £38 price.

| Leg | Stripe did | Event replayed | Application state after |
|---|---|---|---|
| First invoices (×3) | three subscriptions created, first invoices paid (£38 each) | `invoice.payment_succeeded` ×3 (`evt_1UJKzX…`, `evt_1UJKzg…`, `evt_1UJKzk…`) | three `Payment` rows `succeeded`, 3800, with charge + payment-intent + invoice ids |
| Dispute | card `pm_card_createDispute` → Stripe opened dispute `du_1UJKzdJnyaESWz7bm949jD68` on its own | `charge.dispute.created` (`evt_1UJKzf…`) | that member's `Payment.status = disputed` |
| Refund via the app | owner POST `/api/payments/<id>/refund` with `subscriptionAction: cancel_at_period_end` → Stripe refund `re_3UJKziJnyaESWz7b0pp3xS3I` (3800), subscription `cancel_at_period_end: true`, member keeps access | `charge.refunded` (`evt_3UJKzi…`) | `Payment.status = refunded`, `refundedAmountPence 3800`, `refundedAt` set; exactly one refund on Stripe |
| Failed renewal | default card switched to `pm_card_chargeCustomerFail`; clock advanced to period end + 1 h → renewal invoice `in_1UJL09…` failed | `invoice.payment_failed` (`evt_1UJL0N…`) | member `paymentStatus = overdue`, `status` still `active`, still linked; a `Payment` row `failed` beside the earlier `succeeded` one |
| Cancel at period end | clock advance → Stripe ended `sub_1UJKzhJnyaESWz7b2NGfKSxX` | `customer.subscription.deleted` (`evt_1UJL0D…`) | member `status = cancelled`, `paymentStatus = cancelled`, `stripeSubscriptionId = null`, `cancelledAt` set; `MemberStatusEvent active → cancelled, reason stripe_webhook` |
| Redelivery | same deletion event posted again | `customer.subscription.deleted` | `{"received":true,"alreadyProcessed":true}`; still exactly one status event |

## What the product taught the harness (kept as behaviour, not worked around)
- A subscription invoice cannot be refunded without saying what happens to the subscription: the route answers 400 with `requiresSubscriptionAction` until `refund_only | cancel_at_period_end | cancel_now` is given. Run 1 failed on this and the script now uses the app's own `cancel_at_period_end`.
- `pm_card_chargeDeclined` is refused at attach time ("Your card was declined"); the documented token for a renewal that bounces is `pm_card_chargeCustomerFail`. Run 2 failed on this.

## Not covered
`account.application.deauthorized` (cannot be produced on a Custom test account by API — unit-tested with a signed event); Bacs Direct Debit mandates (card only here); dispute **closed** lost/won (the created leg only); out-of-order delivery (unit-tested: `active` after `canceled` does not resurrect).
