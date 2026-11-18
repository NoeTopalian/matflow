# Recovering erased member notes: read-only plan (11 Nov 2026)

**Status.** A plan only. Nothing has been read from production. No credential has been used and no data written. Every step marked **[Noe]** is his: production reads, the Neon console, and any write.

## What happened

From `39385235` (1 Jun 2026) until the hotfix (`hotfix/member-notes-preserved`), every member edit that did not send `notes` wrote `notes = null`. That covers:
- the staff profile save;
- a plan change from the Subscribe drawer;
- a status change;
- a support edit session.

The member's internal notes were erased. The notes box itself, which sends only `notes`, saved correctly.

## What evidence exists (from the repository; production not checked)

| Source | What it holds | Usable for | Status |
|---|---|---|---|
| **AuditLog `member.update` rows** | `metadata.fields` = the keys the route parsed. On main this list includes `"notes"` for every erasing edit, because the parsed body carried `notes: null`. **No note text**: `notes` is not in the diff fields | Finding **which** members lost notes and **when** | Exists for every edit since audit logging began |
| **Neon point-in-time restore** (a new branch at a past instant) | The whole database as it was at that instant | Reading the notes as they were just before an erasing edit | **Window unconfirmed.** Neon docs (fetched 4 Oct 2026, `docs/runbooks/RESTORE-REHEARSAL-ISOLATED.md`): Free = 6 hours, paid plans default to 1 day (Launch up to 7, Scale up to 30). The plan in use is not confirmed in the repository; the paid-infrastructure rule says no paid plan until two clubs pay. Never rehearsed. **[Noe]** to read the plan and restore window in the Neon console |
| **Weekly S3 `pg_dump`** (`.github/workflows/db-backup.yml`) | Logical dumps, if they ran | Notes as of each Sunday dump | **Recorded as never working**: `db-restore.md` says the S3 dump does not exist; `GO-LIVE-2026-09.md` says it failed every Sunday since 12 Jul. **[Noe]** to check `gh run list --workflow=db-backup.yml` and the bucket |
| **Kept TeamUp import files** (`ImportJob.fileBlobUrl`, read by `readImportFile`) | The original export rows. The importer builds `notes` from them (`lib/importers/teamup.ts` notes parts; guardian-draft text) | Regenerating notes **that came from an import** | Files are kept on main (no automatic deletion). Covers only imported notes, not notes staff typed later |
| Vercel and Resend logs | Request metadata, not bodies | Nothing | — |

**Not every erased note is recoverable.** A note typed by staff and erased outside the restore window, before any successful S3 dump, is gone from every system-held source. Only staff memory can restore it.

## Step 1: find the affected members (read-only) [Noe runs this against production]

An erasing edit is a `member.update` row whose `fields` include `notes` alongside other fields. The notes box sends `notes` alone, so a row whose only field is `notes` is a deliberate notes save.

```sql
-- READ ONLY. Every erasing edit since the defect landed.
SELECT a."tenantId", a."entityId" AS member_id, a."createdAt" AS erased_at, a."userId",
       a.metadata->'fields' AS fields
FROM "AuditLog" a
WHERE a.action = 'member.update'
  AND a."createdAt" >= '2026-06-01'
  AND a.metadata->'fields' ? 'notes'
  AND jsonb_array_length(a.metadata->'fields') > 1
ORDER BY a."tenantId", a."entityId", a."createdAt";
```

```sql
-- READ ONLY. For each affected member: the last erasing edit, any deliberate
-- notes save after it (staff re-entered notes: preserve it), and the notes now.
WITH erasing AS (
  SELECT "tenantId", "entityId" AS member_id, max("createdAt") AS last_erased_at
  FROM "AuditLog"
  WHERE action = 'member.update' AND "createdAt" >= '2026-06-01'
    AND metadata->'fields' ? 'notes' AND jsonb_array_length(metadata->'fields') > 1
  GROUP BY 1, 2
), later_notes_save AS (
  SELECT a."entityId" AS member_id, max(a."createdAt") AS saved_at
  FROM "AuditLog" a JOIN erasing e ON e.member_id = a."entityId"
  WHERE a.action = 'member.update' AND a."createdAt" > e.last_erased_at
    AND a.metadata->'fields' = '["notes"]'::jsonb
  GROUP BY 1
)
SELECT e.*, l.saved_at AS notes_saved_after, (m.notes IS NULL) AS notes_now_empty
FROM erasing e
JOIN "Member" m ON m.id = e.member_id
LEFT JOIN later_notes_save l ON l.member_id = e.member_id
ORDER BY e."tenantId", e.last_erased_at;
```

**Candidates for recovery** are members with an erasing edit, no deliberate notes save after it, and `notes` empty now. A member with a later notes save, or with notes present now, is **excluded**: their current notes are a later, legitimate edit and are kept.

The audit rows do not show whether the member had notes before the erasing edit. Many candidates will have had none. The sources below decide that.

## Step 2: recover candidate text, per member, read-only

1. **Inside the restore window only.** **[Noe]** creates a Neon point-in-time **branch** at an instant just before each member's first erasing edit (Neon console → Branches → create from a point in time). The branch never touches production (`docs/runbooks/RESTORE-REHEARSAL-ISOLATED.md`). Read `SELECT id, notes FROM "Member" WHERE id IN (...)` on that branch only. Erasures older than the window cannot be read this way.
2. **Imported notes.** For a candidate created by a TeamUp import, re-run the importer's note mapping **read-only** on the kept import file. The proposed text is what the import wrote. It applies only if no deliberate notes save happened between the import and the erasure (the audit trail shows this). A script under `scripts/` would do this against a Neon branch, never production. Not written yet.
3. **Everything else** is unrecoverable from systems. List these members per club so staff can re-enter notes from memory.

## Step 3: compare and propose (no write)

Produce one review file per club with these columns:
- member id;
- current notes (expected empty);
- proposed text;
- source (`pitr:<instant>` or `import:<job id>`);
- the erasing audit row id;
- confidence.

Candidates with no source are listed as "not recoverable: ask staff".

## Step 4: write, only with approval [Noe]

**Do not restore an old database over production.** Any write is a reviewed script, rehearsed on a Neon branch first, applying one row at a time:

```sql
UPDATE "Member" SET notes = $proposed
WHERE id = $member_id AND "tenantId" = $tenant_id AND notes IS NULL;  -- never over a later edit
```

Each applied row writes an audit row (`member.notes.restored`, with source and evidence). The script prints a dry-run first. Noe approves the exact file (by digest) before it runs against production, and runs it himself.

## What Noe decides

1. **Ship the hotfix** (separate approval). Until it is deployed, every profile, plan or status save keeps erasing notes.
2. **Confirm the Neon plan and restore window** in the console. If it is 6 hours, only erasures in the last few hours are readable that way.
3. **Check whether any S3 dump exists:** `gh run list --workflow=db-backup.yml`, then the bucket.
4. **Run the Step 1 queries** (read-only) and share the counts, not the note text, to size this.
5. **Whether to build the read-only import-note regeneration script** (Step 2.2).
6. **Whether to tell affected clubs.** At present that is Total BJJ only. The privacy page says backups are "typically between 7 and 30 days" (`app/legal/privacy/page.tsx:95-96`), which may be false on the current plan. That is a pre-existing finding.
