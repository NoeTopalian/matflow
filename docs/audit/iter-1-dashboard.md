# Audit — Iteration 1, Area 4: Dashboard surfaces

**Date**: 2026-05-31
**Branch**: `audit/loop-fixes-04` (branched from `main` HEAD `43de1ab`)
**Scope**: `app/dashboard/**`, `components/dashboard/**`, `components/layout/Sidebar.tsx`, `lib/reports.ts`, `lib/dashboard-todo.ts`
**Method**: 4 OMC subagents in parallel (code-reviewer, security with OWASP cheat-sheet, verifier, scientist).

## Convergence summary

| Agent | Critical | High | Medium | Low |
|---|---|---|---|---|
| Code Reviewer | 3 | 3 | 5 | 4 |
| Security Reviewer | 0 | 0 | 4 | 3 |
| Verifier | 0 | 4 | 7 | 7 |
| Perf | 0 | 3 | 5 | 5 |

**Deduplicated NEW Critical**: 3 (all authz-convention drift).
**Deduplicated NEW High**: 10 (mix of convention, real bugs, perf scale).

OWASP coverage from security agent: **A01–A10 all marked clean** at production-relevance level. Defence-in-depth gaps tracked as Medium.

---

## NEW Critical findings (authz convention drift — non-exploitable but project invariant violations)

### A4C-1 — `reports/page.tsx` uses raw `auth()` + inline role check
- **Location**: `app/dashboard/reports/page.tsx:6-9`
- **Fix**: `const { session } = await requireRole(["owner", "manager"]);`

### A4C-2 — `analysis/page.tsx` same pattern
- **Location**: `app/dashboard/analysis/page.tsx:8-10`
- **Fix**: `const { session } = await requireRole(["owner"]);`

### A4C-3 — `settings/page.tsx` same pattern
- **Location**: `app/dashboard/settings/page.tsx:88-91`
- **Fix**: `const { session } = await requireRole(["owner"]);`

---

## NEW High findings

### A4H-1 — `layout.tsx` uses raw `auth()` instead of `requireStaff()`
- **Location**: `app/dashboard/layout.tsx:1,19`
- **Fix**: `const { session } = await requireStaff();` — closes the belt-and-braces gap where downstream pages forgetting `requireStaff` would be reachable by members via direct URL.

### A4H-2 — Dead legacy `<table>` block (~120 lines) shipping in client bundle
- **Location**: `components/dashboard/MembersList.tsx:705-822`
- **Fix**: Delete the `className="hidden"` wrapped block entirely.

### A4H-3 — `href={a.blobUrl}` without URL-protocol guard (XSS via `javascript:`)
- **Location**: `components/dashboard/InitiativesPanel.tsx:240`
- **Fix**: Guard with `safeUrl = blobUrl.startsWith("https://") || blobUrl.startsWith("http://") ? blobUrl : "#"`.

### A4H-4 (verifier) — `/dashboard/payments` page has no try/catch → 500 on DB error
- **Location**: `app/dashboard/payments/page.tsx:42-65`
- **Fix**: Wrap `withTenantContext` call in try/catch matching the pattern used by all other pages; render empty state on error.

### A4H-5 (verifier) — 9 hard ESLint errors blocking build
- **Locations**:
  - `app/dashboard/payments/page.tsx:126` — `react-hooks/purity` (false positive but blocks lint)
  - `app/dashboard/payments/page.tsx:194` — unescaped `'`
  - `components/dashboard/CoachRegister.tsx:147,271` — unescaped `'`
  - `components/dashboard/MembershipsManager.tsx:420` — unescaped `'`
  - `components/dashboard/PaymentsTable.tsx:129` — unescaped `'`
  - `components/dashboard/RemoveMemberModal.tsx:51,98` — `react-hooks/set-state-in-effect` (real React rules violation)
- **Fix**: Escape `'` to `&apos;`, restructure RemoveMemberModal effect to use ref/callback pattern.

### A4H-6 (verifier) — 20 failing unit tests block CI
- **Files**: `tests/unit/promotion-candidates.test.ts` (15 fails), `tests/unit/admin-checkin-autoselect.test.tsx` (5 fails)
- **Root cause (promotion-candidates)**: `vi.mock("@/lib/prisma")` missing `$transaction` stub; `withTenantContext` now calls it
- **Fix**: Add `$transaction: (fn: any) => fn(prisma)` to the mock
- **Root cause (admin-checkin)**: regression — component fetches that test didn't expect

### A4H-7 (verifier) — MobileNav missing `/dashboard/coach` + `/dashboard/promotions`
- **Location**: `components/layout/MobileNav.tsx`
- **Fix**: Add both routes to `MORE_NAV` with appropriate role guards.

### A4H-8 (perf) — `atRiskMembers` NOT EXISTS scales poorly
- **Location**: `app/dashboard/page.tsx:128-134`
- **Note**: at Total BJJ's ~120 members this is negligible; becomes noticeable at 500+. Defer to backlog as Medium — proper fix needs `Member.lastVisitAt` materialized column + trigger.

### A4H-9 (perf) — `AttendancePage.getSummary` fetches all rows into memory
- **Location**: `app/dashboard/attendance/page.tsx:63-108`
- **Note**: defer to backlog as Medium — refactor to 3 DB aggregations.

### A4H-10 (perf) — Member profile page: 2 sequential post-`Promise.all` queries
- **Location**: `app/dashboard/members/[id]/page.tsx:214-229`
- **Fix**: Fold `totpRow` + `rosterMemberships` into the initial `Promise.all`.

---

## NEW Medium findings (append to backlog-medium.md)

- **M-A4-1 (security)**: CSRF (`assertSameOrigin`) missing on ~11 mutating dashboard-invoked API routes (announcements, classes, ranks, staff, members/[id]/rank, memberships, DSAR erase). Mitigated by SameSite=Lax + JSON CORS preflight but project convention requires explicit guard. Large sweep — defer.
- **M-A4-2 (security)**: DSAR export lacks rate-limit. **Will fix in Batch C** given prod-readiness.
- **M-A4-3 (security)**: DSAR erase lacks rate-limit. **Will fix in Batch C** given prod-readiness.
- **M-A4-4 (security)**: GET `/api/settings` exposes tenant metadata to all staff including coach (should restrict to owner+manager).
- **M-A4-5 (code review)**: `hex()` colour helper duplicated 11 times across components — extract to `lib/color.ts`.
- **M-A4-6 (code review)**: `MembersList.tsx` exceeds 1000 lines — extract `AddMemberModal` + helpers.
- **M-A4-7 (code review)**: `app/dashboard/reports/page.tsx` swallows errors silently — show banner.
- **M-A4-8 (code review)**: `analysis/page.tsx` 9-element tuple destructuring fragile.
- **M-A4-9 (code review)**: Sidebar nav role array vs page-level authz drift risk.
- **M-A4-10 (verifier)**: Mobile header logo clips at `lg` size (36px column, 48px logo).
- **M-A4-11 (verifier)**: `DashboardStats` "Check-In" + "Add Class" buttons not role-gated for coach.
- **M-A4-12 (verifier)**: `app/member/progress/page.tsx` flashes hardcoded demo data on first render.
- **M-A4-13 (verifier)**: 16 sub-pages have no `loading.tsx` (only root `/dashboard`).
- **M-A4-14 (verifier)**: `promotions/page.tsx` uses `requireStaff` + manual role check (should use `requireOwnerOrManager`).
- **M-A4-15 (perf)**: `waiverMissing` + `missingPhone` stats lack composite indexes on `waiverAccepted` / `phone`.
- **M-A4-16 (perf)**: `MembersList counts` recomputed 11× per render — memoise.
- **M-A4-17 (perf)**: `getReportsData` uncached — wrap in `unstable_cache` with 5-min TTL.
- **M-A4-18 (perf)**: `members/page.tsx orderBy: name` unindexed.

## NEW Low findings (append to backlog-low.md)
- L-A4-1..7: minor type narrowing, unused vars, missing `Next/Image`, redundant guards, etc.

---

## Fix plan

### Batch A (quick wins, in this iter):
- A4C-1 + A4C-2 + A4C-3: Replace raw `auth()` with `requireRole()` in 3 pages
- A4H-1: Same fix in layout
- A4H-2: Delete dead table block in MembersList
- A4H-3: URL-protocol guard in InitiativesPanel
- A4H-4: try/catch on payments page
- A4H-5: Fix 9 ESLint errors (unescaped quotes + set-state-in-effect refactor)
- A4H-7: Add coach + promotions to MobileNav
- A4H-10: Parallelise member profile sequential queries

### Batch B (test fixes, in this iter):
- A4H-6: Fix promotion-candidates mock + investigate admin-checkin regression

### Batch C (rate-limits + prod-readiness, in this iter):
- M-A4-2 + M-A4-3: DSAR export + erase rate-limits

### Deferred (Medium backlog):
- M-A4-1 (CSRF bulk sweep), M-A4-4 (settings exposure), M-A4-5..18, A4H-8 + A4H-9 (perf scale)
