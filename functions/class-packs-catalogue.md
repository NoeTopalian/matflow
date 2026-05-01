# Class Packs Catalogue

> **Status:** ✅ Working · creates Stripe Product+Price on the connected account · stored locally with `stripePriceId` for member purchase.

## Purpose

Some gyms sell prepaid class bundles instead of (or alongside) monthly subscriptions: "10 classes valid for 90 days, £100". Class packs are the catalogue side — the owner-defined SKU. Member purchase + redemption is in [class-pack-purchase-and-redemption.md](class-pack-purchase-and-redemption.md).

The model: each pack has a credit count, a validity window (days), and a price. When a member buys it, we create a [`MemberClassPack`](../prisma/schema.prisma) with `creditsRemaining = totalCredits` and `expiresAt = purchasedAt + validityDays`. Each class attendance burns one credit until the pack is empty or expires.

## Data model

```prisma
model ClassPack {
  id              String   @id @default(cuid())
  tenantId        String
  name            String                    // e.g. "10-Class Pack" or "Beginner Bundle"
  description     String?
  totalCredits    Int                       // 1..1000
  validityDays    Int                       // 1..3650 (10 years cap)
  pricePence      Int                       // 0..1,000,000 (£10,000 cap)
  currency        String   @default("GBP")
  isActive        Boolean  @default(true)   // gym can deactivate without deleting
  stripePriceId   String?                   // null until Stripe price created
  stripeProductId String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  memberPacks     MemberClassPack[]

  @@index([tenantId, isActive])
}
```

The Stripe IDs are populated on creation — we proactively create the Stripe Product and Price so member purchase can immediately use `stripePriceId` without per-purchase price creation.

## Surfaces

- Settings → Revenue → "Class Packs" section (see [settings-revenue.md](settings-revenue.md))
- Add Pack modal: name, totalCredits, validityDays, pricePence, optional description
- List view: name, credits, validity, price, active toggle, edit/archive
- Member side: `/member/class-packs` (or in-profile section) lists active packs available to buy

## API routes

### `GET /api/class-packs`

Owner/manager only. Returns all packs for the tenant (active + inactive), sorted active-first then newest:

```ts
const { tenantId } = await requireOwnerOrManager();
const rows = await prisma.classPack.findMany({
  where: { tenantId },
  orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
});
return NextResponse.json(rows);
```

### `POST /api/class-packs`

Owner/manager only. **Requires Stripe Connect** because we create Stripe-side Product + Price atomically:

```ts
// 1. Validate Stripe is connected
const tenant = await prisma.tenant.findUnique({where:{id:tenantId},
  select:{stripeAccountId:true, stripeConnected:true}});
if (!tenant?.stripeConnected || !tenant.stripeAccountId) return 400;

// 2. Create Stripe Product on the connected account
const stripeProduct = await stripe.products.create(
  { name, description: description ?? `${totalCredits} classes valid for ${validityDays} days` },
  { stripeAccount: tenant.stripeAccountId },
);

// 3. Create Stripe Price (one-time, in pence)
const stripePrice = await stripe.prices.create(
  { product: stripeProduct.id, unit_amount: pricePence, currency: (currency ?? "GBP").toLowerCase() },
  { stripeAccount: tenant.stripeAccountId },
);

// 4. Persist locally with both Stripe IDs
const created = await prisma.classPack.create({
  data: { tenantId, name, description, totalCredits, validityDays,
          pricePence, currency: "GBP", isActive: true,
          stripeProductId: stripeProduct.id, stripePriceId: stripePrice.id },
});

// 5. Audit
await logAudit({ tenantId, userId, action: "class_pack.create", entityType: "ClassPack", entityId: created.id, ... });
```

**Order matters:** Stripe write FIRST, then local DB. If Stripe succeeds but our DB write fails, the orphaned Stripe Price is harmless (no member can ever buy it without a `ClassPack` row). The reverse would have us with a local pack pointing at a non-existent Stripe price → buy attempts would 500.

### `PATCH /api/class-packs/[id]` and `DELETE /api/class-packs/[id]`

Owner/manager only.

- PATCH: update name/description/isActive. Price/credits/validity are NOT mutable — changing them would break member purchase semantics. Owner has to deactivate + create a new pack instead.
- DELETE: only if no member has bought it (FK guard via `memberPacks` relation). Otherwise PATCH `isActive=false` to "archive".

## Why price is immutable

If a member bought "10 classes for £100" and the owner later edited the same pack to "5 classes for £50", the historical `MemberClassPack` rows would mismatch their original purchase intent. Same logic as why Order items are a JSON snapshot rather than a relational join (see [orders-pay-at-desk.md](orders-pay-at-desk.md)).

## Validation

```ts
const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  totalCredits: z.number().int().min(1).max(1000),
  validityDays: z.number().int().min(1).max(3650),
  pricePence: z.number().int().min(0).max(10_000_00),  // £10,000 cap
  currency: z.string().min(3).max(3).optional(),
  isActive: z.boolean().optional(),
});
```

`max: 1000` credits is generous — most gyms sell 5/10/20-class packs. The cap exists to catch typos (no one is buying a 10,000-class pack).

## Connect dependency

Class packs cannot exist without a connected Stripe account. The error path returns:

```ts
return NextResponse.json({ error: "Connect Stripe before creating class packs" }, { status: 400 });
```

This is intentional — there's no "pay-at-desk class pack" flow today. If a gym wants to sell paper punch-cards, that's not modelled here.

## Security

| Control | Where |
|---|---|
| Tenant scope | All reads/writes filter `where: {tenantId}` |
| Owner-only writes | `requireOwnerOrManager()` on POST/PATCH/DELETE |
| Stripe-first ordering | Stripe write before local DB — prevents dangling local rows |
| Connect account isolation | Stripe Product+Price created on the gym's account, not platform |
| Audit log | `class_pack.create`, `class_pack.update`, `class_pack.archive` |
| Price/credits immutability | Schema-level — only `isActive`, `name`, `description` are PATCHable |

## Known limitations

- **No "trial pack"** — can't gift a free 1-class pack via the catalogue (would need a separate gifting endpoint).
- **No "members-only" gating** — anyone with a member account can buy any active pack. No tier/age restrictions.
- **No quantity discounts** — buying 2 packs is just 2x the price.
- **Currency is per-pack but the system assumes GBP everywhere** (totals, reports). Multi-currency would need a wider refactor.
- **No pack analytics** — no built-in "how many of pack X have been sold this month?" report. Owner has to query the DB.
- **PATCH cannot edit credits/validity** by design — but the UI doesn't surface that clearly. Owner finds out via 400.

## Test coverage

- No dedicated unit test for the catalogue CRUD today
- Stripe Product+Price creation tested manually (test-mode key); harness for mocked Stripe-create would be a worthwhile add

## Files

- [app/api/class-packs/route.ts](../app/api/class-packs/route.ts) — GET/POST
- [app/api/class-packs/[id]/route.ts](../app/api/class-packs/[id]/route.ts) — PATCH/DELETE
- [components/dashboard/settings/SettingsRevenue.tsx](../components/dashboard/settings/SettingsRevenue.tsx) — owner UI
- [prisma/schema.prisma](../prisma/schema.prisma) — `ClassPack`, `MemberClassPack`, `ClassPackRedemption` models
- See [class-pack-purchase-and-redemption.md](class-pack-purchase-and-redemption.md), [member-class-pack-purchase.md](member-class-pack-purchase.md), [stripe-webhook.md](stripe-webhook.md), [settings-revenue.md](settings-revenue.md)
