# Member Class Pack Purchase

> **Status:** ✅ Working · 3 payment paths (Bank transfer / Cash / Card via Stripe) · rate-limited 10/hour/member · race-safe Stripe Customer creation.

## Purpose

Members buy prepaid class packs (e.g. "10 classes for £100, valid 60 days"). Credits decrement on check-in via the [class-pack-purchase-and-redemption.md](class-pack-purchase-and-redemption.md) flow. This doc covers the BUY-side UX and route.

## Surfaces

| Surface | Path |
|---|---|
| Pack detail + buy page | [/member/purchase/pack/[id]](../app/member/purchase/pack/[id]/page.tsx) — server-component fetch of pack details |
| Client buy form | [PurchasePackClient](../components/member/PurchasePackClient.tsx) — payment-method radio + buy button + success/error |
| Pack list (member profile) | [ClassPacksWidget](../components/member/ClassPacksWidget.tsx) embedded in [/member/profile](../app/member/profile/page.tsx) — owned packs (with credits remaining, days left) + available packs to buy |

## API consumed

- [`GET /api/class-packs/[id]`](../app/api/class-packs/[id]/route.ts) — pack details (name, description, totalCredits, validityDays, pricePence, currency)
- [`GET /api/member/class-packs`](../app/api/member/class-packs/route.ts) — `{ owned: MemberClassPack[], available: ClassPack[] }`
- [`POST /api/member/class-packs/buy`](../app/api/member/class-packs/buy/route.ts) — body `{ packId, paymentMethod: "card"|"bank"|"cash" }`. Returns:
  - `card`: `{ stripeUrl }` for redirect to Stripe Checkout
  - `bank` or `cash`: records a `Payment` intent with `status='pending'` (gym confirms receipt later via Mark Paid drawer in admin)

## Flow — card

1. Member on profile or schedule sees a pack offer → tap → `/member/purchase/pack/[id]`
2. Server fetches pack, renders client component
3. Member selects "Card" radio → "Purchase" button enables
4. POST `/api/member/class-packs/buy` with `paymentMethod="card"`
5. Server: race-safe Customer creation via `updateMany({where:{stripeCustomerId:null}})` (avoids two parallel buys creating two Customers)
6. Stripe Checkout session created with `metadata.matflowKind="class_pack"` + `packId` + `memberId` + `tenantId`
7. Browser redirects to Stripe-hosted checkout
8. On success: webhook `checkout.session.completed` → `MemberClassPack` row created in transaction with matching `Payment` row — see [stripe-webhook.md](stripe-webhook.md) and [class-pack-purchase-and-redemption.md](class-pack-purchase-and-redemption.md)

## Flow — bank/cash

1. Same first 3 steps as card
2. Member selects "Bank" or "Cash" radio → "Confirm intent" button
3. POST `/api/member/class-packs/buy` with `paymentMethod="bank"` or `"cash"`
4. Server records a `Payment` intent with `status='pending'` (no MemberClassPack yet — only created when the gym marks it paid)
5. Member sees confirmation: "Recorded — pay at the desk to activate"
6. Owner uses Mark Paid drawer in `/dashboard/payments` → flips Payment to `succeeded` AND creates the `MemberClassPack`

## Security

- Member-authed
- Tenant-scoped: pack must belong to member's tenant (`findFirst({where:{id, tenantId}})`)
- **Rate-limited 10/hour per member** to defeat accidental double-tap or scripted abuse
- Race-safe Customer create — same pattern as [stripe-subscriptions.md](stripe-subscriptions.md)
- Server-side price snapshot on `Payment.amountPence` — never trust client
- Webhook idempotent on `Payment.stripePaymentIntentId @unique`

## Known limitations

- **No pack stacking validation** — a member can buy a 10-pack while already holding a 20-pack with 18 credits left. Schema allows it; UX could warn.
- **No partial refund** — if a pack expires with credits remaining, those credits are forfeit. No automatic refund flow.
- **Card path requires Stripe Connect** — if tenant hasn't connected Stripe, the "Card" radio is disabled (greyed out).
- **No "purchase history"** for the member — they see currently-active packs, but expired/refunded ones disappear.
- **Receipt email** — depends on Stripe's default; no MatFlow-branded receipt sent.

## Test coverage

- Indirectly via [stripe-webhook.md](stripe-webhook.md) tests
- No dedicated unit test for the buy route

## Files

- [app/member/purchase/pack/[id]/page.tsx](../app/member/purchase/pack/[id]/page.tsx)
- [components/member/PurchasePackClient.tsx](../components/member/PurchasePackClient.tsx)
- [components/member/ClassPacksWidget.tsx](../components/member/ClassPacksWidget.tsx)
- [app/api/member/class-packs/route.ts](../app/api/member/class-packs/route.ts)
- [app/api/member/class-packs/buy/route.ts](../app/api/member/class-packs/buy/route.ts)
- [app/api/class-packs/[id]/route.ts](../app/api/class-packs/[id]/route.ts) — public pack detail (read-only)
- See [class-packs-catalogue.md](class-packs-catalogue.md), [class-pack-purchase-and-redemption.md](class-pack-purchase-and-redemption.md), [stripe-webhook.md](stripe-webhook.md)
