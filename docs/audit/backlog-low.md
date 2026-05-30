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

## From iter-3-prs.md (PR #2–#6 audit, 2026-05-30, post-iter-2-amend)

### Verifier
- **L3-1** [`components/dashboard/DashboardStats.tsx:230, 414`] — `ownerTodoCount` badge counts only tasks **assigned to** the viewer (via `myOpenTaskCount`), but the drawer shows tasks **involving** the viewer (assigned OR created). A manager who created 5 tasks for others sees 5 cards in the drawer but `0` in the badge. Likely intentional ("my workload" vs "my visibility"), but undocumented. Add a code comment or doc note clarifying the asymmetry.

### Perf (informational, no action)
- **L3-2** [`app/api/tasks/route.ts`] — `Cache-Control: private, no-store` correctly suppresses browser caching; on a `runtime = "nodejs"` route there is no CDN consequence (Vercel Edge Network never caches `private` responses). Header is advisory only — confirmed no unintended side-effect from the M2-3 fix.
- **L3-3** [`prisma/schema.prisma` Task model] — Adding `@@index([tenantId, status, createdById])` (M2-1 fix) introduces one more B-tree update per INSERT / status-change. At <500 tasks/month estimated volume the write amplification is negligible (~µs per write).

## From iter-3-auth-boundary.md (Area 2 light verify, 2026-05-30)

- **L-A2I3-1** [`app/api/admin/auth/operator-totp/route.ts:97-108`] — Non-atomic findUnique+update on TOTP-failure path. Two concurrent failures can both read `failedLoginCount = N` and both write `N+1`. Race-safe (idempotent double-lockout at threshold; never grants extra attempts) — same pattern as the bcrypt-side code in `lib/operator-auth.ts:211-222`. Risk: Low.
- **L-A2I3-2** [`app/api/auth/reset-password/route.ts:53-57`] — Pre-existing inline comment describes User-wins precedence but does not explicitly cite the backlog ID `M-A2I2-1`. The companion `forgot-password` route carries the formal reference. Documentation completeness only.
