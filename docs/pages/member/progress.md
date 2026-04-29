# /member/progress

| | |
|---|---|
| **File** | app/member/progress/page.tsx |
| **Section** | member |
| **Auth gating** | Auth required; proxy blocks non-members from `/member` |
| **Roles allowed** | member |
| **Status** | ✅ working |

## Purpose
Member progress tracker. Shows: current belt card (belt colour graphic, stripe pips, promoter name, yearly class-count progress bar to 150), four stat cards (classes this week / this month / this year / current streak in weeks), and a "Your Classes" list of subscribed class schedules. Falls back to demo data (`DEMO_MEMBER`) if the API call fails.

## Inbound links
- MobileNav member layout — "Progress" tab (primary navigation)

## Outbound links
- [/member/schedule](schedule.md) — empty-state link "Go to Schedule to subscribe to classes"

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/member/me | Fetch member name, belt (name/color/stripes/promotedBy), attendance stats (thisWeek/thisMonth/thisYear/streakWeeks/totalClasses), primaryColor |
| GET | /api/member/classes | Fetch subscribed class schedules (id, name, day, time, coach) |

## Sub-components
- `BeltCard` (inline) — belt graphic with stripe pips and yearly progress bar

## Mobile / responsive
- Mobile-first, `px-4` padded. Stats in a `grid-cols-2` grid. Belt card and class list stack vertically.

## States handled
- Load error: red retry banner with retry button.
- Loading: `classesLoading` spinner on the classes section.
- Empty classes: friendly empty state with link to schedule.
- Demo fallback: `DEMO_MEMBER` data shown until API resolves.

## Known issues
- **P2 open** — Progress bar denominator is hardcoded to 150 (`const pct = Math.round((totalClasses / 150) * 100)`) regardless of belt level; not configurable per belt or tenant.

## Notes
The `streakWeeks` value in `stats` is computed server-side in the `/api/member/me` handler. The `primaryColor` from the API response updates the component's colour theme dynamically.
