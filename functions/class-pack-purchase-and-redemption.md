# Class Pack — Purchase & Redemption

> **Status:** ✅ Working · atomic webhook handler creates `MemberClassPack` + `Payment` rows in one transaction · idempotent on `MemberClassPack.stripePaymentIntentId @unique` · check-in burns a credit when an active pack exists.

## Purpose

The buy → use lifecycle for class packs. Member checks out a [ClassPack](class-packs-catalogue.md) on Stripe, the webhook materialises a `MemberClassPack` (their personal pack instance with credits), then each subsequent class check-in burns one credit until the pack is empty or refunded.

**G6 (owner decision, 27 Oct 2026): packs never expire.** A pack is usable until its credits are used or it is refunded. `MemberClassPack.expiresAt` and `ClassPack.validityDays` are nullable, new rows store NULL, and no code reads either to decide anything; the legacy status `expired` is usable like `active`.

## Data model

```prisma
model MemberClassPack {
  id                    String    @id @default(cuid())
  tenantId              String
  memberId              String
  member                Member    @relation(fields: [memberId], references: [id])
  packId                String
  pack                  ClassPack @relation(fields: [packId], references: [id])
  creditsRemaining      Int                          // decrements on each redemption
  purchasedAt           DateTime  @default(now())
  expiresAt             DateTime?                    // NULL since G6; never read
  stripePaymentIntentId String?   @unique            // dedup key — webhook idempotency
  status                String    @default("active") // active | refunded; legacy "expired" is usable

  redemptions ClassPackRedemption[]

  @@index([memberId, status])
  @@index([tenantId, expiresAt])
}

model ClassPackRedemption {
  id                 String          @id @default(cuid())
  memberPackId       String
  memberPack         MemberClassPack @relation(fields: [memberPackId], references: [id])
  attendanceRecordId String          @unique         // 1 redemption per attendance
  redeemedAt         DateTime        @default(now())

  @@index([memberPackId])
}
```

`ClassPackRedemption.attendanceRecordId @unique` enforces 1 credit per attendance — even if the redemption logic gets called twice for the same check-in, the unique constraint short-circuits the second.

## Surfaces

- Member-facing buy: `/member/class-packs` listing or in-profile button → `POST /api/member/class-packs/buy` → Stripe Checkout
- Member-facing use: silent — credit burns automatically on check-in. UI shows "N classes left" (no expiry) on the member profile (see [member-class-pack-purchase.md](member-class-pack-purchase.md))
- Owner side: visible on member detail page → "Class Packs" section showing active packs with credits

## Purchase flow

### Step 1 — Member clicks Buy

`POST /api/member/class-packs/buy` with `{packId}`:

```ts
// Rate limit: 10 purchases per hour per member
const rl = await checkRateLimit(`pack:buy:${memberId}`, 10, 60 * 60 * 1000);
if (!rl.allowed) return 429;

// Validate pack exists, is active, has Stripe price
const pack = await prisma.classPack.findFirst({
  where: { id: packId, tenantId, isActive: true },
});
if (!pack || !pack.stripePriceId) return 404;

// Validate Stripe is connected
const tenant = await prisma.tenant.findUnique({...});
if (!tenant?.stripeConnected || !tenant.stripeAccountId) return 400;

// Race-safe stripeCustomerId creation — see "Customer race" below
let customerId = member.stripeCustomerId;
if (!customerId) {
  const customer = await stripe.customers.create(
    { email: member.email, name: member.name },
    { stripeAccount: tenant.stripeAccountId },
  );
  const updated = await prisma.member.updateMany({
    where: { id: member.id, stripeCustomerId: null },
    data: { stripeCustomerId: customer.id },
  });
  if (updated.count === 1) {
    customerId = customer.id;
  } else {
    // Lost the race. Re-read the winner's id.
    const fresh = await prisma.member.findUnique({...});
    customerId = fresh?.stripeCustomerId ?? customer.id;
  }
}

// Create Stripe checkout session on connected account
const checkoutSession = await stripe.checkout.sessions.create(
  {
    mode: "payment",
    customer: customerId,
    line_items: [{ price: pack.stripePriceId, quantity: 1 }],
    success_url: `${origin}/member/profile?pack=success`,
    cancel_url:  `${origin}/member/profile?pack=cancel`,
    metadata: {
      matflowKind: "class_pack",     // routes the webhook handler
      tenantId, memberId: member.id, packId: pack.id,
    },
  },
  { stripeAccount: tenant.stripeAccountId },
);

return NextResponse.json({ url: checkoutSession.url });
```

### Step 2 — Member pays on Stripe-hosted page

Redirected to `success_url` on success. Local DB has nothing yet — the webhook is the source of truth.

### Step 3 — Webhook materialises the MemberClassPack

In [stripe-webhook.md](stripe-webhook.md), the `checkout.session.completed` handler:

```ts
case "checkout.session.completed": {
  const meta = session.metadata ?? {};
  if (meta.matflowKind === "class_pack" && meta.packId && meta.memberId && meta.tenantId) {
    const pack = await prisma.classPack.findFirst({
      where: { id: meta.packId, tenantId: meta.tenantId },
    });
    if (!pack) break;

    const stripePaymentIntentId = session.payment_intent as string;

    // Atomic — both rows or neither
    await prisma.$transaction([
      prisma.memberClassPack.create({
        data: {
          tenantId: meta.tenantId, memberId: meta.memberId, packId: pack.id,
          creditsRemaining: pack.totalCredits, expiresAt: null,
          stripePaymentIntentId, status: "active",
        },
      }),
      prisma.payment.create({
        data: {
          tenantId: meta.tenantId, memberId: meta.memberId,
          amountPence: pack.pricePence, currency: pack.currency,
          status: "succeeded", stripePaymentIntentId,
          paidAt: new Date(), kind: "class_pack",
        },
      }),
    ]);
  }
}
```

Idempotent because `MemberClassPack.stripePaymentIntentId @unique` and `Payment.stripePaymentIntentId @unique` — Stripe webhook retries (3 days exponential backoff) hit P2002 on the second insert and the transaction rolls back cleanly. The `StripeEvent` dedup at the top of the handler usually short-circuits before this even runs.

## Redemption flow

When a member is checked into a class (whether by themselves at the kiosk or by a coach via /admin), the attendance handler checks for an active pack:

```ts
// Pseudo — actual logic lives in the attendance creation endpoint
const activePack = await prisma.memberClassPack.findFirst({
  where: {
    memberId, tenantId,
    status: { not: "refunded" },   // legacy "expired" is usable (G6)
    creditsRemaining: { gt: 0 },
  },
  orderBy: [{ purchasedAt: "asc" }, { id: "asc" }],   // oldest purchase first (G6)
});

if (activePack) {
  await prisma.$transaction([
    prisma.classPackRedemption.create({
      data: { memberPackId: activePack.id, attendanceRecordId: attendance.id },
    }),
    prisma.memberClassPack.update({
      where: { id: activePack.id },
      data: { creditsRemaining: { decrement: 1 } },
    }),
  ]);
}
```

The `attendanceRecordId @unique` constraint means even a double-fire of the redemption logic for the same attendance would no-op the second.

## Expiry

None since G6 (27 Oct 2026). Nothing reads `expiresAt` or writes `status = "expired"`: `lib/checkin.ts` claimPack spends any pack with credits that is not refunded, and the member pack list (`GET /api/member/class-packs`) lists active packs and legacy expired packs with credits. Dates left on older packs are history only.

## Customer race

Two simultaneous purchase attempts by the same member could both find `stripeCustomerId = null` and both create a Stripe Customer. The `updateMany({where:{stripeCustomerId: null}})` is a CAS-style guard — only the first request flips the column, the loser sees `count === 0` and re-reads the winner's id. The losing Stripe Customer is orphaned but harmless.

## Security

| Control | Where |
|---|---|
| Rate limit | 10 purchases / hour / member (`pack:buy:{memberId}`) |
| Tenant scope | Pack + member + tenant all checked together; cross-tenant 404s |
| Stripe-side authority | Webhook reads metadata from Stripe — never trusts purchase-flow inputs after redirect |
| Idempotency | `MemberClassPack.stripePaymentIntentId @unique` + `Payment.stripePaymentIntentId @unique` + `StripeEvent` dedup |
| Atomic webhook | `$transaction` ensures pack + payment row arrive together or not at all |
| Customer race-safe | `updateMany` with `null` predicate prevents double-write |
| 1-redemption-per-attendance | `ClassPackRedemption.attendanceRecordId @unique` |

## Known limitations

- **Stripe product descriptions** of packs created before G6 may still say "valid for N days" on Stripe Checkout; updating them is a manual Stripe step for the club.
- **No refund-aware credit deduction** — if owner refunds a pack purchase via Stripe, the `MemberClassPack` row stays. `charge.refunded` webhook updates `Payment` but not `MemberClassPack.status`.
- **No "transfer pack to family member"** — packs are tied to the buying member.
- **Oldest purchase first** is the redemption order, but the UI doesn't surface which pack a credit came from.
- **Manual class-pack purchase (cash at desk)** isn't modelled — owner has to manually insert a `MemberClassPack` row via DB.

## Test coverage

- No dedicated test for the redemption flow today
- Webhook idempotency relied upon via the `StripeEvent` dedup tested in [tests/integration/security.test.ts](../tests/integration/security.test.ts)
- An end-to-end "buy → check in → credit decremented" test would be a high-value add

## Files

- [app/api/member/class-packs/buy/route.ts](../app/api/member/class-packs/buy/route.ts) — Stripe checkout creation
- [app/api/member/class-packs/route.ts](../app/api/member/class-packs/route.ts) — list active packs for member
- [app/api/stripe/webhook/route.ts](../app/api/stripe/webhook/route.ts) — `checkout.session.completed` class_pack handler
- [prisma/schema.prisma](../prisma/schema.prisma) — `ClassPack`, `MemberClassPack`, `ClassPackRedemption`
- See [class-packs-catalogue.md](class-packs-catalogue.md), [member-class-pack-purchase.md](member-class-pack-purchase.md), [stripe-webhook.md](stripe-webhook.md), [admin-checkin.md](admin-checkin.md), [todays-register.md](todays-register.md)
