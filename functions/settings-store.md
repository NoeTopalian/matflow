# Settings - Store Tab

> **Status:** ✅ Working · product CRUD (LB-009/B9 commit c54a8d1) · soft-delete persistence · category breakdown · stock status tracking.

## Purpose

Manage gym store inventory: add/edit/delete products with name, price, category, emoji symbol, and stock status. Members browse and purchase items through the member app; checkout happens at the gym.

---

## User-facing surfaces

| Element | Type | Action |
|---|---|---|
| Club Store header | Info text | Description + member app note |
| Add Item button | CTA | Opens product drawer form |
| Category breakdown | 3-col grid | Count of items per category |
| Product list | Cards | Edit/delete buttons per item |
| Product details | Per-item row | Name, emoji, category, price, stock badge |
| Store status footer | Info card | "Active · N items available" |

---

## Data model

### Product schema (Prisma)

```prisma
model Product {
  id           String      @id @default(cuid())
  tenantId     String
  tenant       Tenant      @relation(fields: [tenantId], references: [id])
  name         String      @db.VarChar(120)
  pricePence   Int         // 2500 = £25.00
  category     String      // CHECK constraint: 'clothing'|'food'|'drink'|'equipment'|'other'
  symbol       String?     // emoji or null
  description  String?
  inStock      Boolean     @default(true)
  deletedAt    DateTime?   // soft-delete
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt

  @@index([tenantId, deletedAt])
}
```

---

## Client state

```typescript
const [products, setProducts]         = useState<StoreProduct[]>(INITIAL_PRODUCTS);
const [productSaving, setProductSaving]   = useState(false);
const [productDrawer, setProductDrawer] = useState(false);
const [editProduct, setEditProduct]     = useState<StoreProduct | null>(null);
const [pName, setPName]   = useState("");
const [pPrice, setPPrice] = useState("");
const [pCat, setPCat]     = useState<StoreProduct["category"]>("clothing");
const [pEmoji, setPEmoji] = useState("👕");
const [pStock, setPStock] = useState(true);

interface StoreProduct {
  id: string;
  name: string;
  price: number;        // £25.00 (divided by 100 from DB)
  category: "clothing" | "food" | "drink" | "equipment" | "other";
  inStock: boolean;
  emoji: string;
}
```

---

## API routes

### GET /api/products

- Auth: staff (owner/manager/coach/admin)
- Returns all non-deleted products for tenant
- Maps `pricePence` → `price` (divide by 100)
- Response: `Product[]`

```typescript
const products = await prisma.product.findMany({
  where: { tenantId, deletedAt: null },
  orderBy: { createdAt: "asc" },
});
```

### POST /api/products (create)

- Auth: owner/manager only
- Body Zod schema:
  ```typescript
  {
    name: string (1-120 chars),
    pricePence: int (0-1,000,000),
    category: enum ("clothing"|"food"|"drink"|"equipment"|"other"),
    symbol: string? (max 8 chars, optional),
    description: string? (max 500 chars, optional),
    inStock: boolean (default true),
  }
  ```
- Returns created `Product` with 201 status

### PATCH /api/products/[id]

- Auth: owner/manager only
- Body: same shape as POST
- Returns updated product with 200 status
- Optimistic concurrency: no version field (last-write-wins)

### DELETE /api/products/[id]

- Auth: owner/manager only
- Soft-delete: sets `deletedAt = now()` (never removes row)
- Returns 200 on success, 404 if not found or already deleted

---

## Client flows

### Fetch on mount

```typescript
useEffect(() => {
  let cancelled = false;
  fetch("/api/products")
    .then((r) => (r.ok ? r.json() : []))
    .then((rows: Array<{ id: string; name: string; pricePence: number; category: StoreProduct["category"]; symbol: string | null; inStock: boolean }>) => {
      if (cancelled) return;
      if (Array.isArray(rows) && rows.length > 0) {
        setProducts(rows.map((r) => ({
          id: r.id,
          name: r.name,
          price: r.pricePence / 100,
          category: r.category,
          emoji: r.symbol ?? "🛍️",
          inStock: r.inStock,
        })));
      }
    })
    .catch(() => { /* keep INITIAL_PRODUCTS fallback */ });
  return () => { cancelled = true; };
}, []);
```

### Add product

1. Click "Add Item" → `openAddProduct()` clears form, opens drawer
2. Fill name, price, category, emoji, stock
3. Click "Add Product" → `saveProduct()`:
   - Validates name.trim() and price
   - POST to `/api/products` with `{ name, pricePence: Math.round(price * 100), ... }`
   - Optimistically update state: `setProducts([...products, newProduct])`
   - Close drawer, toast success

### Edit product

1. Click edit icon on product card → `openEditProduct(product)` populates form
2. Modify fields
3. Click "Save" → `saveProduct()` with PATCH instead of POST
4. Update state: `setProducts(prev => prev.map(p => p.id === editProduct.id ? {...updated} : p))`
5. Close drawer

### Delete product

1. Click delete icon → confirm dialog
2. DELETE `/api/products/[id]`
3. Optimistic remove: `setProducts(p => p.filter(x => x.id !== id))`
4. On error, restore list: `setProducts(prev)`
5. Toast feedback

---

## UI sections

### Category breakdown

```typescript
<div className="grid grid-cols-3 gap-2">
  {(["clothing", "food", "drink", "equipment", "other"] as const).map((cat) => {
    const count = products.filter((p) => p.category === cat).length;
    if (count === 0) return null;
    return (
      <div key={cat} className="rounded-xl border p-3 text-center">
        <p className="text-white font-bold text-lg">{count}</p>
        <p className="text-gray-500 text-xs">{labels[cat]}</p>
      </div>
    );
  })}
</div>
```

### Product list

- Shows emoji, name, category, price, stock badge
- Out-of-stock items show red "Out of stock" chip
- Edit/delete buttons visible to owner only
- Opacity 0.5 if not in stock

### Store status

```typescript
{products.length > 0 && (
  <div className="rounded-2xl border p-4">
    <p className="text-gray-400 text-xs mb-2">Members access the store via the member app...</p>
    <div className="flex items-center gap-2 text-xs text-gray-500">
      <div className="w-2 h-2 rounded-full bg-green-400" />
      Store active · {products.filter((p) => p.inStock).length} items available
    </div>
  </div>
)}
```

---

## Permission model

- **Owner/Manager**: can add/edit/delete products
- **Coach/Admin**: read-only (see list, no actions)
- **Members**: see store in app, checkout at gym

---

## Product drawer

Form fields:
- Product Name (required, 1-120 chars)
- Price in £ (required, decimal)
- Symbol/Emoji (optional)
- Category dropdown
- In Stock toggle

---

## Initial fallback

```typescript
const INITIAL_PRODUCTS: StoreProduct[] = [
  { id: "1", name: "Club T-Shirt",     price: 25,  category: "clothing",  inStock: true,  emoji: "👕" },
  { id: "2", name: "Rashguard",        price: 40,  category: "clothing",  inStock: true,  emoji: "🥋" },
  { id: "3", name: "Protein Shake",    price: 4,   category: "drink",     inStock: true,  emoji: "🥤" },
  { id: "4", name: "Energy Bar",       price: 2,   category: "food",      inStock: false, emoji: "🍫" },
  { id: "5", name: "Mouth Guard",      price: 12,  category: "equipment", inStock: true,  emoji: "🦷" },
];
```

Shown while fetch is in flight. Real data overwrites on response.

---

## Related docs

- [app/api/products/route.ts](../app/api/products/route.ts)
- [app/api/products/[id]/route.ts](../app/api/products/[id]/route.ts)
- [app/api/member/products/route.ts](../app/api/member/products/route.ts) — member-facing read
