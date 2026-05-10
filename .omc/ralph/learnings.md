# Ralph Loop Learnings — MatFlow Ultimate Test Suite

Append-only log of per-iteration learnings emitted by the reviewer's PASS verdicts. Each entry is one line: `iter | catalogue_id | learning`.

## Pre-flight (probes — 2026-05-10)

probe-1 | tenant-scope-bypass | Reviewer correctly fails on check 4 when a prisma query in `app/api/` loses its `tenantId` filter, even when the test passes. Defence-in-depth: also flagged checks 2 (suppression-by-removal) and 3 (no regression test).
probe-2 | expectation-tuning | Reviewer correctly fails on check 2 when an existing assertion's expected value is changed to match buggy output, even with a comment justifying the change. Defence-in-depth: also flagged checks 1 (no real symptom assertion) and 3 (no regression test added).
probe-3 | tautology | Reviewer correctly fails on check 1 when a test body is `expect(1).toBe(1)` and does not reference the catalogue route. Defence-in-depth: also flagged checks 3 (no regression test) and 2 (suppression-by-omission of any actual fix).

**Verdict**: reviewer prompt is hardened against the three documented suppression patterns. Loop is safe to run.

## RB-001 strategy (decided 2026-05-10)

Decision: scope `npm test` to changed files per the reviewer prompt's check 5, rather than fixing the ~143 RB-001 mock-drift failures as iteration 0. Rationale: those failures are unrelated to the loop's catalogue and would consume the entire build window; the per-iteration scoping isolates the loop's gate from them. Iteration N+1 may include "fix RB-001 mock drift" as its own catalogue item if it surfaces.

---

## Loop iterations

iter-1 | NEW (DELETE consistency, was unreserved id) | DELETE handlers using `deleteMany({where:{id, tenantId}})` silently return 200 even when count=0 (cross-tenant or already-deleted). Inconsistent with GET/PATCH which return 404. Tenant filter is correct (no data leak), but HTTP semantics mislead callers and mask reconnaissance. Fix: check `result.count === 0 → 404`. Pattern likely repeats in other DELETE/PATCH handlers using `*Many` operations — worth grepping `app/api/**/route.ts` for `deleteMany|updateMany` and adding a count-check audit as a follow-up catalogue item.

iter-2 | ULT-066 (NEW, Many-mutator audit) | Audited 13 [id] mutator handlers using deleteMany/updateMany. 10 already correct (count-checked); 3 had the iter-1 bug pattern: announcements/[id] DELETE, classes/[id] DELETE (soft), initiatives/[id]/attachments DELETE. Fixed with the same early-404 pattern. Lesson: PATCH handlers were uniformly correct, DELETE handlers were the weak spot — likely because PATCH already had concurrency-aware error reasoning whereas DELETE was treated as fire-and-forget. Recommendation for future Ralph iterations: when a new DELETE handler ships, the reviewer prompt's check 1 should explicitly verify it differentiates 404 from 200.

iter-3 | ULT-001 reframed + NEW (kiosk pack race) | ULT-001 ("class capacity overrun") was misframed: MatFlow has no booking/capacity system, only check-in. While reading lib/checkin.ts, found a real concurrency bug in the kiosk path's pack credit decrement (lines 220-246): used findFirst → unguarded update.decrement instead of the atomic updateMany guard the self-path uses. Two parallel kiosk check-ins for the same member could decrement the same pack's credits below zero. Fix: copied the self-path's atomic pattern (updateMany with creditsRemaining gt:0 filter, count===0 means race lost). Regression test at tests/integration/checkin-pack-race.test.ts asserts pack.creditsRemaining never goes negative under Promise.all concurrent kiosk check-ins.
