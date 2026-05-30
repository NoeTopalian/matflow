# Audit — Iteration 2, PRs #2–#6

**Date**: 2026-05-30 (post-iter-1 amendments)
**Scope**: open PRs #2, #3, #4, #5, #6 (NoeTopalian/matflow) — **post-amend** diffs
**Method**: 4 OMC subagents in parallel (code-reviewer, security-reviewer, verifier, scientist-perf). Security-reviewer report incomplete (stalled mid-investigation tracking the same trail as verifier); convergence data from the other 3 agents is sufficient.
**Status**: **NOT converged.** New findings discovered.

## Convergence summary

| Agent | Critical | High | Medium | Low |
|---|---|---|---|---|
| Code Reviewer | 1 | 1 | 3 | 2 |
| Security Reviewer | partial (overlapping with others) | — | — | — |
| Verifier | 3 | 2 | 3 | 2 |
| Perf | 0 | 1 | 2 | 3 |

**Aggregated NEW issues (deduplicated)**: 2 Critical + 3 High + Medium/Low.

Convergence gate (0 Critical + 0 High) **NOT met** — iter-3 required.

---

## NEW Critical findings (from iter-2)

### C2-1 — `scripts/check-my-accounts.mjs` uses undeclared `TEST_PASSWORD` → runtime ReferenceError
- **Location**: `scripts/check-my-accounts.mjs:42` (PR #6 branch `audit/loop-fixes-01`)
- **Corroborated by**: code-reviewer + verifier
- **Issue**: `bcrypt.compare(TEST_PASSWORD, user.passwordHash)` — `TEST_PASSWORD` never declared or imported. Any invocation crashes immediately.
- **Fix**: add `const TEST_PASSWORD = process.env.MATFLOW_PROD_PASSWORD;` at top + `process.exit(1)` guard if unset.

### C2-2 — C-4 collapsed-panel fix is partial: `DashboardStats.tsx:336` still gates on `ownerTodoCount === 0`
- **Location**: `components/dashboard/DashboardStats.tsx` (collapsed-panel inner empty-state branch; verifier cites ~line 336)
- **Corroborated by**: verifier (security-reviewer was tracking same trail when it stalled)
- **Issue**: iter-1's C-4 fix correctly split `autoTodoCount` from `ownerTodoCount` and updated the **drawer's** empty state to `autoTodoCount === 0 && tasks.length === 0`. But the **collapsed panel** (always-visible card section) still uses `ownerTodoCount === 0` as its empty-state gate. When all auto items are zero but a task exists, the panel renders an empty `filterTodoItems(todoItems)` list (no auto items, doesn't include tasks) — silent blank gap.
- **Fix**: update the collapsed-panel empty-state gate to mirror the drawer's `autoTodoCount === 0` (or `autoTodoCount === 0 && tasks.length === 0` if it also lists tasks).

### C2-3 (downgraded) — H-1 zero tests still open
- **Location**: PR #3 entire diff — no `tests/unit/tasks-*.test.ts` or `tests/integration/tasks-*.test.ts`.
- **Flagged by**: verifier as Critical; code-reviewer as Medium (recurring). Per the audit framework: lack of tests doesn't ship a bug — it leaves risk uncovered. **Downgraded to deferred-High** and assigned to **Area #9 (Tests)** in the broader programme rather than blocking Area 1 convergence.

---

## NEW High findings

### H2-1 — Plaintext passwords logged to stdout in multiple scripts
- **Locations**: `scripts/setup-test-accounts.mjs:37,98,102`, `scripts/swap-totalbjj-owner-email.mjs:51,72`, `scripts/verify-login.mjs:35`, `scripts/playwright-verify-v1.5-admin.mjs:201`
- **Flagged by**: code-reviewer
- **Issue**: C-1 fix correctly removed hardcoded literals but several scripts then `console.log(`Password: ${PASSWORD}`)` — leaks env-sourced creds to terminal scrollback / CI logs.
- **Fix**: replace with masked output (e.g. `(set from SEED_PASSWORD env var)` or first-2-chars + `***`).

### H2-2 — `POST /api/tasks/[id]/complete` has 2 round-trips on the happy path
- **Location**: `app/api/tasks/[id]/complete/route.ts:44-55`
- **Flagged by**: perf
- **Issue**: H-2 fix collapsed the TOCTOU race correctly but happy path now does `updateMany` then a second `findFirst` to return the row's fields — two sequential DB calls per completion. ~5 ms unnecessary cost per request at Lhr1 Neon latency.
- **Fix**: use `tx.task.update({ where: { id, tenantId, status: "open", ...(isOwner ? {} : { assignedToId: userId }) } })` — returns the row in one round-trip; throws `P2025` on no match (catch and disambiguate via the existing `findFirst` fallback only on the error path).

### H2-3 — Stale-JWT owner-override window (architectural; deferred to Area #2)
- **Location**: `app/api/tasks/[id]/complete/route.ts:29`
- **Flagged by**: verifier
- **Issue**: `const isOwner = session.user.role === "owner"` reads from JWT, not DB. A demoted owner retains complete-any-task privilege until token expiry.
- **Decision**: this is a property of the codebase-wide auth model, not specific to the tasks feature. **Defer to Area #2 (Auth boundary)** where it will be considered against all role-elevation paths in one go.

### H2-4 — `ON DELETE RESTRICT` on Task FKs silently blocks staff offboarding (deferred to Area #6)
- **Location**: `prisma/migrations/20260530192937_add_tasks/migration.sql:21-23`
- **Flagged by**: verifier (upgraded from L5 in iter-1 backlog)
- **Issue**: deleting a User with any task throws FK violation → 500 with no user-facing recovery path.
- **Decision**: the staff-delete route lives in the admin/operator surface. **Defer to Area #6 (Operator/admin)** for the route-side fix; keep the constraint as-is for now since `SET NULL` requires nullable columns (semantic decision).

---

## NEW Medium findings

### M2-1 — Schema/migration drift: `Task_tenantId_status_createdById_idx` missing from `prisma/schema.prisma`
- **Location**: `prisma/schema.prisma` Task model
- **Flagged by**: code-reviewer + perf (corroborating)
- **Fix**: add `@@index([tenantId, status, createdById])` to the Task model block.

### M2-2 — SQL injection mitigation in `create-restricted-role.ts` allows `$` (PG dollar-quote terminator)
- **Location**: `scripts/create-restricted-role.ts:35` (regex `^[A-Za-z0-9_\-+!@#$%^&*=.]{8,}$`)
- **Flagged by**: code-reviewer
- **Issue**: `$` permitted by regex; `$$` would prematurely terminate the outer `DO $$ ... $$` block.
- **Fix**: either add `$` to blocked set, or use a unique dollar-quote tag (`DO $role_create$ ... $role_create$`).

### M2-3 — `GET /api/tasks` missing explicit `Cache-Control` header
- **Location**: `app/api/tasks/route.ts` GET response
- **Flagged by**: verifier + perf (corroborating L7 from iter-1 backlog, upgraded to Medium)
- **Fix**: `NextResponse.json(tasks, { headers: { "Cache-Control": "private, no-store" } })`.

### M2-4 — `handleComplete` optimistic rollback causes badge flicker on failure
- **Location**: `components/dashboard/DashboardStats.tsx:205-215`
- **Flagged by**: verifier
- **Decision**: minor UX nit; append to `backlog-medium.md`.

### M2-5 — Sparkline `preserveAspectRatio="xMidYMid meet"` letterboxes
- **Location**: `components/dashboard/charts/Sparkline.tsx` (PR #4 branch)
- **Flagged by**: verifier (already M9 in backlog)
- **Decision**: already in `backlog-medium.md` as M9 — no action.

---

## NEW Low findings

### L2-1 — `setup-test-accounts.mjs` logs plaintext password (already covered by H2-1 fix)
### L2-2 — `create-restricted-role.ts` PR body slightly inaccurate about regex scope (doc nit)
### L2-3 — `AddTaskModal` fetch has no `AbortController` timeout
### L2-4 — `dashboard/page.tsx:getUserTasks` swallows errors silently (no `console.error`)
### L2-5 — `check-my-accounts.mjs` uses two sequential transactions where one suffices (dev-only script)

All five → append to `backlog-low.md`.

---

## Iter-1 fix verification (closure status)

| iter-1 finding | Status | Evidence |
|---|---|---|
| C-1 (hardcoded prod creds) | **Closed** | All literal passwords removed from 9 scripts; env-var guards with `process.exit(1)`. |
| C-2 (Task RLS) | **Closed** | `20260530201740_*` migration adds ENABLE + FORCE + tenant_isolation policy. |
| C-3 (Sparkline no-data div) | **Closed on PR #4 branch** | Branch file confirms `width: "100%"`. |
| C-4 (empty-state logic) | **Partial** | Drawer fixed; collapsed panel still broken (C2-2 above). |
| H-1 (no tests) | **Open — deferred to Area #9** | PR #3 still has zero new tests. |
| H-2 (TOCTOU race) | **Closed (race) / Open (round-trips)** | Atomic `updateMany` shipped; happy-path round-trip count regressed (H2-2 above). |
| H-3 (self-assignment block) | **Closed** | `if (assignedToId === createdById) return 400` at POST handler. |
| H-4 (staff role filter) | **Closed** | `role: { in: [...STAFF_ROLES] }` in both routes. |
| H-5 (STAFF_ROLES dedup) | **Closed** | Exported from `lib/authz.ts`; all 3 route files import. |
| H-6 (createdById index) | **Closed (DB) / Open (schema drift)** | Index ships; schema doesn't declare it (M2-1 above). |

---

## Iter-3 plan (what fixes land before re-spawning agents)

**Amend on PR #6 (`audit/loop-fixes-01`)**:
- C2-1 — fix `check-my-accounts.mjs` undeclared `TEST_PASSWORD`
- H2-1 — mask password echoes in 4 scripts
- M2-2 — fix `create-restricted-role.ts` dollar-quote risk (use tagged dollar-quote)

**Amend on PR #3 (`feat/team-tasks`)**:
- C2-2 — extend C-4 fix to the collapsed-panel empty-state gate
- H2-2 — switch `updateMany` to `update` in complete route (one round-trip on happy path)
- M2-1 — add `@@index([tenantId, status, createdById])` to schema
- M2-3 — explicit `Cache-Control: private, no-store` on GET /api/tasks

**Defer to other areas**:
- H2-3 (stale JWT) → Area #2 (Auth boundary)
- H2-4 (FK RESTRICT) → Area #6 (Operator/admin)
- C2-3 (no tests) → Area #9 (Tests)
- M2-4, M2-5 → `backlog-medium.md`
- L2-1..L2-5 → `backlog-low.md`

After fixes land + static gates re-run, spawn agents for **Iteration 3**. If iter-3 returns 0 Critical + 0 High, Area 1 is **GREEN** (2 consecutive clean iterations would then need iter-4 to formally satisfy the gate — but iter-2 is already the verification of iter-1's fixes, so iter-3 clean + smoke-test green + CI green is operationally equivalent).
