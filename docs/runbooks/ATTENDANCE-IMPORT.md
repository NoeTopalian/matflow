# Importing a club's attendance history

Written 2026-09-30. Planner: `lib/importers/attendance.ts` (`parseAttendanceCsv`, `planAttendanceImport`), pinned by `tests/unit/import-attendance.test.ts`. The route that writes a plan to the database is `app/api/admin/import/attendance/route.ts` (owner only): `POST mode=preview` stores the file and plans it; `POST mode=commit` with the `jobId` re-reads and re-plans, then writes past `ClassInstance` rows and `AttendanceRecord` rows tagged with the import job (a live check-in for the same member and session wins); `DELETE ?jobId=` rolls the job back. A committed file cannot be imported again until it is rolled back — to correct an import, roll it back, fix the cause, and import again.

> **Format acceptance is BLOCKED until the club's real export has been inspected.** The default column mapping below is a TeamUp-*style* guess built from synthetic fixtures. No real attendance export has been read. Before any club's history is imported: obtain the actual file, check its header row, statuses, date and time formats and timezone against this contract, adjust the mapping (or the parser) and add a fixture with the file's exact header row to the tests. Until then, nothing here is a promise to a club.

## What an import does — and never does

It turns historical rows into **past class sessions** and **attendance records** so the member's history and the reports show what happened before MatFlow. It **never** consumes a class credit or pack, creates a payment or invoice, sends an invitation, fires a notification or touches a waiver. The plan types carry no field for any of those (asserted in the tests), and the commit route must write with plain inserts, never through the check-in route. Every record is written with `checkInMethod: "import"`.

## Data contract

### Columns

Headers are matched case-insensitively; the first candidate present wins. A club-specific `mapping` can override any field.

| Field | Required | Default header candidates |
|---|---|---|
| Class | **yes** | Event Name, Class, Class Name, Event |
| Start date | **yes** (or a combined start) | Start Date, Date, Event Date |
| Start time | **yes** unless the date cell carries the time | Start Time, Time |
| Combined start | alternative to the two above | Start, Start Date Time, Start Datetime, Starts At |
| Status and/or attended flag | **at least one** | Status, Attendance Status, Booking Status / Attended, Checked In, Attendance |
| Customer id and/or email | **at least one** | Customer ID, Member ID, Client ID / Customer Email, Email, Email Address |
| Customer name | optional, strongly recommended | Customer Name, Name, Member Name |
| End time | optional | End Time |
| Row id | optional | Attendance ID, Booking ID, Registration ID, ID |

A file missing a required field is refused whole, naming every missing field. Headers present that no field uses are **reported** (`unmappedColumns`), as are blank header cells and mapped columns that are empty on every row (`blankColumns`) — the importer never guesses what an unknown column means.

### Dates and times

Club **wall-clock** times, in the club's IANA timezone (`Tenant.timezone`). Dates: `YYYY-MM-DD` or UK `DD/MM/YYYY`. Times: `HH:mm`, `HH:mm:ss`, or `h:mm am/pm`. There is no free-form fallback: `03/04/2026` is always 3 April, and a US-ordered export has to be declared, not detected. A timestamp carrying an offset or `Z` is refused (`offset_not_supported`) — it is a different contract (an instant, not a wall clock) and will be supported only once a real export shows it.

DST: conversion goes through `parseTime` in `lib/class-time.ts`. On the spring-forward day a time inside the missing hour (e.g. 01:30 on 29 Mar 2026 in London) is **quarantined** (`nonexistent_local_time`), never shifted. In the autumn repeated hour (01:00–01:59 on 25 Oct 2026 in London) the time is ambiguous; it resolves to the **second (GMT)** occurrence. Clubs rarely run classes then; if the file has any, confirm them with the club.

### Statuses

| Source wording (case-insensitive) | Outcome |
|---|---|
| attended, checked in, present, completed, visited, signed in | **record** |
| booked, reserved, confirmed, registered | excluded `booked` (becomes a record if the attended flag says yes) |
| cancelled, canceled | excluded `cancelled` (always — an attended flag does not override it) |
| late cancel, late cancelled, late cancellation | excluded `late_cancel` |
| no show, no-show, absent, missed | excluded `no_show` |
| waitlist, waitlisted, waiting list | excluded `waitlisted` |
| (no status) + attended flag yes / no | record / excluded `not_attended` |
| attended + flag no, or no-show + flag yes | quarantined `conflicting_status` |
| anything else, or an unreadable flag | quarantined `unknown_status` |
| nothing at all | quarantined `missing_status` |

### Matching people

1. **Source customer id**, against the ids the caller supplies per member (`PlanMember.sourceIds`). MatFlow has no column for these yet — see "Open" below.
2. Else **email**, exact and lower-cased, and only when exactly one member holds it (`ambiguous_email` otherwise). If the row's name differs from that member's name the row is quarantined `email_name_mismatch`: in practice that is a child booked on a parent's address, and crediting the parent would be wrong. Imported children carry synthesised addresses, so a child's history can only be matched by source id.
3. **Never by name alone.** No id and no email → `no_person_key`; nothing matched → `unresolved_person`.

### Matching classes

By name — trimmed, case-insensitive, whitespace collapsed — or by an alias the owner supplies (`PlanClass.aliases`). An unknown name still produces a session with `classId: null` so the owner can see it, and its rows are quarantined `unknown_class`; two classes sharing the name → `ambiguous_class`. **A class is never invented**: the owner creates or aliases it and re-runs.

### Sessions and records

A session is one class at one UTC instant, carrying the club-local date and `HH:mm` needed for `ClassInstance` (`date` via `sessionDayMarker`, `startTime`, `endTime`). End: the export's end time, else start + the class's duration, else none. A record is one member in one session (the same pair as `AttendanceRecord @@unique([memberId, classInstanceId])`), with `checkInTime` = session start (exports carry no real check-in instant). The same person twice in a session collapses to one record; the extra rows are excluded `duplicate` and listed on the record's `sourceRowIds`.

### Provenance

Every record lists the source row ids it came from (the export's own id column, else `row:<line>`). Every excluded or quarantined row carries its row id, file line, reason and detail. The plan should be stored on the `ImportJob` (`dryRunSummary` / `errorLog`) with the uploaded file, so any record can be traced back to its line.

## Reconciliation

Every input row lands in exactly one bucket: **records + excluded + quarantined = input rows** (duplicates are counted inside excluded). The totals give three views to check against the old platform's own reports before committing:

- **by month** (club-local `YYYY-MM`; unreadable dates under `unknown`): records, excluded, quarantined;
- **by person**: records per member — spot-check a regular and a beginner with the club;
- **by session**: records per session — compare a few busy classes with the old register.

A discrepancy is resolved before commit, not after.

## Partial failure, restart and correction

- **Deterministic keys.** Session keys are `class:<classId>@<UTC start>` (or `name:<name>@<UTC start>` for an unmatched class); record keys append `#<memberId>`. A re-run of the same file — or the same rows in another order — produces the same keys.
- **Restart.** The commit route must be idempotent on those keys: upsert the `ClassInstance` on `(classId, date, startTime)` and insert `AttendanceRecord` with skip-on-conflict on `(memberId, classInstanceId)`. A run that dies half-way is re-run with the same file; rows already written are skipped, nothing is doubled. Commit in bounded batches inside `withTenantContext`.
- **Correction.** Fix the cause (add the member's source id, create or alias the class, correct the file) and re-run: previously quarantined rows now plan as records, previously written ones are skipped. Removing a wrongly imported record needs provenance on the row (below) so that only `import` rows from that job are touched — never live check-ins.
- **Existing live check-ins.** A live record for the same member and instance wins; the import skips it.

## Open (needs a decision before the commit route)

1. **Real export** — blocked as above.
2. **Member source ids** — MatFlow stores no previous-platform customer id, so `sourceIds` must be passed in by the caller. Proposal: a nullable `Member.externalRef String?` with `@@unique([tenantId, externalRef])`, written by the member importer.
3. **Record provenance** — `AttendanceRecord` has no import link; `checkInMethod = "import"` is the only marker. Proposal: nullable `importJobId String?` (+ index) and `sourceRowId String?` on `AttendanceRecord`, so a bad import can be rolled back by job without touching live data.
4. **Historical instances** — imported `ClassInstance` rows fall inside the class's schedule range; confirm the class-instances cron and the timetable ignore past dates so history does not reappear as bookable classes.
