# Timetable Management

> **Status:** ✅ Working · class CRUD · weekly schedule rules (`ClassSchedule`) · materialised `ClassInstance` rows generated 4 weeks ahead · soft-delete preserves history · weekly grid responsive (commit `8016202`).

## Purpose

The owner's "what runs when" view. Define classes (Fundamentals BJJ, Open Mat, Kids), give each a weekly recurrence rule (`dayOfWeek + startTime + endTime`), and the system materialises individual `ClassInstance` rows for upcoming dates so members can subscribe / check in to specific occurrences.

## Surfaces

| Surface | Path |
|---|---|
| Timetable page | [/dashboard/timetable](../app/dashboard/timetable/page.tsx) |
| Editor + week grid | [TimetableManager](../components/dashboard/TimetableManager.tsx) — Add Class drawer, Generate 4 Weeks button, week grid (Mon-Sun horizontal scroll, min-w 980px per commit `8016202`), All Classes list |

## Data model

```prisma
model Class {
  id             String   @id @default(cuid())
  tenantId       String
  name           String
  description    String?
  instructorId   String?     // legacy free-text
  coachUserId    String?     // FK User — preferred
  coachName      String?     // display fallback
  location       String?
  duration       Int          // minutes
  maxCapacity    Int?
  requiredRankId String?     // members below this rank can't subscribe
  maxRankId      String?     // members above this can't subscribe (e.g. kids-only)
  color          String?
  isActive       Boolean  @default(true)   // "paused" — kept on the schedule but hidden
  deletedAt      DateTime?                  // soft-delete — removed from history
  createdAt      DateTime @default(now())
  ...
}

model ClassSchedule {
  id        String    @id @default(cuid())
  classId   String
  dayOfWeek Int       // 0=Sun, 1=Mon … 6=Sat (JS getDay() convention)
  startTime String    // "09:30"
  endTime   String    // "10:30"
  startDate DateTime  @default(now())
  endDate   DateTime?
  isActive  Boolean   @default(true)
}

model ClassInstance {
  id                 String   @id @default(cuid())
  classId            String
  date               DateTime
  startTime          String
  endTime            String
  isCancelled        Boolean  @default(false)
  cancellationReason String?
  ...
  @@index([classId, date])
  @@index([date, isCancelled])
}
```

`isActive` vs `deletedAt` distinction: paused classes stay visible in history (`isActive=false`), removed classes are gone (`deletedAt!=null`). Soft-delete added in migration `20260430000002_soft_delete_extensions`.

## API routes

### `GET /api/classes`
Staff. Lists active+visible classes for the tenant, includes `schedules` and (optionally) recent `instances`.

### `POST /api/classes`
Owner/manager. Body: `{ name, duration, maxCapacity?, location?, color?, coachUserId?, schedules: [{dayOfWeek, startTime, endTime}] }`. Creates Class + nested ClassSchedule rows.

### `PATCH /api/classes/[id]`
Owner/manager. Tenant-guarded `findFirst({where: {id, tenantId}})`. Updates fields and replaces schedules array if supplied.

### `DELETE /api/classes/[id]`
Soft-delete — sets `deletedAt = now`. Member-side queries default-filter `where: { deletedAt: null }`.

### `POST /api/classes/[id]/instances`
Generate `ClassInstance` rows for the next N weeks. Body: `{ weeks: 1-52 (default 4) }`. Single `findMany` for existing instances (no N+1 — verified by [tests/unit/class-instances-no-n-plus-one.test.ts](../tests/unit/class-instances-no-n-plus-one.test.ts)) and a `createMany` with `skipDuplicates: true` for the rest.

### `POST /api/instances/generate`
Bulk variant — generate for ALL classes in the tenant. Same algorithm as the per-class route, looped.

## Generate-instances algorithm

For each class schedule:
1. `current = today`; advance forward day-by-day until `current.getDay() === sched.dayOfWeek`
2. While `current ≤ today + N weeks`:
   - Build candidate `{ classId, date, startTime, endTime }`
   - Add `current += 7 days`
3. Fetch existing instances in the same range with one `findMany`
4. Filter candidates by the existing-keys Set
5. `createMany(skipDuplicates: true)` — defence in depth against race conditions

## Security

- `requireOwnerOrManager()` on writes (`POST`/`PATCH`/`DELETE`). Reads need staff.
- Tenant-scope guard on every mutation
- `coachUserId` FK constrained to `User` (Prisma relation)
- Soft-delete keeps historical attendance / payments queryable

## Known limitations

- **No timezone awareness.** All times treated as the gym's local time. A multi-region franchise would need `Tenant.timezone`.
- **No exceptions/holidays.** Cancellations are per-instance via `isCancelled=true`; no "skip Christmas" recurrence rule. Owner has to mark each affected ClassInstance individually.
- **Schedule changes don't auto-regen.** If the owner moves a class from Mon to Tue, future instances created under the old schedule remain unless manually deleted.
- **Layout previously cramped on iPad portrait** — class names truncated to "Fun…" / "Adv…". Fixed in commit `8016202` by bumping grid `min-w` from 616px to 980px so the whole strip horizontal-scrolls and each cell is wide enough for full names.

## Files

- [app/dashboard/timetable/page.tsx](../app/dashboard/timetable/page.tsx)
- [components/dashboard/TimetableManager.tsx](../components/dashboard/TimetableManager.tsx)
- [app/api/classes/route.ts](../app/api/classes/route.ts)
- [app/api/classes/[id]/route.ts](../app/api/classes/[id]/route.ts)
- [app/api/classes/[id]/instances/route.ts](../app/api/classes/[id]/instances/route.ts)
- [app/api/instances/generate/route.ts](../app/api/instances/generate/route.ts)
- [prisma/schema.prisma](../prisma/schema.prisma) — `Class`, `ClassSchedule`, `ClassInstance`
