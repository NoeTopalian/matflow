# Audit — Iteration 2, Area 6: Operator / admin

**Date**: 2026-06-01
**Branch**: `audit/loop-fixes-06` (HEAD post-Batch-A/B/C = 59a5165)
**Predecessor**: `iter-1-operator-admin.md` (closed 2 Critical + 9 High)
**Method**: 3 OMC subagents (security/verifier/perf) re-audit post-Batch-A/B/C.

## Convergence summary

| Agent | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security | 0 | **0** | 2 (LOW-end) | 1 |
| Verifier | 0 | **0** | 2 | 1 |
| Perf | 0 | 1 | 2 | 0 |

**Deduplicated NEW Critical**: 0.
**Deduplicated NEW High**: 1 (A6I2-P-1 — Stripe-cancel loop is serial).

**Security iter-2 verdict (verbatim)**: *"Result: 0 Critical + 0 High. This is clean pass 1 of 2 for the security consecutive-clean gate."*

**Verifier iter-2 verdict**: *APPROVE — all iter-1 closures verified. No new Critical or High gaps introduced by Batch A+B+C. Two Medium items appropriate for backlog.*

**iter-1 closures re-verified by all 3 agents**: A6I1-S-1, A6I1-S-3, A6I1-S-4, A6I1-S-5, A6I1-V-1, A6I1-V-2, A6I1-V-4, A6I1-P-1, A6I1-P-2, A6I1-P-3, A6I1-P-4 — all pass.

---

## NEW High finding (Batch D, this iter)

### A6I2-P-1 · Stripe-cancel loop is serial in suspend + soft-delete

- **Files**: `app/api/admin/customers/[id]/suspend/route.ts:73-79`, `…/soft-delete/route.ts:71-77`
- **Class**: Hot-path latency / Vercel timeout risk
- **Description**: Each `cancelSubscriptionAtPeriodEnd` is a ~500 ms Stripe API round-trip. The `for (const m of subs) { await … }` pattern serialises them. A tenant with 100 active member subscriptions blocks the Vercel function for ~50 s before reaching the atomic DB block. Neither route sets `maxDuration`, so the default 60 s timeout applies — 100 members is within reach of a timeout. Calls are independent (distinct `stripeSubscriptionId` values), safe to fan out.
- **Fix**: `Promise.allSettled` across the slice. Preserves the best-effort semantic (one Stripe failure ≠ abort). Also captures failed subscription IDs into the audit metadata (closes NEW-M-1 from verifier).

---

## NEW Medium findings (backlog — M-A6I2-*)

- **M-A6I2-1** (security): `makeTempPassword` modular bias — alphabet 31 chars, `byte % 31` introduces ~0.4 % per-character bias (~59.5 effective bits over 12 chars, vs theoretical 59.7). Practically unexploitable; defence-in-depth tightening only. (`app/api/admin/customers/[id]/force-password-reset/route.ts:29`)
- **M-A6I2-2** (security): Approval route logs activation magic-link token to console.warn when `RESEND_API_KEY` is unset. Intentional for dev; if staging runs without Resend the token appears in Vercel logs (operator-only access — minimal blast radius). (`app/api/admin/applications/[id]/approve/route.ts:185`)
- **M-A6I2-3** (verifier): Stripe-cancel failure detail — partly closed by A6I2-P-1 fix (failed IDs now in audit metadata). Backlog item: also `console.warn` the failed IDs for proactive monitoring.
- **M-A6I2-4** (verifier): `logAudit` is fire-and-forget for suspend/soft-delete/transfer-ownership; the 200 response races the DB write. `dsar/erase` already uses await-before-respond — apply the same pattern to these destructive routes for evidence integrity.
- **M-A6I2-5** (perf): `checkRateLimit` issues 2–3 sequential DB queries per request. Admin routes are low-traffic so impact is minor, but `RateLimitHit(bucket, hitAt)` lacks a composite index and the `count` may seq-scan.
- **M-A6I2-6** (perf): Import commit progress write per slice = 80 round-trips total (40 data + 40 progress). Could merge into the same transaction with no UX regression.

## NEW Low findings (backlog — L-A6I2-*)

- **L-A6I2-1** (security): Admin mutation routes other than upload lack `assertSameOrigin`. JSON content-type + `SameSite=Strict` cookies provide adequate defence-in-depth (CORS preflight + cookie scope); flagged for completeness only.
- **L-A6I2-2** (verifier): Transfer-ownership audit `tenantId` comes from URL param, not re-read from DB. Earlier `tenant.findUnique` guard catches mismatches (404), so safe in practice.

---

## Batch D — applied

A6I2-P-1: Replace `for { await cancel(...) }` with `Promise.allSettled(...)` in both suspend + soft-delete; also bake failed IDs into audit metadata (closes M-1 from verifier inline).

---

## Status

iter-2 = 0 Critical + 1 High (A6I2-P-1). Batch D applied. Static gates expected clean (no schema changes; small refactor in 2 files). **Next**: iter-3 audit to confirm 2-consecutive-clean gate. After audit-green: test-engineer phase, then merge PR #11.
