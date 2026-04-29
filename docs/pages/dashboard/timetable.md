# /dashboard/timetable

| | |
|---|---|
| **File** | app/dashboard/timetable/page.tsx |
| **Section** | dashboard |
| **Auth gating** | Auth required; page-level `requireStaff()` |
| **Roles allowed** | owner / manager / coach / admin |
| **Status** | ✅ working |

## Purpose
Class CRUD interface. Lists all active classes for the tenant with name, coach, location, duration, capacity, colour, description, required rank, and their associated weekly schedules (day-of-week + start/end times). Staff can add a new class, edit an existing class, delete a class, add or edit schedule slots, and generate future class instances (batched via `createMany({ skipDuplicates: true })`). Supports `?new=class` query param to open the add-class form immediately on page load (used by the DashboardStats quick-action button).

## Inbound links
- [/dashboard](home.md) — "Add Class" quick-action button (`?new=class`)
- [/dashboard](home.md) — WeeklyCalendar "View timetable" link (no params)

## Outbound links
— (self-contained; no navigation to other pages)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | prisma.class.findMany | Fetch active classes with schedules and required rank (server-side) |
| — | prisma.rankSystem.findMany | Fetch rank systems for the required-rank dropdown (server-side) |
| POST | /api/classes | Create a new class |
| PATCH | /api/classes/[id] | Update class details or schedules |
| DELETE | /api/classes/[id] | Soft-delete or deactivate a class |
| POST | /api/instances/generate | Generate class instances forward (batched, skipDuplicates) |

## Sub-components
- TimetableManager ([components/dashboard/TimetableManager.tsx](../../../components/dashboard/TimetableManager.tsx)) — full client-side CRUD UI with forms, schedule management, and instance generation

## Mobile / responsive
- Primarily desktop-oriented layout. `[needs browser test]` on mobile.

## States handled
- Empty state: empty class list shown by TimetableManager.
- Form validation via zod within TimetableManager.
- DB error: empty arrays passed to component (error silently caught).

## Known issues
— none blocking

## Notes
The `?new=class` query param is consumed by TimetableManager to auto-open the new-class form. Instance generation uses `createMany({ skipDuplicates: true })` (US-009) to avoid duplicates when regenerating.
