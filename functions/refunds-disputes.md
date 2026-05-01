# Refunds & Disputes

> **Status:** ⚠️ Refund route works (issued via Stripe, mirrored to local Payment) · Dispute model is webhook-fed but has no UI surface for the owner to respond.

## Purpose

Cover both sides of "money going back" — voluntary refunds (owner clicks Refund on a payment) and chargebacks (Stripe notifies us a customer has disputed a charge with their bank).

## Refunds

### Surfaces

- Owner Payments table → per-row "Refund" button
- Drawer or inline form: amount (default = full amount, editable for partial), reason
- After: Payment row updates with `refundedAt + refundedAmountPence`; UI shows "Refunded £X · {date}"

### Data model

```prisma
model Payment {
  ...
  status              String     // 'refunded' once any amount returned
  refundedAt          DateTime?
  refundedAmountPence Int?       // partial refunds preserve the original amount
  ...
}
```

### Route — `POST /api/payments/[id]/refund`

Owner/manager. Body: `{ amountPence?, reason? }` (omit amount → full refund).

1. Tenant-guard: `findFirst({where: {id, tenantId}})` — reject 404 cross-tenant
2. Verify Payment is refundable: status='succeeded', has `stripeChargeId` (manual cash payments can't be refunded via Stripe — UI should show only an "adjust" path)
3. Call `stripe.refunds.create({ charge, amount?, reason? }, { stripeAccount })` — refund issued in the gym's Stripe
4. **Important ordering**: Stripe write FIRST, then local DB:
   - On Stripe success: update `Payment.refundedAmountPence`, `refundedAt`, `status='refunded'`
   - On DB-update failure (rare): log + rely on the eventual `charge.refunded` webhook to reconcile
5. Audit log: `payment.refund` with refunded amount and reason

### Why Stripe-first ordering

If we updated the DB first and Stripe rejected, our DB would say "refunded" but the customer never got their money. Reversing that is harder (the user trusts the local view). Doing Stripe first means the worst case is "Stripe refunded but our DB doesn't show it yet" — and the webhook backstop fixes that within seconds.

## Disputes (chargebacks)

When a customer disputes a charge with their bank, Stripe creates a Dispute object and we get notified via webhook.

### Data model

```prisma
model Dispute {
  id              String   @id @default(cuid())
  tenantId        String
  paymentId       String?
  stripeDisputeId String   @unique
  amountPence     Int
  currency        String
  reason          String     // e.g. "fraudulent", "subscription_canceled"
  status          String     // needs_response | under_review | won | lost | charge_refunded
  evidenceDueAt   DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([tenantId, status])
}
```

### Webhook handlers (in [stripe-webhook.md](stripe-webhook.md))

- `charge.dispute.created` → Insert Dispute row, status='needs_response'. Stripe places the chargeback amount on hold.
- `charge.dispute.updated` → Update status as the dispute progresses
- `charge.dispute.closed` (closed/funds_returned/funds_withdrawn) → final status

### Owner response

Currently **no UI**. Owner has to handle disputes in their Stripe dashboard. The Dispute row in our DB exists for the audit trail and could power a future inbox.

To respond properly: owner needs to upload evidence (receipts, signed waiver, attendance log) via Stripe's dispute response API. Easy to wire in MatFlow but not built yet.

## Flow — owner-initiated refund

1. Member emails: "I never used the membership, please refund March"
2. Owner → /dashboard/members/{id} → Payments tab → finds the £60 March payment
3. Click **Refund** → drawer prompts for amount (defaults full)
4. Submit → `POST /api/payments/[id]/refund`
5. Stripe processes refund (typically settles in 5-10 business days)
6. Local Payment row updates immediately AND webhook backstop confirms

## Flow — chargeback

1. Member disputes a £60 charge via their bank ("never authorised")
2. Stripe sends `charge.dispute.created` webhook
3. We insert Dispute row, status='needs_response', `evidenceDueAt = +5 business days`
4. **(Owner currently has no UI alert)** — they find out when they next check Stripe dashboard
5. Owner uploads evidence via Stripe directly
6. Stripe ultimately rules: `dispute.closed` event → status='won' or 'lost' → `Dispute.status` updates

## Security

- `requireOwnerOrManager()` on refund endpoint
- Tenant-scoped on both refund and dispute handler
- Audit log on every refund
- Stripe-side authority — we can never refund more than was paid (Stripe enforces)

## Known limitations

- **No dispute UI.** Owner finds out about chargebacks via email or Stripe dashboard. A `/dashboard/disputes` page reading from the Dispute table would be a quick win.
- **No automated evidence packaging** — the audit trail (waiver, attendance, payment history) is all in our DB but not bundled for Stripe's evidence API.
- **No partial-refund reason categories** — Stripe accepts free text but our UI doesn't surface the standard reasons (`duplicate`, `fraudulent`, `requested_by_customer`).
- **Cash refunds aren't refunds** — they have to be a separate "adjustment" Payment with a negative amount (or a Mark Paid for the inverse). Not currently modelled cleanly.
- **Dispute fee not tracked** — Stripe charges £15 per dispute regardless of outcome; we don't surface it.

## Files

- [app/api/payments/[id]/refund/route.ts](../app/api/payments/[id]/refund/route.ts)
- [app/api/stripe/webhook/route.ts](../app/api/stripe/webhook/route.ts) — `charge.dispute.*` + `charge.refunded` handlers
- [components/dashboard/PaymentsTable.tsx](../components/dashboard/PaymentsTable.tsx) — Refund button per row
- [prisma/schema.prisma](../prisma/schema.prisma) — `Payment.refunded*`, `Dispute` model
- See [payments-ledger.md](payments-ledger.md), [stripe-webhook.md](stripe-webhook.md)
