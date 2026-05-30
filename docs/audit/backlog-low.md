# Audit Backlog — Low severity

Tracked, non-blocking polish items. Address opportunistically.

## From iter-1-prs.md (PR #2–#5 audit, 2026-05-30)

### Code review

- **L1** [PR #2 / PR #3 props] — New props are optional with defaults. Making them required gives compile-time safety against silent prop-drop bugs.
- **L2** [`components/dashboard/AddTaskModal.tsx`] — Reset `useEffect` doesn't clear `assignedToId` or the cached `staff` list. On reopen the user sees stale data until the fetch resolves. Reset both on open.
- **L3** [`components/dashboard/MembersList.tsx`] — 5-tile grid at `sm:grid-cols-3` leaves an orphan tile (5 % 3 = 2 + 1 remainder). Visually uneven. Either reduce to 4 tiles or use `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5` (already done) + accept the orphan, or move one tile to a sibling row.

### Security

- **L4** [`POST /api/tasks`] — No rate limit. Authenticated-insider blast radius only, but a per-user limit (e.g. 50/hr via `lib/rate-limit.ts`) would mitigate spam from a compromised staff account.

### Verifier

- **L5** [`prisma/migrations/20260530192937_add_tasks/migration.sql`] — Uses `ON DELETE RESTRICT` for `createdById` / `assignedToId` FKs. Deleting a `User` who has tasks will fail loudly. New constraint not flagged in PR #3 body. Either document or switch to `ON DELETE SET NULL` + nullable columns (semantic change — needs UX call).
- **L6** [PR #5 fix comment] — Self-contradictory: says "lg" in old comment but the old code was `md`. Just a stale comment.

### Perf

- **L7** [`GET /api/tasks`] — Lacks explicit `Cache-Control: private, no-store`. The analogous `/api/staff/assignable` sets `private, max-age=300`. Set explicitly to avoid accidental caching by CDNs / browsers.
- **L8** [`components/dashboard/DashboardStats.tsx`] — `todoListLabel` template literal recomputed every render. Trivial cost; wrap in `useMemo` for consistency with the rest of the codebase's hot-path conventions.
- **L9** [`app/api/staff/assignable/route.ts`] — `orderBy: [role, name]` would benefit from a composite index `(tenantId, role, name)` if staff lists ever exceed ~200/tenant. Speculative — defer until evidence.

### Closed by iter-1 fixes (no action needed)

- ~~`app/api/tasks/[id]/complete` uses two round-trips (findFirst + update)~~ — **closed** by H-2 fix at `192eaf8`. Already collapsed into one `updateMany` with `count === 1` check.

## From iter-2-prs.md (PR #2–#6 audit, 2026-05-30, late session)

### Code review
- **L2-1** [`scripts/setup-test-accounts.mjs`] — was logging plaintext password to stdout. **Closed by H2-1 fix** (commit on PR #6 amend) — kept here as audit-trail breadcrumb.
- **L2-2** [`scripts/create-restricted-role.ts`] — PR #6 body wording about the regex scope is slightly misleading (says "rejects quotes and backslashes" but `$$` was the actual exploit surface). Doc-only nit; the underlying code is now correct after M2-2 fix.

### Verifier
- **L2-3** [`components/dashboard/AddTaskModal.tsx:53-65`] — fetch lacks `AbortController` timeout. If Neon pool saturates the spinner never resolves. Defer until user reports it.
- **L2-4** [`app/dashboard/page.tsx:getUserTasks`] — swallows all exceptions silently and returns `[]`. Migration-lag failures render as "no tasks" with no server-log breadcrumb. Add `console.error("[getUserTasks]", e)` before `return []`.

### Perf
- **L2-5** [`scripts/check-my-accounts.mjs:12-34`] — two sequential transactions where one suffices (also captured as M2-5; identical issue, kept in Low because it is a dev-only script).
