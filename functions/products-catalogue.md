# Products Catalogue

> **Status:** ✅ Working · soft-delete via `deletedAt` · CHECK constraint on `category` (NOT VALID + VALIDATE migration) · DB-backed price authority for all checkout paths.

## Purpose

The Product table is the source of truth for shop items a gym sells: gi, rashguards, energy bars, drinks, water bottles, pads. Two consumers:

1. **Display** — `/member/shop` lists products, owner Settings → Store CRUDs them
2. **Pricing authority** — `/api/member/checkout` rebuilds a `priceMap` from this table on every checkout to validate the cart server-side (never trust client prices)

## Data model

```prisma
model Product {
  id          String    @id @default(cuid())
  tenantId    String
  name        String
  pricePence  Int
  currency    String    @default("GBP")
  category    String    @default("other")   // CHECK: clothing | food | drink | equipment | other
  symbol      String?                       // e.g. emoji or short code shown in UI
  description String?
  inStock     Boolean   @default(true)
  deletedAt   DateTime? // Soft-delete; consumers default-filter where deletedAt IS NULL
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@index([tenantId, deletedAt])
  @@index([tenantId, inStock, deletedAt])
}
```

CHECK constraint on `category` enforced via [migration 20260430000003](../prisma/migrations/20260430000003_product_category_check/migration.sql) using NOT VALID + VALIDATE:

```sql
ALTER TABLE "Product" ADD CONSTRAINT product_category_check
  CHECK (category IN ('clothing','food','drink','equipment','other')) NOT VALID;
ALTER TABLE "Product" VALIDATE CONSTRAINT product_category_check;
```

NOT VALID means the constraint is added without scanning existing rows (instant), then VALIDATE runs the scan in a separate, locking-light transaction. Safe for live tables.

## Surfaces

### Owner side

- Settings → Store tab → product CRUD list (see [settings-store.md](settings-store.md))
- Add Product modal: name, price, category, symbol (optional), description (optional), in-stock toggle
- Edit drawer: same fields + Soft-Delete button
- Categories shown as filter pills (clothing / food / drink / equipment / other)

### Member side

- `/member/shop` — grid of products grouped by category (see [member-shop.md](member-shop.md))
- Out-of-stock products visually muted; clicking shows "Out of stock" toast (no add to cart)
- Soft-deleted products (`deletedAt != null`) hidden entirely

## API routes

### `GET /api/products`

Staff-only (owner | manager | coach). Returns all non-deleted products for the tenant:

```ts
const { tenantId } = await requireStaff();
const products = await prisma.product.findMany({
  where: { tenantId, deletedAt: null },
  orderBy: { createdAt: "asc" },
});
return NextResponse.json(products);
```

No pagination — gyms typically have <100 products, so a single fetch is fine.

### `POST /api/products`

Owner/manager only. Validated by Zod:

```ts
const createSchema = z.object({
  name: z.string().min(1).max(120),
  pricePence: z.number().int().min(0).max(1_000_000),     // £10,000 cap
  category: z.enum(["clothing","food","drink","equipment","other"]),
  symbol: z.string().max(8).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  inStock: z.boolean().optional().default(true),
});
```

Tenant injected from session — never accepted from body.

### `PATCH /api/products/[id]` and `DELETE /api/products/[id]`

Owner/manager only. PATCH allows partial field updates with the same Zod schema. DELETE is a soft-delete: stamps `deletedAt = new Date()` rather than removing the row, preserving order history that references the product by id.

### `GET /api/member/products`

Member-facing read for the shop grid. Filters `inStock: true` AND `deletedAt: null`.

## Price authority pattern

This is the most important consumer of the table — checkout MUST re-derive prices server-side:

```ts
// app/api/member/checkout/route.ts
async function buildPriceMap(tenantId: string): Promise<Record<string, number>> {
  if (tenantId === "demo-tenant") return PRODUCT_PRICE_MAP;          // demo fallback
  const rows = await prisma.product.findMany({
    where: { tenantId, deletedAt: null },                            // soft-delete respected
    select: { id: true, pricePence: true },
  });
  if (rows.length === 0) return PRODUCT_PRICE_MAP;                   // empty-tenant fallback
  return Object.fromEntries(rows.map((r) => [r.id, r.pricePence / 100]));
}

// Then for each cart item:
const serverPrice = priceMap[item.id];
if (serverPrice === undefined || Math.abs(item.price - serverPrice) > 0.001) {
  return 400;
}
```

The ±0.001 tolerance handles floating-point drift between pence-int and pound-float arithmetic. Anything bigger fails closed.

## Demo / fallback catalogue

[lib/products.ts](../lib/products.ts) ships a static `PRODUCT_PRICE_MAP` covering common martial-arts products with placeholder prices. Used in three cases:

1. `tenantId === "demo-tenant"` — public marketing demo
2. A real tenant has zero `Product` rows yet — they can ship with defaults while building their own catalogue
3. DB connection error — `try/catch` returns the fallback map rather than failing checkout

## Categories

Enforced enum at the DB layer: `clothing | food | drink | equipment | other`. Adding a category requires:

1. New migration to drop + re-add the CHECK constraint (or use `ADD VALUE` if Postgres ENUM)
2. Update Zod schema in `app/api/products/route.ts`
3. Update Zod schema in `app/api/products/[id]/route.ts`
4. Update category filter pills in [SettingsStore](../components/dashboard/settings/SettingsStore.tsx)

We chose CHECK constraint over native Postgres ENUM because dropping/re-creating an enum value is annoyingly difficult — CHECK is a single ALTER.

## Security

| Control | Where |
|---|---|
| Tenant scope | Every read filters `where: {tenantId}`; tenant injected from session, not body |
| Owner-only writes | `requireOwnerOrManager()` on POST/PATCH/DELETE |
| Server-side price authority | Cart prices ignored in checkout — DB always wins |
| Zod validation | Length caps, integer pence, category enum |
| Soft-delete preserves history | Order JSON snapshots reference deleted products by id; orders remain readable |
| CHECK constraint | DB-level guard against invalid categories even if API bypassed |

## Known limitations

- **No image upload** — products only have a `symbol` text field (emoji / short code). Image uploads via Vercel Blob would be a quick add.
- **No stock tracking** — `inStock` is a boolean toggle, not a quantity. No "low stock" alerts.
- **No variants** — gi sizes (A0, A1, A2…) have to be separate products. No SKU/variant model.
- **No discounts / promo codes** — flat price only.
- **Currency is per-product but not per-tenant enforced** — a single tenant could mix GBP and USD products today (though UI defaults all to GBP).
- **No bulk import** — manual entry per product. Could plug into the [csv-importer.md](csv-importer.md) machinery if needed.

## Test coverage

- No dedicated unit test for product CRUD today — covered indirectly by checkout integration tests that exercise `buildPriceMap`
- Schema CHECK constraint enforced at migration time

## Files

- [app/api/products/route.ts](../app/api/products/route.ts) — GET/POST
- [app/api/products/[id]/route.ts](../app/api/products/[id]/route.ts) — PATCH/DELETE
- [app/api/member/products/route.ts](../app/api/member/products/route.ts) — member-facing read
- [components/dashboard/settings/SettingsStore.tsx](../components/dashboard/settings/SettingsStore.tsx) — owner UI
- [lib/products.ts](../lib/products.ts) — `PRODUCT_PRICE_MAP` fallback
- [prisma/schema.prisma](../prisma/schema.prisma) — `Product` model
- [prisma/migrations/20260430000003_product_category_check/migration.sql](../prisma/migrations/20260430000003_product_category_check/migration.sql)
- See [settings-store.md](settings-store.md), [member-shop.md](member-shop.md), [orders-pay-at-desk.md](orders-pay-at-desk.md), [orders-stripe-checkout.md](orders-stripe-checkout.md)
