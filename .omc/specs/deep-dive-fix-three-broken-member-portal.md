# Deep Dive Spec: Fix Member Portal & Dashboard Bugs

## Metadata
- Interview ID: dd-member-portal-fixes-001
- Rounds: 3
- Final Ambiguity Score: 9%
- Type: brownfield
- Generated: 2026-04-18
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.92 | 0.35 | 0.32 |
| Constraint Clarity | 0.90 | 0.25 | 0.23 |
| Success Criteria | 0.88 | 0.25 | 0.22 |
| Context Clarity | 0.95 | 0.15 | 0.14 |
| **Total Clarity** | | | **0.91** |
| **Ambiguity** | | | **9%** |

## Goal
Fix 5 member portal and dashboard bugs where APIs are fully implemented but components were never wired to them. Specifically: wire the member schedule page to the real API, add a profile save handler, fix "Your Classes" to show attended classes, auto-select the correct class instance when navigating from the calendar deeplink, and normalize role casing in auth to prevent silent empty sidebars.

(H4 — promotedBy resolution — deferred: leave as null for now.)

## Constraints
- No new API endpoints needed — all required endpoints already exist
- H4 (promotedBy): leave hardcoded null, do not add a secondary DB lookup
- C5 "Your Classes": show classes member has actually attended (via AttendanceRecord), not ClassSubscription
- H3: auto-select today's instance — requires reading `?class=` param and finding the ClassInstance for today's date
- H13: normalize role in `auth.ts` session callback (single source of truth), not in Sidebar
- Email field remains read-only in profile save (PATCH /api/member/me does not accept email changes)
- No UI/UX redesign — only wire existing UI to correct data sources

## Non-Goals
- H4 promotedBy resolution (coach name lookup) — deferred
- ClassSubscription persistence (subscribe/unsubscribe toggle in schedule page) — out of scope
- Notification toggles in profile page — out of scope
- New features, pagination, or layout changes

## Acceptance Criteria
- [ ] **C1**: Member schedule page fetches from `/api/member/schedule` on mount; classes displayed match real DB data; no hardcoded `ALL_CLASSES` constant used in render
- [ ] **C2**: Profile page has a Save button that calls `PATCH /api/member/me` with `{name, phone}`; success shows a toast/confirmation; inputs are controlled (not `defaultValue`)
- [ ] **C5**: Progress page "Your Classes" section shows the last N distinct classes the member has attended, drawn from `AttendanceRecord` — not a tenant class list slice
- [ ] **H3**: Clicking "Check in" on a WeeklyCalendar event navigates to `/dashboard/checkin?class=<id>`; the checkin page reads that param, finds today's `ClassInstance` for that `classId`, and passes it as `initialInstanceId` to `AdminCheckin`
- [ ] **H13**: `auth.ts` session callback normalizes `token.role` with `.toLowerCase().trim()` before assigning to `session.user.role`; role type in `next-auth.d.ts` is a union `"owner" | "manager" | "coach" | "admin" | "member"`
- [ ] All existing tests pass (`npm test`)
- [ ] TypeScript build passes (`npm run build`)

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| "Your Classes" means subscribed classes | Could mean attended history | → Attended history (AttendanceRecord) |
| H4 requires secondary DB lookup | Could just skip | → Skip, leave null for now |
| H13 fix belongs in Sidebar | Could normalize at auth layer instead | → Auth layer (auth.ts), single source of truth |
| cls.id in deeplink is ClassInstance ID | Is actually Class template ID | → Needs ClassInstance lookup by classId + today's date |
| dayOfWeek convention mismatch C1→API | Schedule API uses same 0=Sun convention | → Straight field rename (dow → dayOfWeek), same values |

## Technical Context

### C1 — Schedule page
- **File**: `app/member/schedule/page.tsx`
- **Current**: `ALL_CLASSES` is a module-level const; zero API calls
- **Fix**: Add `useEffect` + `fetch("/api/member/schedule")` + replace `ALL_CLASSES` with state; map API `dayOfWeek` → component `dow` (same convention, just field rename)
- **API**: `GET /api/member/schedule` — fully implemented, returns `{id, name, startTime, endTime, coach, location, capacity, dayOfWeek, classInstanceId}`

### C2 — Profile save
- **File**: `app/member/profile/page.tsx`
- **Current**: Inputs use `defaultValue`, no save handler, no PATCH
- **Fix**: Convert name/phone inputs to controlled (`useState`), add Save button with `fetch("/api/member/me", { method: "PATCH", body: JSON.stringify({name, phone}) })`, show success/error feedback
- **API**: `PATCH /api/member/me` — fully implemented, accepts `{name, phone}`

### C5 — Progress "Your Classes"
- **File**: `app/member/progress/page.tsx`
- **Current**: `fetch("/api/member/schedule")` → `.slice(0, 4)` — wrong, shows tenant classes
- **Fix**: Replace with a call to get the member's recent attendance, group by class name, show distinct attended classes. Can use `/api/member/me` `stats.totalClasses` context already available, or add `?history=true` to the schedule API. Simplest: add `GET /api/member/attendance` that returns distinct attended `classId`s with names, or query the existing `/api/member/me` data. **Recommended**: add `?classes=attended` param to `/api/member/schedule` OR use a new lightweight endpoint.
- **Alternative simple fix**: fetch `AttendanceRecord` grouped by class via a dedicated endpoint `GET /api/member/classes` that returns distinct classes attended.

### H3 — Checkin deeplink
- **Files**: `app/dashboard/checkin/page.tsx`, `components/dashboard/AdminCheckin.tsx`
- **Current**: Page has no `searchParams`; hardcodes `initialInstanceId = instances[0].id`
- **Fix**: 
  1. `checkin/page.tsx`: accept `{ searchParams }` prop, read `searchParams.class` 
  2. If `class` param present: query `prisma.classInstance.findFirst({ where: { classId: param, date: { gte: startOfToday, lte: endOfToday }, isCancelled: false } })`
  3. Pass result (or fallback to `instances[0]`) as `initialInstanceId` to `AdminCheckin`

### H13 — Role normalization
- **File**: `auth.ts` (session callback, line 149), `types/next-auth.d.ts`
- **Current**: `session.user.role = token.role as string` — verbatim, no normalization
- **Fix**: `session.user.role = (token.role as string).toLowerCase().trim()`
- **Type fix**: Change `role: string` to `role: "owner" | "manager" | "coach" | "admin" | "member"` in `next-auth.d.ts`

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Member | core domain | id, name, email, phone, role, memberId | belongs to Tenant |
| ClassInstance | supporting | id, classId, date, isCancelled | belongs to Class |
| Class | core domain | id, name, dayOfWeek, tenantId | has many ClassInstances, Schedules |
| AttendanceRecord | core domain | memberId, classInstanceId, checkInTime | belongs to Member, ClassInstance |
| Schedule | supporting | dayOfWeek, startTime, endTime | belongs to Class |

## Trace Findings
- **Most likely explanation**: All 6 bugs are implementation omissions — APIs exist and work correctly, but components were never wired to them.
- **Lane 1 resolved**: C1 uses hardcoded ALL_CLASSES; C2 missing PATCH call — both confirmed by full file read.
- **Lane 2 resolved**: C5 `.slice(0,4)` on unfiltered tenant classes; H4 hardcoded null on line 121. promotedById IS written by rank API so H4 could be fixed but user chose to defer.
- **Lane 3 resolved**: H3 checkin page has zero searchParams reads; H13 role never normalized in 4-layer auth pipeline.
- **Critical unknowns resolved during trace**: (1) promotedById is written — H4 deferrable, not broken-by-design. (2) cls.id is Class template ID — H3 needs instance lookup. (3) dayOfWeek convention matches — C1 is a straight swap.

## Interview Transcript
<details>
<summary>Full Q&A (3 rounds)</summary>

### Round 1
**Q:** For C5: what should "Your Classes" show?
**A:** Show rank + what classes they can see + what classes they actually attended
**Ambiguity:** 30% (Goal: 0.9, Constraints: 0.7, Criteria: 0.75)

### Round 2
**Q (H4):** Resolve promotedBy to name or skip?
**A:** Skip for now — leave as null
**Q (H13):** Normalize role in auth or sidebar?
**A:** User asked for clarification → confirmed: normalize in auth.ts
**Ambiguity:** 20%

### Round 3
**Q (H3):** Auto-select today's instance on deeplink or just open checkin?
**A:** Auto-select today's instance
**Ambiguity:** 9%
</details>
