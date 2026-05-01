# Settings - Integrations Tab

Status: Working. Google Drive OAuth connect + folder picker. Member CSV import (Generic/MindBody/Glofox/Wodify).

## Purpose

Connect external integrations: Google Drive (read-only, one folder) for AI report context, and member CSV import from various gym management systems.

---

## User-facing surfaces

### Google Drive section

Google Drive card with:
- Cloud icon + description
- Status badge: green "Connected" (if connected + folder selected)
- Buttons:
  - Connect Google Drive (if not connected)
  - Choose folder (if connected but no folder selected)
  - Disconnect (if connected)
  - Re-index button (if folder selected)
- Folder name display (if selected)
- File count + last indexed timestamp (if indexed)
- Error messages if any

### Member CSV import section (ImportPanel component)

Import format selector:
- Generic CSV (default columns)
- MindBody (MindBody export format)
- Glofox (Glofox export format)
- Wodify (Wodify export format)

File upload:
- Drag-drop zone or click to browse
- Accepts .csv files

Preview + mapping (before import):
- Shows first N rows
- Column mapping UI (select which CSV column → member field)
- Required fields: name, email

Import button:
- Validates mapped fields
- POST to /api/admin/import/{format}
- Shows progress spinner
- Error/success messages

---

## Client state

status: { connected: boolean, folderId?: string, folderName?: string, connectedAt?: string, lastIndexedAt?: string, fileCount?: number }
loading: boolean (initial status fetch)
pickerOpen: boolean (folder picker modal)
folders: DriveFolder[] (list of user's Drive folders)
foldersLoading: boolean (loading folder list)
busy: boolean (operation in progress)
error: string | null (error message)

---

## Google Drive flows

### Initial status check

1. useEffect on mount → refreshStatus()
2. Fetch GET /api/drive/status
3. Returns status object
4. setStatus(data)

### Connect

1. Click "Connect Google Drive" → connect()
2. Fetch GET /api/drive/connect → returns { url: string }
3. window.location.href = url (OAuth redirect to Google)
4. User grants permission, redirected back to app
5. refreshStatus() updates connected flag

### Disconnect

1. Click "Disconnect" button → confirm dialog
2. POST /api/drive/disconnect
3. refreshStatus() clears folder, resets state
4. toast confirmation

### Select folder

1. Click "Choose folder" → openPicker()
2. Fetch GET /api/drive/folders → list of Drive folders
3. setFolders(data)
4. User clicks folder in picker → pickFolder(folder)
5. POST /api/drive/select-folder with { folderId, folderName }
6. refreshStatus() shows selected folder
7. Picker closes

### Re-index

1. Click "Re-index" button (if folder selected) → reindex()
2. POST /api/drive/index
3. Indexes all files in selected folder
4. refreshStatus() updates lastIndexedAt, fileCount
5. toast "Re-index started" or error

---

## API routes (Google Drive)

GET /api/drive/status
- Auth: owner only
- Returns { connected, folderId?, folderName?, connectedAt?, lastIndexedAt?, fileCount? }

GET /api/drive/connect
- Auth: owner only
- Returns { url: string } (Google OAuth URL)

POST /api/drive/disconnect
- Auth: owner only
- Clears stored OAuth token, folder selection
- Returns 200

GET /api/drive/folders
- Auth: owner only (requires connected = true)
- Returns array of { id?, name? } from user's Drive

POST /api/drive/select-folder
- Auth: owner only
- Body: { folderId: string, folderName: string }
- Stores folder ID in Tenant
- Returns 200

POST /api/drive/index
- Auth: owner only
- Starts async indexing of selected folder
- Returns 200 (async, not awaited)

---

## CSV import flows (ImportPanel)

### Select format

1. Click format button (Generic/MindBody/Glofox/Wodify)
2. Sets import format
3. Form adjusts expected columns

### Upload file

1. Drag-drop or click to browse
2. Select .csv file
3. File read in browser

### Map columns

1. Shows first N rows of CSV
2. Dropdown per required field (name, email, phone, etc)
3. User selects which CSV column → member field

### Preview

1. Shows mapped rows
2. Validates required fields populated
3. Shows any warnings (duplicate emails, etc)

### Import

1. Click "Import members" button
2. POST /api/admin/import/{format} with:
   ```
   {
     csvContent: string (file contents),
     columnMapping: { name: "Name", email: "Email", ... },
     format: "generic" | "mindbody" | "glofox" | "wodify",
   }
   ```
3. Server parses CSV, creates Member rows
4. Returns { imported: number, skipped: number, errors: string[] }
5. Show results toast

---

## API routes (CSV import)

POST /api/admin/import/{format}
- Auth: owner only
- Body: { csvContent, columnMapping, format }
- Parses CSV per format
- Creates Member rows (skips duplicates)
- Returns 200 with { imported, skipped, errors }

---

## Components

IntegrationsTab (components/dashboard/IntegrationsTab.tsx)
- Handles Google Drive integration UI
- Imports ImportPanel for CSV upload

ImportPanel (components/dashboard/ImportPanel.tsx)
- Format selector (4 buttons)
- File uploader
- Column mapper
- Preview + import button
- Results display

---

## Permission model

Owner: full access (connect/disconnect Drive, select folder, import members)
Non-owner: no access to Integrations tab

---

## Known limitations

Google Drive:
- Read-only access (no write)
- Single folder only (cannot select multiple)
- Indexing is async (no real-time updates)
- No file filtering UI (all files in folder indexed)

CSV import:
- No dry-run (imports on submit, shows results after)
- No undo (imported rows stay, errors logged)
- No scheduling (manual import only)
- Generic format must match expected columns exactly

---

## Related docs

app/api/drive/status/route.ts
app/api/drive/connect/route.ts
app/api/drive/disconnect/route.ts
app/api/drive/folders/route.ts
app/api/drive/select-folder/route.ts
app/api/drive/index/route.ts
app/api/admin/import/[format]/route.ts
components/dashboard/ImportPanel.tsx
