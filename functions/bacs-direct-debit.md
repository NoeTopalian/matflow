# BACS Direct Debit (UK)

> **Status:** ✅ Wired (schema + webhook handlers + tenant flag) · ⚠️ untested with a real UK bank mandate in this session.

## Purpose

UK members hate being charged on a card every month. BACS Direct Debit is the standard alternative — the gym debits their bank account directly via a one-time mandate. Lower fees for the gym, no expired-card churn for the member.

Stripe supports BACS via Payment Element. We surface it as an option at subscription sign-up when the gym opts in via `Tenant.acceptsBacs`.

## Data model

```prisma
model Tenant {
  ...
  acceptsBacs Boolean @default(false)   // gym opts in to BACS at signup
  ...
}

model Member {
  ...
  preferredPaymentMethod String @default("card")   // 'card' | 'bacs'
  ...
}
```

Migration: `20260426232743_bacs_direct_debit`.

## Surfaces

- Settings → Revenue → "Accept BACS Direct Debit" toggle (writes `Tenant.acceptsBacs`)
- Member subscription sign-up → if `Tenant.acceptsBacs && tenant.stripeAccountId`: show "Pay by Direct Debit" radio alongside Card
- Member profile → if `preferredPaymentMethod === "bacs"` AND `paymentStatus === "pending"` show "Direct Debit pending — settles in ~4 working days" notice

## Sign-up flow

1. Member chooses "Direct Debit" radio at subscription sign-up
2. Client `POST /api/stripe/create-subscription` with `paymentMethod: "bacs_debit"`
3. Server creates Stripe Subscription with `payment_settings.payment_method_types: ["bacs_debit"]`
4. Returns clientSecret → Stripe Payment Element collects sort code + account number + account holder
5. Customer authorises (BACS-specific consent UI)
6. Stripe initiates the mandate — typically takes 3 business days to confirm
7. First payment: 4 working days from mandate confirmation

We set `Member.preferredPaymentMethod = "bacs"` immediately on sign-up.

## Webhook handlers (extended in [stripe-webhook.md](stripe-webhook.md))

| Event | Action |
|---|---|
| `payment_intent.processing` | BACS payments enter "processing" state for ~4 working days. Set `Member.paymentStatus = 'pending'` so the UI shows pending instead of overdue. |
| `payment_intent.succeeded` | Normal succeeded path — Payment row inserted, status flips to 'paid' |
| `payment_intent.payment_failed` (BACS-specific reasons: `bacs_debit_authorisation_revoked`, `bacs_debit_disputed`, etc.) | Payment row failed, member overdue |
| `mandate.updated` | If `status = 'inactive'` (revoked, expired, debit returned): flip `paymentStatus = 'overdue'`, reset `preferredPaymentMethod = 'card'`. Owner contacts member to re-set-up. |
| `payment_method.detached` | Audit-log only (no Member field today) |

## Why "pending" matters

Without the explicit `pending` state, BACS payments would look "overdue" for 4 days every month — owner would chase the member unnecessarily and the member would be confused. The `processing` handler keeps the UI honest.

## Mandate revocation

A member can cancel a Direct Debit mandate via their bank app at any time. When they do:

1. Stripe sends `mandate.updated` with `status = 'inactive'`
2. We mark them overdue + reset to 'card'
3. Owner sees the overdue chip on next dashboard load → contacts member
4. Member either re-sets-up BACS OR provides a card

## Security

- `Tenant.acceptsBacs` gate prevents accidentally collecting bank details when the gym hasn't agreed to BACS terms
- Stripe handles all bank-detail PCI scope (we never see sort code / account number)
- Mandate IDs not stored locally — Stripe is source of truth
- Audit log on mandate state changes

## Known limitations

- **No real-bank E2E test** in this session. Stripe's BACS test mode uses fake account numbers; a real-bank test requires a UK current account.
- **No "re-set-up Direct Debit" UI** for members whose mandate went inactive. They have to message the gym, who has to ask them to re-do the sign-up.
- **No mandate-status display** on the member profile — they can't see "your Direct Debit is active" or "expires in X" because we don't store the mandate locally.
- **UK only** — BACS is a UK scheme. SEPA (EU) and ACH (US) would need separate wiring.
- **First-payment delay (4 working days)** is an industry reality but not pre-warned in the UI clearly enough.

## Files

- [app/api/stripe/webhook/route.ts](../app/api/stripe/webhook/route.ts) — `payment_intent.processing`, `mandate.updated` handlers
- [app/api/stripe/create-subscription/route.ts](../app/api/stripe/create-subscription/route.ts) — accepts `paymentMethod: "bacs_debit"`
- [prisma/schema.prisma](../prisma/schema.prisma) — `Tenant.acceptsBacs`, `Member.preferredPaymentMethod`
- [prisma/migrations/20260426232743_bacs_direct_debit/migration.sql](../prisma/migrations/20260426232743_bacs_direct_debit/migration.sql)
- See [stripe-subscriptions.md](stripe-subscriptions.md), [stripe-webhook.md](stripe-webhook.md), [stripe-portal.md](stripe-portal.md) (members can switch back to card via portal if self-billing is enabled)
