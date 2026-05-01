# Initiatives

> **Status:** ✅ Working · timeline log of owner-defined business events with optional file attachments · feeds AI report context.

## Purpose

When attendance dips in May, the owner wants to look back and remember: "Oh — we ran a free-trial promo in April; that's why May numbers look bad in comparison." Initiatives is a structured log of those events: marketing pushes, new classes added, holiday closures, price changes, coach hires.

Two consumers:

1. **Owner Reports + Analysis** — render initiatives as vertical timeline marks on attendance/revenue charts so the owner can correlate movement with what they did
2. **AI Monthly Report** — recent initiatives feed into the prompt context so the model reasons about them ("attendance is up 15% — likely tied to the new beginners' class added on March 3rd")

## Data model

```prisma
model Initiative {
  id          String   @id @default(cuid())
  tenantId    String
  type        String                          // CHECK enum (see below)
  startDate   DateTime
  endDate     DateTime?                       // null = single-day or open-ended
  notes       String?                         // free-text context
  createdById String
  createdBy   User     @relation(fields: [createdById], references: [id])
  createdAt   DateTime @default(now())

  attachments InitiativeAttachment[]

  @@index([tenantId, startDate])
}

model InitiativeAttachment {
  id           String   @id @default(cuid())
  initiativeId String
  initiative   Initiative @relation(fields: [initiativeId], references: [id])
  filename     String
  url          String                          // Vercel Blob URL
  mimeType     String
  sizeBytes    Int
  uploadedAt   DateTime @default(now())
}
```

`type` enforced at the API layer with Zod `enum(["marketing","new_class","price_change","holiday","coach_hired","other"])` — adding a value requires an API + UI change but no migration.

## Surfaces

- Owner side: Reports tab → "Initiatives" timeline view
- Add modal: type dropdown, start/end dates, notes, optional file upload
- Edit drawer: same fields + delete
- Chart overlays: vertical lines on attendance + revenue charts at `startDate`, hovering shows the type + notes

## API routes

### `GET /api/initiatives`

Owner/manager. Returns last 100 initiatives for the tenant, with attachments included:

```ts
const { tenantId } = await requireOwnerOrManager();
const rows = await prisma.initiative.findMany({
  where: { tenantId },
  include: { attachments: true },
  orderBy: { startDate: "desc" },
  take: 100,
});
```

### `POST /api/initiatives`

Owner/manager. Validated with Zod:

```ts
const createSchema = z.object({
  type: z.enum(["marketing","new_class","price_change","holiday","coach_hired","other"]),
  startDate: z.string().min(1),                  // ISO date string
  endDate: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

const created = await prisma.initiative.create({
  data: {
    tenantId, type, startDate: new Date(startDate), endDate: endDate ? new Date(endDate) : null,
    notes: notes ?? null, createdById: userId,
  },
  include: { attachments: true },
});

await logAudit({tenantId, userId, action: "initiative.create",
  entityType: "Initiative", entityId: created.id,
  metadata: {type, startDate}, req});
```

### `PATCH /api/initiatives/[id]` and `DELETE /api/initiatives/[id]`

Owner/manager only. Tenant-scoped. PATCH allows partial field updates; DELETE removes the initiative + cascades attachments.

### `POST /api/initiatives/[id]/attachments`

Multipart upload. File goes to Vercel Blob, then we record the URL:

```ts
const file = formData.get("file") as File;
if (file.size > 10 * 1024 * 1024) return 413;       // 10MB cap
const blob = await put(file.name, file, { access: "public" });
const att = await prisma.initiativeAttachment.create({
  data: { initiativeId, filename: file.name, url: blob.url,
          mimeType: file.type, sizeBytes: file.size },
});
```

Public-access blobs because owners share these (poster mockups, training plans). If sensitivity ever became an issue, switch to private + signed URLs.

## Type taxonomy

| Type | When to use |
|---|---|
| `marketing` | Promo campaigns, social pushes, outreach events, sponsorships |
| `new_class` | Class added to the schedule (kids' BJJ, women-only Muay Thai) |
| `price_change` | Tier price increases / new tier introduced |
| `holiday` | Closures (bank holidays, retreats, owner away) |
| `coach_hired` | Staff change material to attendance (new coach with following) |
| `other` | Catch-all for "something happened" without a clean category |

Used by the AI report's prompt to weight context — `holiday` initiatives explain attendance dips, `marketing` initiatives explain new-member spikes.

## Monthly Report integration

When [`POST /api/ai/monthly-report`](ai-monthly-report.md) builds context, it pulls initiatives where `startDate >= 60 days ago`:

```ts
const recentInitiatives = await prisma.initiative.findMany({
  where: { tenantId, startDate: { gte: sixtyDaysAgo } },
  orderBy: { startDate: "desc" },
});
```

These are formatted into the prompt as:

```
# Recent business events (likely causes for metric movement):
- 2026-04-12  marketing  "Spring open-mat day, ~30 attendees, posted on Instagram"
- 2026-04-01  new_class  "Added Thursday 7am Beginners' BJJ"
- 2026-03-28  holiday    "Closed Easter weekend"
```

The AI Report itself stores back into the Initiatives table with `type="other"` and the report text in `notes`, so subsequent reports see prior reports as context.

## Chart overlays

In [owner-analysis.md](owner-analysis.md), the line chart for attendance / revenue includes vertical reference lines at each initiative's `startDate`. Hover shows a tooltip with `{type, notes}`. The colour coding:

- `marketing` → blue
- `new_class` → green
- `price_change` → orange
- `holiday` → grey
- `coach_hired` → purple
- `other` → neutral

## Security

| Control | Where |
|---|---|
| Owner/manager only | `requireOwnerOrManager()` on POST/PATCH/DELETE |
| Tenant scope | All reads/writes filter `where: {tenantId}` |
| Type enum (Zod) | Rejects unknown types at API boundary |
| File size cap | 10MB per attachment |
| Public blobs (deliberate) | Owners share these — opt-in to public |
| Audit log | `initiative.create`, `initiative.update`, `initiative.delete` |

## Known limitations

- **No tag system** — beyond `type`, no free-form tagging ("kids-class", "summer-camp"). Initiatives don't compose.
- **No "expected impact" prediction field** — owner can note "expected +15 new members" but the system doesn't compare actual vs expected.
- **No reminders** — adding an initiative for "ramp price 1st June" doesn't trigger an automated reminder on that date.
- **Attachments are public blobs** — fine for posters, risky if owner uploads anything sensitive. UI doesn't warn.
- **No attachment scanning** — file uploads aren't AV-scanned. Vercel Blob doesn't scan either.
- **Type enum is hardcoded** — adding a new type requires a code release. Consider tenant-defined custom types.
- **No analytics on initiatives themselves** — "which marketing pushes correlated with the biggest member growth?" — would need a join + correlation calc.

## Test coverage

- No dedicated unit test for initiative CRUD today
- AI Report prompt context test (recommended) would assert initiatives flow into the prompt with the expected formatting

## Files

- [app/api/initiatives/route.ts](../app/api/initiatives/route.ts) — GET/POST
- [app/api/initiatives/[id]/route.ts](../app/api/initiatives/[id]/route.ts) — PATCH/DELETE
- [app/api/initiatives/[id]/attachments/route.ts](../app/api/initiatives/[id]/attachments/route.ts) — Vercel Blob upload
- [prisma/schema.prisma](../prisma/schema.prisma) — `Initiative`, `InitiativeAttachment`
- See [ai-monthly-report.md](ai-monthly-report.md), [owner-reports.md](owner-reports.md), [owner-analysis.md](owner-analysis.md)
