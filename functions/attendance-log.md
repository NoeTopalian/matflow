# Attendance Log

> **Status:** ✅ Working · paginated history of check-ins across the whole gym · 4 method filters · KPI strip.

## Purpose

Read-only audit/reporting view of every check-in. Useful for owners reconciling the door, coaches double-checking who attended, or auditors confirming claimed visits.

## Surfaces

- Page: [/dashboard/attendance](../app/dashboard/attendance/page.tsx)
- Component: [AttendanceView](../components/dashboard/AttendanceView.tsx)

## Data model

```prisma
model AttendanceRecord {
  id              String        @id @default(cuid())
  tenantId        String
  memberId        String
  classInstanceId String
  checkInTime     DateTime      @default(now())
  checkInMethod   String        // "qr" | "admin" | "self" | "auto"

  @@unique([memberId, classInstanceId])  // 1 record per member per class instance
  @@index([memberId, checkInTime])
  @@index([tenantId, checkInTime])
}
```

The `@@unique([memberId, classInstanceId])` prevents double check-ins; later attempts fail with Prisma `P2002` and the route handler returns 409.

## KPIs

This Month / This Week (check-ins) · Active Members (this month) · Top Class (this month).

## Filters

Methods: All / QR Scan / Admin / Self. Searchbox filters by member name or class.

## Security

- `requireStaff()` — anyone on staff can view (audit transparency)
- All Prisma queries tenant-scoped
- No PII beyond what's already on the page (member name, class name)
- Read-only — no mutations from this view

## Known limitations

- **No date-range picker** — fixed window of recent records (last 100 or so).
- **No CSV export** of attendance specifically (Payments has one; attendance doesn't).
- **No "delete check-in" button** — staff has to fix mistakes via direct DB edit.
- **No "auto" check-in source today** — `checkInMethod='auto'` is reserved but no system writes it (would be e.g. proximity-based or NFC).

## Files

- [app/dashboard/attendance/page.tsx](../app/dashboard/attendance/page.tsx)
- [components/dashboard/AttendanceView.tsx](../components/dashboard/AttendanceView.tsx)
