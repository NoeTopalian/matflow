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
  maxClassesPerWeek Int?         // legacy weekly limit; still read (see below)
  classLimit        Int?         // T7c: N classes ... (1-60)
  classLimitBasis   String?      // ... per "week" | "month" | "weeks"; all NULL = Unlimited
  classLimitWeeks   Int?         // basis "weeks": every N weeks (2-8)
  classLimitAnchor  DateTime?    // basis "weeks": the date the periods count from (@db.Date)
  isKids            Boolean  @default(false)
  isActive          Boolean  @default(true)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([tenantId, isActive])
}
```

CHECK constraint on `billingCycle` enforced in migration `20260430000001_schema_check_constraints` (NOT VALID + VALIDATE pattern).

**Class allowance (T7c, Sean note 5; product decision 20 Oct 2026).** A plan can allow `classLimit` classes (1-60) per EXPLICIT period, never a rolling window: `classLimitBasis` is `week` (each calendar week, Monday to Sunday), `month` (each calendar month) or `weeks` (every `classLimitWeeks` weeks, 2-8, counted from the plan's `classLimitAnchor` date — one set of periods for everyone on the plan; see `docs/readiness/CLASS-ALLOWANCE-RESET-MODEL-2026-10-21.md` for the open per-member question). A class is judged against the period that contains it, on the club's wall clock. Migrations `20261017052858_tier_class_allowance` and `20261021140000_tier_class_allowance_basis` add the nullable columns with CHECKs that keep the set consistent. `lib/class-allowance.ts` holds the reader rule and the wording: the basis wins; a non-null `maxClassesPerWeek` with no basis (the previous build's field) reads as N each calendar week; the routes write every allowance column in step (a weekly allowance mirrors N into `maxClassesPerWeek`, anything else sets it NULL), so the previous build is never silently overridden. The routes accept `classLimit` + `classLimitBasis` (plus `classLimitWeeks` + `classLimitAnchor` for `weeks`; nulls = Unlimited) and still accept the legacy `maxClassesPerWeek`, never both. The plan editor shows "Classes allowed", a reset basis, and for every-N-weeks the weeks and the period start date, with a plain summary and the actual period dates before saving ("Attend up to 4 classes during each 4-week period. Your next reset is Tuesday 17 November 2026."); the table reads e.g. "4 every 4 weeks", "3 each week", "8 each month" or "Unlimited". `allowanceUsageText()` words the member portal line ("2 of 4 classes used this 4-week period — resets Tuesday 17 November"). Billing frequency (`billingCycle`) is a separate field and never implies an allowance.

## API routes

- `GET /api/memberships` — staff. List active tiers for tenant.
- `POST /api/memberships` — owner/manager. Create new tier.
- `PATCH /api/memberships/[id]` — owner/manager. Tenant-guarded.
- `DELETE /api/memberships/[id]` — owner/manager. Soft-disable via `isActive = false` (hard delete would orphan member.membershipType references).

## Flow

1. Owner opens `/dashboard/memberships`
2. Empty state on first run; clicks **+ Add tier**
3. Drawer: name + price + cycle + class allowance ("Classes allowed" with a reset basis — each week, each month, or every 2-8 weeks from a start date; blank = Unlimited) + isKids toggle
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
- **Class allowance enforced (T7)** — N classes per explicit period (week, calendar month, or every N weeks from the plan's start date), enforced from the moment a limit is saved. Attending consumes one session of the period containing the class; booking consumes nothing and is never refused for the allowance (the member is told what will happen at the door); cancelling a booking or being absent consumes nothing; an unmarked or undone visit is a deleted row, so it goes back to its own period. Member app and kiosk refuse with the count and the reset date; desk register, card scanner and coach tick ask and record the override on the audit row. Class-pack check-ins and imported history do not count; once the allowance is used up, a member with a usable class pack checks in on a pack credit at the member app and the kiosk (staff doors ask instead). Lock order Class, then Member, then pack, on every check-in path; the undo-to batch and the Stripe dispute webhook take the same order (`lib/checkin.ts`). The member portal reads the count from the uncached `GET /api/member/me/allowance` (profile plan card, schedule) and a parent sees a child's count on the child's page.

## Files

- [app/dashboard/memberships/page.tsx](../app/dashboard/memberships/page.tsx)
- [components/dashboard/MembershipsManager.tsx](../components/dashboard/MembershipsManager.tsx)
- [app/api/memberships/route.ts](../app/api/memberships/route.ts)
- [app/api/memberships/[id]/route.ts](../app/api/memberships/[id]/route.ts)
- [prisma/migrations/20260428000003_membership_tiers/migration.sql](../prisma/migrations/20260428000003_membership_tiers/migration.sql)
