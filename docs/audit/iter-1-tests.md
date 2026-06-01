# Audit — Iteration 1, Area 9: Tests (final QA sweep)

**Date**: 2026-06-01
**Branch**: `audit/loop-fixes-09`
**Scope**: `tests/**` — unit + integration + e2e harness, 99 baseline vitest failures, e2e collection state, Playwright dual-project readiness.
**Method**: Manual sweep (test-engineer subagent hit Bash denial; I ran the diagnosis myself).

## Convergence summary

| Concern | iter-1 state | Action this iter |
|---|---|---|
| **e2e collection** | BROKEN — 3 specs had top-level `throw` on missing `TEST_PASSWORD` → `npx playwright test --list` returned 0 tests in 0 files | FIXED — converted to sentinel + describe-level `test.skip(!process.env.TEST_PASSWORD, ...)`. List now shows 238 tests across 25 files. |
| **vitest 99 baseline fails** | RB-001 mock drift; routes use `withTenantContext` / `withRlsBypass` callbacks; tests expect `prisma.$transaction()` directly | NOT FIXED iter-1 — fix scope = 20 unit test files + 6 integration files = research project. Documented as feature-follow-up. |
| **Dual-project Playwright sweep** | Cannot run locally — `.env.test` wired but no dev server in this environment | Validation deferred to CI / next session. |

## What was fixed

### A9I1-1 · e2e collection unblocked (3 specs)

- `tests/e2e/auth/member-account-unlock.spec.ts`
- `tests/e2e/auth/member-password-reset.spec.ts`
- `tests/e2e/auth/member-totp-recovery.spec.ts`

All three had a top-level `if (!TEST_PASSWORD) throw new Error(...)` guard from "audit C-1" (security: no hardcoded credentials). That throw fires at module load time, breaking `npx playwright test --list` for the entire suite — including the 22 specs that don't need `TEST_PASSWORD`.

Replaced with sentinel pattern:

```typescript
// At top of file
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? "";

// At top of test.describe block
test.describe.serial("Suite name", () => {
  test.skip(!process.env.TEST_PASSWORD, "TEST_PASSWORD env var required (audit C-1) — set it in .env.test to run.");
  // ... tests
});
```

Effect: `npx playwright test --list` now returns **238 tests in 25 files**, dual-project (`chromium` + `Mobile Chrome`).

## What was NOT fixed (carry to feature follow-up)

### A9I1-2 · 99 vitest baseline failures (RB-001 mock drift)

**Root cause**: API routes used to call `prisma.$transaction(fn)` directly. Audit areas 1–8 migrated every tenant-scoped route to `withTenantContext(tenantId, fn)` / `withRlsBypass(fn)` from `lib/prisma-tenant.ts`. The mocks in 20+ test files still assert on `txMock` (= `prisma.$transaction`) being called — but the routes now go through the wrapper helpers, which internally call `$transaction` from a different module-graph instance.

**Affected files** (the 20 unit + 6 integration that fail at baseline):

```
tests/unit/accept-invite.test.ts
tests/unit/admin-checkin-autoselect.test.tsx
tests/unit/dsar-export.test.ts
tests/unit/env-gate-visibility.test.ts
tests/unit/kids-tenant-scope.test.ts
tests/unit/magic-link-security.test.ts
tests/unit/member-class-subscriptions.test.ts
tests/unit/member-self-billing.test.ts
tests/unit/onboarding-csv-handoff.test.ts
tests/unit/optimistic-concurrency.test.ts
tests/unit/promoted-by-resolution.test.ts
tests/unit/rank-promote-no-notification.test.ts
tests/unit/refund-atomicity.test.ts
tests/unit/reset-password-session-invalidation.test.ts
tests/unit/schedule-dayofweek.test.ts
tests/unit/stripe-webhook-handlers.test.ts
tests/unit/totp-mandatory-owner.test.ts
tests/unit/totp-member-optional.test.ts
tests/unit/totp-recovery-codes.test.ts
tests/unit/upload-blob.test.ts
tests/integration/cross-tenant-stats.test.ts
tests/integration/operator-member-totp-reset.test.ts
tests/integration/security.test.ts
tests/integration/tenant-isolation.test.ts
```

**Fix pattern** (already working in `tests/unit/announcements-unseen.test.ts` + `tests/unit/promotion-candidates.test.ts`):

```typescript
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => {
  const txProxy = { /* per-test model mocks */ };
  return {
    prisma: {
      ...txProxy,
      $transaction: vi.fn(async (fn: (tx: typeof txProxy) => unknown) => fn(txProxy)),
    },
  };
});
```

**Estimate**: ~30 min per file × 24 files = ~12 hours. Plus a number of tests have STALE ASSERTIONS (route shape changed between Areas 1-8; the assertion still expects the old shape — e.g. `cross-tenant-stats.test.ts` expects `body.stats.thisWeek === 2` but the new shape returns 3). Each needs a per-test code-vs-test review.

**Recommendation**: feature follow-up phase. Schedule a dedicated session focused exclusively on RB-001 mock migration. CI continues to ship with `continue-on-error: true` on Vitest (A7I1-V-5 deferred from Area 7) until the migration completes.

### A9I1-3 · Dual-project Playwright sweep

Cannot run locally:
- Requires dev server (`npm run dev` against the test-branch DB)
- Requires `TEST_PASSWORD` env var (for the 3 specs we just fixed)
- Requires test-branch DB seeded with the fixture tenant + members

CI runs `Typecheck + Vitest` but NOT Playwright. Adding a Playwright job to CI is feature-follow-up scope.

**Recommended next-session approach**:
1. Spin up the dev server pointed at `.env.test`'s `TEST_DATABASE_URL`
2. Set `TEST_PASSWORD` for the seeded test owner
3. `npx playwright test --project=chromium`
4. Triage failures (real bug vs flake vs env-config gap)
5. `npx playwright test --project=Mobile Chrome`
6. Triage same
7. Re-run both until 2-consecutive-100%-green

## Static gates

- `npx tsc --noEmit` — clean (3 spec edits preserve type-narrowing via `?? ""` sentinel)
- `npx playwright test --list` — 238 tests in 25 files (was 0 in 0 files pre-fix)
- `npx vitest run` — 99 fail / 327 pass / 71 skip / 6 todo (IDENTICAL to baseline — no regressions; the unfixed RB-001 drift is the headline)

## Status

iter-1 = e2e collection unblocked (the primary harness blocker for the final dual-project sweep). 99 vitest baseline + dual-project Playwright sweep deferred to feature follow-up. No further iteration of Area 9 needed via the audit loop — both remaining items are bounded scope, well-understood, and need a dedicated session rather than additional audit iterations.

**Area 9 ships with**:
- e2e collection working (this was blocking everything)
- iter-1 doc capturing the RB-001 root cause + fix pattern
- Explicit scope hand-off for feature follow-up
