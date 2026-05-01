# Members List

> **Status:** ✅ Working · cursor pagination · 5 server-side filter chips · 5 KPI tiles · clickable rows.

## Purpose

The owner's roster view — every member at the gym, with quick filters for "needs attention" categories that match the dashboard's Owner To-Do tiles.

## Surfaces

- Page: [/dashboard/members](../app/dashboard/members/page.tsx)
- Table: [MembersList](../components/dashboard/MembersList.tsx)

## Filter chips → URL `?filter=`

| Chip | Server filter |
|---|---|
| All | none |
| Needs Attention | `OR: [{!waiverAccepted}, {phone IS NULL}, {paymentStatus='overdue'}, atRisk]` |
| Waiver Missing | `waiverAccepted: false` |
| Missing Phone | `phone: null` |
| Quiet (14d+) | left-join attendance, max(checkInTime) older than 14d |
| Kids | `parentMemberId: { not: null }` |

Filter is **server-side pushdown** so it works across the entire dataset, not just the loaded page.

## API

### `GET /api/members?cursor=...&take=50&filter=...`
Staff. Cursor pagination on `id` (cursor = id of last item from previous page). Returns `{ members, nextCursor }`. Tenant-scoped via `where: { tenantId }`. Includes the most recent `MemberRank` per member (1 per discipline) for the rank chip column.

### `POST /api/members`
Owner/manager/admin. Creates a member. For non-kid members: auto-mints a `MagicLinkToken purpose='first_time_signup'` and sends invite email — see [accept-invite.md](accept-invite.md). Kids get a synthesised email and no token.

## KPI tiles (top of page)

Total Members · Paid · Overdue · Waivers Missing · Tasters

## Security

- `requireStaff()` on GET (owner/manager/admin/coach) — coach can READ but not write
- `requireRole(["owner","manager","admin"])` on POST
- Audit log on every create (`logAudit({action: "member.create" | "member.create.kid"})`)

## Known limitations

- **No bulk actions** (mass-archive, bulk waiver chase email).
- **Search** is client-side filter on the loaded page only — doesn't query server.
- **Default sort** is `joinedAt desc` — no toggle.

## Files

- [app/dashboard/members/page.tsx](../app/dashboard/members/page.tsx)
- [components/dashboard/MembersList.tsx](../components/dashboard/MembersList.tsx)
- [app/api/members/route.ts](../app/api/members/route.ts)
