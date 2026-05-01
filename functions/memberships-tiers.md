# Membership Tiers

> **Status:** ✅ Working · per-tenant tier catalog · billing-cycle CHECK constraint · soft-active toggle · referenced from Settings → Revenue and used in Stripe subscription pricing.

## Purpose

Define the membership packages a gym sells (Monthly Unlimited £60, Annual £600, Student £45, etc.). Members get pinned to a tier via `Member.membershipType` (string match), and the tier's `pricePence` feeds the revenue calculations + Stripe Price creation.

## Surfaces

- Page: [/dashboard/memberships](../app/dashboard/memberships/page.tsx)
- Component: [MembershipsManager](../components/dashboard/MembershipsManager.tsx)
- Empty state when no tiers seeded
- Cross-reference: [settings-revenue.md](settings-revenue.md) (uses tier prices to compute MRR by tier breakdown)

## Data model

```prisma
model MembershipTier {
  id                String   @id @default(cuid())
  tenantId          String
  name              String      // "Monthly Unlimited"
  description       String?
  pricePence        Int      @default(0)
  currency          String   @default("GBP")
  billingCycle      String   @default("monthly")  // CHECK: monthly|annual|none
  maxClassesPerWeek Int?         // null = unlimited
  isKids            Boolean  @default(false)
  isActive          Boolean  @default(true)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([tenantId, isActive])
}
```

CHECK constraint on `billingCycle` enforced in migration `20260430000001_schema_check_constraints` (NOT VALID + VALIDATE pattern).

## API routes

- `GET /api/memberships` — staff. List active tiers for tenant.
- `POST /api/memberships` — owner/manager. Create new tier.
- `PATCH /api/memberships/[id]` — owner/manager. Tenant-guarded.
- `DELETE /api/memberships/[id]` — owner/manager. Soft-disable via `isActive = false` (hard delete would orphan member.membershipType references).

## Flow

1. Owner opens `/dashboard/memberships`
2. Empty state on first run; clicks **+ Add tier**
3. Drawer: name + price + cycle (monthly/annual/none) + max classes/week + isKids toggle
4. Submit → `POST /api/memberships`
5. Tier appears in list; member-side membership selector and Settings → Revenue both pick up the new tier

## Stripe interaction

When a tier is created (and Stripe Connect is configured), some setups also create a Stripe Product + Price for it so Stripe Checkout can use the price ID directly. See [stripe-subscriptions.md](stripe-subscriptions.md). Currently the wiring is owner-driven (you choose when to push to Stripe) rather than auto-mirrored.

## Security

- Owner/manager only on writes
- Tenant-scoped
- billing-cycle enforced at DB level via CHECK constraint
- Soft-disable preserves historical member memberships

## Known limitations

- **No tier change history** — if an owner edits "Monthly £60" → "Monthly £65", existing members' `membershipType` string still says "Monthly Unlimited" but the price has changed silently. No version snapshot on Member.
- **String match coupling** — `Member.membershipType` is a free-text field, not an FK to MembershipTier. Easy to drift (typos, renames).
- **No member-facing upgrade flow** — members can't switch tiers from inside the app; staff has to do it manually.
- **maxClassesPerWeek not enforced** — schema field exists but no check-in route reads it. Pure metadata today.

## Files

- [app/dashboard/memberships/page.tsx](../app/dashboard/memberships/page.tsx)
- [components/dashboard/MembershipsManager.tsx](../components/dashboard/MembershipsManager.tsx)
- [app/api/memberships/route.ts](../app/api/memberships/route.ts)
- [app/api/memberships/[id]/route.ts](../app/api/memberships/[id]/route.ts)
- [prisma/migrations/20260428000003_membership_tiers/migration.sql](../prisma/migrations/20260428000003_membership_tiers/migration.sql)
