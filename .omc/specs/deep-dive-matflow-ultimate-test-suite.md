# MatFlow — Ultimate Test Suite (Ralph-Executable Spec)

**Status**: ready for execution
**Pipeline stage**: deep-dive output → Ralph
**Generated**: 2026-05-10
**Slug**: `matflow-ultimate-test-suite`
**Source trace**: `.omc/specs/deep-dive-trace-matflow-ultimate-test-suite.md`

## Goal

Stand up a comprehensive automated quality system for the MatFlow Next.js codebase that:
- Combines Playwright (frontend journeys), Vitest (backend correctness, concurrency, RLS), and LLM agent code review (auth-bypass, secrets, signature hygiene)
- Runs in a Ralph self-iterating loop driven by a frozen-then-append-only error catalogue
- Systematically eliminates the documented error patterns in `40-Projects/matflow/matflow-common-errors.md` and `defensive-engineering-reference.md`
- Has explicit, hardened coverage of: booking/unbooking races, admin/owner privilege manipulation, cross-table data contradictions, ease-of-use regressions

## Constraints

- Existing test infra: Vitest (~62 unit, ~5 integration), Playwright (~13 e2e specs, chromium + Mobile Chrome). Don't replace; extend.
- Existing CI: `.github/workflows/ci.yml` runs typecheck + Vitest with `continue-on-error: true` because of ~143 RB-001 mock-drift failures. Loop must scope `npm test` to its own changed files OR fix RB-001 as iteration 0.
- Vercel build window: 10 min. Don't add Playwright to CI (would blow window).
- Local dev DB is production Neon — chaos/concurrency tests must run against an ephemeral Neon branch, not main.
- Solo founder, 10-15 hrs/wk post-3-June; loop must be fully autonomous between checkpoints.

## Non-Goals

- Replacing Vitest or Playwright with another framework.
- 100% coverage as a target — coverage is a means, not the goal.
- Auto-fixing the RB-001 mock-drift failures inside the same loop (separate iteration 0).
- Property-based testing (out of scope for v1).
- Production chaos testing across multiple Vercel instances (out of scope for v1; flagged as Lane 2's critical unknown).

## Acceptance Criteria

- [ ] `.omc/ralph/error-catalogue.json` exists with ~80 seeded items (Lane 2 master table + Lane 1 route gaps + RB-001 + repo TODOs).
- [ ] `.omc/ralph/reviewer-prompt.md` contains the 6 hard-fail-check reviewer prompt verbatim from this spec.
- [ ] `.omc/ralph/learnings.md` exists (created empty; populated by reviewer's PASS verdicts).
- [ ] Pre-flight: 3 planted-bug probes have run against the reviewer; all 3 produced FAIL verdicts on the correct check.
- [ ] Iteration 0 fixes RB-001 mock-drift OR the reviewer prompt scopes `npm test` to changed files (decided + documented).
- [ ] One parameterised Vitest integration suite at `tests/integration/cross-tenant-authorisation-matrix.test.ts` exists, drives off Prisma models with `tenantId`, asserts GET/PATCH/DELETE return 404 and leave row byte-identical.
- [ ] Ralph loop runs to completion of one full pass (~80 iterations) OR halts at the 100-iter safety stop with surfaced reasons.
- [ ] Final report: every catalogue item has either a passing test (route + role + assertion all reference the item) or is explicitly marked `wontfix` with a reasoned comment.
- [ ] Stop predicate satisfied: catalogue zero open + last 5 reviewer verdicts PASS + ≥60% line coverage on `app/api/` and `lib/`.
- [ ] No regressions: pre-loop `npm run lint && npm run build` exit codes are still 0 after the loop completes.

## Approach

### Phase A — Pre-flight (one-shot, before the loop)

1. **Build the catalogue.** Single agent run produces `.omc/ralph/error-catalogue.json`:
   ```json
   [
     {
       "id": "ULT-001",
       "suspected_failure": "Class capacity overrun: 2 members book last spot simultaneously",
       "route_or_module": "app/api/member/classes/[id]/book/route.ts",
       "severity": "CRITICAL",
       "evidence_hint": "common-errors §2; defensive-eng §3.4 atomic UPDATE pattern",
       "test_type": "vitest-integration",
       "explicit_assertion": "Spawn 5 Promise.all calls against capacity=1; expect((await tx.attendanceRecord.count(...))).toBe(1) and 4 × 409",
       "status": "open"
     }
     // ~79 more
   ]
   ```
   Source: Lane 2's 60-row master table + Lane 1's coverage matrix gaps + the 11 known RB-001 failures + every `// TODO`/`// FIXME` in `app/` and `lib/`.

2. **Save the reviewer prompt.** Write the prompt below verbatim to `.omc/ralph/reviewer-prompt.md`. Ralph references it from config.

3. **Run the 3 planted-bug probes.** For each, plant the bug on a throwaway branch, run one Ralph iteration, assert the reviewer FAILs on the correct check:
   - Probe 1: `app/api/members/route.ts` `where: { tenantId }` → `where: {}`. Reviewer must FAIL on check 4 (tenant-scope-bypass).
   - Probe 2: take a real failing test in `tests/unit/refund-atomicity.test.ts`, "fix" it by tuning the expected value. Reviewer must FAIL on check 2 (suppression — expectation tuning).
   - Probe 3: write a test body of `expect(1).toBe(1)` for any catalogue item. Reviewer must FAIL on check 1 (no real assertion).
   If any probe is rubber-stamped, edit the reviewer prompt before continuing. Cost: ~$1.20 (Sonnet), ~20 min wall-clock.

4. **Decide RB-001 strategy.** Either run iteration 0 to fix the ~143 mock-drift failures (clean slate), or accept that the reviewer prompt scopes `npm test` to changed files only. Document the decision in `.omc/ralph/learnings.md` line 1.

### Phase B — Loop (autonomous, ~80 iterations)

Per iteration:
1. Ralph executor pops the oldest `status: open` item from `error-catalogue.json` (severity CRITICAL > HIGH > MEDIUM > LOW within timestamp order).
2. Executor writes a test for the suspected failure using the test type assigned in the catalogue:
   - **vitest-integration**: under `tests/integration/`, follows `tests/integration/rls-foundation.test.ts` seed/teardown pattern.
   - **vitest-unit**: under `tests/unit/`.
   - **playwright-e2e**: under `tests/e2e/`, follows `tests/e2e/auth/login.spec.ts` pattern.
   - **agent-review**: a one-shot agent task that audits diffs / patterns; result is a markdown report committed under `tests/audits/`.
3. Executor runs the test. If it fails (the bug really exists), executor fixes the underlying code with the smallest possible change.
4. Executor runs `npm run lint && npx tsc --noEmit && npm test -- --run <test_paths> && npm run build`.
5. If the executor produced an `e2e` spec, also runs `npm run test:e2e <spec>`.
6. Reviewer prompt fires (separate context window — see Phase C). Inputs: catalogue item, executor diff, test paths, captured output.
7. On reviewer PASS: catalogue item marked `status: closed`; reviewer's `learning` line appended to `.omc/ralph/learnings.md`.
8. On reviewer FAIL: catalogue item stays `open`, executor's diff is reverted, the FAIL reasons are appended to the catalogue item's `attempts` array. Executor must shrink scope or change approach next iteration.
9. Every 5 iterations = one milestone:
   - Run full `tests/integration/` (not just changed files).
   - Run full Playwright e2e (chromium + Mobile Chrome).
   - Spin up an ephemeral Neon branch and run any tagged `concurrency-stress` tests against it. Drop branch.
   - Run `vitest --coverage` and append `coverage.lcov.summary` to `.omc/ralph/coverage-history.json`.
10. Every 25 iterations: also run Playwright Lighthouse on the 5 critical routes (`/`, `/login`, `/dashboard`, `/member/home`, `/dashboard/settings`). Diff against last run; flag regressions.

### Phase C — Reviewer prompt (verbatim, save to `.omc/ralph/reviewer-prompt.md`)

```
You are the verification reviewer for one Ralph iteration on the MatFlow
repository. You have NO authority to write code. Your only output is a
single JSON object: {"verdict": "PASS"|"FAIL", "reasons": [...], "learning": "..."}.

Inputs you will receive:
- catalogue_item: {id, suspected_failure, route_or_module, severity}
- executor_diff: unified diff of all files changed this iteration
- test_paths: list of new/modified test files (always under tests/)
- captured_output: stdout+stderr from `npm run lint && npx tsc --noEmit
  && npm test -- --run <test_paths> && npm run build`
- (optional) e2e_output: stdout+stderr from `npm run test:e2e <spec>` if
  the executor produced a Playwright spec

You MUST FAIL the iteration if ANY of the following is true. Quote the
exact line/file in `reasons` for each failure you cite.

1. The new test does not exercise the catalogue_item.suspected_failure.
   Specifically: the test body must reference the route/module named in
   catalogue_item.route_or_module AND assert on the symptom (status code,
   DB row, rendered text, redirect URL) named in suspected_failure.
   A test that only asserts `expect(true).toBe(true)`, only mocks the
   thing it claims to test, or only checks "no throw" is FAIL.

2. The fix is suppression, not repair. Suppression patterns to FAIL on:
   - Wrapping the failing call in try/catch with no rethrow and no log.
   - Loosening a Zod schema to accept the bad input instead of validating.
   - Changing an assertion's expected value to match buggy output.
   - Adding `// eslint-disable`, `@ts-expect-error`, or `as any` near the
     bug site without an inline justification comment of >=20 chars.
   - Deleting a previously-passing test in the same diff.

3. No regression test exists. The iteration MUST add at least one test
   that, when reverted to pre-fix code (mentally simulate by reading the
   diff backwards), would fail. If the test would still pass against
   pre-fix code, FAIL.

4. Tenant scoping is broken. If the diff touches any file in app/api/,
   app/dashboard/, lib/reports.ts, or any prisma query, and that query
   does NOT go through withTenantContext OR include `where: { tenantId }`,
   FAIL with reason "tenant-scope-bypass". Reference CLAUDE.md.

5. Build/lint/typecheck/test gate. If captured_output contains any of:
   "error TS", "ESLint:", "FAIL ", "Build error", non-zero exit code
   in the trailing summary line — FAIL.

6. Scope creep. If the diff modifies more than 5 files OR more than 200
   lines of non-test code, FAIL with reason "scope-too-wide" (Ralph must
   shrink the iteration). Test files do not count toward this limit.

PASS only if all six checks are clean. On PASS, also emit a one-line
`learning` field summarising what the bug taught about MatFlow — this is
appended to .omc/ralph/learnings.md and is the only persistent state the
next iteration's executor sees from this one.
```

### Phase D — Stop predicate

```
STOP when ALL THREE hold simultaneously at the end of an iteration:
(a) error-catalogue.json has zero status: open items
(b) the last 5 consecutive reviewer verdicts are PASS
(c) `npm test -- --run` exit code is 0 AND `vitest --coverage` summary
    shows >= 60% line coverage on app/api/ AND lib/
    (measured at milestone boundaries, not every iteration)

SAFETY: if 100 iterations have run and any of (a)(b)(c) still fail,
halt and surface to the human with the open catalogue items + recent
FAIL reasons.
```

### Phase E — Single highest-leverage test (run as iteration 1)

A parameterised Vitest integration suite that, for every Prisma model with a `tenantId` column, asserts cross-tenant access fails:

```ts
// tests/integration/cross-tenant-authorisation-matrix.test.ts
// Layered onto tests/integration/rls-foundation.test.ts seed/teardown infra.
// For each model M with tenantId:
//   1. Seed two tenants A and B, with one row of M in each.
//   2. As tenantA staff (owner/manager/coach/admin), GET /api/<resource>/{tenantBRowId} → expect 404.
//   3. As tenantA staff, PATCH /api/<resource>/{tenantBRowId} with mutating body → expect 404 AND prisma.<m>.findUnique({id: tenantBRowId}) is byte-identical to before.
//   4. As tenantA staff, DELETE /api/<resource>/{tenantBRowId} → expect 404 AND row still exists.
```

This single suite catches every authorisation-drift bug at once. Ship it as iteration 1 (or as a probe before the catalogue, if the cataloguer agent exposes it earlier).

## Files to modify / create

**Create:**
- `.omc/ralph/error-catalogue.json` — the seeded catalogue
- `.omc/ralph/reviewer-prompt.md` — the verbatim reviewer prompt
- `.omc/ralph/learnings.md` — append-only learning log
- `.omc/ralph/coverage-history.json` — milestone coverage snapshots
- `tests/integration/cross-tenant-authorisation-matrix.test.ts` — Phase E parameterised suite
- `tests/audits/` — directory for agent-review audit reports
- (later, per iteration) ~30-50 new test files across `tests/unit/`, `tests/integration/`, `tests/e2e/`

**Modify:**
- `package.json` — possibly add `npm run loop` script that invokes ralph with the spec path
- `.github/workflows/ci.yml` — possibly fix RB-001 scoping if iteration 0 takes that path

**Untouched (out of scope):**
- Production code under `app/` and `lib/` is touched only when an iteration's bug is real and the fix is in scope (≤5 files / ≤200 non-test lines per the reviewer's check 6)

## Verification

1. **Pre-loop**: 3 planted-bug probes all produce reviewer FAILs on the expected check. Documented in `.omc/ralph/learnings.md` line 1-3.
2. **Mid-loop**: every 5 iterations, milestone gate passes — full integration + e2e run + coverage snapshot.
3. **Post-loop**: stop predicate D satisfied OR safety halt at 100 iterations with surfaced reasons.
4. **Manual sanity check**: run `npm run lint && npm run build && npm test` in repo root → all exit code 0. Review `.omc/ralph/learnings.md` for the executor's per-iteration insights — should contain ~80 distinct learnings about MatFlow's failure modes.
5. **Cost reconciliation**: total LLM spend ≤ $35 (Sonnet) for one full pass. Neon branch costs ≤ $0.50.

## Trace Findings (carried forward)

- The kiosk-token surface (`app/kiosk/[token]/*`) has zero coverage proving entropy / cross-tenant isolation / rotation invalidation. Catalogue items ULT-KIOSK-001..005 cover this.
- Distributed serverless concurrency cannot be reproduced in Vitest or Playwright. Catalogue items tagged `concurrency-stress` run against an ephemeral Neon branch at milestone boundaries; production-instance racing is flagged as a v2 concern.
- The reviewer prompt's check 2 (suppression patterns) is the single load-bearing line. Pre-flight planted-bug probes validate it before any real iteration.
- 11 RB-001 mock-drift failures are in `tests/unit/` and currently bypassed by `continue-on-error: true` in CI. They must be either fixed in iteration 0 or scoped out of `npm test` per the reviewer prompt.

## Out of scope

- Property-based testing (consider for v2).
- Mutation testing (Stryker — consider for v2).
- Production chaos testing across two Vercel preview instances behind a load balancer (Lane 2's critical unknown — needs separate infra work).
- Building the staging Neon branch as a permanent fixture (Priority #2 from the previous deep-dive trace; should be done before this loop runs to make the loop's milestone Neon branches cheaper).
