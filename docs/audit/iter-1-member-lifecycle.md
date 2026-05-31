# Audit — Iteration 1, Area 3: Member lifecycle

**Date**: 2026-05-31
**Branch**: `audit/loop-fixes-03` (branched from `main` HEAD `82d49ec`)
**Scope**: Stripe webhook (`app/api/stripe/webhook/route.ts`), Member model + migrations, member self-service billing (`/api/member/subscriptions/**`, `/api/member/checkout`, `/api/member/class-packs/buy`, `/api/stripe/portal`, `/api/stripe/create-subscription`), staff PATCH (`/api/members/[id]`), DSAR erase, admin customer transitions (`suspend`, `soft-delete`, `transfer-ownership`, `totp-reset`), taster onboarding (`/api/apply`, `/api/members/accept-invite`), cron routes, member cascade delete (`lib/member-delete.ts`)
**Method**: 4 OMC subagents in parallel. All returned full reports.
**Status**: **NOT converged.** 2 Critical + 10 High deduplicated.

## Convergence summary

| Agent | Critical | High | Medium | Low | Verdict |
|---|---|---|---|---|---|
| Code Reviewer | 2 | 4 | 6 | 3 | NOT GREEN |
| Security Reviewer | 0 | 6 | 6 | 4 | NOT GREEN |
| Verifier | 1 | 4 | 3 | 4 | NOT GREEN |
| Perf | 0 | 1 | 4 | 6 | NOT GREEN |

**Deduplicated NEW Critical**: 2.
**Deduplicated NEW High**: 10.

Stake-list discovery: `lib/stripe.ts`, `lib/dunning.ts`, `lib/member-status.ts` do **not** exist — Stripe is instantiated inline at 2 sites; dunning is inlined in the webhook; no centralised state-transition validator. App billing lives at `/api/stripe/portal`, not `/api/member/billing/**` (which doesn't exist).

---

## NEW Critical findings

### A3C-1 — Webhook `customer.subscription.deleted` does NOT flip `Member.status = "cancelled"`
- **Location**: `app/api/stripe/webhook/route.ts:128-135`
- **Corroborated by**: code-reviewer C-1, verifier C3A-1
- **Issue**: The handler writes `paymentStatus: "cancelled"` + nulls `stripeSubscriptionId` but **never sets `Member.status`**. Yet `/api/member/subscriptions/cancel/route.ts:7-9` and `lib/stripe/subscriptions.ts:138` both explicitly state the webhook flips Member.status. Contract unfulfilled. Result: every self-cancelled member sits in `status: "active"` + `paymentStatus: "cancelled"` forever; appears in active member counts; passes check-in filters; gym owner has no churn signal. Same gap on `customer.subscription.updated` for `canceled/incomplete_expired`.
- **Fix**: Add `status: "cancelled"` to the `updateMany` `data` at line 133. Apply same to `customer.subscription.updated` handler at line 368 for the cancelled-status branches.

### A3C-2 — `memberUpdateSchema` allows GDPR-erased members to be flipped back to `status = "active"`
- **Location**: `lib/schemas/member.ts:18-32` + `app/api/members/[id]/route.ts:94-174`
- **Flagged by**: code-reviewer C-2
- **Issue**: DSAR erase sets `email = "deleted-{cuid}@deleted.invalid"` and `status = "cancelled"`. Nothing prevents a staff PATCH to flip the row back to `status = "active"`, resurrecting an erased member's record. Violates GDPR Art. 17 fulfilment evidence.
- **Fix**: In the PATCH handler, refuse to mutate `status` away from `"cancelled"` when `email` matches the erasure sentinel pattern `^deleted-.*@deleted\.invalid$`.

---

## NEW High findings (deduplicated)

### A3H-1 — Missing CSRF on 5 mutating member/staff billing routes
- **Locations**:
  - `app/api/member/checkout/route.ts:47` POST
  - `app/api/member/class-packs/buy/route.ts:14` POST
  - `app/api/member/me/route.ts:177` PATCH (member self-profile)
  - `app/api/stripe/portal/route.ts:10` POST
  - `app/api/stripe/create-subscription/route.ts:25` POST
  - `app/api/stripe/subscription-plans/route.ts:66` POST
- **Flagged by**: security H-A3-1..5, code-reviewer H-1
- **Fix**: Add `assertSameOrigin(req)` at top of each handler. Pattern matches every other mutating route. 6×1-line additions.
- **Bonus**: `/api/member/checkout` also lacks Zod (security H-A3-1). Add `bodySchema` enforcing `items[].quantity` integer positive max 100, `successUrl/cancelUrl` URL format.

### A3H-2 — Webhook `sendEmail` inside `withRlsBypass` transaction can fire on rollback (duplicate notifications)
- **Location**: `app/api/stripe/webhook/route.ts:175-210`
- **Flagged by**: code-reviewer H-2
- **Issue**: Fire-and-forget emails execute immediately within the transaction. If any later step throws, the outer catch at line 529 rolls back the idempotency claim → Stripe retries → emails fire again. Result: duplicate "payment failed" notifications to member and owner.
- **Fix**: Collect email payloads in an array inside the transaction; dispatch after `withRlsBypass` resolves successfully.

### A3H-3 — No staff route to reactivate member billing (no `paymentStatus` PATCH path)
- **Location**: Absent — `/api/admin/customers/[id]/reactivate` doesn't exist; `memberUpdateSchema` doesn't expose `paymentStatus`
- **Flagged by**: code-reviewer H-3
- **Issue**: Once `paymentStatus: "cancelled"` is set by the webhook, the only recovery paths are: (a) member creates new Stripe subscription, (b) raw DB surgery. No staff-facing button. This is a feature gap.
- **Fix**: Add `paymentStatus` to `memberUpdateSchema` with audit logging on transition. OR add dedicated `/api/members/[id]/reactivate-billing` route. Cleaner: extend the schema.

### A3H-4 — TOTP reset uses `totpRecoveryCodes: undefined` (Prisma no-op) → stale codes survive reset
- **Locations**: `app/api/admin/customers/[id]/totp-reset/route.ts:53`, `app/api/admin/customers/[id]/member-totp-reset/route.ts:63`
- **Flagged by**: code-reviewer L-A3-4 upgraded to H-4
- **Issue**: Setting a Prisma field to `undefined` means "don't update". Old recovery codes remain valid after a TOTP reset — attacker who obtained pre-reset codes can bypass the new TOTP enrolment.
- **Fix**: Change `undefined` → `null` in both files. Two-line fix.

### A3H-5 — `payment_intent.succeeded` does NOT flip `Member.paymentStatus = "paid"`
- **Location**: `app/api/stripe/webhook/route.ts:389-416`
- **Flagged by**: verifier H3A-1
- **Issue**: The `invoice.payment_succeeded` branch correctly flips `paymentStatus = "paid"` on Member. The `payment_intent.succeeded` branch only upserts the Payment row. Standalone PaymentIntents (non-invoice: BACS DD single charges, some class-pack flows) leave the Member's `paymentStatus` unchanged. BACS flow (`payment_intent.processing → pending`, then `succeeded → should be paid`) is broken at the Member-status leg.
- **Fix**: In the `payment_intent.succeeded` handler, add `tx.member.update({ where: { id: member.id }, data: { paymentStatus: "paid" } })` guarded on `member !== null`.

### A3H-6 — Staff PATCH `status = "cancelled"` does not cancel the Stripe subscription
- **Location**: `app/api/members/[id]/route.ts:94-174` + `lib/schemas/member.ts:26`
- **Flagged by**: verifier H3A-2
- **Issue**: Staff can PATCH `status = "cancelled"` on a member whose `stripeSubscriptionId IS NOT NULL`. The DB row says cancelled but Stripe keeps charging the card. Conversely, PATCHing `status = "active"` on a member whose subscription was deleted creates an active member with no billing.
- **Fix**: In the PATCH handler, if `status` is transitioning to `"cancelled"` and `member.stripeSubscriptionId IS NOT NULL`, call `cancelSubscriptionAtPeriodEnd` (from `lib/stripe/subscriptions.ts`). Alternatively: reject the PATCH with 400 and force cancellation through the dedicated `/api/member/subscriptions/cancel` route.

### A3H-7 — DSAR erase does NOT cancel the Stripe subscription
- **Location**: `app/api/admin/dsar/erase/route.ts:80-100`
- **Flagged by**: verifier H3A-3
- **Issue**: Erasure anonymises PII + sets `status = "cancelled"`, but doesn't call any Stripe cancellation. Stripe keeps charging the card after the member has exercised their right to erasure. Both a commercial dispute risk AND a GDPR data-minimisation issue.
- **Fix**: Before the erase update, if `member.stripeSubscriptionId IS NOT NULL`, call `cancelSubscriptionAtPeriodEnd`. Log outcome in the audit row metadata.

### A3H-8 — Tenant suspend/soft-delete bumps `User.sessionVersion` but NOT `Member.sessionVersion`
- **Locations**: `app/api/admin/customers/[id]/suspend/route.ts:39-41`, `app/api/admin/customers/[id]/soft-delete/route.ts:46-48`
- **Flagged by**: verifier H3A-4
- **Issue**: Suspended tenant — Member JWTs remain valid until natural expiry (~30 days). Members keep accessing the portal, checking in, viewing data. Defeats suspension as access control.
- **Fix**: Add `tx.member.updateMany({ where: { tenantId }, data: { sessionVersion: { increment: 1 } } })` to both routes mirroring the existing User pattern.

### A3H-9 — Missing audit-log entries on financial state transitions
- **Locations** (representative):
  - `app/api/stripe/create-subscription/route.ts` (staff creates sub)
  - `app/api/member/subscriptions/start/route.ts` (member self-subscribes)
  - `app/api/member/class-packs/buy/route.ts` (member buys class pack)
  - `app/api/member/checkout/route.ts` (member places shop order)
  - Most webhook event handlers: `subscription.deleted`, `payment_failed`, `payment_succeeded`, `subscription.updated`, `refunded`, `dispute.*`, `customer.deleted`
- **Flagged by**: security H-A3-6
- **Fix**: Add `logAudit({...})` after each financial state transition. Pattern: action `member.subscription.{create,cancel}`, `member.payment.{succeeded,failed}`, `member.classpack.purchased`, etc. ~10-12 `logAudit` calls across 6+ files.

### A3H-10 — `Member.stripeCustomerId` has no index → seq-scan on every webhook event
- **Location**: `prisma/schema.prisma` Member model
- **Flagged by**: perf H3A-1
- **Issue**: `findMember(customerId)` at `webhook/route.ts:106-110` does `findFirst({ where: { stripeCustomerId, tenantId } })`. At 500 members: ~0.5ms per scan. At 5000 (10×): ~50ms per event → ~350ms on the 7-trip `invoice.payment_failed` path. Approaches Stripe timeout boundary.
- **Fix**: Add `@@index([tenantId, stripeCustomerId])` to Member model + migration. Single-line schema change + hand-crafted migration.

---

## NEW Medium findings (append to backlog-medium.md)

- **M3A-1**: Webhook handler is a 541-line God Function with 13 if/else branches — extract per-event-type modules under `lib/stripe-webhook-handlers/`
- **M3A-2**: `as unknown as typeof event` typing — every payload field uses `as Foo` casts. Import Stripe's typed interfaces.
- **M3A-3**: Stripe client instantiated inline via dynamic import at 2 sites. Create `lib/stripe.ts` singleton.
- **M3A-4**: No test coverage for `subscription.deleted`, `payment_failed`, `dispute.*`, `refunded`, `checkout.session.completed` webhook branches.
- **M3A-5**: `refreshStripeAccountStatus` called inside `withRlsBypass` starts its own `withTenantContext` — nested-transaction confusion.
- **M3A-6**: No centralised state-transition validator (`lib/member-status.ts` absent).
- **M3A-7**: `Member.stripeCustomerId` has no `@@unique([tenantId, stripeCustomerId])` constraint — DB-level invariant missing.
- **M3A-8**: Webhook outer catch is bare `catch { }` — bugs in handlers are silent.
- **M3A-9**: `payment_failed` owner-notification loop is serial — minor at 1 owner, avoidable.
- **M3A-10**: `Member(tenantId, paymentStatus)` no index — dashboard overdue queries scale concern.
- **M3A-11**: `Member.stripeSubscriptionId` no index — speculative for direct-subscription lookups.
- **M3A-12**: `/api/member/me` GET issues 3 sequential `withTenantContext` calls — fold to one.
- **M3A-13**: Hard-delete destroys `AttendanceRecord` history silently — undocumented in `lib/member-delete.ts`.
- **M3A-14**: Transfer-ownership not atomic — two sequential updates can leave tenant ownerless on crash.
- **M3A-15**: `paymentStatus = "free"` has no write path — orphaned schema value.
- **M3A-16**: `checkout` no Zod + no item-count cap (security M-A3-6) — partial fix in A3H-1.
- **M3A-17**: `Member.stripeCustomerId` cross-tenant collision possible — partial-unique constraint missing.

## NEW Low findings (append to backlog-low.md)

- **L3A-1**: No taster TTL or auto-conversion deadline.
- **L3A-2**: `paymentStatus = "paused"` semantics undefined for check-in access.
- **L3A-3**: `customer.subscription.created` ignored — undocumented choice.
- **L3A-4**: `customer.subscription.deleted` `updateMany` has no `status` precondition.
- **L3A-5**: `apply/route.ts` returns internal CUID.
- **L3A-6**: `checkout/route.ts orderRef` uses predictable `Date.now().toString(36)`.
- **L3A-7**: `stripe/connect/health` leaks NEXTAUTH_URL raw value.
- **L3A-8**: `cron/monthly-reports` CRON_SECRET not constant-time compared.
- **L3A-9**: `sendEmail` 2 sequential transactions per send — collapse to 1.
- **L3A-10**: `charge.refunded` + `invoice.voided` use 2-trip findFirst+update where updateMany suffices.

---

## Fix routing — Batch A (quick wins, low risk)

All of these are localised, single-file edits:
- **A3C-1**: webhook subscription.deleted + subscription.updated cancelled branch → add `status: "cancelled"`
- **A3C-2**: PATCH member route → erasure-pattern guard
- **A3H-1**: 6 routes × add `assertSameOrigin` (5 mutating) + add Zod to `checkout`
- **A3H-4**: 2 files × `totpRecoveryCodes: undefined → null`
- **A3H-5**: webhook `payment_intent.succeeded` → add `member.update` for paymentStatus
- **A3H-8**: 2 admin routes × add `member.updateMany` sessionVersion bump
- **A3H-10**: schema.prisma `@@index([tenantId, stripeCustomerId])` + hand-crafted migration

## Fix routing — Batch B (medium-effort, moderate risk)

- **A3H-2**: Refactor webhook `payment_failed` to defer email dispatch outside transaction
- **A3H-9**: ~10 `logAudit` calls across 6+ files for financial transitions

## Fix routing — Batch C (cross-cutting, higher risk)

- **A3H-3**: Extend `memberUpdateSchema` to allow `paymentStatus` PATCH with audit
- **A3H-6**: Staff PATCH `status="cancelled"` → call `cancelSubscriptionAtPeriodEnd`
- **A3H-7**: DSAR erase → call `cancelSubscriptionAtPeriodEnd` before anonymise

Batch C requires Stripe SDK calls; deserves careful smoke-test before merge.

After Batches A + B + C land + static gates pass → iter-2 to verify convergence (expect 0/0).
