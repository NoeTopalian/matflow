# Member Shop

> **Status:** ✅ Working · 8-product catalogue (DB-backed via LB-009 with `lib/products.ts` fallback) · cart drawer · pay-at-desk OR Stripe checkout · Order persisted on both paths (LB-001 + commit `b4c5c5d`).

## Purpose

The member's "buy stuff" surface — physical goods (rashguard, mouthguard, hoodie, water bottle, energy bars). Two checkout paths: pay-at-desk for cash or for tenants without Stripe Connect, OR Stripe checkout when the gym has Stripe wired and the publishable key is exposed to the client.

## Surfaces

- Page: [/member/shop](../app/member/shop/page.tsx)
- Header: gym tenant name + Cart icon (with badge count)
- Category filter pills (All / Clothing / Food / Drinks / Equipment)
- 2-column product grid: emoji + name + description + price + ± quantity controls
- Cart drawer (slides up from bottom): item list + total + "Place Order" or "Pay" button
- Order success screen: order ref + total + "Show this to staff at the front desk"

## API consumed

- [`GET /api/member/products`](../app/api/member/products/route.ts) — returns product list. **Reads from `Product` table when the tenant has rows; falls back to `lib/products.ts` PRODUCTS array for empty tenants** (so a fresh gym sees a stocked store on day one).
- [`POST /api/member/checkout`](../app/api/member/checkout/route.ts) — body `{ items, successUrl, cancelUrl }`. Returns `{ mode, orderRef?, total?, url? }` depending on path:
  - `pay_at_desk`: writes Order, returns `{ mode: "pay_at_desk", orderRef, total, items, message }` — see [orders-pay-at-desk.md](orders-pay-at-desk.md)
  - `stripe`: writes Order with `paymentMethod="stripe"` + `stripeSessionId`, returns `{ mode: "stripe", url }` — browser redirects — see [orders-stripe-checkout.md](orders-stripe-checkout.md)

## Pay-at-desk vs Stripe selection

```ts
const PAY_AT_DESK = !process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
```

Client-side decision based on whether the publishable key is exposed at build time. Server-side: `/api/member/checkout` uses `STRIPE_SECRET_KEY` instead (one is exposed to browser, one isn't — they should match in pair). If they drift the user can hit a 400 "Stripe not connected" from the API.

## Cart UX

- Add → product card flips its `+` button to `– qty +` controls
- Persist in component state (NOT localStorage today — refresh = empty cart)
- Cart drawer: total, per-line ± / × remove, fat checkout button at the bottom
- Empty state: cart drawer shows "Your cart is empty" with a basket icon

## Server price validation

The checkout route NEVER trusts client-supplied prices. It rebuilds `priceMap` from the tenant's `Product` rows and rejects any item where the supplied price ≠ server price. Stops a malicious client from POST-ing a £25 hoodie for £0.01.

## Security

- Member-authed
- Tenant-scoped via `Member.tenantId` and `Product.tenantId`
- Server-validated prices on checkout
- Stripe checkout pre-creates the Order with `status='pending'` so the row exists even if the user closes the tab
- Webhook flips Order to paid via tenant-scoped `updateMany({status:'pending'})` — idempotent
- Audit log on checkout creation

## Known limitations

- **Cart not persisted** across refreshes — feature, not bug, for shop-day UX but fragile for slow tap-around-and-leave behaviours.
- **No stock counters** — `inStock` is binary (in / out). Out-of-stock items render disabled with greyed-out card; no "X left" UI.
- **No images** — products use a single emoji as icon. Product schema has no `imageUrl` column.
- **Refund flow doesn't reach back to Order** — refunds happen via Stripe webhook against `Payment` rows; the Order keeps `status='paid'`. Should mirror to `Order.status='refunded'` for accuracy.
- **No tax / VAT handling** — prices are flat.

## Test coverage

- E2E: [tests/e2e/member/shop.spec.ts](../tests/e2e/member/shop.spec.ts)
- Unit: [tests/unit/order-mark-paid.test.ts](../tests/unit/order-mark-paid.test.ts) (covers the desk-side flip)

## Files

- [app/member/shop/page.tsx](../app/member/shop/page.tsx)
- [app/api/member/products/route.ts](../app/api/member/products/route.ts) — DB read with PRODUCTS fallback
- [app/api/member/checkout/route.ts](../app/api/member/checkout/route.ts) — both paths
- [lib/products.ts](../lib/products.ts) — fallback catalogue
- See [products-catalogue.md](products-catalogue.md), [orders-pay-at-desk.md](orders-pay-at-desk.md), [orders-stripe-checkout.md](orders-stripe-checkout.md)
