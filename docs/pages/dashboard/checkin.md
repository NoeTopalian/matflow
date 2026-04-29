# /dashboard/checkin

| | |
|---|---|
| **File** | app/dashboard/checkin/page.tsx |
| **Section** | dashboard |
| **Auth gating** | Auth required; page-level `requireRole(["owner", "manager", "admin"])` — coaches explicitly excluded |
| **Roles allowed** | owner / manager / admin (not coach) |
| **Status** | ✅ working |

## Purpose
Admin attendance-marking interface for today's class instances. Shows a class picker at the top (today's non-cancelled instances ordered by start time); selecting a class loads all active/taster members with their current rank and checked-in status. Staff tap a member card to toggle their attendance for that instance. Supports `?class=<classId>` query param to pre-select a specific class (e.g. from a direct link). If a `?class=` param is provided but no matching today's instance exists, an empty state is shown.

## Inbound links
- [/dashboard](home.md) — "Check-In" quick-action button in DashboardStats

## Outbound links
— (self-contained)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | prisma.classInstance.findMany | Fetch today's class instances (server-side) |
| — | prisma.member.findMany | Fetch active/taster members with latest rank (server-side) |
| — | prisma.attendanceRecord.findMany | Fetch existing check-ins for the selected instance (server-side) |
| POST | /api/checkin | Mark a member as checked in (client-side toggle) |
| DELETE | /api/checkin?classInstanceId=&memberId= | Unmark attendance (client-side toggle) |

## Sub-components
- AdminCheckin ([components/dashboard/AdminCheckin.tsx](../../../components/dashboard/AdminCheckin.tsx)) — client-side class picker and member check-in grid

## Mobile / responsive
- Mobile-first design. Member cards displayed in a scrollable list. Class picker is a horizontal scroll strip.

## States handled
- Empty instances: shown when no classes are scheduled today.
- `?class=` param provided but no today's instance found: empty member list state.
- DB error: empty arrays passed (error silently caught).

## Known issues
- **P2 ✅ Mitigated** — `/api/checkin/members` endpoint was unbounded; now cursor-paginated (default 200, max 500) — see OWNER_SITE_SUMMARY.md.

## Notes
Coaches are excluded from this page by `requireRole(["owner", "manager", "admin"])`. They use `/dashboard/coach` instead (which shows only their own classes). The MobileNav component also hides the Check-In tab for coaches.
