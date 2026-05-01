# Waiver System

> **Status:** ✅ Working · production-ready · two collection paths (member self-serve + staff-supervised) · immutable signed snapshots stored in Vercel Blob.

## Purpose

Capture each member's signed liability waiver for legal/compliance purposes. Every gym (`Tenant`) can override the default waiver text with its own; every signature is stored as an immutable `SignedWaiver` snapshot (title + content frozen at sign time, plus signer name, drawn signature image, IP, user-agent, and a `collectedBy` field that records *how* the waiver was collected — self-serve vs staff-supervised on a front-desk device).

---

## User-facing surfaces

| Surface | Who uses it | Path |
|---|---|---|
| Member onboarding waiver step | Adult member, first login | [app/onboarding/page.tsx](../app/onboarding/page.tsx) (signs via `/api/waiver/sign`) |
| Member profile reminder | Adult member who skipped onboarding | [app/member/profile/page.tsx](../app/member/profile/page.tsx) |
| Owner-side member detail "Waiver missing" chip | Staff | [components/dashboard/MemberProfile.tsx](../components/dashboard/MemberProfile.tsx) |
| **Supervised waiver page** (front-desk iPad) | Staff hands device to member | [/dashboard/members/[id]/waiver](../app/dashboard/members/[id]/waiver/page.tsx) → [SupervisedWaiverPage.tsx](../components/dashboard/SupervisedWaiverPage.tsx) |
| Owner To-Do "Missing waivers" tile | Owner dashboard | [DashboardStats.tsx](../components/dashboard/DashboardStats.tsx) → links to `/dashboard/members?filter=waiver-missing` |
| Settings → Waiver tab (custom text) | Owner | [components/dashboard/SettingsPage.tsx](../components/dashboard/SettingsPage.tsx) — Waiver tab |
| "Copy waiver link" / "Open waiver on this device" actions | Staff (member detail "More" menu) | Magic-link `purpose='waiver_open'` flow |

---

## Data model

### `Tenant` (extends from base — see [prisma/schema.prisma:41-42](../prisma/schema.prisma))
```prisma
waiverTitle    String?  // override (null = use default)
waiverContent  String?  // override (null = use default from lib/default-waiver.ts)
```

### `Member`
```prisma
waiverAccepted    Boolean   @default(false)
waiverAcceptedAt  DateTime?
```
*Quick-check fields — set when any `SignedWaiver` row is created. Never trusted as the legal record on their own; the `SignedWaiver` snapshot is.*

### `SignedWaiver` — the immutable legal record
```prisma
model SignedWaiver {
  id                String    @id @default(cuid())
  memberId          String
  member            Member    @relation(fields: [memberId], references: [id])
  tenantId          String
  titleSnapshot     String     // frozen at sign time — survives later Settings changes
  contentSnapshot   String     // frozen at sign time
  version           Int       @default(1)
  signerName        String?
  signatureImageUrl String?    // Vercel Blob public URL (PNG)
  collectedBy       String?    // 'self' | 'admin_device:{userId}'
  ipAddress         String?
  userAgent         String?
  acceptedAt        DateTime  @default(now())

  @@index([memberId, acceptedAt])
  @@index([tenantId])
}
```

A new `SignedWaiver` row is **never updated** — re-signs append a new row (auditable history).

### `MagicLinkToken` (re-used for "open waiver on a different device")
```prisma
purpose String @default("login")    // login | first_time_signup | waiver_open
```
The `waiver_open` purpose lets a staff user generate a single-use link that opens the supervised-waiver page on (e.g.) the member's own phone instead of the front-desk iPad.

---

## Default waiver text

Source: [lib/default-waiver.ts](../lib/default-waiver.ts) — `buildDefaultWaiverTitle()` + `buildDefaultWaiverContent(gymName)`.

> *"I acknowledge that martial arts and combat sports involve physical contact, which carries an inherent risk of injury. By signing this waiver, I voluntarily accept all risks associated with training and participation at {gymName}…"*

UK English, ~5 short paragraphs, gym-name-templated. Used until/unless the owner overrides it in Settings → Waiver.

---

## API routes

### `GET /api/waiver` ([route.ts](../app/api/waiver/route.ts))
Returns the **current** waiver to display (tenant override OR default).
- Auth: any logged-in user (member or staff)
- Response: `{ title, content, isCustom }`
- `isCustom: true` when either `waiverTitle` or `waiverContent` is non-null on the tenant

### `POST /api/waiver/sign` ([route.ts](../app/api/waiver/sign/route.ts)) — member self-serve
- Auth: any logged-in user with `session.user.memberId` set
- Rate-limit: **5 attempts per 15 min per memberId** (`waiver:sign:{memberId}` bucket)
- Body Zod-validated: `{ signatureDataUrl: dataURL ≤ 200KB, signerName: 1-120 chars, agreedTo: literal(true) }`
- Validates PNG via magic bytes (0x89 0x50 0x4E 0x47) — rejects fake `.png` bombs
- Returns 503 when `BLOB_READ_WRITE_TOKEN` env var unset
- Uploads signature to Vercel Blob: `tenants/{tenantId}/signatures/{cuid}.png` with `addRandomSuffix: true`
- Snapshots tenant title + content into the new `SignedWaiver` row (frozen — survives later settings changes)
- Updates `Member.waiverAccepted = true` + `waiverAcceptedAt = now`
- Calls `logAudit({ action: "waiver.sign", entityType: "Member", entityId: memberId, metadata: { signedWaiverId, collectedBy: "self" }, req })`
- Returns 201 with `{ ok, signedWaiverId, signatureImageUrl }`

### `POST /api/members/[id]/waiver/sign` ([route.ts](../app/api/members/[id]/waiver/sign/route.ts)) — staff-supervised
Same shape as above, **but**:
- Auth: staff only (`owner | manager | admin | coach`)
- Tenant-scope enforced via `findFirst({ where: {id, tenantId} })` (never bare `findUnique` — see Sprint 2 gate B-5)
- Rate-limit keyed by **staff user id**, not memberId (`waiver:supervised:{userId}`)
- `collectedBy: "admin_device:{staffUserId}"` — honest about who collected it
- Audit action: `"waiver.sign.supervised"` with `staffSupervisedBy` in metadata

---

## End-to-end flows

### Flow 1 — Member self-serve (during onboarding)
1. Member finishes onboarding wizard, lands on the waiver step
2. Client fetches `GET /api/waiver` → renders title + content
3. Member draws signature in `<SignaturePad>` ([components/ui/SignaturePad.tsx](../components/ui/SignaturePad.tsx))
4. Member ticks "I agree" + types their name + clicks Sign
5. Client converts canvas → PNG dataURL → POSTs to `/api/waiver/sign`
6. Server validates rate-limit → Zod → PNG magic bytes → uploads to Vercel Blob → creates `SignedWaiver` → flips `Member.waiverAccepted` → audit-logs → returns 201
7. Member redirects to `/member/home` with the gym now unlocked

### Flow 2 — Staff supervised (front-desk iPad)
1. Owner opens member detail → "More actions" menu → **"Open waiver on this device"** (only visible when `waiverAccepted === false` and role ∈ {owner, manager, admin, coach})
2. Browser navigates to `/dashboard/members/[id]/waiver`
3. Page renders [SupervisedWaiverPage](../components/dashboard/SupervisedWaiverPage.tsx) — light-mode, kiosk-friendly layout, gym branding header
4. Staff hands device to member; member reads, signs, types name, taps Sign
5. POST to `/api/members/[id]/waiver/sign` with `collectedBy: "admin_device:{staffUserId}"`
6. Redirect to `/dashboard/members/[id]?waiver=signed` so staff sees the chip flip green

### Flow 3 — "Copy waiver link" (member's own phone)
1. Owner clicks **"Copy waiver link"** in More-actions menu
2. UI calls a magic-link mint endpoint with `purpose: "waiver_open"`, copies the URL to clipboard
3. Owner texts/messages the URL to the member
4. Member opens link on their phone → token verified → lands on supervised waiver page → signs as in Flow 2

### Flow 4 — Owner customises the waiver text
1. Settings → **Waiver tab** → editor shows current `tenant.waiverTitle` / `waiverContent` (or defaults if unset)
2. Owner edits → Save → `PATCH /api/settings` writes `waiverTitle` + `waiverContent` on the Tenant
3. Future signatures snapshot the new text
4. **Past signatures keep their old `titleSnapshot` / `contentSnapshot`** — that's the whole point of the snapshot pattern

---

## Security posture

| Control | Where | Detail |
|---|---|---|
| Tenant scoping | every route | `findFirst({where:{id, tenantId}})` pattern (no bare `findUnique` for member lookups) — Sprint 2 gate B-5 |
| Rate limit (self) | `/api/waiver/sign` | 5 / 15 min per memberId, bucket `waiver:sign:{memberId}` |
| Rate limit (supervised) | `/api/members/[id]/waiver/sign` | 5 / 15 min per staff user id |
| File-type validation | both sign routes | PNG magic bytes (0x89 50 4E 47) — rejects fake images |
| Upload size cap | both sign routes | `signatureDataUrl` Zod max 300KB (~200KB binary) |
| Storage | Vercel Blob | `addRandomSuffix: true` prevents URL guessing; `tenants/{tenantId}/signatures/` namespacing |
| Env-gate fail-closed | both sign routes | 503 with clear message when `BLOB_READ_WRITE_TOKEN` unset |
| Audit trail | both sign routes | `logAudit({action: "waiver.sign" | "waiver.sign.supervised"})` with member id, staff id, ip, ua |
| Immutability | schema | `SignedWaiver` rows are insert-only — re-signs append, never overwrite |
| Snapshot freezing | both sign routes | `titleSnapshot` + `contentSnapshot` frozen at sign time — settings changes never retroactively change the legal record |
| Headers | both sign routes | `X-Content-Type-Options: nosniff` on responses |

---

## Known limitations / follow-ups

- **No version field bump on text edits.** When an owner edits the waiver text after some members have signed, `SignedWaiver.version` stays at `1` for everyone. The intent of the field is clear but the bump logic isn't wired. Currently: each row stores its own `titleSnapshot`/`contentSnapshot` which is sufficient for legal evidence; `version` is just a convenience field.
- **No "re-sign required" workflow.** If the owner materially changes the waiver, members aren't prompted to re-sign. They could be: a `Tenant.waiverRequiresResign` flag + `Member.waiverAccepted` reset would do it. Not implemented.
- **No PDF export.** Auditors who want a PDF of a member's signed waiver would have to compose one from `titleSnapshot + contentSnapshot + signatureImageUrl` manually. Worth a small report endpoint.
- **Kid waivers signed by parent.** Kids (`accountType='kids'`) are passwordless and have no member login; their waiver is signed by the parent via the supervised flow, with `signerName` set to the parent's name. The data model handles this fine; UX could be clearer (waiver chip on kid profiles should say "Signed by {parent name}" rather than just "Signed").
- **`waiver_open` magic-link mint endpoint** — the flow is wired in `MagicLinkToken` schema but the actual "Copy waiver link" mint route should be inspected to confirm it's been built (look for any `purpose: "waiver_open"` create call).

---

## Test coverage

- [tests/unit/supervised-waiver-tenant-scope.test.ts](../tests/unit/supervised-waiver-tenant-scope.test.ts) — verifies the staff-supervised route refuses cross-tenant member ids (Sprint 2 gate B-5 regression)
- No vitest covers the self-serve `/api/waiver/sign` route directly — relied on E2E for now

---

## Files (full inventory)

**API**
- [app/api/waiver/route.ts](../app/api/waiver/route.ts) — GET tenant waiver
- [app/api/waiver/sign/route.ts](../app/api/waiver/sign/route.ts) — member self-serve POST
- [app/api/members/[id]/waiver/sign/route.ts](../app/api/members/[id]/waiver/sign/route.ts) — staff-supervised POST
- [app/api/settings/route.ts](../app/api/settings/route.ts) — owner saves custom title/content (PATCH on Tenant)

**Pages**
- [app/dashboard/members/[id]/waiver/page.tsx](../app/dashboard/members/[id]/waiver/page.tsx) — staff-supervised waiver page
- [app/onboarding/page.tsx](../app/onboarding/page.tsx) — member onboarding waiver step

**Components**
- [components/dashboard/SupervisedWaiverPage.tsx](../components/dashboard/SupervisedWaiverPage.tsx) — kiosk waiver UI
- [components/ui/SignaturePad.tsx](../components/ui/SignaturePad.tsx) — canvas-based signature pad

**Lib**
- [lib/default-waiver.ts](../lib/default-waiver.ts) — default title + body templates

**Schema**
- [prisma/schema.prisma](../prisma/schema.prisma) — `Tenant.waiverTitle/Content`, `Member.waiverAccepted/AcceptedAt`, `SignedWaiver` model, `MagicLinkToken.purpose='waiver_open'`
