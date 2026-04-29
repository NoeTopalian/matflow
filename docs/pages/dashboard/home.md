# /dashboard

| | |
|---|---|
| **File** | app/dashboard/page.tsx |
| **Section** | dashboard |
| **Auth gating** | Auth required (not in PUBLIC_PREFIXES); page-level `requireStaff()` — redirects unauthenticated to `/login`, members to `/member/home` |
| **Roles allowed** | owner / manager / coach / admin |
| **Status** | ✅ working |

## Purpose
Primary landing page after staff login. Displays eight live stat cards (total active members, new this month, attendance this week/month, waiver missing, missing phone, payments due, at-risk members not seen in 14 days) plus a weekly calendar (Mon–Sun class instances for the current week with name, coach, capacity, enrolled count). Stats and classes are fetched in parallel via `Promise.all` server-side. The `DashboardStats` component also contains an "Owner To-Do" drawer (amber metric card) that opens a slide-in panel with actionable tasks. Four stat cards link directly to `/dashboard/members` with pre-applied filter query params.

## Inbound links
- [/](../public/root.md) — root redirect
- [/login](../public/login.md) — post-login redirect for staff roles
- [/login/totp](../public/login-totp.md) — post-TOTP-verify redirect
- [/onboarding](../onboarding/owner-wizard.md) — wizard completion redirect

## Outbound links
- [/dashboard/members?filter=waiver-missing](members.md) — "Waiver Missing" stat card
- [/dashboard/members?filter=overdue](members.md) — "Payments Due" stat card
- [/dashboard/members?filter=missing-phone](members.md) — "Missing Phone" stat card
- [/dashboard/members?filter=quiet](members.md) — "At-Risk Members" stat card
- [/dashboard/checkin](checkin.md) — quick-action button in DashboardStats
- [/dashboard/timetable?new=class](timetable.md) — "Add Class" quick-action button
- [/dashboard/coach](coach.md) — "Today's Register" link in DashboardStats

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | prisma.classInstance.findMany | Fetch current week's class instances (server-side) |
| — | prisma.member.count (×5) | Active, new-this-month, waiver-missing, missing-phone, overdue, at-risk counts (server-side) |
| — | prisma.attendanceRecord.count (×2) | Attendance this week + this month (server-side) |

## Sub-components
- DashboardStats ([components/dashboard/DashboardStats.tsx](../../../components/dashboard/DashboardStats.tsx)) — eight metric cards, Owner To-Do drawer, quick-action buttons
- WeeklyCalendar ([components/dashboard/WeeklyCalendar.tsx](../../../components/dashboard/WeeklyCalendar.tsx)) — Mon–Sun class grid; "View timetable" link to `/dashboard/timetable`

## Mobile / responsive
- `max-w-6xl mx-auto space-y-6`. DashboardStats uses responsive grid (`grid-cols-2 md:grid-cols-4`). WeeklyCalendar adapts to screen width with horizontal scroll on small screens.

## States handled
- Empty state: stats default to zeros, classes default to empty array if DB error. Error logged via `console.error("[dashboard]", e)`.

## Known issues
- **P1 ✅ Closed** (`c075575`) — N+1 query on attendance counts replaced with `_count`.
- **P1 ✅ Closed** (`c075575`) — Silent DB error catch replaced with `console.error`.
- **P2 open** — DashboardStats redesign (commit `b811589`) not browser-tested — see OWNER_SITE_SUMMARY.md.

## Notes
The Owner To-Do drawer items are derived from the same stat values (e.g. `waiverMissing > 0` adds a waiver task). The four filter links use `?filter=` query params that `MembersList` reads via `searchParams.get("filter")` on the members page.
