# Round 1: labels that say what their data is (9 Nov 2026)

Baseline `origin/main` 33592fe0. Branch `fix/round1-trust`. Leads came from the 9 Nov
site-tour pack; each was re-traced in the current code before it was changed. No query,
aggregation, amount, role, schema or business rule changed. Facts below hold as of 9 Nov 2026.

## What was claimed, what the code does, what changed

| Screen | Said before | What the source does | Now says |
|---|---|---|---|
| Dashboard home, today's classes | "N booked" | `enrolled` is `_count.attendances` on the ClassInstance (`app/dashboard/page.tsx`), i.e. check-ins, not bookings | "N checked in" |
| Attendance, stat card | "Top Class · this month" | `fetchSummary` groups AttendanceRecord by `classInstanceId` and takes the single busiest instance, then names its class (`app/dashboard/attendance/page.tsx`) | "Busiest session · most check-ins at one session this month" |
| Attendance, footer | "Showing N of M records" | `fetchRecentAttendance` loads the latest 100 rows (`RECENT_ATTENDANCE_LIMIT`); a session view loads up to 1,000. Search and the method filter run only within those rows | `attendanceFooter()`: "Latest 100 records. Older records aren't loaded here." when the limit is reached; "N records." when not; "N matches among the latest 100 loaded records. Search covers only these loaded records." when filtered; "No attendance records yet." only when the club has none loaded |
| Attendance, empty list | "No attendance records found" for both an empty history and a search with no hits | the list is `filtered` from `records` | "No attendance records yet." vs "No matches among the loaded records." |
| Settings → Revenue, "Recent Activity" | "Joined" / "Cancelled" per row | rows are the newest Payment records (`app/api/revenue/summary/route.ts` `recentPayments`); `action` is "cancelled" when status is failed or refunded, else "joined" | heading "Recent payments"; each row labelled by payment status: Paid, Pending, Failed, Refunded, Disputed. The route now also returns `status` (additive); the client falls back to "Payment recorded" / "Failed or refunded" without it |
| Reports → Initiatives | a failed read showed "No initiatives yet"; a refused or lost create or delete showed nothing | `InitiativesPanel` swallowed the read error, ignored non-ok writes and threw on network errors | a failed read shows "Couldn't load initiatives." with Retry (a re-read only); a refused create shows the route's sentence and keeps the draft; a lost response says the outcome isn't known and offers a refresh of the list; a refused delete keeps the row and says so; a 404 on delete re-reads |

## Accessible names added (no handler, permission or destination changed)

| Control | Name |
|---|---|
| Settings → Store, product row edit | "Edit {product}" |
| Settings → Store, product row remove (a soft delete, `deletedAt`) | "Remove {product} from the shop" |
| Settings → Store, Add/Edit Product "In Stock" toggle | `role="switch"`, `aria-checked`, "In stock" |
| Member Shop, quantity and add buttons | "Remove one {product}", "Add one more {product}", "Add {product} to cart" |
| Member Shop, cart | "Close cart", "Remove one {item}", "Add one more {item}", "Remove {item} from cart" |
| Member Schedule, class details sheet close | "Close class details" |
| Login, show/hide password | "Show password" / "Hide password", with `aria-pressed` |
| Reports → Initiatives, delete | "Delete {type} initiative from {date}" |

## Deliberately retained
- The Attendance page still loads at most the latest 100 rows; this round changes the wording only. Pagination or a server search is separate work.
- `/preview` (the static marketing preview) still shows a "Recent Activity" list with "Joined" rows. It is demo copy, outside this round.
- Reports' "Top classes" tile is a different metric (per class, from `lib/reports.ts`) and is unchanged.

## Verification
See the PR body / completion report for the exact commit each check ran on. Unit: `tests/unit/round1-truthful-labels.test.tsx`, `tests/unit/initiatives-panel-failures.test.tsx`, `tests/unit/attendance-session-focus.test.tsx` (three exact-string assertions updated to the new wording; nothing loosened).
