# Audit — Iteration 1, Area 5: Member surfaces

**Date**: 2026-05-31
**Branch**: `audit/loop-fixes-05` (branched from `main` HEAD `bef34b2`)
**Scope**: `app/member/**`, `components/member/**`, `app/api/member/**`, magic-link landing, member TOTP UI
**Method**: 3 OMC subagents in parallel (security with OWASP cheat-sheet, verifier, perf). Code-reviewer skipped to save budget — verifier covers overlap.

## Convergence summary

| Agent | Critical | High | Medium | Low |
|---|---|---|---|---|
| Security | 0 | 1 | 3 | 4 |
| Verifier | 0 | 5 (blockers) | (rolled up in blockers) | (rolled up) |
| Perf | 0 | 2 | 8 | (rolled up) |

**Deduplicated NEW Critical**: 0.
**Deduplicated NEW High**: 8 (1 CSRF + 5 verifier UX blockers + 2 perf).

OWASP coverage from security agent: **A01–A10 all marked clean** at production-relevance level. CSRF gaps are the only A01 issue; rest is defence-in-depth.

---

## NEW Critical findings

None.

---

## NEW High findings

### A5H-1 (security) — Missing CSRF guard on `POST/DELETE /api/member/class-subscriptions/[classId]`
- **Location**: `app/api/member/class-subscriptions/[classId]/route.ts:21` (POST), `:48` (DELETE)
- **Issue**: Authenticated member route lacks `assertSameOrigin`. A malicious page could forge cross-origin POST/DELETE to subscribe / unsubscribe a logged-in member from a class. SameSite=Lax provides primary mitigation for JSON POSTs (CORS preflight blocks them) but the convention requires explicit `assertSameOrigin` and DELETE with query params can bypass preflight.
- **Fix**: Add `const v = assertSameOrigin(req); if (v) return v;` at the top of both handlers.

### A5H-2 (verifier) — Cancelled member sees no UI feedback
- **Location**: `app/member/home/page.tsx` (no consumer of `member.status`)
- **Issue**: `/api/member/me` returns `member.status` but `/member/home` never reads it. A member with `status === "cancelled"` sees the identical home screen as an active member. Critical UX gap given Area 3's webhook fix — members will hit this state.
- **Fix**: Add a banner that reads `status` from `/api/member/me` response and renders a "Your gym membership has been cancelled — contact [gym] to reactivate" card when `status === "cancelled"` or `"inactive"`. Data already available; just needs consuming.

### A5H-3 (verifier) — `/member/schedule` hardcodes `primaryColor`, ignores tenant branding
- **Location**: `app/member/schedule/page.tsx:347`
- **Issue**: `const primaryColor = PRIMARY` hardcodes `#3b82f6`. Every other member page reads from `localStorage.getItem("gym-settings")` or `/api/member/me`. Schedule is the only outlier — tenants with red/green/etc brand see blue throughout the schedule view.
- **Fix**: Read from localStorage (same pattern as `app/member/shop/page.tsx:31-36`).

### A5H-4 (verifier) — `<DemotionBanner />` exists but never imported (dead code)
- **Location**: `components/member/DemotionBanner.tsx` (component built; never rendered)
- **Issue**: Component self-fetches `/api/member/me/recent-demotion` and is feature-complete, but grep shows zero imports across `app/`. A demoted member sees no acknowledgement.
- **Fix**: Render `<DemotionBanner />` near the top of `app/member/home/page.tsx` main content area (after the greeting block, before the kids feed). No props needed — component self-fetches.

### A5H-5 (verifier) — Bottom-nav tap height ~36px (below 44px WCAG minimum)
- **Location**: `app/member/layout.tsx:316`
- **Issue**: Tabs are `min-w-[56px] py-1` with 28px icon → ~36px tap height. Falls short of 44px WCAG touch-target guideline. Affects every member on mobile (the primary device).
- **Fix**: Change `py-1` → `py-2` or add `min-h-[48px]` to the `<Link>` element.

### A5H-6 (verifier) — Beginner Card + Milestones on Profile are compile-time demo data
- **Location**: `app/member/profile/page.tsx:14-51` (`BEGINNER_CARD` + `MILESTONES` constants)
- **Issue**: A real member always sees "Alex Johnson's" milestones (White → Blue belt, UKBJJA Nottingham Bronze) and the same static technique checklist regardless of their actual history. Data accuracy bug — members will see someone else's progress.
- **Decision**: This needs real data plumbing (DB columns or API endpoints for actual milestones and beginner-checklist progress). **Deferred to feature follow-up phase** — pure backend gap requiring schema work, not a quick audit fix.

### A5H-7 (perf) — `/api/member/me/children?include=timetable` is N+1 (1+2K trips per K children)
- **Location**: `app/api/member/me/children/route.ts:107-160`
- **Issue**: Per-kid `classSubscription.findMany` + `classInstance.findMany` inside `Promise.all` map. K children = 1 + 2K trips. At 10-kid cap = 21 DB round-trips.
- **Fix**: Bulk query — single `classSubscription.findMany({ where: { memberId: { in: kidIds } } })` then group in JS, then single `classInstance.findMany({ where: { classId: { in: allClassIds } } })`. Collapses 1+2K → 3 trips.

### A5H-8 (perf) — `/api/member/me` fetched 2× concurrently per page load (layout banner + page)
- **Location**: `Recommend2FABannerMember` (in layout) + each page's `loadPageData()`
- **Issue**: On every member page load, both the banner and the page fetch `/api/member/me` simultaneously. Each is cache-miss. Full tab tour (Home → Schedule → Progress → Profile) = ~7 fetches, of which 4 are duplicates.
- **Fix (low-risk)**: Add `Cache-Control: private, max-age=30, stale-while-revalidate=300` to the GET response. Browser serves cached for 30 s, eliminating same-tab duplicates at zero architectural cost. 30 s staleness fine since data changes only on explicit profile save.

---

## NEW Medium findings (append to backlog-medium.md)

- **M-A5-1 (security)**: CSRF on `POST /api/member/totp/verify` — narrow window (requires intercepted code) but inconsistent with policy.
- **M-A5-2 (security)**: CSRF on `POST /api/member/me/mark-announcements-seen` — low blast radius (announcements seen flag) but inconsistent.
- **M-A5-3 (security)**: Photo URL stored without scheme validation (`app/api/member/children/[id]/photos/route.ts:30-34`) — currently safe (`<img src>` only), would become stored-XSS if used as anchor/iframe. Add scheme allow-list `https?://` or `data:image/`.
- **M-A5-4 (perf)**: `/api/member/me` promoter lookup is sequential after member fetch. Fix: include `promotedByUser: { select: { id: true, name: true } }` in `memberRanks` include — collapses 2 trips to 1 join.
- **M-A5-5 (perf)**: `OnboardingModal` (~350 lines JSX) always-parsed; dynamic-import via `next/dynamic` to defer to first-visit.
- **M-A5-6 (perf)**: `computeMemberStats` fires 8 parallel queries; 5 are COUNT with date windows — collapsible to 1 `groupBy` with FILTER expressions.
- **M-A5-7 (perf)**: `/api/member/classes` uses unconstrained `include: { class: true }` — over-fetches columns; switch to `select`.
- **M-A5-8 (perf)**: `MemberLayout` leaks stale `<link>` font tags on font switch — `document.head.appendChild` without cleanup.

## NEW Low findings (append to backlog-low.md)

- **L-A5-1 (security)**: `member.update` calls use `where: { id }` without `tenantId` in 5 routes — defence-in-depth gap, RLS is backstop.
- **L-A5-2 (security)**: `totp/verify` `findUnique` without `tenantId` — `id` comes from server-signed JWT so safe.
- **L-A5-3 (security)**: `dangerouslySetInnerHTML` in member layout — mitigated by `isHexColor()` + `isSafeFontFamily()` validators. No action required.
- **L-A5-4 (security)**: `/api/member/me` selects `passwordHash` then uses only `!== null` check. Replace with computed boolean or document with comment.
- **L-A5-5 (verifier)**: No desktop centering on member layout — content sprawls full 1280px width. UX nit.

---

## Fix plan

**Batch A (CSRF — quick wins, this iter)**:
- A5H-1: CSRF on member class-subscriptions POST + DELETE
- M-A5-1: CSRF on member TOTP verify (upgrade from M because we're at the file anyway)
- M-A5-2: CSRF on mark-announcements-seen (upgrade — single line)

**Batch B (UX blockers — this iter)**:
- A5H-2: Cancelled-member banner on `/member/home`
- A5H-3: Tenant primaryColor on `/member/schedule`
- A5H-4: Wire `<DemotionBanner />` into `/member/home`
- A5H-5: Nav tap-height fix in `/member/layout.tsx`

**Batch C (Perf — this iter)**:
- A5H-7: `/api/member/me/children` N+1 collapse to 3 fixed queries
- A5H-8: `/api/member/me` `Cache-Control` header

**Deferred to feature follow-up**:
- A5H-6: Profile real data (Beginner Card + Milestones) — needs schema/API work, not an audit fix

**Deferred to Medium backlog**:
- M-A5-3 (photo URL scheme validation), M-A5-4..8 (perf medium items)

After Batches A + B + C land + static gates pass → iter-2 if needed, otherwise straight to PR + merge + Area 6.
