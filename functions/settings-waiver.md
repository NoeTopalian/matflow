# Settings - Waiver Tab

Status: Working. Inline editor for tenant waiver title + content. Saves via PATCH /api/settings.

## Purpose

Owner-side editor for custom waiver text. Cross-reference functions/waiver-system.md for member sign flows; this doc covers only the Settings UI for editing waiver text.

---

## User-facing surfaces

Liability Waiver card (owner only)
- Status badge: "Custom waiver" (if edited) or "Using default" (if null)
- Display mode: preview of current waiver (title + content paragraphs)
- Edit button: toggles to edit mode

Edit mode (when waiverEditing = true)
- Waiver title input (200 char max, required)
- Waiver content textarea (20,000 char max, shows char count)
- Save button (disabled while saving)
- Cancel button (reverts to last saved)
- Reset to Default button (if custom text exists)

Display mode (when waiverEditing = false)
- Shows title as heading
- Shows content paragraphs (splits on "\n\n")
- Uses default if both title + content are null/empty
- Edit Waiver button

---

## Default waiver text

From lib/default-waiver.ts:

Title: "Liability Waiver & Assumption of Risk"

Content (4 paragraphs):
- "I acknowledge that martial arts and combat sports involve physical contact, which carries an inherent risk of injury. By signing this waiver, I voluntarily accept all risks associated with training and participation at this facility."
- "I agree to follow all gym rules, coach instructions, and safety guidelines at all times. I confirm that I am physically fit to participate and have disclosed any known medical conditions or injuries that may affect my training."
- "I release the gym, its owners, coaches, staff, and affiliates from any liability for injury, loss, or damage arising from my participation, except in cases of gross negligence or wilful misconduct."
- "This waiver applies to all activities on the premises including classes, open mat sessions, and any gym-organised events."
- (Additional closing paragraph)

---

## Client state

waiverTitle: string (from settings.waiverTitle or "")
waiverContent: string (from settings.waiverContent or "")
waiverEditing: boolean (false = display mode, true = edit mode)
waiverSaving: boolean (true while fetching)

---

## Client flows

### View default waiver

1. Tab opens, waiverEditing = false
2. If waiverTitle and waiverContent are both null:
   - Show default title + content
   - Badge shows "Using default"
3. Else:
   - Show custom title + content
   - Badge shows "Custom waiver"

### Edit custom waiver

1. Click "Edit Waiver" button → setWaiverEditing(true)
2. Form appears with current title + content
3. Modify text in inputs (title max 200, content max 20,000)
4. Click "Save" button → handleSave():
   - setWaiverSaving(true)
   - PATCH /api/settings with { waiverTitle, waiverContent }
   - On success: setWaiverEditing(false), toast "Waiver saved"
   - On error: toast "Failed to save waiver"
5. Click "Cancel" button → setWaiverEditing(false), revert to last saved

### Reset to default

1. In edit mode, if custom text exists, "Reset to Default" button shows
2. Click → confirm dialog "Reset to default waiver text?"
3. If confirmed:
   - PATCH /api/settings with { waiverTitle: null, waiverContent: null }
   - setWaiverTitle(""), setWaiverContent("")
   - setWaiverEditing(false)
   - toast "Reset to default waiver"

---

## API integration

PATCH /api/settings
- Auth: owner only
- Body fields:
  ```
  {
    waiverTitle: string | null,
    waiverContent: string | null,
  }
  ```
- Saves to Tenant row
- No return value needed (200 OK)

---

## Persistence

### Future members
- When a member signs waiver (POST /api/waiver/sign), the current Tenant.waiverTitle + waiverContent are **snapshots frozen** into the SignedWaiver row
- If owner changes waiver text later, new signatures use new text
- Old signatures keep old frozen text (immutable record)

### History
- No version field on Tenant.waiverTitle/Content
- Changes overwrite previous text
- No audit trail of edits (consider adding if needed)

---

## Permission model

Owner: can edit title + content
Non-owner: read-only (view current waiver only, no edit access)

---

## Related docs

functions/waiver-system.md — member sign flows, API routes, data model, legal record storage
app/api/settings/route.ts — PATCH endpoint
