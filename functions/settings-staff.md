# Settings - Staff Tab

Status: Working. Staff invite/manage with role chips, temporary password generation.

## Purpose

Manage gym staff: invite with auto-generated passwords, edit role/name, delete staff.

## Data model

User schema: role CHECK constraint (owner|manager|coach|admin)

StaffMember type:
- id: string
- name: string
- email: string
- role: string
- createdAt: string

## Role metadata

owner (gold Crown) | manager (purple Shield) | coach (blue User) | admin (green Settings)

## Client state

staff array | staffDrawer open | editStaff (if editing) | sfName, sfEmail, sfRole, sfPassword | tempPassword (shown after add)

## API routes

POST /api/staff
- Auth: owner only
- Creates new user with email, name, role
- Auto-generates password if not provided (randomBytes + "Aa1!")
- Returns 201 with { id, name, email, role, createdAt, temporaryPassword? }
- 409 if email exists

PATCH /api/staff/[id]
- Auth: owner only
- Updates name, role, password (newPassword field)
- Optimistic concurrency (US-508, no version check)
- Returns 200 with updated user

DELETE /api/staff/[id]
- Auth: owner only
- Soft or hard delete
- Returns 200

## Client flows

### Add staff
1. Click "Add Staff" → openAddStaff() clears form, opens drawer
2. Fill: Full Name, Email, Role, Password (optional)
3. Click "Add Staff" → handleStaffSave() POST /api/staff
4. If temporaryPassword: show code block, user clicks "Done"
5. Else: close drawer + toast

### Edit staff
1. Click edit icon → openEditStaff(member) populates form, opens drawer
2. Modify: Name, Role, New Password (optional, email read-only)
3. Click "Save Changes" → handleStaffSave() PATCH /api/staff/[id]
4. Close drawer + toast

### Delete staff
1. Click delete icon → confirm dialog
2. DELETE /api/staff/[id]
3. Optimistic remove + toast

### View
- List all members with role chips
- Owner shows "(you)" label
- Owner cannot edit/delete own record
- Non-owner cannot add/edit/delete

## Permission model

Owner: full access
Manager: read-only
Coach/Admin: no access to Staff tab

## Related docs

app/api/staff/route.ts
app/api/staff/[id]/route.ts
