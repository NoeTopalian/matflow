# /member/purchase/pack/[id]

| | |
|---|---|
| **File** | app/member/purchase/pack/[id]/page.tsx |
| **Section** | member |
| **Auth gating** | Auth required; server component calls `auth()` and redirects to `/login` if no session |
| **Roles allowed** | member (and any authenticated role — no role restriction beyond session check) |
| **Status** | ⚠️ partial — Stripe payment path requires `tenant.stripeConnected === true` |

## Purpose
Purchase page for a specific class pack. Fetches the `ClassPack` record (scoped to the tenant, active only) and the tenant's Stripe-connected status. Renders `PurchasePackClient` with the pack details (name, description, total credits, validity days, price in pence, currency), gym name, and whether Stripe is available. Returns 404 if the pack ID does not exist or is inactive for the tenant.

## Inbound links
- [/member/profile](profile.md) — ClassPacksWidget links to purchase page per pack (`href="/member/profile"` back link in PurchasePackClient lines 87, 101)

## Outbound links
- [/member/profile](profile.md) — "Back to profile" link in PurchasePackClient

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | prisma.classPack.findFirst | Fetch active pack by ID scoped to tenant (server-side) |
| — | prisma.tenant.findUnique | Fetch tenant name + stripeConnected flag (server-side) |

## Sub-components
- PurchasePackClient ([components/member/PurchasePackClient.tsx](../../../components/member/PurchasePackClient.tsx)) — client-side purchase UI; shows pack details, price, and checkout button; handles Stripe redirect or error when Stripe not connected

## Mobile / responsive
- Mobile-first full-page layout delegated to PurchasePackClient.

## States handled
- `notFound()` if pack does not exist or is inactive for this tenant.
- `stripeAvailable === false`: PurchasePackClient shows a "contact the gym" message instead of payment button.

## Known issues
- **P2 open** — No role guard; any authenticated user (including staff) who knows a pack URL can access this page. In practice staff are redirected away from `/member/*` by the proxy, but the page-level check only verifies session existence, not role.

## Notes
The `[id]` param is the `ClassPack.id` UUID. The pack must be both `isActive === true` and belong to `session.user.tenantId` — cross-tenant access is prevented by the `where: { id, tenantId }` query.
