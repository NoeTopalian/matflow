# Orders — Pay at Desk

> **Status:** ✅ Working · brand-new (LB-001 commit `18f4061`) · pay-at-desk shop checkout creates a real `Order` row · idempotent mark-paid endpoint (commit `b4c5c5d`).

## Purpose

When a member buys something in the shop and pays cash/card at the front desk, we now persist a real `Order` row instead of just `console.log`-ing a fake reference. Closes audit C9. The owner can later mark it paid; the row is the audit trail.

## Surfaces

- Member side: [/member/shop](../app/member/shop/page.tsx) — checkout button POSTs to `/api/member/checkout`
- Owner side: order list (TBD — currently no `/dashboard/orders` page; rows visible only via DB or future mark-paid drawer)
- Owner action: "Mark paid" — flips pending → paid, stamps `paidAt` and `paidByUserId`

## Data model

```prisma
model Order {
  id              String   @id @default(cuid())
  tenantId        String
  memberId        String?
  member          Member?  @relation(fields: [memberId], references: [id])
  orderRef        String   @unique     // e.g. "ORD-LMRK4G" — human-friendly reference
  items           Json                  // [{id, name, price, quantity}] snapshot
  totalPence      Int
  currency        String   @default("GBP")
  status          String   @default("pending")     // CHECK: pending | paid | cancelled
  paymentMethod   String                            // CHECK: pay_at_desk | stripe
  paidAt          DateTime?
  paidByUserId    String?     // staff user who marked it paid (pay_at_desk only)
  stripeSessionId String?  @unique     // null for pay-at-desk; set for Stripe path
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([tenantId, status])
  @@index([tenantId, createdAt])
  @@index([memberId])
}
```

CHECK constraints (status, paymentMethod, totalPence ≥ 0) enforced via [migration 20260430000005_orders](../prisma/migrations/20260430000005_orders/migration.sql) using NOT VALID + VALIDATE pattern.

## API routes

### `POST /api/member/checkout` (pay_at_desk branch)

When `STRIPE_SECRET_KEY` is unset OR member chose pay-at-desk:

```ts
const orderRef = `ORD-${Date.now().toString(36).toUpperCase()}`;
const total = validatedItems.reduce((sum, i) => sum + i.serverPrice * i.quantity, 0);

await prisma.order.create({
  data: {
    tenantId: session.user.tenantId,
    memberId: session.user.memberId ?? null,
    orderRef,
    items: validatedItems.map(i => ({ id: i.id, name: i.name, price: i.serverPrice, quantity: i.quantity })),
    totalPence: Math.round(total * 100),
    status: "pending",
    paymentMethod: "pay_at_desk",
  },
});

return NextResponse.json({
  mode: "pay_at_desk",
  orderRef,
  total,
  items,
  message: "Your order has been placed. Please pay at the front desk.",
});
```

DB write failure does NOT block the user (try/catch with console.error). Front-desk transaction continues — owner can re-create the order from receipt if needed.

### `POST /api/orders/[id]/mark-paid`

Owner/manager only. Idempotent + tenant-scoped:

```ts
const existing = await prisma.order.findFirst({
  where: { id, tenantId },
  select: { id: true, status: true, paidAt: true },
});
if (!existing) return 404;

if (existing.status === "paid") {
  // Idempotent re-call — return existing row, no second write
  return NextResponse.json(await prisma.order.findUnique({where: {id}}));
}
if (existing.status === "cancelled") return 409;

const updated = await prisma.order.update({
  where: { id },
  data: { status: "paid", paidAt: new Date(), paidByUserId: userId },
});
return NextResponse.json(updated);
```

## Flow

1. Member adds items to cart, taps **Place Order** in [/member/shop](../app/member/shop/page.tsx)
2. Client POSTs to `/api/member/checkout` (pay-at-desk branch — Stripe key absent OR explicit choice)
3. Server validates item prices server-side (rebuild from `Product` table — never trust client), creates `Order` row with `status='pending'`
4. Returns `{ orderRef, total }` → client shows success screen with the reference
5. Member walks to front desk, shows the orderRef on their phone
6. Owner takes cash/card, opens future "Mark paid" UI → POST `/api/orders/[id]/mark-paid`
7. Order flips `pending → paid`, `paidAt` stamped, `paidByUserId` records who took the money

## Security

| Control | Where |
|---|---|
| Server price validation | `/api/member/checkout` rebuilds priceMap from `Product.findMany({where:{tenantId}})` — never trusts client |
| Tenant scope on mark-paid | `findFirst({where:{id, tenantId}})` — owner of gym A can't mark gym B's orders |
| Idempotent mark-paid | Status='paid' short-circuit prevents double-stamping `paidAt` |
| Cancelled-order guard | Refuses 409 instead of silently succeeding |
| Audit log | `order.create.pay_at_desk`, `order.mark_paid` |
| `paidByUserId` | Forensic trail — who took the cash for each order |

## Known limitations

- **No `/dashboard/orders` page yet.** Rows are inserted but there's no list view, no per-order detail, no mark-paid button surfaced. Owner has to query the DB or build it from scratch as a follow-up.
- **No "cancel order" button** for cases where the member changes their mind before paying.
- **`items` is a Json snapshot, not a relational join** — if a Product is later renamed/deleted, the Order keeps the old name. By design (snapshot for legal/financial integrity).
- **No receipt email** — member just gets the on-screen confirmation. Email receipt would close a UX gap for "I lost my phone".

## Test coverage

- [tests/unit/order-mark-paid.test.ts](../tests/unit/order-mark-paid.test.ts) — 4 cases: 404 cross-tenant, pending→paid happy path, idempotent re-call, 409 cancelled order

## Files

- [app/api/member/checkout/route.ts](../app/api/member/checkout/route.ts) — pay_at_desk branch
- [app/api/orders/[id]/mark-paid/route.ts](../app/api/orders/[id]/mark-paid/route.ts)
- [prisma/schema.prisma](../prisma/schema.prisma) — `Order` model
- [prisma/migrations/20260430000005_orders/migration.sql](../prisma/migrations/20260430000005_orders/migration.sql)
- See [orders-stripe-checkout.md](orders-stripe-checkout.md), [member-shop.md](member-shop.md), [products-catalogue.md](products-catalogue.md)
