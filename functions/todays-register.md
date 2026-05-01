# Today's Register (Coach View)

> **Status:** ✅ Working · DST-safe `/api/coach/today` (commit `153a9ec`) · simple list of today's classes for fast attendance marking from a coach's phone.

## Purpose

Coach-facing equivalent of the dashboard's Today's Classes widget. Strip away admin chrome — show just today's classes, tap one to open the register and tick attendees.

## Surfaces

| Surface | Path |
|---|---|
| Coach landing | [/dashboard/coach](../app/dashboard/coach/page.tsx) |
| Register sheet | Per-class drilldown via [CoachRegister](../components/dashboard/CoachRegister.tsx) |

## API routes

### `GET /api/coach/today`
Authed (coach role and above). Returns today's `ClassInstance` rows for the coach's tenant. **Recently fixed in commit `153a9ec`**:

- Widens the SQL window by ±12 h to catch seed rows that drifted across UTC boundaries
- Strictly filters to today's local calendar date in JS (`toDateString()` match)
- De-dupes by `(classId, startTime)` so a single class showing twice (DST artefact) collapses to one entry

Without the fix, owners saw "No-Gi" twice on Thu 30 Apr because the seed had inserted that instance with one offset on creation and another after BST kicked in.

### `POST /api/coach/instances/[id]/register`
Mark attendance for a member. Creates an `AttendanceRecord` with `checkInMethod='admin'`.

### `PATCH /api/coach/instances/[id]/attendance`
Bulk-set attendance for a register session.

## Flow

1. Coach signs in → `/dashboard/coach`
2. Page server-component fetches `/api/coach/today` → list of today's `ClassInstance`s
3. Each row shows class name, start-end time, location, current `attendedCount` and capacity
4. Coach taps a row → drilldown to register UI
5. Tick boxes → `POST /api/coach/instances/[id]/register` for each member

## Security

- `requireRole(["owner","manager","coach","admin"])` — broader than other staff routes because coaches need access
- Tenant-scoped via the class's tenant (`where: { class: { tenantId } }`)
- Rate limit on register POSTs to prevent accidental double-clicks

## Known limitations

- **No "regular attendees" pre-tick.** Coach has to scan the member list every time. A `Member.regularClasses` join with the current instance's class would auto-tick likely-attendees.
- **No bulk actions** ("mark all present" / "mark all absent" with deselects).
- **Coach can mark anyone present** — even members who don't subscribe to that class. By design (walk-ins) but no warning.

## Files

- [app/dashboard/coach/page.tsx](../app/dashboard/coach/page.tsx)
- [components/dashboard/CoachRegister.tsx](../components/dashboard/CoachRegister.tsx)
- [app/api/coach/today/route.ts](../app/api/coach/today/route.ts) — DST-safe today's classes
- [app/api/coach/instances/[id]/register/route.ts](../app/api/coach/instances/[id]/register/route.ts)
- [app/api/coach/instances/[id]/attendance/route.ts](../app/api/coach/instances/[id]/attendance/route.ts)
