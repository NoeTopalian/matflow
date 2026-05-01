# Orders — Stripe Checkout

> **Status:** ✅ Working · `checkout.session.completed` webhook flips order to paid (commit `b4c5c5d`) · Order row created BEFORE redirect to Stripe so it survives tab-close · uses connected account when tenant has Stripe Connect.

## Purpose

Member-facing online checkout for shop items. When the gym has Stripe connected and a card payment method is acceptable, the cart submits to a real Stripe Checkout Session — money lands in the gym's connected account, our DB tracks the Order row, and the webhook backstop flips it from `pending → paid` once Stripe confirms.

For tenants without Stripe, the same endpoint falls back to the [pay-at-desk path](orders-pay-at-desk.md). Same DB shape, same `Order.orderRef` — only the payment route differs.

## Surfaces

- Member side: [/member/shop](../app/member/shop/page.tsx) — cart → Place Order → `/api/member/checkout`
- Stripe-hosted page: `https://checkout.stripe.com/...` (with the gym's branding, since it's a connected-account session)
- Success: redirected to `{origin}/member/shop?success=1` (validated same-origin — see security)
- Cancel: redirected to `{origin}/member/shop`
- Owner side: order row visible only via DB today (no `/dashboard/orders` page — same gap as pay-at-desk)

## Data model

Reuses the [`Order`](../prisma/schema.prisma) model from [pay-at-desk](orders-pay-at-desk.md) — only difference is `paymentMethod = "stripe"` and `stripeSessionId` is populated.

```prisma
model Order {
  ...
  paymentMethod   String           // 'stripe' for this branch
  stripeSessionId String? @unique  // Stripe checkout session id
  ...
}
```

The `stripeSessionId @unique` constraint matters — it's the dedup key alongside the webhook's status filter.

## API route — `POST /api/member/checkout` (stripe branch)

When `STRIPE_SECRET_KEY` is set AND tenant has a `stripeAccountId`:

```ts
// 1. Re-validate prices against Product table — never trust client cart
const priceMap = await buildPriceMap(session.user.tenantId);
for (const item of items) {
  const serverPrice = priceMap[item.id];
  if (serverPrice === undefined || Math.abs(item.price - serverPrice) > 0.001) {
    return 400;
  }
}

// 2. Validate redirect URLs are same-origin (open-redirect prevention)
const safeSuccessUrl = safeSameOriginUrl(successUrl, `${origin}/member/shop?success=1`, origin);
const safeCancelUrl  = safeSameOriginUrl(cancelUrl,  `${origin}/member/shop`,           origin);

// 3. Create Stripe checkout session ON the connected account
const orderRef = `ORD-${Date.now().toString(36).toUpperCase()}`;
const checkoutSession = await stripe.checkout.sessions.create(
  {
    mode: "payment",
    line_items: lineItems,
    success_url: safeSuccessUrl,
    cancel_url: safeCancelUrl,
    payment_method_types: ["card"],
    metadata: {
      matflowKind: "shop_order",     // routing tag for the webhook handler
      tenantId: session.user.tenantId,
      orderRef,
      ...(memberId ? { memberId } : {}),
    },
  },
  connectedAccount ? { stripeAccount: connectedAccount } : undefined,
);

// 4. Persist Order row BEFORE returning the redirect URL
await prisma.order.create({
  data: { tenantId, memberId, orderRef, items, totalPence,
          status: "pending", paymentMethod: "stripe",
          stripeSessionId: checkoutSession.id },
});

return NextResponse.json({ mode: "stripe", url: checkoutSession.url });
```

DB write failure does NOT block the user — Stripe session is already live. The webhook can reconstruct via metadata if needed.

## Webhook — `checkout.session.completed` (matflowKind = `shop_order`)

In [stripe-webhook.md](stripe-webhook.md):

```ts
case "checkout.session.completed": {
  const meta = session.metadata ?? {};
  if (meta.matflowKind === "shop_order" && meta.orderRef && meta.tenantId) {
    await prisma.order.updateMany({
      where: { tenantId: meta.tenantId, orderRef: meta.orderRef, status: "pending" },
      data: { status: "paid", paidAt: new Date() },
    });
  }
}
```

Idempotent because the `where: {status: "pending"}` filter no-ops on retries — once flipped to `paid`, subsequent webhook deliveries (which Stripe retries for ~3 days) silently match zero rows and write nothing. Tenant-scoped via `tenantId` in the where clause.

## Connect routing

The session is created `{stripeAccount: connectedAccount}` so the customer pays the GYM, not MatFlow. Money lands in the gym's Stripe balance. We don't take a platform fee on shop orders today (Connect fees only apply to subscriptions — see [stripe-connect-onboarding.md](stripe-connect-onboarding.md)).

## Flow

1. Member adds items to cart in [/member/shop](../app/member/shop/page.tsx)
2. Click **Place Order** → POST `/api/member/checkout` with `{items, successUrl, cancelUrl}`
3. Server validates prices against `Product.findMany({where:{tenantId,deletedAt:null}})`
4. Server validates redirect URLs are same-origin (rejects external URLs)
5. Server creates Stripe Checkout Session on the connected account with `metadata.matflowKind = "shop_order"`
6. Server inserts `Order` row with `status="pending"`, `stripeSessionId`, `paymentMethod="stripe"`
7. Returns `{mode:"stripe", url}` → client `window.location.href = url`
8. Member completes payment on Stripe-hosted page → redirected to `{origin}/member/shop?success=1`
9. **Async:** Stripe sends `checkout.session.completed` to our webhook → `Order.status` flips to `paid`, `paidAt` stamped

The async flip happens within seconds of payment success — the success page can poll or just show a confirmation regardless.

## Security

| Control | Where |
|---|---|
| Server price validation | `buildPriceMap(tenantId)` — every item re-priced from `Product` table; ±0.001 tolerance |
| Open-redirect prevention | `safeSameOriginUrl()` — rejects `successUrl`/`cancelUrl` pointing outside `req.nextUrl.origin` |
| Tenant scope | `Product.findMany({where:{tenantId}})` for price map; `Order.create` includes `tenantId` |
| Connect isolation | Stripe sees the gym's connected account, not the platform — money flows correctly |
| Webhook idempotency | `where:{status:"pending"}` filter + `Order.stripeSessionId @unique` |
| Soft-delete respected | Price map filters `deletedAt: null` — deleted products can't be ordered even if in client cart |
| No client trust | All amounts re-fetched server-side; client `price` only sanity-checked |

## Demo-tenant fallback

`buildPriceMap("demo-tenant")` returns the static `PRODUCT_PRICE_MAP` from [lib/products.ts](../lib/products.ts) without touching the DB. Lets the marketing/demo gym work without seeded Product rows.

For real tenants with no Product rows yet, the same `PRODUCT_PRICE_MAP` is the fallback — they can checkout with the demo catalogue while building their own.

## Known limitations

- **No order list UI** — same gap as pay-at-desk. Owner can't see incoming orders without a DB query or future `/dashboard/orders` page.
- **No webhook reconciliation tool** — if the webhook silently fails (e.g. signature drift after rotation), pending orders stay pending forever. A nightly cron checking Stripe sessions older than 1h would close this.
- **No partial refunds for shop orders** — refund tooling targets `Payment` rows, not `Order` rows. Owner has to refund via Stripe dashboard directly.
- **No "view receipt" link** — Stripe sends a receipt email; we don't surface the Stripe receipt URL in our UI.
- **Cart abandonment** — `Order` row is created BEFORE Stripe completes. If the member closes the tab, we get a `pending` row that never becomes `paid`. No cleanup job today.
- **Connect fee not captured** — shop orders don't carry an `application_fee_amount`, so MatFlow takes 0% on shop revenue (vs the subscription fee model).

## Test coverage

- Tested via the same integration tests as the webhook ([tests/integration/security.test.ts](../tests/integration/security.test.ts) — signature verification + tenant scope)
- Direct unit test of the shop_order branch: TBD (would assert the `updateMany({where:{status:"pending"}})` idempotency win)

## Files

- [app/api/member/checkout/route.ts](../app/api/member/checkout/route.ts) — stripe branch (lines ~109-186)
- [app/api/stripe/webhook/route.ts](../app/api/stripe/webhook/route.ts) — `checkout.session.completed` shop_order handler
- [app/member/shop/page.tsx](../app/member/shop/page.tsx) — checkout button
- [lib/products.ts](../lib/products.ts) — PRODUCT_PRICE_MAP fallback
- [prisma/schema.prisma](../prisma/schema.prisma) — `Order.stripeSessionId @unique`
- See [orders-pay-at-desk.md](orders-pay-at-desk.md), [stripe-webhook.md](stripe-webhook.md), [products-catalogue.md](products-catalogue.md), [member-shop.md](member-shop.md)
