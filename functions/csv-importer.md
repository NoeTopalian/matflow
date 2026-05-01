# CSV Importer

> **Status:** ✅ Working · members + ranks + tiers via header-mapped CSV upload · all-or-nothing transaction per file · audit-logged.

## Purpose

When a gym migrates from another platform (ClubManager, Spond, MindBody), they have spreadsheets — not API access. The CSV importer accepts those spreadsheets, lets the owner map each column to a MatFlow field, and atomically inserts the rows. Without this, onboarding a 200-member gym takes a day of manual entry; with it, ~5 minutes.

## Surfaces

- Settings → Account → "Import members" (and similar entries for ranks, tiers under their respective tabs)
- Drop-zone + file picker accepting `.csv` / `.tsv`
- Step 2: column-mapping UI — left side shows CSV headers, right side shows MatFlow fields, drag-to-pair
- Step 3: dry-run preview ("this will create 187 members, skip 12 duplicates by email")
- Step 4: commit → progress bar → completion summary

## Supported imports

| Entity | Required columns | Optional columns | Dedup key |
|---|---|---|---|
| Member | `name`, `email` | `phone`, `dateOfBirth`, `membershipType`, `joinedAt`, `notes`, `emergencyContactName`, `emergencyContactPhone`, `emergencyContactRelation`, `medicalConditions` | `(tenantId, email)` |
| Rank assignment | `memberEmail`, `discipline`, `rankName` | `stripes`, `achievedAt` | `(memberId, rankSystemId)` |
| Membership tier | `name`, `pricePence`, `currency` | `description`, `interval` | `(tenantId, name)` |
| Class schedule | `className`, `dayOfWeek`, `startTime`, `endTime` | `coachName`, `location`, `capacity` | `(tenantId, className)` for the class; schedules append |

## Flow — Members import

### Step 1 — Upload + parse

Server endpoint: `POST /api/members/import` (multipart). Streams file into memory (gym CSVs are small — <5MB cap), parses with `papaparse`:

```ts
const Papa = (await import("papaparse")).default;
const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
const headers = parsed.meta.fields ?? [];
const rows = parsed.data as Record<string, string>[];
```

Returns `{ uploadId, headers, sampleRows: rows.slice(0, 5) }` to the client. The full row set is cached server-side for the next step (in-memory; abandoned uploads garbage-collect after 10 minutes).

### Step 2 — Column mapping

Client posts `{ uploadId, mapping: {csvHeader: matflowField, ...} }`. Server validates required fields are mapped, runs a dry-run:

```ts
let toCreate = 0, toSkip = 0, errors: string[] = [];
const existingEmails = new Set(
  (await prisma.member.findMany({where:{tenantId}, select:{email:true}}))
    .map(m => m.email.toLowerCase())
);

for (const row of rows) {
  const email = row[mapping.email]?.toLowerCase().trim();
  if (!email || !isEmail(email)) { errors.push(`Row ${i}: invalid email`); continue; }
  if (existingEmails.has(email)) { toSkip += 1; continue; }
  toCreate += 1;
}
return { toCreate, toSkip, errors: errors.slice(0, 20) };
```

The 20-error cap keeps the response payload small; if there are 200 invalid rows the user fixes the CSV before retrying.

### Step 3 — Commit

Client posts `{ uploadId, confirm: true }`. Server runs the import in a single `$transaction`:

```ts
await prisma.$transaction(async (tx) => {
  for (const row of validRows) {
    await tx.member.create({
      data: {
        tenantId, name: row.name, email: row.email,
        phone: row.phone ?? null,
        dateOfBirth: row.dateOfBirth ? new Date(row.dateOfBirth) : null,
        membershipType: row.membershipType ?? null,
        joinedAt: row.joinedAt ? new Date(row.joinedAt) : new Date(),
        ...
      },
    });
  }
}, { timeout: 60_000 });

await logAudit({tenantId, userId, action: "csv_import.completed",
  entityType: "Member", entityId: "_bulk",
  metadata: {created: validRows.length, skipped: skippedRows.length}, req});
```

All-or-nothing: if any single row fails (e.g. constraint violation), the entire transaction rolls back. The owner gets an error and the DB is unchanged. The 60s timeout accommodates 1000-row imports; bigger imports would need a job queue.

## Date / boolean parsing

CSVs are wildly inconsistent about formats. Helpers tolerate:

- **Dates**: ISO (`2024-03-15`), UK (`15/03/2024`), US (`03/15/2024` — guessed from header name), Excel-serial integers
- **Booleans**: `true / false / yes / no / y / n / 1 / 0` (case-insensitive)
- **Phone**: stripped of spaces, dashes, parens; left as string (no E.164 normalisation)
- **Empty strings → null** for nullable fields

Ambiguous date formats (`03/04/2024`) are reported in the dry-run errors so the owner clarifies before commit.

## Member dedup

By lowercased email per-tenant. Already-existing members are skipped, not updated — "re-import to update" would be a footgun. Owner can bulk-edit via the members list instead.

## Rank assignment

Two-step: (1) members must already exist (look up by email); (2) rank systems must exist for the discipline. Missing either → row error.

```ts
const member = await tx.member.findFirst({where:{tenantId, email: row.memberEmail}});
const rankSystem = await tx.rankSystem.findFirst({
  where:{tenantId, discipline: row.discipline, name: row.rankName, deletedAt: null}
});
if (!member || !rankSystem) { errors.push(...); continue; }
await tx.memberRank.upsert({...});
```

The `upsert` means re-importing updates the achieved date / stripes if newer.

## Security

| Control | Where |
|---|---|
| Owner-only | `requireOwner()` on import endpoints |
| Tenant scope | All inserts carry `tenantId` from session, never from CSV |
| File-size cap | 5MB; rejects larger uploads with 413 |
| MIME validation | Accepts `text/csv`, `text/tab-separated-values`, `application/csv` |
| Atomic transaction | All-or-nothing — partial imports impossible |
| Email dedup | Prevents accidental duplicates |
| In-memory upload cache | 10-min GC; not persisted to disk |
| Audit log | `csv_import.completed` with row count |

## Known limitations

- **No background jobs** — large imports (>2000 rows) may exceed the 60s transaction timeout. Worth a queue + progress polling for big migrations.
- **No update-on-reimport** — only create-or-skip. Owner can't bulk-fix a typo across 100 members via CSV.
- **No rollback UI** — if the owner regrets an import, they have to delete members manually. A "rollback last import" feature would require import-batch tagging.
- **Memory bound** — entire file in memory. ~5MB cap is fine for member CSVs (200 rows × ~25KB each), tight for richer payloads.
- **No mapping persistence** — every import re-maps columns from scratch. Saving the mapping per source ("ClubManager export → fields") would speed re-imports.
- **No rank dedup beyond `(memberId, rankSystemId)`** — a member with two BJJ blue-belt entries (different stripes) collapses to one.
- **No soft-error handling** — one bad row aborts the whole transaction. A "skip-and-continue" mode would be friendlier.

## Test coverage

- Unit tests for the date / boolean parsers
- Integration test: small CSV → mapping → commit → row count assert (recommended; not yet exhaustive)

## Files

- `app/api/members/import/route.ts` — multipart upload + dry-run + commit
- `components/dashboard/CsvImporter.tsx` — three-step wizard UI
- `lib/csv-parsers.ts` — date/boolean/phone normalisation helpers
- See [members-list.md](members-list.md), [ranks-management.md](ranks-management.md), [memberships-tiers.md](memberships-tiers.md), [audit-log.md](audit-log.md)
