# Audit — Iteration 1, PRs #2–#5

**Date**: 2026-05-30 (late session)
**Scope**: open pull requests #2, #3, #4, #5 (NoeTopalian/matflow)
**Method**: 4 OMC subagents run in parallel — code-reviewer, security-reviewer, verifier, scientist (perf focus)
**Status**: findings captured; no code changes applied this iteration (user chose: save + sleep + fix tomorrow)

## TL;DR — what to do first when you pick this up

1. **🚨 Rotate production credentials.** Multiple scripts have hardcoded `password123` against `https://matflow.studio`, plus `ZqDs03yrgukxNq2UyY8ZXX` in `scripts/playwright-verify-v1.5-admin.mjs`. These are in git history forever. Change the prod password in your Vercel/Neon admin **before** anything else.
2. **🚨 Amend PR #3's migration to add RLS on `Task`.** Every other tenant-scoped table has `ENABLE ROW LEVEL SECURITY` + `FORCE` + a `tenant_isolation` policy. The new `Task` table has none. Match the pattern in `prisma/migrations/20260503100000_*`.
3. **🐛 PR #4 didn't actually finish.** The Sparkline's "No data" `<div>` fallback still uses fixed-pixel `width` — same overflow bug just on the empty path.
4. **🐛 PR #3 broke the dashboard "All caught up" state.** `ownerTodoCount` now includes `myOpenTaskCount`, so the green tick never shows when any task exists.
5. **PR #3 has zero tests.** Add at least: POST /api/tasks tenant-scope test, complete authz test, GET filters by viewer.

---

## CRITICAL findings

### C-1 — Committed production credentials (Security)
- `scripts/playwright-verify-v1.5-admin.mjs:44` — operator password `ZqDs03yrgukxNq2UyY8ZXX` as fallback
- `scripts/prod-admin-login-direct.mjs:30`, `scripts/prod-admin-open-dashboard.mjs:12`, `scripts/prod-noe-login-and-enrol.mjs:17`, `scripts/swap-totalbjj-owner-email.mjs:13`, `scripts/playwright-prod-admin-login.mjs:28` — `const PASSWORD = "password123"` against production
- `scripts/create-restricted-role.ts:12,21` — hardcoded DB role password `matflow_app_test_2026` + SQL via `$executeRawUnsafe` with string interpolation

**Action**: rotate prod password, remove all fallback values, require `process.env.OPERATOR_PASSWORD` with `throw` on missing. Parameterise the SQL in `create-restricted-role.ts`.

### C-2 — Missing RLS on new `Task` table (Security + Code Review)
`prisma/migrations/20260530192937_add_tasks/migration.sql` creates the table and FKs but does not:
- `ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;`
- `ALTER TABLE "Task" FORCE ROW LEVEL SECURITY;`
- `CREATE POLICY tenant_isolation ON "Task" ...;`

Every other tenant-scoped table has all three. App-layer `withTenantContext` filtering still works, but the defence-in-depth backstop is missing.

**Action**: amend PR #3's migration. Mirror the pattern from `prisma/migrations/20260503100000_rls_policies_foundation`.

### C-3 — PR #4 Sparkline no-data path NOT fixed (Verifier)
The patch only changed the `<svg>` element. The empty-state `<div style={{ width, height, … }}>No data</div>` (Sparkline.tsx pre-patch lines 60–73) still uses fixed-pixel `width` and reproduces the same overflow bug whenever `data.length === 0`.

**Action**: amend PR #4 to either (a) change the empty `<div>` to `style={{ width: "100%", height, … }}` or (b) render a tiny inline SVG/placeholder.

### C-4 — PR #3 empty-state logic incoherent (Verifier)
`ownerTodoCount` was changed from `(waiver + payment + phone + atRisk)` to include `+ myOpenTaskCount`. The drawer's "All caught up — nothing to action" `<CheckCircle2 />` is gated on `ownerTodoCount === 0` — which now **never fires** when any task is open. Drawer renders an empty auto-derived section even when all gym-health metrics are zero.

**Action**: split into two empty states — one for gym-health (auto items), one for tasks — and only show the "All caught up" tick when both are empty.

---

## HIGH findings

### H-1 — PR #3 has zero tests
Three new API routes, a new Prisma model, a new modal, and significant DashboardStats changes — no unit, integration, or e2e tests. Every other route has coverage.
**Action**: at minimum add `tests/unit/tasks-route.test.ts` (authz + validation + tenant scope) and `tests/integration/tasks-flow.test.ts` (create → complete → tenant isolation).

### H-2 — TOCTOU race on task completion (Code Review)
`app/api/tasks/[id]/complete/route.ts:63-72` does `findFirst` (status check) then `update`. Two concurrent requests can both pass the open-status check and both update — no race protection.
**Action**: replace with `updateMany` with `where: { id, tenantId, status: "open" }` and check `count === 1`. Single atomic round-trip.

### H-3 — `POST /api/tasks` doesn't block self-assignment (Verifier)
The UI excludes the caller from the dropdown (`AddTaskModal.tsx:42`), but the API route doesn't assert `assignedToId !== createdById`. Direct API call bypasses the UI guard.
**Action**: add `if (assignedToId === ctx.userId) return 400;` to the POST handler.

### H-4 — `GET /api/staff/assignable` returns ALL users in tenant (Verifier)
The query is `tx.user.findMany({ where: { tenantId } })` with no role filter. The `User` model is staff-only by schema constraint today, so not exploitable — but the PR body's claim implies an explicit role filter exists.
**Action**: add `role: { in: STAFF_ROLES }` to the where clause for explicitness + future-proofing.

### H-5 — STAFF_ROLES duplicated in 3 new files (Code Review)
Local `const STAFF_ROLES = [...]` declared in each of `app/api/tasks/route.ts`, `app/api/tasks/[id]/complete/route.ts`, `app/api/staff/assignable/route.ts`. The constant already lives in `lib/authz.ts:12`.
**Action**: export from `lib/authz.ts` and import; remove the 3 local copies.

### H-6 — Missing index for the `createdById` branch of `GET /api/tasks` (Perf)
The query filters on `(tenantId, status, assignedToId = me OR createdById = me)`. Only `(tenantId, status, assignedToId)` is indexed. Postgres falls back to bitmap OR + seq scan on the `createdById` arm.
**Action**: add `CREATE INDEX "Task_tenantId_status_createdById_idx" ON "Task"("tenantId", "status", "createdById");` to the migration (or a follow-up migration).

---

## MEDIUM findings

- (Code Review) `DashboardStats.tsx` grew into a God Object — task section should be extracted into a dedicated `<TaskList>` component.
- (Code Review) `app/dashboard/page.tsx:getUserTasks` duplicates the exact Prisma query from `GET /api/tasks` — extract to `lib/tasks.ts` data-access function.
- (Code Review) `Sparkline.tsx` uses hardcoded `id="spark-fill"` for the SVG gradient — two instances on the same page will collide. Use `React.useId()`.
- (Code Review) `AddTaskModal.tsx:42` useEffect has `assignedToId` in closure but not in deps (eslint-disabled). Split into two effects (fetch + default-assignee).
- (Code Review) Falls back to `"My's To Do List"` when name empty — awkward possessive. Use `"My To Do List"` (no `'s`) on empty fallback.
- (Security) New routes use `auth()` + manual role check instead of `requireStaff()` — diverges from the codebase convention. Should use the helper.
- (Security) Owner override in complete route uses `session.user.role === "owner"` literal vs the centralised pattern.
- (Security) `npm audit` shows 10 moderate dependency vulnerabilities (postcss, uuid, qs, brace-expansion, @hono/node-server) — none critical/high, but worth a `npm audit fix` pass.
- (Verifier) `preserveAspectRatio="xMidYMid meet"` on Sparkline will letterbox (add whitespace) when container aspect ratio differs — visual consequence not mentioned in PR body.
- (Verifier) `ReportsView`'s pre-existing wrapper (`[&>svg]:w-full`) was already overriding the old fixed pixel width — the actual new fix in PR #4 only genuinely benefits AnalysisView.
- (Verifier) `tasks` state in DashboardStats is initialised from prop but never re-synced on prop changes (router refresh staleness).
- (Verifier) `/To Do List/i` regex in the e2e is less precise than the old `/Owner To-Do/i` — would match if the page ever gained a second element containing the phrase.
- (Perf) `handleCreated` / `handleComplete` not memoised — propagates re-renders to `<AddTaskModal>` even when closed. Wrap in `useCallback`.
- (Perf) `myOpenTaskCount` recomputed via `.filter()` on every render — wrap in `useMemo` keyed on `tasks` + `currentUserId`.
- (Perf) Sparkline geometry computed against logical viewBox width (320), not actual rendered pixel width — labels/dots/text anchors will be misaligned at non-320px rendered widths. Use `ResizeObserver` or document the constraint.

---

## LOW findings

- (Code Review) PR #2/#3 new props are optional with defaults — making them required gives compile-time safety.
- (Code Review) `AddTaskModal` reset useEffect doesn't reset `assignedToId` or `staff` cache — stale data on reopen.
- (Code Review) `MembersList` 5-tile grid at `sm:grid-cols-3` leaves an orphan tile (5/3=1 remainder) — not a bug, just visually uneven.
- (Security) No rate limit on `POST /api/tasks` — limited blast radius (authenticated insider only), but a per-user limit (50/hr) would mitigate spam.
- (Verifier) Migration uses `ON DELETE RESTRICT` for `createdById`/`assignedToId` FKs — deleting a User who has tasks will fail. New constraint not flagged in PR body.
- (Perf) `GET /api/tasks` lacks an explicit `Cache-Control: private, no-store` (the analogous `/api/staff/assignable` sets `private, max-age=300`).
- (Perf) `app/api/tasks/[id]/complete` uses two round-trips (findFirst + update). Collapsible into one `updateMany`.
- (Perf) `todoListLabel` template literal recomputed on every render — trivial cost but worth a `useMemo` for consistency.
- (Perf) `staff/assignable` `orderBy: [role, name]` would benefit from a composite index `(tenantId, role, name)` if staff lists ever exceed ~200/tenant.
- (Verifier) PR #5 fix comment is self-contradictory (says "lg" in old comment but old code was `md`) — minor.

---

## Backlog routing for tomorrow

- **Amend PR #3** (force-push): C-2, C-4, H-1, H-2, H-3, H-4, H-5, H-6.
- **Amend PR #4**: C-3.
- **New `audit/loop-fixes-01` branch + PR**: credential rotation (C-1) + `create-restricted-role.ts` parameterisation + dep audit (M).
- **Defer to follow-up sessions**: Component refactor (TaskList extraction), Sparkline geometry/ResizeObserver, `useMemo`/`useCallback` sweep, tests beyond MVP.

---

## Convergence status — iteration 1 result

Loop terminator says: this area is NOT green (Critical + High count > 0). Iteration 2 needed once fixes land. Cap is 4 per area; expect 1–2 more iterations before this area passes the "0 Critical / 0 High for 2 consecutive iterations" gate.

## Next-session opening move
Read this file first. Start with C-1 (rotate prod password externally), then C-2 (RLS amend on PR #3), then walk down the list. Each fix lands per the routing above; static gates after each batch.
