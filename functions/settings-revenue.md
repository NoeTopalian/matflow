# Settings - Revenue Tab

> **Status:** ✅ Working · real data via `/api/revenue/summary` (LB-005 commit 18f4061) · Stripe Connect integration · subscription plans · 6-month revenue chart · membership tier breakdown · recent activity feed.

## Purpose

Revenue analytics dashboard showing MRR/ARR, active members, membership distribution, and recent transactions. Stripe Connect enables live payment tracking; without it, the tab shows demo data.

---

## Key sections

- Stripe Connect: OAuth button + status badge
- BACS Direct Debit: payment method toggle (post-Stripe)
- Member Self-Billing: enable/disable with contact fallback
- Privacy: email + policy URL
- Socials: Instagram, Facebook, TikTok, YouTube, Twitter, website
- Subscription Plans: list + "Add Plan" drawer (Stripe only)
- Revenue summary: MRR, ARR, active members, avg per member
- Charts: 6-month revenue bars, membership tier breakdown, recent activity

---

## Data flow

### Lazy-load on tab open

```typescript
useEffect(() => {
  if (tab !== "revenue" || revenueLoaded) return;
  fetch("/api/revenue/summary")
    .then((r) => (r.ok ? r.json() : EMPTY_REVENUE))
    .then((d) => { if (!cancelled) setRevenue(d); })
    .catch(() => { if (!cancelled) setRevenue(EMPTY_REVENUE); })
    .finally(() => { if (!cancelled) setRevenueLoaded(true); });
  return () => { cancelled = true; };
}, [tab, revenueLoaded]);
```

### API response (app/api/revenue/summary/route.ts)

- Queries Payment rows for current + last month
- Groups membershipType to count tiers
- Calculates MRR (current month), ARR (MRR * 12), growth %, avg per member
- Returns 6-month history, membership breakdown, last 6 recent payments

### Stripe flow

1. `connectStripe()` → shows ToS confirmation → POST to `/api/stripe/connect`
2. Receives OAuth URL → redirects to Stripe dashboard
3. On return, `stripeIsConnected` state updates
4. Plans lazy-load via `loadPlans()` GET `/api/stripe/subscription-plans`
5. `disconnectStripe()` → POST `/api/stripe/disconnect` with confirmation

---

## Sections (when Stripe connected)

### BACS Direct Debit
- Toggle + explanation (1% capped at £2)
- Saves `acceptsBacs` to Tenant via PATCH `/api/settings`

### Member Self-Billing
- Toggle + email + URL fields
- When off, shows owner's contact details to members
- Saves `memberSelfBilling`, `billingContactEmail`, `billingContactUrl`

### Subscription Plans
- List of Stripe Price objects with amount, interval
- "Add Plan" button opens drawer form
- POST `/api/stripe/subscription-plans` to create new plan

### Charts
- **Monthly Revenue**: 6-month bar chart (height proportional to revenue)
- **Membership Tiers**: progress bars showing distribution per tier
- **Recent Activity**: transaction feed (joined/cancelled, 6 most recent)

---

## Permission model

- **Owner**: full access (Stripe, BACS, self-billing, all settings)
- **Manager**: read-only view of revenue data
- **Others**: no access to Revenue tab

---

## Related docs

- [app/api/revenue/summary/route.ts](../app/api/revenue/summary/route.ts)
- [components/dashboard/ClassPacksManager.tsx](../components/dashboard/ClassPacksManager.tsx)
- [components/dashboard/PaymentsTable.tsx](../components/dashboard/PaymentsTable.tsx)
