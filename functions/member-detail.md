# Member Detail Page

> **Status:** ✅ Working · 6 tabs · staff-supervised waiver button · Mark Paid drawer · `promotedBy` enrichment (LB-007 commit `18f4061`) · narrow-viewport layout fixed (commit `8016202`).

## Purpose

The owner's deep view on a single member. Header shows identity + key chips (rank, membership, status, payment, waiver). Below: KPI strip + stats row + 6 tabs covering every facet of the member's relationship with the gym.

## Surfaces

| Surface | Path |
|---|---|
| Page | [/dashboard/members/[id]](../app/dashboard/members/[id]/page.tsx) |
| Member profile component | [MemberProfile](../components/dashboard/MemberProfile.tsx) |
| Family panel (below member) | [OwnerFamilyManagement](../components/dashboard/OwnerFamilyManagement.tsx) |
| Supervised waiver | [/dashboard/members/[id]/waiver](../app/dashboard/members/[id]/waiver/page.tsx) — kiosk page for staff-supervised signing (see [waiver-system.md](waiver-system.md)) |

Page renders `<MemberProfile />` first then `<OwnerFamilyManagement />` (order swapped in commit `8016202` so the page opens with the member, not the family panel).

## Header

- Back button → `/dashboard/members`
- Avatar (initials, primary-color gradient)
- Member name `<h1>` — wraps on long names (no longer `truncate` after `8016202`)
- Status pills: Rank (with stripe dots), Membership, Active/Inactive, Payment, Waiver
- "Member since…" + "Action needed" indicator
- Action group: Mark paid manually · Edit · ⋯ menu (Mark inactive, Copy waiver link, Open waiver on this device)

## KPI strip (5 tiles)

Waiver / Payment / Last Visit / Joined / Membership — all `truncate` on values, but the grid is `grid-cols-2 sm:grid-cols-3 xl:grid-cols-5` (commit `8016202`) so labels never get crushed.

## Stats row (5 tiles)

Total Visits · This Month · This Week · Streak · Subscriptions count.

## 6 tabs

| Tab | Source |
|---|---|
| Overview | Contact + Safety, Membership + Billing, Waiver compliance |
| Attendance ({n}) | Last 50 attendance records joined to ClassInstance + Class |
| Payments ({n}) | Payment ledger (see [payments-ledger.md](payments-ledger.md)) |
| Ranks ({n}) | Belt history with `promotedBy` user name (LB-007) |
| Classes ({n}) | ClassSubscriptions (member's followed classes) |
| Notes | Free-text notes |

## API routes

### `GET /api/members/[id]`
Owner/manager/admin/coach. Tenant-guarded. Includes:

- `memberRanks` (with `rankSystem`, recent `rankHistory` records)
- Last 20 `attendances` (joined to ClassInstance → Class)
- **`promotedBy` enrichment** — extracts every distinct `promotedById` across ranks AND rankHistory, runs ONE `User.findMany({where: {id: {in: ids}}})`, attaches `{ id, name }` to each rank/history entry. Replaces the old "always null" behaviour (audit H4).

### `PATCH /api/members/[id]`
Owner/manager. Optimistic concurrency via `updatedAt` check (US-508). Bumps `sessionVersion` on role change.

### `POST /api/members/[id]/rank`
Promote/demote. Writes `MemberRank.update` + appends `RankHistory` row with `promotedById = session.user.id`.

### `POST /api/members/[id]/{link-child,unlink-child}`
Family management — see [member-family.md](member-family.md).

### `POST /api/members/[id]/waiver/sign`
Staff-supervised waiver — see [waiver-system.md](waiver-system.md).

### `POST /api/members/[id]/payments`
Manual payment record — see [payments-ledger.md](payments-ledger.md).

## Security

- `requireRole(["owner","manager","admin","coach"])` — coach can read, owner/manager can write
- All Prisma reads/writes tenant-scoped via `findFirst({where: {id, tenantId}})`
- Optimistic concurrency token on PATCH prevents lost updates from concurrent edits
- Audit log on every mutation (`logAudit({action: "member.*"})`)
- Family-link operations have depth-cap (kids cannot have kids) — checked in [link-child route](../app/api/members/[id]/link-child/route.ts)

## Recent fixes

- **`promotedBy` enrichment** (LB-007, commit `18f4061`) — `MemberRank.promotedBy` is now `{ id, name } | null` instead of always null. Same logic applied to `rankHistory` entries.
- **Layout fix** (commit `8016202`) — narrow viewports (≤1100 px main col) used to crush the name to "N…" because the actions group `shrink-0` consumed all flex space. Header now stacks `flex-col sm:flex-row`, h1 uses `break-words` not `truncate`, KPI grids use progressive breakpoints, render order swapped (Profile then Family).

## Known limitations

- **No "audit trail" tab** — would surface AuditLog entries for this member. Schema supports it (`entityType="Member", entityId={id}`), UI doesn't.
- **Notes tab** is plain text only — no attachments, no markdown.
- **Promotion form** uses next-rank inferred from current; no jump-to-arbitrary-belt UI.
- **Family panel below the fold** on small viewports — discoverability could be a tab instead.

## Files

- [app/dashboard/members/[id]/page.tsx](../app/dashboard/members/[id]/page.tsx)
- [components/dashboard/MemberProfile.tsx](../components/dashboard/MemberProfile.tsx)
- [components/dashboard/OwnerFamilyManagement.tsx](../components/dashboard/OwnerFamilyManagement.tsx)
- [components/dashboard/MarkPaidDrawer.tsx](../components/dashboard/MarkPaidDrawer.tsx)
- [app/api/members/[id]/route.ts](../app/api/members/[id]/route.ts) — promotedBy enrichment lives here
- [app/api/members/[id]/rank/route.ts](../app/api/members/[id]/rank/route.ts)
- [app/api/members/[id]/payments/route.ts](../app/api/members/[id]/payments/route.ts)
