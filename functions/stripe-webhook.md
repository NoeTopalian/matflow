# Stripe Webhook

> **Status:** ✅ Working · svix signature verification · `StripeEvent` unique-key idempotency · 14+ event handlers including `checkout.session.completed` for shop_order (commit `b4c5c5d`) and class_pack.

## Purpose

Single endpoint where Stripe pushes EVERY payment / subscription / mandate / dispute event for ALL connected accounts (gyms). We verify the signature, dedupe via `StripeEvent.eventId @unique`, then route to a per-event-type handler.

## Surfaces

- Endpoint: `POST /api/stripe/webhook`
- Whitelisted in [proxy.ts](../proxy.ts) — public, signature-gated
- Configured in Stripe dashboard → Developers → Webhooks → endpoint URL = `{NEXTAUTH_URL}/api/stripe/webhook`

## Required env vars

| Var | What |
|---|---|
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` from Stripe webhook config — used by `stripe.webhooks.constructEvent()` |
| `STRIPE_SECRET_KEY` | For follow-up Stripe API calls (e.g. expanding charges) |

## Idempotency

```prisma
model StripeEvent {
  id          String   @id @default(cuid())
  eventId     String   @unique     // Stripe event.id — dedup key
  type        String
  processedAt DateTime @default(now())
}
```

Pattern at the top of the route:

```ts
try {
  await prisma.stripeEvent.create({ data: { eventId: event.id, type: event.type } });
} catch (e) {
  if ((e as { code?: string }).code === "P2002") {
    return NextResponse.json({ ok: true, dedup: true });
  }
  throw e;
}
// proceed to handler
```

Stripe retries failed deliveries with exponential backoff for ~3 days. The dedup ensures a retry doesn't double-write. If the handler later throws, the StripeEvent row exists but the side-effects didn't — Stripe won't retry, so we have a small "claim and rollback on failure" gap. Acceptable.

## Event handlers (full list)

### Subscription lifecycle

| Event | Action |
|---|---|
| `customer.subscription.created` | (no-op — handled at create-subscription endpoint) |
| `customer.subscription.updated` | Update `Member.stripeSubscriptionId` if changed |
| `customer.subscription.deleted` | Set `Member.stripeSubscriptionId = null`, `paymentStatus = 'cancelled'` |
| `customer.deleted` | Clear `Member.stripeCustomerId` on matching members |

### Invoices / payments

| Event | Action |
|---|---|
| `invoice.payment_succeeded` | Upsert Payment with `status='succeeded'`, `paidAt = now`, `amountPence`, `stripeInvoiceId` |
| `invoice.payment_failed` | Upsert Payment with `status='failed'`, `failureReason`; set `Member.paymentStatus = 'overdue'` |
| `invoice.voided` | Flip existing succeeded → refunded |
| `payment_intent.succeeded` | Upsert Payment (catches one-off intents not tied to a subscription) |
| `payment_intent.processing` | (BACS) — set `Member.paymentStatus = 'pending'` until 4-day settlement |

### Refunds & disputes

| Event | Action |
|---|---|
| `charge.refunded` | Set `Payment.refundedAt = now`, `refundedAmountPence = total_refunded` |
| `charge.dispute.created` | Insert Dispute row with `status = 'needs_response'`, `evidenceDueAt` |
| `charge.dispute.updated` | Update Dispute status (under_review / won / lost / charge_refunded) |

### BACS Direct Debit

| Event | Action |
|---|---|
| `mandate.updated` | If `status = 'inactive'` → flip Member to `paymentStatus = 'overdue'`, `preferredPaymentMethod = 'card'` |
| `payment_method.detached` | Audit-log only (no Member field today) |

### Checkout sessions (one-off purchases)

| Event | Action |
|---|---|
| `checkout.session.completed` (matflowKind = `class_pack`) | Atomic transaction: create `MemberClassPack` + `Payment` rows. Idempotent on `Payment.stripePaymentIntentId @unique` |
| `checkout.session.completed` (matflowKind = `shop_order`) | `prisma.order.updateMany({where: {tenantId, orderRef, status:'pending'}, data: {status:'paid', paidAt: new Date()}})` — tenant-scoped + idempotent because the where filter requires `status='pending'` (commit `b4c5c5d`) |

`matflowKind` is a metadata key set by us when creating the checkout session — see [stripe-subscriptions.md](stripe-subscriptions.md), [member-class-pack-purchase.md](member-class-pack-purchase.md), [orders-stripe-checkout.md](orders-stripe-checkout.md).

## Member lookup helper

Most handlers need to find a Member by `stripeCustomerId`. Helper `findMember(customerId)` lives at the top of the file:

```ts
async function findMember(stripeCustomerId: string) {
  return prisma.member.findFirst({
    where: { stripeCustomerId },
    select: { id: true, tenantId: true },
  });
}
```

Returns `null` if no match — handler then skips. Stripe does include `customer` on most events but not all (some BACS events have only `payment_intent.customer` nested).

## Connect account routing

Webhook events from Connect accounts arrive at the SAME endpoint with `event.account` set to the connected account ID. We don't filter by `event.account` — instead we look up the affected member by `stripeCustomerId` (which is unique per Connect account anyway). Tenant scope is enforced by the FK to Member.

## Security

| Control | Where |
|---|---|
| Signature verification | `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)` — throws on tamper |
| Idempotency | `StripeEvent.eventId @unique` — duplicate replays return 200 immediately |
| No client trust | All amounts/customers re-fetched from `event.data.object`, never from query params |
| Tenant scope | Every write is via Member or Tenant FK — leaks impossible |
| Audit log | Every meaningful handler calls `logAudit({ action: "stripe.webhook.{event_type}" })` |

## Known limitations

- **No DLQ** — if a handler throws AFTER the StripeEvent row is created, the side-effect is lost and Stripe won't retry. Worth a try/catch that DELETEs the StripeEvent on handler failure, OR a separate retry queue.
- **No type expansion** — handlers cast `obj as ...` rather than using Stripe SDK type generics. Easy to typo a field name.
- **Currency assumptions** — handlers store `amountPence` directly from Stripe's `amount_total` which IS in pence for GBP — but for currencies where Stripe uses different units (JPY = whole units), this would mis-compute.
- **No "claim and rollback" pattern in tests** — the idempotency win-condition isn't unit tested with a forced second-firing scenario.

## Test coverage

- [tests/integration/security.test.ts](../tests/integration/security.test.ts) covers signature verification + tenant-scope assertions
- Subscription update + invoice voided handler tests live in `tests/unit/stripe-webhook-*.test.ts` (verify exact filenames)

## Files

- [app/api/stripe/webhook/route.ts](../app/api/stripe/webhook/route.ts) — single file, ~400 lines, all handlers inline
- [prisma/schema.prisma](../prisma/schema.prisma) — `StripeEvent`, `Payment`, `Dispute`, `Member.stripe*` fields, `Order.stripeSessionId`
- See [stripe-subscriptions.md](stripe-subscriptions.md), [refunds-disputes.md](refunds-disputes.md), [bacs-direct-debit.md](bacs-direct-debit.md), [orders-stripe-checkout.md](orders-stripe-checkout.md), [class-pack-purchase-and-redemption.md](class-pack-purchase-and-redemption.md)
