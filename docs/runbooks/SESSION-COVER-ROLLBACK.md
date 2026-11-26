# Rolling the app back past session cover (PR #134) once cover rows exist

Added 26 Nov 2026 (PR #134, round 2). Fix forward is the rule (never Vercel Instant Rollback or Promote,
[INCIDENT-AND-RESTORE-RUNBOOK.md](../security/INCIDENT-AND-RESTORE-RUNBOOK.md) §4). This page covers the one case where
a build from before session cover is redeployed (a revert merged to `main`) while the `SessionCover` table holds rows.

## Why the previous build breaks

The migration `20261126120000_session_cover` adds `SessionCover` with RESTRICT keys to `ClassInstance`, `User` and
`Tenant`. The previous build never reads the table, so the app runs, but it deletes sessions and clubs without knowing
about cover rows:

| Previous build's flow | With a cover row on a session it deletes |
|---|---|
| Weekly-slot edit (Timetable, change a class's time) | `PATCH /api/classes/[id]` answers 500 "Failed to update class"; nothing of the edit is saved |
| Attendance-import rollback | The rollback fails on `SessionCover_classInstanceId_fkey`; nothing is rolled back |
| Club purge (closed club, 30-day window passed) | The purge stops on the same key; the club stays, its claim stands, the next run retries and fails again. If the club's only cover rows are detached ones (`classInstanceId` null: a closed or withdrawn row whose session a weekly-slot edit removed), its sessions go and the purge stops later, at its staff step, on `SessionCover_requestedById_fkey` (every row names who asked; the previous build deletes the club's users before the club itself, so it never reaches `SessionCover_tenantId_fkey`) |

A cover row on a session that already ended blocks the import rollback and the purge just as much as an upcoming one.
A detached row blocks only the purge (it references the club and its staff, not a session).

## Procedure (in this order)

1. **Keep the rows outside the database, then remove them.** With `DATABASE_URL` naming the database:

   ```
   node scripts/session-cover-rollback.mjs --expect-host <endpoint> --export <new file.json>            (read only: count and export)
   node scripts/session-cover-rollback.mjs --expect-host <endpoint> --export <another new file.json> --delete
   node scripts/session-cover-rollback.mjs --expect-host ep-bold-wave --export <another new file.json> --delete --confirm-production-delete   (production only; Noe)
   ```

   `--expect-host` is the Neon endpoint (`ep-hidden-salad` for the test branch; production `ep-bold-wave` is Noe's to
   run), or `127.0.0.1` for a local rehearsal database. Against production, `--delete` is refused before anything
   connects unless `--confirm-production-delete` is added as well (the read-only export needs no extra flag); the test
   branch and a local database need no extra flag. The export file must not exist yet. The export and the delete
   run in one transaction that first takes `LOCK TABLE "SessionCover" IN SHARE ROW EXCLUSIVE MODE`, so no cover can be
   requested, claimed or assigned between them; the delete must remove exactly the rows exported or it is rolled back.
   It prints the endpoint host and counts, never the URL. Keep the export file with the incident notes: it is the only
   record of who was covering what.
2. **Deploy the previous build.** Do this straight after step 1. The new build is still live until then, so a cover
   written in between would block again; if the deploy is delayed, run step 1 again with a new export file.
3. **Leave the empty table and the migration in place.** The previous build never reads `SessionCover`; dropping it is
   not needed and would make a later fix-forward re-run the migration by hand.
4. **Tell the club.** Every cover request, claim and assignment is gone from the app: coaches who agreed to cover will
   no longer see "Yours", and the regular coach shows on every session again. Send the club the export as a list
   (session, cover coach) so they can arrange it by hand until the fix goes out.

When session cover comes back (fix forward), the old rows are not restored: covers are asked for again on the sessions
that still need them. The Activity log keeps the history of what happened before the rollback.

## Rehearsal (26 Nov 2026, local database, synthetic club)

Run on WSL Postgres 18 (`127.0.0.1`, database `matflow_local`), never production and never the shared test branch.
The session-cover migration was applied to it from PR #134; the previous build (main `adf1feea`, its own Prisma client
without `SessionCover`) ran from a separate checkout. Two synthetic clubs (`mfv-rollback-<stamp>`), each with two covered
sessions: an upcoming Thursday 19:00 on a live class, and a session created by an attendance import.

| Step | Result |
|---|---|
| Previous build, weekly-slot edit Thu 19:00 to 19:30 | HTTP 500 "Failed to update class"; the covered session still exists |
| Previous build, attendance-import rollback | fails on `SessionCover_classInstanceId_fkey` |
| Previous build, club purge | fails on `SessionCover_classInstanceId_fkey`; the club still exists |
| `session-cover-rollback.mjs --expect-host 127.0.0.1 --export …` | 4 rows exported, nothing removed |
| `session-cover-rollback.mjs --expect-host 127.0.0.1 --export … --delete` | 4 rows exported, 4 removed |
| Previous build, weekly-slot edit (same class) | HTTP 200: 1 slot removed, 1 added, 2 sessions removed, 8 created |
| Previous build, attendance-import rollback | works: 1 session and 1 class removed |
| Previous build, club purge | `purged` (the club whose earlier purge failed resumed its claim and finished) |
