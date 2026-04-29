# /dashboard/coach

| | |
|---|---|
| **File** | app/dashboard/coach/page.tsx |
| **Section** | dashboard |
| **Auth gating** | Auth required; page-level `requireStaff()` — all staff roles including coaches |
| **Roles allowed** | owner / manager / coach / admin |
| **Status** | ✅ working |

## Purpose
Coach-flavoured "today's register" — focused on the classes the current user is coaching rather than all instances. Shows today's classes assigned to this coach, attendance counts (using `_count` after US-010 fix), and waitlist if any. Coaches mark or unmark attendance per class instance. Designed as the primary workflow for coaches who do not have access to the full admin check-in page.

## Inbound links
- [/dashboard](home.md) — "Today's Register" link in DashboardStats (`href="/dashboard/coach"`)
- [/dashboard](home.md) — "Today's Register" link at top of class list in DashboardStats

## Outbound links
— (self-contained)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| GET | /api/coach/today | Fetch today's class instances for this coach |
| GET | /api/coach/instances/[id]/register | Fetch member list for a specific instance |
| POST | /api/coach/instances/[id]/attendance | Mark / unmark a member's attendance |

## Sub-components
- CoachRegister ([components/dashboard/CoachRegister.tsx](../../../components/dashboard/CoachRegister.tsx)) — full client-side register UI with class tabs and member attendance toggles

## Mobile / responsive
- Mobile-aware design. CoachRegister is optimised for tablet/phone use during a live class.

## States handled
- Empty state: no classes today for this coach.
- Loading and error states handled within CoachRegister.

## Known issues
— none blocking

## Notes
Unlike `/dashboard/checkin`, this page uses the coach-specific API routes (`/api/coach/*`) which scope queries to the current user's classes. The page component itself is minimal — it delegates everything to `CoachRegister` and passes only `primaryColor`.
