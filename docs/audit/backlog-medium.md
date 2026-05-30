# Audit Backlog — Medium severity

Tracked, non-blocking findings. Address opportunistically or in scheduled cleanup PRs.

## From iter-1-prs.md (PR #2–#5 audit, 2026-05-30)

### Code review

- **M1** [`components/dashboard/DashboardStats.tsx`] — God Object. Task section should be extracted into a dedicated `<TaskList>` component for SOC.
- **M2** [`app/dashboard/page.tsx:getUserTasks`] — Duplicates the exact Prisma query from `GET /api/tasks`. Extract into `lib/tasks.ts` data-access function and reuse.
- **M3** [`components/dashboard/charts/Sparkline.tsx`] — Hardcoded `id="spark-fill"` for the SVG `<linearGradient>`. Two instances on the same page will collide. Use `React.useId()`.
- **M4** [`components/dashboard/AddTaskModal.tsx:42`] — `useEffect` reads `assignedToId` via closure but it's not in the dep array (eslint-disabled). Split into two effects: (a) fetch staff, (b) default-assignee selection keyed on staff list.
- **M5** [`components/dashboard/DashboardStats.tsx`] — Empty-name fallback renders `"My's To Do List"` (awkward possessive). Change to `"My To Do List"` (no `'s`).

### Security

- **M6** [`app/api/tasks/route.ts`, `app/api/tasks/[id]/complete/route.ts`, `app/api/staff/assignable/route.ts`] — Use `auth()` + manual `STAFF_ROLES.includes(role)` check. Diverges from the codebase convention. Switch to `requireStaff()` helper from `lib/authz.ts`.
- **M7** [`app/api/tasks/[id]/complete/route.ts`] — Owner override uses `session.user.role === "owner"` literal. Centralise via a shared helper (`isOwner(role)` or similar).
- **M8** [npm audit] — 10 moderate dependency vulnerabilities (postcss, uuid, qs, brace-expansion, @hono/node-server). None critical/high. Run `npm audit fix` and verify no breaking changes.

### Verifier

- **M9** [`components/dashboard/charts/Sparkline.tsx`] — `preserveAspectRatio="xMidYMid meet"` will letterbox (whitespace bars) when the container aspect ratio differs from the viewBox. Not flagged in PR #4 body.
- **M10** [`components/dashboard/ReportsView.tsx`] — Pre-existing wrapper (`[&>svg]:w-full`) was already overriding the old fixed pixel width. PR #4's fix only genuinely benefits `AnalysisView`; `ReportsView` was already fine.
- **M11** [`components/dashboard/DashboardStats.tsx`] — `tasks` state initialised from prop but never re-synced on prop changes. Router refresh can cause staleness. Add a `useEffect` to sync from prop, or lift state.
- **M12** [`tests/e2e/dashboard/owner-todo-personalised.spec.ts` (or equivalent)] — `/To Do List/i` regex is broader than the old `/Owner To-Do/i`. Could match a second future element. Tighten to `^(Noe|Morgan|…)'s To Do List$`.

### Perf

- **M13** [`components/dashboard/DashboardStats.tsx`] — `handleCreated` / `handleComplete` not memoised → re-render cascade into `<AddTaskModal>` even when closed. Wrap in `useCallback`.
- **M14** [`components/dashboard/DashboardStats.tsx`] — `myOpenTaskCount` recomputed via `.filter()` on every render. Wrap in `useMemo` keyed on `[tasks, currentUserId]`.
- **M15** [`components/dashboard/charts/Sparkline.tsx`] — Geometry computed against logical viewBox width (320), not actual rendered pixel width. Labels / dot positions misalign at non-320px rendered widths. Use `ResizeObserver` or document the constraint and snap rendered width to 320px multiples.

## From iter-2-prs.md (PR #2–#6 audit, 2026-05-30, late session)

### Verifier
- **M2-4** [`components/dashboard/DashboardStats.tsx:205-215`] — `handleComplete` optimistic rollback flickers the badge count by 1 between the optimistic remove and the rollback on failed completion. Minor UX nit; consider deriving `myOpenTaskCount` from a memoised count keyed on a stable snapshot, or accept the flicker as low-cost.

### Perf
- **M2-5** [`scripts/check-my-accounts.mjs:12-34`] — Each `check()` call runs two separate `prisma.$transaction` calls (tenant lookup + user lookup) with their own `set_config` overhead. Collapsible into one transaction. Dev-only diagnostic script; low priority.
