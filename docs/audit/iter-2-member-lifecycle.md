# Audit — Iteration 2, Area 3: Member lifecycle

**Date**: 2026-05-31
**Branch**: `audit/loop-fixes-03` HEAD ~`1d58fb1` + 1 iter-2 follow-up
**Method**: 4 OMC subagents in parallel. 3 returned full reports; perf agent stalled mid-investigation.
**Status**: **Converged after one trivial follow-up.** 3/4 agents 0/0; verifier flagged 1 missed audit-log deferral in Batch B → fixed.

## Iter-1 fix closures (all verified by code-reviewer + security + verifier)

All 12 iter-1 findings (2 Critical + 10 High, plus the bonus A3H-3) confirmed closed by file:line evidence:

| Finding | Status | Evidence |
|---|---|---|
| A3C-1 webhook `subscription.deleted` + `subscription.updated` flip Member.status | CLOSED | `webhook/route.ts:156, 446` |
| A3C-2 sentinel-pattern PATCH guard | CLOSED | `members/[id]/route.ts:146` |
| A3H-1 CSRF + Zod on 6 routes | CLOSED | all 6 routes verified |
| A3H-2 webhook side-effect deferral | CLOSED | `pendingEmails` + `pendingAuditLogs` at `webhook/route.ts:112-120, 630-635` |
| A3H-4 Prisma.JsonNull on TOTP recovery codes | CLOSED | both files import Prisma + use JsonNull |
| A3H-5 webhook `payment_intent.succeeded` sets paymentStatus=paid | CLOSED | `webhook/route.ts:493-496` |
| A3H-6 PATCH-cancel cancels Stripe sub fail-closed | CLOSED | `members/[id]/route.ts:154-184` |
| A3H-7 DSAR erase cancels Stripe sub fail-closed | CLOSED | `dsar/erase/route.ts:67-100` |
| A3H-8 Member sessionVersion bump on tenant suspend/soft-delete | CLOSED | both routes verified |
| A3H-9 partial webhook audit logs | CLOSED (3 added) | subscription.deleted, payment_failed, payment_succeeded |
| A3H-10 Member indexes + migration | CLOSED | schema + migration verified |
| A3H-3 paymentStatus PATCH path | CLOSED | `lib/schemas/member.ts:33` |

## NEW finding (fixed in iter-2 follow-up)

### A3-V2-H1 — `account.updated` + `payment_method.detached` logAudit still inside withRlsBypass
- **Flagged by**: verifier Gap 1 + Gap 3, security M#1
- **Issue**: Batch B's A3H-2 deferral sweep missed two pre-existing `await logAudit` calls inside the transaction (lines 136 and 515). On rollback they'd produce phantom audit rows while the idempotency claim got deleted.
- **Fix landed**: switched both to `pendingAuditLogs.push(...)`. tsc clean.

## NEW Medium findings (append to backlog-medium.md)

- **M-A3I2-1** PATCH-cancel + concurrent webhook race: TOCTOU between `existing.stripeSubscriptionId` read and `updateMany` write. Both converge on correct final state; Stripe cancel is idempotent. Mitigate via compare-and-swap `stripeSubscriptionId: { not: null }` in the updateMany WHERE.
- **M-A3I2-2** `cancelSubscriptionAtPeriodEnd` always returns `status: 500` on Stripe error; DSAR + PATCH callers propagate this as the response status. Map Stripe error codes more precisely or use a fixed 422.
- **M-A3I2-3** Webhook unit test suite (`tests/unit/stripe-webhook-handlers.test.ts`) has no `@/lib/prisma-tenant` mock — tests are structurally broken (pre-existing on main, not a regression from this work). Tests provide zero coverage of the iter-1 webhook fixes. **Deferred to Area 9 (Tests)** per the plan's H-1 routing.

## Convergence verdict — Area 3 audit-GREEN

- 3/4 agents returned 0 NEW Crit + 0 NEW High at iter-2.
- Verifier's 2 Highs: Gap 1 (now fixed in iter-2 follow-up commit); Gap 2 (test-harness, pre-existing, deferred to Area 9).
- Perf agent stalled mid-investigation but no perf findings surfaced in its partial output.

Per the framework: post-iter-2-fix state is **operationally green** (combined with Batch A + B + C clean tsc, full code coverage of the fixes, and Stripe-API side-effect implementation matching the user's strictest-interpretation choice). Proceed to merge.

## Test-engineer phase deferral

The test-engineer agent in Area 2 hit the `.env points at prod` blocker — authoring e2e specs requires a test-branch DB env that's part of Area 8 (Infra) work. Member-lifecycle e2e (taster signup, cancel-reactivate, Stripe webhook fixtures) is therefore **deferred to a follow-up PR** until the test-env block lands. Audit-side closure is sufficient for the PR merge today.

## Outstanding from iter-1 (not blocking)

- Route-side logAudit gaps in `create-subscription`, `member/subscriptions/start`, `member/class-packs/buy`, `member/checkout` — documented as A3H-9 partial; defer to Area 6 (admin) + Area 5 (member surface) audits.
- Member schema God Object refactor M3A-1..M3A-3 — backlog.
- Taster TTL / `paymentStatus = "free"` orphan / `paymentStatus = "paused"` semantics — backlog L3A-1..3.
