# Admin Check-In (Front Desk)

> **Status:** ✅ Working · staff manually checks in members at the front desk · "Find Walk-In Member" toggle for unknown faces · QR Page link for self-service kiosk.

## Purpose

The front-desk reception view. Staff sees the current/upcoming class, scrollable member roster with rank + membership chips, and one-tap "check in" per member. Walk-in search lets them find members not in the default roster.

## Surfaces

- Page: [/dashboard/checkin](../app/dashboard/checkin/page.tsx)
- Component: [AdminCheckin](../components/dashboard/AdminCheckin.tsx)
- Deep-link from dashboard / coach / weekly calendar via `?class={instanceId}`
- QR Page button at top → [/checkin/[slug]](../app/checkin/[slug]/page.tsx) (member-facing kiosk — see [qr-checkin-kiosk.md](qr-checkin-kiosk.md))

## API

### `POST /api/checkin`
Authed staff route. Body: `{ classInstanceId, memberId, method?: "admin"|"qr"|"self" }`. Creates an `AttendanceRecord` (handles `P2002` duplicate as 409 idempotent), optionally redeems a class pack credit (see [class-pack-purchase-and-redemption.md](class-pack-purchase-and-redemption.md)).

### `GET /api/checkin/members?slug={tenantSlug}&instanceId={id}`
Returns the member roster filtered by:
- Class subscriptions (default — members who follow this class)
- Rank gate (`requiredRankId` ≤ member's rank ≤ `maxRankId`)

When the user clicks "Find Walk-In Member", the UI flips to a global tenant search instead of the class-filtered roster.

## Flow

1. Staff opens `/dashboard/checkin` (or with `?class=...` deep-link)
2. Header shows current class + start time + capacity ("0 checked in · 13 remaining · Cap: 20")
3. Member tiles render: avatar (initials), name, rank chip, membership chip
4. Search box filters by name
5. **Find Walk-In Member** toggle → button label flips to "Walk-In Search Active" → search expands beyond the class roster
6. Tap a member tile → `POST /api/checkin` → row swaps to "✓ Checked in" state

## Security

- `requireStaff()` — coaches can also do front-desk work
- Tenant-scoped (`session.user.tenantId` everywhere)
- Idempotent on `(memberId, classInstanceId)` unique constraint
- Audit logged via `logAudit({ action: "attendance.checkin" })`

## Known limitations

- **Class instance must already exist** — can't check someone into a class on a day where the instance hasn't been generated. Fix: bulk-generate via Timetable's "Generate 4 Weeks" button.
- **No "uncheck" button** — staff has to delete the AttendanceRecord directly from DB if they tap by mistake.
- **Walk-in search has no filter** — shows every member in the tenant; on a 500-member gym it's a long scroll.
- **No member photo** — initials only.

## Files

- [app/dashboard/checkin/page.tsx](../app/dashboard/checkin/page.tsx)
- [components/dashboard/AdminCheckin.tsx](../components/dashboard/AdminCheckin.tsx)
- [app/api/checkin/route.ts](../app/api/checkin/route.ts)
- [app/api/checkin/members/route.ts](../app/api/checkin/members/route.ts)
