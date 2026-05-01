# Stripe Customer Portal

> **Status:** ✅ Working · gated behind `Tenant.memberSelfBilling=true` flag · default policy is owner-managed billing (members CANNOT self-serve unless the gym opts in).

## Purpose

When a member needs to update their card, switch to BACS Direct Debit, view invoices, or cancel their subscription themselves, we mint a Stripe Customer Portal session and redirect them to Stripe's hosted UI. Stripe handles all the PCI / regulatory bits.

## The owner-managed-billing default

Per [memory/project_billing_ownership_default.md](../.claude/projects/c--Users-NoeTo-Desktop-matflow/memory/project_billing_ownership_default.md): MatFlow's default policy is **owner-managed billing** — the gym owner sets up Direct Debit / takes a card on the iPad, the member just trains. Self-service Stripe portal access is the **exception**, opt-in per tenant via `Tenant.memberSelfBilling = true`.

This matches the in-person UK gym onboarding reality. Members who train at a friendly local club don't expect (or want) to wrangle Stripe billing — they want their coach to handle it.

## Surfaces

- Member side: [/member/profile](../app/member/profile/page.tsx) → Membership card → "Manage billing" button
- The button only renders if `Tenant.memberSelfBilling === true` — see [MemberBillingTab](../components/member/MemberBillingTab.tsx) lines ~109-119
- Default tenants show a static text block: "For billing changes or cancellations, contact {gymName}: {billingContactEmail}" instead of a button

## Data model

```prisma
model Tenant {
  ...
  memberSelfBilling   Boolean @default(false)  // gym opts IN to self-billing
  billingContactEmail String?                   // shown in fallback text
  billingContactUrl   String?                   // optional "view billing page" link
  ...
}

model Member {
  ...
  stripeCustomerId String?
  ...
}
```

## API routes

### `POST /api/stripe/portal`
Member-authed. Pre-flight checks:

1. `session.user.memberId` set (not staff) — else 403
2. `Tenant.memberSelfBilling === true` — else 403 with message "Self-billing is disabled for this gym"
3. `Tenant.stripeAccountId` set — else 400 "Stripe not configured"
4. `Member.stripeCustomerId` set — else 400 "No subscription on file"

If all clear: `stripe.billingPortal.sessions.create({ customer, return_url: NEXTAUTH_URL + "/member/profile" })` with `{ stripeAccount }` header so it runs on the gym's Connect account. Returns `{ url }` for the client to `window.location.assign()`.

Audit log: `member.stripe_portal_open`.

## Flow

### Self-billing tenant
1. Member → /member/profile → Membership card → "Manage billing"
2. Client `POST /api/stripe/portal`
3. Server returns `{ url }` (a `https://billing.stripe.com/p/session/...` URL)
4. Client redirects → Stripe-hosted portal
5. Member updates card / switches plan / cancels
6. Stripe redirects back to /member/profile via `return_url`
7. Webhook ([stripe-webhook.md](stripe-webhook.md)) catches any subscription/payment-method events that happened during the session

### Owner-managed tenant (default)
1. Member sees fallback text: "For billing changes, contact {gymName}: {billingContactEmail}"
2. Member emails owner
3. Owner uses [Mark Paid drawer](payments-ledger.md) for cash, OR Stripe dashboard for card edits, OR opens the portal on the member's behalf via the owner-side billing flow

## Why this default

- **Most UK gyms operate in-person** — onboarding is physical, payment setup is physical. Forcing members to self-serve confuses them.
- **Compliance burden** — when the owner takes the card, they handle PCI scope (via Stripe). Self-serve adds churn risk and support overhead.
- **Brand control** — Stripe's portal is generic; gyms with strong branding prefer their members never see it.

The opt-in flag exists for tech-forward gyms where members expect SaaS-style self-service.

## Security

- Member-authed
- Tenant-scoped via `Member.tenantId`
- Pre-flight checks reject misconfigured cases with explicit messages
- Stripe portal session is short-lived (typically 5 min) — can't be deep-linked
- All billing changes still flow through webhook for the local DB to stay in sync

## Known limitations

- **No "request billing change" workflow** — for owner-managed tenants, the only fallback is `mailto:`. A dedicated form that opens an internal ticket would be friendlier.
- **memberSelfBilling has no UI today** — the flag exists in schema but isn't toggleable from Settings. Owner must flip it via SQL or via a one-off endpoint.
- **No portal-features customisation** — Stripe's portal can be configured (which features members can self-serve). MatFlow uses Stripe's defaults.
- **Untested end-to-end against real Stripe** in this session.

## Files

- [app/api/stripe/portal/route.ts](../app/api/stripe/portal/route.ts)
- [components/member/MemberBillingTab.tsx](../components/member/MemberBillingTab.tsx) — gating logic + fallback text
- [app/member/profile/page.tsx](../app/member/profile/page.tsx) — embeds MemberBillingTab
- See [stripe-subscriptions.md](stripe-subscriptions.md), [stripe-connect-onboarding.md](stripe-connect-onboarding.md), [bacs-direct-debit.md](bacs-direct-debit.md)
