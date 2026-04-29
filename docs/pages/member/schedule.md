# /member/schedule

| | |
|---|---|
| **File** | app/member/schedule/page.tsx |
| **Section** | member |
| **Auth gating** | Auth required; proxy blocks non-members from `/member` |
| **Roles allowed** | member |
| **Status** | ✅ working |

## Purpose
Full weekly class timetable for the member. Renders a swipeable day-view calendar (7-day week strip with day-pill navigation). Each day shows class blocks on an hour-grid (07:00–22:00). Members can tap a class block to open an `EventSheet` bottom drawer showing time, location, coach, capacity, and a subscribe/unsubscribe toggle. A "now" red-line indicator tracks the current time. Week navigation via prev/next chevrons and a "Today" button. Touch swipe gesture (12% threshold) animates between days using a 3-panel strip technique.

## Inbound links
- MobileNav member layout — "Schedule" tab (primary navigation)
- [/member/home](home.md) — announcement link `href="/member/schedule"` (demo data)

## Outbound links
— (self-contained)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/member/schedule | Fetch all tenant class schedules (id, name, startTime, endTime, coach, location, capacity, color, dayOfWeek, classInstanceId) |

## Sub-components
- `DayGrid` (inline) — hour-grid renderer for a single day with class event blocks
- `EventSheet` (inline) — bottom-sheet detail view for a selected class with subscribe toggle

## Mobile / responsive
- Designed exclusively for mobile/touch. Full-height layout `h-[calc(100vh-56px-64px)]` accounting for member nav bars. Touch swipe gesture for day navigation. Day pills scroll horizontally.

## States handled
- Loading: `scheduleLoading` state shows skeleton while fetching.
- Empty: "No classes today" message in DayGrid.
- Subscribe toggle: client-side only (stored in `subscribed` Set state — not persisted to API).

## Known issues
- **P2 open** — Class subscriptions (bell icon toggle) are client-side only; state is lost on page reload and not persisted to the backend. No API call is made when subscribing/unsubscribing.

## Notes
The `dayOfWeek` API field uses JS convention (0=Sun…6=Sat) but the component internally remaps to 1=Mon…7=Sun. The `classInstanceId` field on schedule items enables the Sign-In sheet on `/member/home` to look up today's instance for self check-in. The `primaryColor` is hardcoded to `"#3b82f6"` (PRIMARY constant) rather than fetched from the member's tenant — a known limitation.
