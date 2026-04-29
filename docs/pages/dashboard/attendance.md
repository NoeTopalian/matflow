# /dashboard/attendance

| | |
|---|---|
| **File** | app/dashboard/attendance/page.tsx |
| **Section** | dashboard |
| **Auth gating** | Auth required; page-level `requireStaff()` |
| **Roles allowed** | owner / manager / coach / admin |
| **Status** | ✅ working |

## Purpose
Read-only attendance history ledger. Shows the last 100 attendance records for the tenant (member name, class name, date, start time, check-in method, check-in timestamp) plus a summary panel (total this week, total this month, unique members this month, top class this month). All data is fetched server-side. No edit actions — purely informational.

## Inbound links
- Sidebar ([components/layout/Sidebar.tsx](../../../components/layout/Sidebar.tsx)) — "Attendance" nav item
- MobileNav ([components/layout/MobileNav.tsx](../../../components/layout/MobileNav.tsx)) — "Attendance" in the More drawer

## Outbound links
— (read-only, no outbound navigation)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | prisma.attendanceRecord.findMany | Last 100 records with member name + class name (server-side) |
| — | prisma.attendanceRecord.findMany (×2) | Month + week records for summary stats (server-side) |
| — | prisma.classInstance.findFirst | Resolve top-class instance ID to class name (server-side) |

## Sub-components
- AttendanceView ([components/dashboard/AttendanceView.tsx](../../../components/dashboard/AttendanceView.tsx)) — renders the records table and summary cards

## Mobile / responsive
- Mobile-first. Table scrolls horizontally on small screens.

## States handled
- Empty list: friendly empty state in AttendanceView.
- DB error: empty arrays and zero summary passed silently (no `console.error`) — see Known Issues.

## Known issues
- **P2 open** — DB error in `getRecentAttendance` / `getSummary` is caught silently with no logging. Same pattern as was fixed on the dashboard page — pending P3 polish pass — see OWNER_SITE_SUMMARY.md.

## Notes
The top-class calculation iterates `monthRecords` in JS (not SQL `GROUP BY`) to find the most-attended class instance ID, then makes a second query to resolve the class name. On tenants with high volume, this could be slow — capped at the month window.
