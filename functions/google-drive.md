# Google Drive Integration

> **Status:** ✅ Working · OAuth + drive.readonly scope · folder-scoped indexing · encrypted tokens at rest · single-flight refresh lock per tenant.

## Purpose

The owner can connect their Google Drive once, pick a single folder, and MatFlow indexes its contents (documents, spreadsheets, text files) for the [AI Monthly Report](ai-monthly-report.md). The report can then cite "your operations notes from March mention X" alongside the database-derived metrics.

We deliberately limit scope to a single folder — the owner doesn't have to grant blanket access to their whole Drive.

## Data model

```prisma
model GoogleDriveConnection {
  tenantId       String   @id
  accessToken    String                      // encrypted via lib/encryption.ts
  refreshToken   String                      // encrypted
  expiresAt      DateTime
  scope          String                      // "https://www.googleapis.com/auth/drive.readonly"
  folderId       String                      // selected folder root (empty until step 2)
  folderName     String                      // display name for UI
  connectedAt    DateTime @default(now())
  connectedById  String                      // User who clicked Connect
  lastIndexedAt  DateTime?                   // null until first index
}

model IndexedDriveFile {
  id            String   @id @default(cuid())
  tenantId      String
  driveFileId   String                       // Google's id
  filename      String
  mimeType      String
  modifiedAt    DateTime                     // file's modifiedTime, not indexed time
  contentHash   String                       // sha256 of (name|modifiedTime|first1KB)
  contentText   String?                      // null if binary; capped at 50KB
  indexedAt     DateTime @default(now())

  @@unique([tenantId, driveFileId])
  @@index([tenantId, modifiedAt])
}
```

Tokens are encrypted via [`lib/encryption.ts`](../lib/encryption.ts) (AES-256-GCM with `AUTH_SECRET_VALUE` as KEK). At-rest leak of the DB without the secret yields nothing usable.

## Surfaces

- Settings → Integrations → "Google Drive" card with Connect / Disconnect / Reindex buttons
- Folder picker: list folders at the Drive root, click to drill in, confirm
- Status display: "Indexed 47 files · last synced 2 hours ago"
- Disconnect → revokes Google's token + wipes local rows

## OAuth flow

### Step 1 — Initiate

```ts
// lib/google-drive.ts
export function buildAuthUrl(tenantId: string): string {
  const ts = Date.now().toString();
  const payload = `${tenantId}:${ts}`;
  const sig = createHmac("sha256", AUTH_SECRET_VALUE).update(payload).digest("hex");
  const state = `${sig}:${payload}`;
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive.readonly"],
    state,
  });
}
```

`state` is HMAC-signed `tenantId:timestamp` with a 10-minute TTL — the callback verifies signature + freshness. Prevents CSRF + replay.

### Step 2 — Callback

```ts
// app/api/drive/callback/route.ts
const verified = verifyState(state);
if (!verified) return 400;
await exchangeCodeAndStore({ code, tenantId: verified.tenantId, userId });
// → encrypts and stores access + refresh tokens
```

`prompt: "consent"` ensures we always get a refresh_token (Google omits it on subsequent grants without `consent`).

### Step 3 — Folder pick

After OAuth, the user lands back at `/dashboard/settings?tab=integrations&drive=connected`. The Drive card now shows a folder picker. They drill in, click a folder, and we set `GoogleDriveConnection.folderId + folderName`.

### Step 4 — Index

`POST /api/drive/reindex` runs `indexFolder(tenantId, folderId)`:

```ts
const files = await listFilesInFolder(tenantId, folderId);
for (const file of files) {
  const text = await extractFileText(tenantId, file.id, file.mimeType);
  await prisma.indexedDriveFile.upsert({
    where: { tenantId_driveFileId: { tenantId, driveFileId: file.id } },
    create: { ..., contentText: text?.slice(0, 50_000) ?? null },
    update: { ..., indexedAt: new Date() },
  });
}
```

Text extraction:
- `application/vnd.google-apps.document` → exported as plain text
- `application/vnd.google-apps.spreadsheet` → exported as CSV
- `text/*` → fetched as media
- PDFs / images / binaries → filename only (no OCR yet)

Contents capped at 50KB per file — Drive can host massive files but we only feed a bounded slice into the AI report context.

## Token refresh

Google access tokens expire in 1 hour. The OAuth client emits a `tokens` event when it auto-refreshes — we persist the new tokens via a per-tenant lock to prevent two concurrent refreshes from stomping each other:

```ts
const refreshLocks = new Map<string, Promise<void>>();

client.on("tokens", (tokens) => {
  if (tokens.access_token) {
    void refreshTokensForTenant(tenantId, async () => {
      await prisma.googleDriveConnection.update({
        where: { tenantId },
        data: {
          accessToken: encrypt(tokens.access_token!),
          ...(tokens.refresh_token ? { refreshToken: encrypt(tokens.refresh_token) } : {}),
          ...(tokens.expiry_date ? { expiresAt: new Date(tokens.expiry_date) } : {}),
        },
      });
    });
  }
});
```

`refreshLocks.get(tenantId) || newLock` — first refresh wins, concurrent ones await the same promise. Per-tenant scope means cross-tenant ops don't block each other.

## Folder ID validation

```ts
function assertValidDriveFolderId(folderId: string): void {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(folderId)) {
    throw new Error("Invalid Drive folder ID");
  }
}
```

Belt-and-braces — the API doesn't trust folder IDs from the client (they're built into the Drive API query string `'{folderId}' in parents`, which would be a query injection vector if not sanitised).

## Disconnect

```ts
export async function revokeConnection(tenantId: string): Promise<void> {
  const conn = await prisma.googleDriveConnection.findUnique({ where: { tenantId } });
  if (!conn) return;
  try {
    const client = buildOAuthClient();
    client.setCredentials({ access_token: decrypt(conn.accessToken) });
    await client.revokeCredentials();   // tells Google to invalidate the grant
  } catch { /* best-effort */ }
  await prisma.indexedDriveFile.deleteMany({ where: { tenantId } });
  await prisma.googleDriveConnection.delete({ where: { tenantId } });
}
```

Revokes Google-side AND wipes our cache — disconnect leaves no trace of file contents in our DB.

## Security

| Control | Where |
|---|---|
| At-rest token encryption | `encrypt(accessToken)` / `encrypt(refreshToken)` via AES-256-GCM with KEK |
| OAuth state HMAC + TTL | `verifyState()` — rejects forged or stale callbacks (10 min window) |
| Folder ID regex | `/^[A-Za-z0-9_-]{20,}$/` — prevents query string injection |
| Read-only scope | `drive.readonly` — we can't modify the user's Drive |
| Single-folder index | We only see the folder the owner picked, not the whole Drive |
| Single-flight refresh | Per-tenant lock prevents concurrent refresh writes |
| Tenant scope | `where: {tenantId}` on all reads/writes; tenant scoped to session |
| Audit log | `drive.connect`, `drive.disconnect`, `drive.reindex` |
| Disconnect = full wipe | DB rows + Google grant both removed |

## Known limitations

- **No incremental sync** — every reindex re-fetches every file. Fine for ~50 files; slow for ~1000. Drive supports `changes.list` for incremental — not wired today.
- **No PDF / image extraction** — binary files indexed by name only. PDF text extraction (pdf-parse) and OCR for images would expand coverage.
- **50KB content cap** — long-form documents truncated. The AI report only sees the first 50KB.
- **No folder hierarchy crawl** — only the directly-selected folder; subfolders are listed but their contents aren't indexed unless the owner picks them too.
- **Single connection per tenant** — `tenantId` is the PK on `GoogleDriveConnection`. Can't connect two Drives (e.g. owner's personal + business).
- **Refresh on demand only** — no scheduled reindex. Owner has to click "Reindex" each month before generating the report.
- **No drive.file scope** (per-file picker) — we use `drive.readonly` for the whole folder. The narrower scope would require a Drive Picker integration.

## Test coverage

- Unit tests for `verifyState()` HMAC + TTL logic
- Integration test for OAuth callback path mocked; live Drive integration tested manually

## Files

- [lib/google-drive.ts](../lib/google-drive.ts) — OAuth client, token storage, indexer
- [lib/encryption.ts](../lib/encryption.ts) — at-rest token crypto
- `app/api/drive/connect/route.ts` — initiates OAuth
- `app/api/drive/callback/route.ts` — exchanges code, stores tokens
- `app/api/drive/folders/route.ts` — list folders for picker
- `app/api/drive/reindex/route.ts` — runs `indexFolder()`
- `app/api/drive/disconnect/route.ts` — revokes + wipes
- [prisma/schema.prisma](../prisma/schema.prisma) — `GoogleDriveConnection`, `IndexedDriveFile`
- See [ai-monthly-report.md](ai-monthly-report.md), [settings-integrations.md](settings-integrations.md), [encryption-secrets.md](encryption-secrets.md)
