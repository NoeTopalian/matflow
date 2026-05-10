# Deep Dive Trace: matflow-ultimate-test-suite

## Observed Result

User asked for an "ultimate testing/quality/error detection test" combining Playwright (frontend) and code-reading (backend), runnable in a Ralph self-iterating loop, comprehensive across the entire program (every site/route/role), with explicit emphasis on booking/unbooking, admin-and-owner account manipulation, contradictory data, ease-of-use, and efficiency. Source notes already in vault: `40-Projects/matflow/cursor-primer.md`, `matflow-common-errors.md`, `defensive-engineering-reference.md`, `context.md`.

Three parallel lanes investigated the design: Lane 1 (coverage × surface inventory), Lane 2 (error pattern × severity → test mapping), Lane 3 (Ralph loop architecture × cost budget).

## Ranked Hypotheses (post-trace)

| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|-----------|------------|-------------------|--------------|
| 1 | A three-tool partition (Playwright e2e + Vitest integration + agent code review) is required — no single tool covers all the error patterns from the source notes. | High | Strong — Lane 1 produced a 12-row table where each row's owner is justified by what the other tools structurally cannot do (e.g. RLS needs real Postgres, auth-bypass needs diff-reading, journeys need a real browser). | Without this partition, ~30% of the error catalogue from Lane 2 would have no testable owner. |
| 2 | Ralph iteration unit must be "one discovered failure per iteration", popped from a frozen catalogue built once before the loop starts. | High | Strong — Lane 3 evaluated all four candidate iteration units (route×role, error category, file, discovered failure) and showed only D converges on real coverage in a finite count. | Iteration unit A wastes 80% of cycles on combos sharing one auth helper; B is too coarse to verify; C is biased to LOC not risk. |
| 3 | The single highest-leverage test is a parameterised Vitest integration suite over every Prisma model with `tenantId`, asserting cross-tenant GET/PATCH/DELETE all return 404 and leave the row unchanged. | High | Strong — Lane 2 identified authorisation drift (def-eng §1.1) as the single largest vibe-coded failure category; this one parameterised suite catches every instance of it. | Layers onto existing `tests/integration/rls-foundation.test.ts` infra. Cheapest single high-yield test. |
| 4 | The reviewer prompt is the load-bearing piece — if the reviewer rubber-stamps suppression-style "fixes", the loop will marker-pen its way to green while leaving the product broken. | High | Strong — Lane 3 made this its critical unknown and provided three specific planted-bug probes to validate. | Architecture has no fallback if the reviewer is blind. |

## Evidence Summary by Hypothesis

- **H1 (three-tool partition)**: Lane 1's table maps 12 distinct concerns to tools by structural fit. Hidden-route auth bypass + webhook signature hygiene + email config drift all go to *agent code review* because they're diff-readable but expensive to runtime-exercise. RLS / concurrency / idempotency stay with Vitest integration. User journeys + visual + perf stay with Playwright.
- **H2 (failure-driven iteration)**: Lane 3 pre-loop catalogue size estimated at ~80 items. Catalogue is append-only (executor adds discovered failures mid-iteration). Loop converges when queue empties twice in a row.
- **H3 (parameterised cross-tenant suite)**: Lane 2's master table contains 60 rows, of which ~15 are cross-tenant authorisation tests. A single parameterised suite collapses these into one file driven off `Object.keys(prisma)` filtered by models with `tenantId`.
- **H4 (reviewer is load-bearing)**: Lane 3 specified the exact reviewer prompt with 6 hard-fail checks. Most important: check 1 (test must reference catalogue route + assert symptom) kills tautologies; check 2 (suppression patterns) kills "fix by silencing"; check 4 (tenant scope) hard-codes the project's biggest invariant.

## Evidence Against / Missing Evidence

- **H1**: The agent-code-review leg adds LLM cost per iteration (~$0.20 Sonnet, ~$1-3 Opus). For a small codebase changing slowly, paying for review on every diff may be more than the value caught. Counter: still cheaper than the next undetected production bug.
- **H2**: A frozen catalogue can become stale if the codebase mutates between catalogue-build and loop-finish. Mitigation: append-only design + executor adds new findings each iteration.
- **H3**: Some Prisma models have `tenantId` only as a denormalised field (e.g. `AttendanceRecord` has `tenantId` indirectly via `Member`). The parameterised suite needs a per-model fixture map, not just blind iteration.
- **H4**: Six checks may not exhaust the suppression patterns LLMs invent. Probe (3 planted bugs) only validates against known patterns.

## Per-Lane Critical Unknowns

- **Lane 1 (Coverage × Surface)**: The kiosk-token threat surface (`app/kiosk/[token]/page.tsx` + `api/kiosk/[token]/*`) uses an unsigned URL token as the entire auth artefact with **zero** test coverage proving entropy / cross-tenant isolation / rotation invalidation. Single biggest hole.
- **Lane 2 (Error × Severity)**: Distributed serverless concurrency + service-worker cache invalidation timing — neither Vitest (in-process) nor Playwright (single-browser) can reliably reproduce two Vercel instances racing on a shared row. Needs staging-branch chaos test or a static-audit agent grep over read-modify-write call sites.
- **Lane 3 (Ralph × Cost)**: Whether Ralph's reviewer prompt actually catches a planted suppression. If check 2 fails to fire on `try { } catch {}` "fixes", the loop's gate is blind.

## Rebuttal Round

- **Best rebuttal to H1 (three-tool partition)**: "Just use Playwright for everything — modern Playwright can hit the DB via Prisma in test fixtures and read source files." *Why it fails*: Playwright cannot reliably reproduce concurrency races (single browser context), cannot replay webhooks deterministically with valid signatures, and cannot grep diffs for hardcoded secrets across 110 route handlers. The structural reasons for the partition hold.
- **Best rebuttal to H2 (failure-driven iteration)**: "A route×role product is more comprehensive — the catalogue might miss latent issues that only show in specific route×role combos." *Why it partly holds*: True — but the executor is instructed to add discovered failures to the catalogue, so the catalogue grows during the loop. After the first full pass, run a route×role sweep as a milestone to catch any combo gaps.

## Convergence / Separation Notes

All three lanes converge on a small set of meta-decisions:
- **Test partition is non-negotiable**: 3 tools, each owning what only they can do.
- **Catalogue-driven iteration**: ~80 items, oldest-severe first, append-only.
- **Reviewer is the load-bearing piece**: 6 hard-fail checks, separate context window from executor.
- **Pre-flight planted-bug probes**: 3 specific bugs validate the architecture before the real loop runs.
- **Stop condition is a 3-way conjunction** (catalogue empty + 5 consecutive PASS + ≥60% coverage): each axis is individually gameable; only the conjunction is robust.

Lane 2's master error table feeds Lane 3's catalogue directly (the 60-row table is the seed).

## Most Likely Explanation

The optimal architecture is a **catalogue-driven Ralph loop with a 3-tool execution partition and a hardened reviewer**. Day-1 setup: build the catalogue (one-shot cataloguer agent run combining Lane 2's table + Lane 1's coverage gaps + RB-001 known mock-drift failures + repo TODOs). Pre-flight: run 3 planted-bug probes to validate the reviewer. Then the loop runs ~80 iterations across ~16 milestones at ~$32 LLM cost (Sonnet) for one full pass, finishing in ~6 hours wall-clock.

The single biggest risk is reviewer blindness — addressed by the planted-bug probes before any real iteration runs.

## Critical Unknown

Whether Ralph's reviewer prompt, as drafted by Lane 3, actually catches a planted `try { } catch {}` suppression. The 3 planted-bug probes are the cheapest insurance against this; total cost ~$1.20 in LLM time and ~20 min wall-clock.

## Recommended Discriminating Probe

Run the three planted-bug probes specified in Lane 3 §"Recommended discriminating probe" *before* invoking the real Ralph loop:

1. Branch `ralph-probe-1`: replace `where: { tenantId }` with `where: {}` in one route → reviewer must FAIL on check 4 (tenant-scope-bypass).
2. Branch `ralph-probe-2`: "fix" a real failing test by changing expected value → reviewer must FAIL on check 2 (suppression — expectation tuning).
3. Branch `ralph-probe-3`: write a tautological test (`expect(1).toBe(1)`) → reviewer must FAIL on check 1 (no real assertion).

If all three are caught, the loop is safe to run. If any are rubber-stamped, edit the reviewer prompt before any real work.
