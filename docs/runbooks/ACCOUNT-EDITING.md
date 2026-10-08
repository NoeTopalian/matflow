# Account editing: who may change which field of a staff account

Added 8 Oct 2026 (account-editing lane R). Covers staff accounts (owner, manager, coach, admin). Member accounts
have their own profile routes and are out of scope. The login-email detail lives in
[OWNER-LOGIN-EMAIL-CHANGE.md](OWNER-LOGIN-EMAIL-CHANGE.md); identity checks before any operator action live in
[SUPPORT-IDENTITY-VERIFICATION.md](SUPPORT-IDENTITY-VERIFICATION.md).

## Principles

- **Self-service acts on the signed-in user only.** No self-service route accepts a user id: the row is the session's
  user in the session's club (`where: { id, tenantId }`), so no other account in this or another club can be targeted.
- **No mass assignment.** Every body schema is `.strict()`: any key the route does not own (role, tenantId, email,
  verification flags, `totp*`, `mustChangePassword`, `sessionVersion`, `passwordHash` …) is a 400 and nothing is written.
- **Operator identity stays separate.** Operator actions are audited with `actAsUserId` = the named operator, so the
  row reads "MatFlow did this to the owner", never "the owner did this". Support (impersonation) sessions are
  read-only and are refused by every route below (proxy.ts and an in-route guard).
- **Audit rows never hold secrets.** No password, hash, authenticator secret, recovery code, grant or token. Login
  addresses appear only as SHA-256 digests. A display name change records the name before and after.
- **Credential changes sign out everywhere.** Password and login-email changes bump `sessionVersion`: every device,
  the one making the change included, signs in again. A display name is not a credential and signs nobody out.
- **The owner can take over a staff account — by design.** An owner can set a staff member's temporary password and
  reset their authenticator, then sign in as them. This is accepted because the owner already holds every permission a
  staff member has. What protects the staff member: every change signs them out everywhere; a temporary password
  expires after 72 h and must be changed at the next sign-in; each change is audited (staff cannot read the Activity
  log). The residual risk: actions taken that way are attributed to the staff member's name.
- **A staff login address the owner corrected stays provisional.** Only an operator can clear a provisional mark, and
  the operator path covers owners only, so that staff member has no forgot-password or Google sign-in until email
  verification exists. Recovery for them is an owner-set temporary password.
- **Login-address changes are not undoable from the Activity log.** The address is stored only as a digest, and an
  undo would bypass the collision check, provisional mark and token retirement; edit it back instead.

## Field-permission matrix

| Field | Owner (self) | Manager / admin / coach (self) | Owner, for a staff member | MatFlow operator, for the owner |
|---|---|---|---|---|
| Display name | Settings → Account → Profile, or My account. `PATCH /api/account/profile`. Audit `user.profile.updated` | My account. Same route and audit | Settings → Staff → edit (`PATCH /api/staff/[id]`) | Operator page → **Owner profile → Correct name**. Step-up `owner.profile` + reason. Audit `admin.owner.profile.updated` |
| Login email | **Current password + fresh authenticator code**. `POST /api/account/login-email`. Saved provisional. Audit `user.login_email.changed` | Same (needs an authenticator) | Settings → Staff → edit (`PATCH /api/staff/[id]`). No step-up (the owner acts on someone else's account). Collision with any staff user or member of the club → 409 that does not say whose; saved **provisional**; reset codes and sign-in links for the old and new address retired; staff member signed out. Audit `staff.update` with address digests only (so not undoable from Activity — edit it back here) | **Login email** card: change / mark provisional / confirm. Step-up `owner.login_email` per sub-action + reason |
| Password | **Current password + fresh authenticator code** (password alone only for an account without one, e.g. a coach). `POST /api/account/password`. Audit `user.password.changed` | Same | Sets a **temporary** password: same strength rule as every other door (10+ characters, upper-case, lower-case, number; weak → 400 naming the rule), 72 h, must change at next sign-in, staff member signed out. No reuse check (it is replaced at `/set-password`). Never in the audit | **Reset only**: Danger Zone → Reset password issues a temporary one (72 h, forced change). Never chooses the final password |
| Temporary → own password | `/set-password` (forced, the only way out of a temporary password) | Same | — | — |
| Authenticator | Enrol at `/login/totp/setup`; regenerate recovery codes (fresh code) in Settings → Account. Cannot turn it off | Enrol at `/login/totp/setup` | Reset a staff member's (Settings → Staff); never the owner's | **Reset only** (Reset 2FA, step-up). Never enrols or reads it |
| Role | Never by self. Ownership moves only by transfer (password re-entered) | Never by self | Settings → Staff (manager/coach/admin only; never makes an owner) | Transfer ownership (step-up) |
| Club (tenant) | Never | Never | Never | Never |
| Provisional / verified mark | Never | Never | Set automatically when they change the address; never cleared | Mark or confirm (attestation) on the Login email card |

Refused on every self-service CHANGE (PATCH/POST): signed out (401), a member (403), a sign-in still owing its code
(403), a temporary-password session (403 — use `/set-password`), an elevated role not yet enrolled (403), a support
session (403). Reads (GET profile, GET login email) follow the same rules except that a support session may read. Rate limits: profile 20 / 15 min, password and login email 5 / 15 min, per user.

### Checks per self-service action

- **Name** — trimmed, 1–100 characters, no control characters (C0, C1), line or paragraph separators, or
  bidirectional embedding/override/isolate marks. This device's session is re-issued with
  the new name so the top bar is right at once; every other device picks it up on its next request (the per-request
  session check reads the row's current name — lib/session-revocation.ts).
- **Password** — an unenrolled owner, manager or admin row is refused (403; the password-only path is for roles that do
  not require an authenticator, e.g. a coach). Then, in order: current password (a wrong one does NOT spend the code);
  the authenticator code CHECKED without spending it, so a caller without the authenticator gets the same generic
  refusal and learns nothing about the new password; then the rule (10+ characters, upper-case, lower-case, number)
  and no reuse of the current or last 8 passwords; then the code is SPENT inside the transaction (single use across
  sign-in, recovery-code regeneration and both change flows: wait for the next code if one was just used).
  One transaction: new hash (only if the hash is still the one checked; 409 otherwise), history row, lockout cleared,
  `sessionVersion` + 1, outstanding reset codes and sign-in links for the login email retired, audit row.
- **Login email** — as [OWNER-LOGIN-EMAIL-CHANGE.md](OWNER-LOGIN-EMAIL-CHANGE.md): password + code, collision with any
  staff user or member of the club refused without saying whose, saved provisional, tokens retired, signed out.

## Owner handover while email is off

### Before activation (owner has never signed in, or is still on a temporary password)

1. Operator: **Login email → Change login email** to the owner's real address (step-up, reason). It is saved
   **provisional**: no reset code, sign-in link or Google sign-in reaches it while email is unverified.
2. Operator: if the address on file was already the right one, **Mark provisional** instead.
3. Operator: **Danger Zone → Reset password** to issue a temporary password (72 h). Hand it over privately on a channel
   verified per SUPPORT-IDENTITY-VERIFICATION.md. Never by email to a provisional address.
4. Owner: signs in with the address and temporary password → `/set-password` (own password) → enrols the authenticator
   → saves recovery codes → reaches the dashboard. The operator never chooses the final password and never sees the
   authenticator.

### After activation (owner has their own password and authenticator)

Either path keeps the account id, club, role, history, password, authenticator and recovery codes:

- **Owner self-service** (preferred): Settings → Account → Login email, with password + a fresh code.
- **Operator** (owner cannot reach the dashboard, identity verified first): Login email → Change. Do **not** reset the
  password or the authenticator: the owner signs in with the new address, the same password and the same authenticator.

Both sign the owner out everywhere and leave the new address provisional until an operator attests otherwise.

## Recovery

| Lost | Who | How |
|---|---|---|
| Password, email on and address not provisional | Owner / staff | Forgot password on the sign-in page |
| Password, email off or address provisional | Owner: MatFlow operator. Staff: the club owner | Operator Reset password (temporary, 72 h). Owner sets a staff member's temporary password in Settings → Staff |
| Authenticator | Owner: recovery code, else operator Reset 2FA. Staff: recovery code, else owner resets it | Re-enrol at next sign-in |
| Wrong login email typed by an operator | Operator | Change it back (same checks); see the login-email runbook's Rollback |
| Wrong display name | Owner self-service, or operator Owner profile | Same route again; every change is audited with before/after |

## Known gaps (not built here)

- Closed 8 Oct 2026 (lane S-staff): the owner's staff edit (`PATCH /api/staff/[id]`) now applies the club-wide
  collision check, the provisional mark, token retirement and digest-only audit, and the shared password strength rule.
  `/set-password` and `/reset-password` use `lib/password-policy.ts` too: one rule and one history length, **8**, on every
  door (set-password kept 5 before; reset-password now also refuses the current password).
  Also closed: creating a staff member (`POST /api/staff`) uses the same strength rule (the form says so); a role or
  address equal to the stored one is not a change, so a name-only save signs nobody out; the staff edit route is gated
  by `requireApiOwner`, so an owner session still owing its code, on a temporary password or not yet enrolled is
  refused inside the route as well as by `proxy.ts`.
- **No database constraint backs the staff/member address check.** `@@unique([tenantId, email])` covers User rows
  only; the "not a member of this club" half is an application check inside the transaction. Two requests at the same
  instant (an owner edit and a member being added with the same address) could both pass. Same limit on the
  self-service and operator login-email changes. Not fixed: needs a cross-table constraint or serialisable isolation.
- Recovery-code regeneration is in Settings → Account (owner) only; managers, coaches and admins see their
  authenticator status on My account but cannot regenerate codes from the UI.
- Regenerating recovery codes still asks for the code through a browser prompt, not the Dialog primitive.

## Code

- Self-service: `app/api/account/profile/route.ts`, `app/api/account/password/route.ts`,
  `app/api/account/login-email/route.ts`; rules in `lib/account-profile.ts`, `lib/password-policy.ts`,
  `lib/login-email.ts`.
- UI: `components/dashboard/ProfileCard.tsx`, `PasswordCard.tsx`, `LoginEmailCard.tsx` (Settings → Account for the
  owner; `/dashboard/account` "My account" for every staff role).
- Operator: `app/api/admin/customers/[id]/owner-profile/route.ts` + `app/admin/tenants/[id]/OwnerProfileCard.tsx`;
  step-up action `owner.profile` in `lib/operator-step-up.ts`.
- Tests: `tests/unit/account-profile.test.ts`, `tests/unit/account-password.test.ts`,
  `tests/unit/operator-owner-profile.test.ts`, `tests/unit/staff-edit-account-rules.test.ts`,
  `tests/unit/password-policy-doors.test.ts`, `tests/integration/account-editing-db.test.ts`.
