# Owner Dashboard Home

> **Status:** ✅ Working · 4 KPI tiles · Owner To-Do drawer (whole header is clickable, recent UX fix `53f3b07`) · Today's Classes widget · 7-day weekly calendar.

## Purpose

The owner's daily landing page. Shows what needs attention RIGHT NOW (Owner To-Do), what's happening TODAY (Today's Classes + KPIs), and the week ahead (Weekly Calendar). Designed to answer "what should I do first?" in <3 seconds.

## Surfaces

| Surface | What |
|---|---|
| `/dashboard` | Main page — [app/dashboard/page.tsx](../app/dashboard/page.tsx) renders [DashboardStats](../components/dashboard/DashboardStats.tsx) + [WeeklyCalendar](../components/dashboard/WeeklyCalendar.tsx) |
| 4 KPI tiles | Owner To-Do · Payments Due · Today's Classes · At-Risk Members — each links to a filtered view |
| Owner To-Do drawer | Side-sheet listing concrete to-dos (missing waivers / phones / quiet members). Whole header is the click target ([commit `53f3b07`](https://github.com/NoeTopalian/matflow/commit/53f3b07)) |
| Today's Classes widget | Inline list with check-in deep-link per class |
| Weekly Calendar | 7 day-cards Mon-Sun with class chips |

## Data flow

```
app/dashboard/page.tsx (server component)
  ├─ requireOwnerOrManager()
  ├─ Promise.all → /api/dashboard/stats + class-instances range query
  └─ <DashboardStats stats classes tenantName primaryColor />
       ├─ KPI tiles (MetricCard component)
       ├─ Owner To-Do panel (button-wrapped header — opens drawer)
       │    └─ filterTodoItems() from lib/dashboard-todo.ts
       └─ Today's Classes panel (date-key filtered)
```

## API routes

### `GET /api/dashboard/stats`
Owner/manager. Returns the metrics block:

```ts
{
  totalActive: number,        // Member.count where status='active'
  newThisMonth: number,
  attendanceThisWeek: number,
  attendanceThisMonth: number,
  waiverMissing: number,      // !waiverAccepted
  missingPhone: number,       // phone is null OR ""
  paymentsDue: number,        // Member.paymentStatus='overdue'
  atRiskMembers: number,      // active + no attendance in last 14 days
}
```

Multi-tenant scoped via `where: { tenantId }` on every query. All queries fired in `Promise.all`.

## Owner To-Do logic ([lib/dashboard-todo.ts](../lib/dashboard-todo.ts))

`filterTodoItems()` keeps any item whose `count > 0`. Items are pre-built in [DashboardStats.tsx:178-211](../components/dashboard/DashboardStats.tsx#L178):

| Item | Filter | Deep-link |
|---|---|---|
| Missing waivers | `!waiverAccepted` | `/dashboard/members?filter=waiver-missing` |
| Overdue payments | `paymentStatus='overdue'` | `/dashboard/members?filter=overdue` |
| Missing phone numbers | `phone IS NULL OR phone=''` | `/dashboard/members?filter=missing-phone` |
| Members not seen in 14 days | left-join attendance, max(checkInTime) | `/dashboard/members?filter=quiet` |

The drawer renders one card per non-zero item. Empty state: green check + "All caught up — nothing to action."

## Recent UX fix (commit `53f3b07`)

Previously only the small "{N} open" pill was clickable; users tapping the panel title or "Items worth checking today" subtitle hit dead space. Now the entire flex header is wrapped in a single `<button>` so any click on title/subtitle/badge opens the drawer. Badge demoted from button to span. `aria-label` added.

## Weekly Calendar

[components/dashboard/WeeklyCalendar.tsx](../components/dashboard/WeeklyCalendar.tsx) renders 7 day-columns with the classes for each day. Today is highlighted; other days show coach + capacity. Click a class card → opens `/dashboard/checkin?class=...`.

## Security

- `requireOwnerOrManager()` at the page level — coaches and admins bounce
- All Prisma queries are tenant-scoped (`where: { tenantId }`)
- No member-level PII rendered above the fold (only counts)

## Known limitations

- **No drag-resize for the calendar.** Fixed 7-day window, no zoom or filter by class.
- **At-risk threshold is hardcoded** (14 days). Could be a tenant setting.
- **KPI tiles always linkable to filtered view** but the filtered view applies the SAME filter logic — drift risk if you add a new criterion in one place but forget the other.
- **Dashboard "Today's Classes (3)" once disagreed with Timetable (1)** — root cause was DST drift in the seed (Apr 30 instances stored at varying UTC offsets crossed midnight differently). Mitigated by the `/api/coach/today` widening (commit `153a9ec`); still keep an eye on this if "Today's Classes" count looks weird after BST/GMT changeover.

## Test coverage

- [tests/unit/todo-filter.test.ts](../tests/unit/todo-filter.test.ts) — `filterTodoItems` returns only non-zero items
- [tests/unit/member-stats-aggregation.test.ts](../tests/unit/member-stats-aggregation.test.ts) — KPI math
- E2E [tests/e2e/dashboard/owner-buttons.spec.ts](../tests/e2e/dashboard/owner-buttons.spec.ts)

## Files

- [app/dashboard/page.tsx](../app/dashboard/page.tsx) — server component, requires owner/manager
- [components/dashboard/DashboardStats.tsx](../components/dashboard/DashboardStats.tsx) — KPIs + Owner To-Do panel + drawer + Today's Classes
- [components/dashboard/WeeklyCalendar.tsx](../components/dashboard/WeeklyCalendar.tsx) — 7-day grid
- [lib/dashboard-todo.ts](../lib/dashboard-todo.ts) — `filterTodoItems` helper
- [app/api/dashboard/stats/route.ts](../app/api/dashboard/stats/route.ts) — KPI source
