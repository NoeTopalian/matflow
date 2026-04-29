# /dashboard/members

| | |
|---|---|
| **File** | app/dashboard/members/page.tsx |
| **Section** | dashboard |
| **Auth gating** | Auth required; page-level `requireStaff()` |
| **Roles allowed** | owner / manager / coach / admin |
| **Status** | ✅ working |

## Purpose
Searchable, filterable, paginated list of all members in the tenant. Displays name, email, phone, membership type, status, payment status, waiver accepted, account type, DOB, joined date, last visit, and current rank. Supports four `?filter=` query-param values that pre-apply named filters (see Notes). The MembersList component handles search, status/payment/waiver filter dropdowns, and ghost-member "Quiet 14d+" chip. Clicking a row navigates to `/dashboard/members/[id]`.

## Inbound links
- [/dashboard](home.md) — four stat-card links with pre-applied filter params:
  - `?filter=waiver-missing`
  - `?filter=overdue`
  - `?filter=missing-phone`
  - `?filter=quiet`
- [/dashboard/members/[id]](members-id.md) — back button in MemberProfile

## Outbound links
- [/dashboard/members/[id]](members-id.md) — row click navigates to member profile

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | prisma.member.findMany | Fetch all tenant members with last rank + last attendance (server-side) |

## Sub-components
- MembersList ([components/dashboard/MembersList.tsx](../../../components/dashboard/MembersList.tsx)) — full client-side table with search input, filter dropdowns, pagination, and row click navigation

## Mobile / responsive
- Mobile-first table with horizontal scroll fallback. Some columns (Method, Last Visit) may be hidden or truncated on narrow screens — `[needs browser test]`.

## States handled
- Empty list: friendly empty state shown by MembersList.
- DB error: empty `members` array passed to component (error silently caught — no `console.error`).

## Known issues
- **P2 open** — Mobile column truncation for "Method" / "Last Visit" — needs browser test.
- **P2 open** — No SWR mutation after add/edit/delete; other open tabs see stale data.

## Notes
### Supported `?filter=` query params
The four filter values are read by `MembersList` via `searchParams.get("filter")` (line 145):

| Value | Effect |
|---|---|
| `waiver-missing` | Pre-filters to active/taster members with `waiverAccepted === false` |
| `overdue` | Pre-filters to members with `paymentStatus === "overdue"` |
| `missing-phone` | Pre-filters to active/taster members with no phone number |
| `quiet` | Pre-filters to active members with no check-in in the last 14 days |

All four are set as clickable links in the Owner To-Do drawer (`DashboardStats.tsx` lines 181–205).
