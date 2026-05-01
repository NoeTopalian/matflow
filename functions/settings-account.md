# Settings - Account Tab

Status: Working. 2FA TOTP setup, check-in QR URL display, subscription tier info, danger zone.

## Purpose

Owner account settings: enable/disable two-factor authentication via authenticator app, display check-in QR URL for members, show subscription tier, access danger zone (support contact).

## User-facing surfaces

Two-Factor Authentication card (owner only)
- Authenticator App toggle + status badge
- "Set up" button (if disabled) or "Disable" button (if enabled)
- Explains TOTP requirement on owner login

Check-In QR Code card (all users)
- Displays URL: {origin}/checkin/{slug}
- Copy button (with "Copied!" feedback)
- Open in new tab button
- Explanation: "Share this URL with members or display as QR code at gym entrance"

Subscription card (all users)
- Shows plan tier (Starter/Pro/Elite/Enterprise)
- Subscription status (active/cancelled/etc)
- Colour-coded badge

Danger Zone card (owner only)
- Red styling
- "Contact support to cancel your subscription or export all data"
- mailto link to hello@matflow.io

## TOTP flow

### Setup (openTotpSetup)

1. Click "Set up" button → openTotpSetup()
2. Fetch GET /api/auth/totp/setup
3. Returns { secret, qrDataUrl }
4. Display in drawer:
   - Step 1: Show QR code + manual key (copy-able)
   - Instruction: "Scan this QR code with Google Authenticator, Microsoft Authenticator, or any TOTP app"
   - Button: "I've scanned it →"
5. Step 2: Input 6-digit code from authenticator app
6. Click "Verify & Enable" → POST /api/auth/totp/setup with { code: "123456" }
7. On success: setMfaEnabled(true), close drawer, toast "Two-factor authentication enabled"
8. On error: show error message, allow retry

### Disable (confirmTotpDisable)

1. Click "Disable" button → opens disable drawer
2. Input current authenticator code (6 digits) for confirmation
3. Click "Disable 2FA" → POST /api/auth/totp/disable with { code }
4. On success: setMfaEnabled(false), close drawer, toast disabled
5. On error: show error, allow retry

## Check-In QR URL

- Read-only URL display
- Copy button: copies `{origin}/checkin/{slug}` to clipboard
  - Shows "Copied!" checkmark for 2 seconds
  - Returns to Copy icon after
- Open button: target="_blank" to /checkin/{slug}
- Purpose: members can scan to sign in at gym entrance

## API routes

GET /api/auth/totp/setup
- Auth: owner only
- Returns { secret: string, qrDataUrl: string }
- Generates TOTP secret, renders QR code as data URL

POST /api/auth/totp/setup
- Auth: owner only
- Body: { code: string (6 digits) }
- Validates code against secret (time-based)
- Sets user.totpEnabled = true
- Returns 200 on success
- Returns 400 if invalid code

POST /api/auth/totp/disable
- Auth: owner only
- Body: { code: string (6 digits) }
- Validates current TOTP code
- Sets user.totpEnabled = false
- Returns 200 on success
- Returns 400 if invalid code

## Client state

mfaEnabled: boolean (init from server)
totpSetupDrawer, totpDisableDrawer: boolean (drawer open/closed)
totpStep: 1 | 2 (setup step)
totpQrUrl, totpSecret, totpCode: string
totpSaving, totpError: state flags
disableCode, disableSaving, disableError: state for disable flow

## Drawer components

### TOTP Setup Drawer

Step 1:
- Loading spinner while fetching QR
- QR code image (180x180)
- Manual key (monospace, copy-able)
- "I've scanned it →" button

Step 2:
- "Enter the 6-digit code from your authenticator app to confirm setup"
- Numeric input (max 6 digits, centered, monospaced)
- Back button (return to Step 1)
- "Verify & Enable" button (disabled if code.length !== 6)
- Error message display

### TOTP Disable Drawer

- "Enter your current authenticator code to confirm you want to disable 2FA"
- Numeric input (max 6 digits)
- Cancel button
- "Disable 2FA" button (red, disabled if code.length !== 6)
- Error message display

## Permission model

Owner: full access (TOTP setup/disable, view all)
Non-owner: read-only (view subscription, check-in URL only)

## Related docs

app/api/auth/totp/setup/route.ts
app/api/auth/totp/disable/route.ts
