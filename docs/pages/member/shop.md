# /member/shop

| | |
|---|---|
| **File** | app/member/shop/page.tsx |
| **Section** | member |
| **Auth gating** | Auth required; proxy blocks non-members from `/member` |
| **Roles allowed** | member |
| **Status** | ⚠️ partial — Stripe checkout path requires `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`; falls back to pay-at-desk mode |

## Purpose
Club merchandise store for members. Displays gym products in a 2-column grid with category filter tabs (all / clothing / food / drink / equipment / other). Members add items to a cart (local state), open the cart drawer, and checkout. Two checkout modes: if `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is set, calls `/api/member/checkout` which returns a Stripe Checkout URL and redirects; otherwise "pay at desk" mode calls the same endpoint and returns an order reference number. Handles `?success=1` redirect from Stripe. Reads primary colour from `localStorage["gym-settings"]` as a fallback.

## Inbound links
- MobileNav member layout ([app/member/layout.tsx](../../../app/member/layout.tsx) line 254) — `href="/member/shop"` in the More sheet

## Outbound links
— (Stripe redirect is external; success param handled on return)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/member/products | Fetch available products (id, name, price, category, inStock, symbol, description) |
| POST | /api/member/checkout | Create Stripe Checkout session or pay-at-desk order reference |

## Sub-components
— (all cart and checkout UI inline in the page file)

## Mobile / responsive
- Mobile-first, 2-column product grid. Cart is a bottom-sheet drawer. Category tabs scroll horizontally.

## States handled
- Load error: red retry banner.
- Empty category: "No items in this category" state with bag icon.
- Empty cart: empty state in cart drawer.
- Order success: full-page success state with order reference.
- Out-of-stock: product card dimmed (opacity 0.5) with "Out of stock" label; add button hidden.

## Known issues
- **P1 open** — Without `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, checkout falls back to pay-at-desk mode silently; no visible indicator on the shop page that Stripe is unconfigured until checkout is attempted.

## Notes
`PAY_AT_DESK = !process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — this flag is evaluated at build time (client-side env var). The cart is purely local state; navigating away clears it. Apple Pay icon shown on the checkout button when Stripe mode is active.
