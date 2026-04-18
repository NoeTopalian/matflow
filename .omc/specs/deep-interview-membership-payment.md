# Deep Interview Spec: Membership Sign-up & Payment Onboarding

## Metadata
- Interview ID: di-payment-001
- Rounds: 7
- Final Ambiguity Score: 15%
- Type: brownfield
- Generated: 2026-04-18
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|---|---|---|---|
| Goal Clarity | 0.85 | 0.35 | 0.30 |
| Constraint Clarity | 0.85 | 0.25 | 0.21 |
| Success Criteria | 0.70 | 0.25 | 0.18 |
| Context Clarity | 0.80 | 0.15 | 0.12 |
| **Total Clarity** | | | **0.81** |
| **Ambiguity** | | | **19%** |

## Goal
Enable gym owners to onboard new members end-to-end: owner creates a pending account in the dashboard, then either (a) sends an email invite for the member to set password + complete GoCardless Direct Debit mandate online, or (b) hands the device to the member to complete the mandate in-person. Member status flips to "active" once the mandate is confirmed.

## Constraints
- **Recurring billing:** GoCardless Direct Debit for monthly/annual membership fees (lower fees than Stripe, no card expiry, near-zero chargebacks)
- **One-off payments:** Stripe (already installed) for shop/taster/event purchases — no change to existing checkout route
- **Membership tiers:** Configurable per gym (owner defines name + price + billing interval in Settings). Each tier maps to a GoCardless subscription plan
- **Two onboarding paths:** Owner chooses at member creation — "Send invite email" or "Set up now on this device"
- **New dependency:** `gocardless-nodejs` npm package
- **No existing GoCardless env vars** — `GOCARDLESS_ACCESS_TOKEN` + `GOCARDLESS_ENVIRONMENT` (sandbox/live) needed
- **Multi-tenant:** All GoCardless resources (mandates, subscriptions, plans) are scoped to the tenant's GoCardless account

## Non-Goals
- PayPal, Square, SumUp — not in scope
- Member-initiated self-registration from a public URL (no `/join` page in this phase)
- Advanced dunning / automatic account suspension on failed payment (phase 2 — failure policy is owner-configured)
- Stripe subscriptions for recurring billing (GoCardless handles this)
- Invoice generation / PDF receipts (phase 2)

## Acceptance Criteria
- [ ] Owner can create a MembershipTier (name, price, interval) in Settings → tiers are stored with a linked GoCardless plan ID
- [ ] "Add Member" form includes: name, email, phone, membership tier selector
- [ ] After creation, owner sees two buttons: "Send Invite" and "Set Up Now"
- [ ] "Send Invite" sends an email with a tokenised link → member sets password + completes GoCardless hosted mandate page → status becomes "active"
- [ ] "Set Up Now" opens the GoCardless hosted mandate page in the current browser (owner's device) → member enters bank details → status becomes "active"
- [ ] GoCardless webhook updates `member.paymentStatus` and `member.status` on mandate events (created, cancelled, failed)
- [ ] Member can log in with the password they set during invite flow
- [ ] Members with `paymentStatus: "overdue"` are flagged in the Members list
- [ ] Stripe checkout for shop/one-off purchases continues to work unchanged

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|---|---|---|
| Owner handles all signup | What if member self-registers? | Out of scope for phase 1 — owner-initiated only |
| Stripe for recurring | GoCardless significantly cheaper + more reliable for UK Direct Debit | GoCardless for recurring; Stripe stays for one-off |
| Single payment model | Owner might want flexibility | Owner configures per-gym: tier names, prices, billing interval |
| Fixed tiers | Gyms have custom pricing | Configurable tiers stored in DB per tenant |

## Technical Context
### Existing codebase
- `stripe@22` + `@stripe/stripe-js@9` installed, `app/api/member/checkout/route.ts` handles one-off Stripe payments (keep unchanged)
- `prisma/schema.prisma` — Member model has: `status` (active/inactive/cancelled/taster), `paymentStatus` (paid/overdue/paused/free), `passwordHash` (optional — members created via admin API have no password yet)
- `app/api/members/route.ts` — POST creates members (staff-only, no passwordHash set)
- `auth.ts` — member login checks `passwordHash`; members with no hash cannot log in

### Schema additions needed
```prisma
model MembershipTier {
  id                String   @id @default(cuid())
  tenantId          String
  tenant            Tenant   @relation(fields: [tenantId], references: [id])
  name              String   // e.g. "Monthly Unlimited"
  priceInPence      Int      // e.g. 4500 = £45.00
  billingInterval   String   // "monthly" | "yearly"
  gcPlanId          String?  // GoCardless plan ID once created
  isActive          Boolean  @default(true)
  createdAt         DateTime @default(now())
  members           Member[]
}

// Add to Member model:
// membershipTierId  String?
// membershipTier    MembershipTier? @relation(...)
// gcMandateId       String?         // GoCardless mandate ID
// gcSubscriptionId  String?         // GoCardless subscription ID
// inviteToken       String?         // One-time invite token
// inviteExpiresAt   DateTime?
```

### New env vars
```
GOCARDLESS_ACCESS_TOKEN=...
GOCARDLESS_ENVIRONMENT=sandbox   # or "live"
GOCARDLESS_WEBHOOK_SECRET=...
```

### New routes needed
- `POST /api/members` — add `membershipTierId` to creation payload
- `POST /api/members/[id]/invite` — generate invite token, send email
- `GET /api/onboarding/[token]` — validate token, return GoCardless hosted mandate URL
- `POST /api/webhooks/gocardless` — handle mandate/subscription events
- `GET/POST /api/settings/membership-tiers` — CRUD for tiers
- `GET/POST /api/settings/membership-tiers/[id]` — update/delete tier

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|---|---|---|---|
| Owner | actor | tenantId, role | manages Members, configures Tiers |
| Member | core domain | id, email, status, paymentStatus, passwordHash, gcMandateId, gcSubscriptionId, inviteToken | belongs to Tenant, has MembershipTier |
| MembershipTier | core domain | id, tenantId, name, priceInPence, billingInterval, gcPlanId | belongs to Tenant, has many Members |
| DirectDebit Mandate | external (GoCardless) | gcMandateId, status | belongs to Member |
| Subscription | external (GoCardless) | gcSubscriptionId, status, amount | linked to Mandate + MembershipTier |
| Invite | supporting | token, expiresAt, memberId | one-to-one with Member |
| Payment | external (Stripe) | one-off purchases only | independent of GoCardless flow |

## Ontology Convergence
| Round | Entities | New | Stable | Stability |
|---|---|---|---|---|
| 1 | Owner, Member | 2 | — | N/A |
| 2 | Owner, Member, Membership, Payment | 2 new | 2 | 50% |
| 3 | Owner, Member, Membership, DirectDebit, Mandate | 2 new | 3 | 60% |
| 4 | Owner, Member, Membership, Mandate, Invite, Payment | 1 new | 5 | 83% |
| 5 | Owner, Member, MembershipTier, Mandate, Subscription, Invite, Payment | 1 renamed | 6 | 86% |

## Interview Transcript
<details>
<summary>Full Q&A (5 rounds)</summary>

**R1 Q:** When a brand new person walks in, what is the very first action?
**R1 A:** Owner creates the account

**R2 Q:** Recurring subscription or manual recurring?
**R2 A:** Recurring subscription (+ "2 options up to owner to decide")

**R3 Q:** What are the 2 options? (Stripe online vs pay-at-desk, etc.)
**R3 A:** Research GoCardless and other providers for best option

**R4 Q:** Complete journey from new person to active paying member?
**R4 A:** Both paths — owner chooses at creation (email invite OR set up on this device)

**R5 Q:** Membership tiers — fixed or configurable per gym?
**R5 A:** Configurable per gym
</details>
