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
  addresses appear only as digests — keyed (HMAC under the server secret) since 9 Oct 2026, because a plain SHA-256 of a
  predictable address can be reversed from a candidate list; older rows hold the plain form. A display name change
  records the name before and after.
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
| Who holds a login address (check) | — (club routes answer a collision with an opaque 409 that never says whose) | — | — | **Login email** card → **Check address**. `POST /api/admin/customers/[id]/login-email/check`, body `{ email }` (strict). Club and owner resolved on the server. Answers free, or the holder: kind (staff / member), id, name, status or role, `canSignIn` (password, or a live invite / sign-in / reset credential for that address in this club), an internal link, and for a member an opaque version; `many` for a legacy duplicate (count only). Durable audit `admin.login_email.checked` with the keyed digest only; `Cache-Control: private, no-store`; 60 / hour per operator; refused to support sessions and non-allow-listed operators |
| A member's contact email (to free an address for the owner) | — (members and owners use the member routes) | — | — (the owner's member edit has its own rules) | Conflict panel → **Change this member's contact address**. `POST /api/admin/customers/[id]/members/[memberId]/contact-email`, body `{ newEmail, reason (10–500), version }` (strict). Step-up `member.contact_email` bound to club / member / "change", the normalised new address and the member's version. Member must be in this club (404 otherwise). A record whose address MatFlow manages — a no-login child placeholder or a GDPR-erasure sentinel — is refused (409 `managed`), and such an address is refused as a target (400); decided at preflight and again inside the transaction. Preflight (same address 400, held 409 with the holder, stale version 409) spends nothing. One transaction: grant spent, version re-checked, claim lock, `email` only (conditional on the address read), sign-in tokens for old and new retired in this club (waiver kept), `sessionVersion` +1 and `unverified: true` only if the member has a password, audit `admin.member.contact_email.changed` with keyed digests. Replay of the same grant → `alreadyApplied`. Never: `externalRef`, status, password, authenticator, recovery codes, memberships, family links, attendance, ledger rows; no merge |

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

## What an email means

One column can carry different meanings depending on the record. Do not read every address as the same thing.

| Field | Meaning | Unique? |
| --- | --- | --- |
| `User.email` | Staff **login identity** (and normally the staff member's mailbox; while `loginEmailProvisionalSince` is set it is an identifier only — see `OWNER-LOGIN-EMAIL-CHANGE.md`) | One login per club across User **and** Member |
| `Member.email` | Member **login identity**. It is also the member's **contact** address: the same column serves both, a documented limitation (there is no separate contact field) | One login per club across User **and** Member |
| `Member.email` = `…@no-login.matflow.local` | **Synthesised** login for a child or a no-email adult. Random, nobody's mailbox, never sent to, never shared | Unique by construction |
| `Member.email` = `deleted-<id>@deleted.invalid` | Erased (Article 17) sentinel. Not a login | Unique by member id |
| `Member.unverifiedEmail` | The **shared family payer** address an import found (e.g. a guardian draft from an emergency contact). Contact only — **not** a login and not claimed; several family rows may share it | No |
| `Member.externalRef` | **Imported source identity** (`teamup:<email>\|<name>`), written once by the first import, never rewritten by an edit | Per import source |

**Canonical form.** Every stored login address is `trim` + lower-case (`lib/email-normalise.ts`). Plus tags and dots
are **not** stripped (`a.b+c@x` and `ab@x` are different mailboxes at many providers), and no address is ever
fabricated except the synthesised no-login form above.

**One login per club across both tables.** auth.ts resolves the club, then looks the address up in User and in Member,
and a User row wins — so a member on a staff address (or the reverse) is shadowed. The same address in **another club**
is a different login and is allowed. Two separate `@@unique([tenantId, email])` indexes do not make the pair unique, so
every writer of a login address calls `claimLoginIdentity` (one address) or `claimLoginIdentities` (an import slice) in
`lib/login-email.ts` **inside its own transaction, before its write**. The claim takes a transaction-scoped advisory
lock on (club, canonical address) — released at commit, safe behind the Neon pooler, available to the restricted
`matflow_app` role — then reports the holders: `none`, one `user`/`member` (id, name, role or status, whether the
address can sign in), or `many`. `many` is a legacy duplicate (two rows on one canonical address, written before the
lock or before the 13 Sep lower-case backfill): it is never resolved by picking one. Club routes answer every collision
with the same opaque 409; the operator owner-login route answers `many` with a 409 `legacy_duplicate` to review.

Writers that claim: member create, member edit, member self-service edit, guardian confirm that adopts the payer
address, staff create, staff edit, own login email, operator owner login email, members import (a row on a **staff**
address is refused and reported; a row on an existing member's address is "already in the club" as before).
Allow-listed with a reason (no claim needed): club creation (the club does not exist yet), application approval (same),
DSAR erase (renames to the per-member sentinel), tenant purge (deletes), and writes that never set `email`.

**Enforcement statement.** This is enforceable only while every writer participates. `tests/unit/login-identity-writers.test.ts`
scans `app/` and `lib/` and fails the build when a User/Member write that could set `email` appears in a file that
neither claims nor sits on its allow-list with a reason. A raw SQL write, a seed or a hand-run script is outside that
guard. Pinned under real concurrency (two connections, both DB roles) by
`tests/integration/login-identity-race-db.test.ts`, and per writer by `tests/integration/login-identity-claims-db.test.ts`.

**When a member's login address changes** (staff edit or self-service): reset codes and sign-in/activation links for the
old and new address in that club are retired (a waiver link is kept; another club is untouched). A staff edit OR a
self-service change by a member who has a password also signs that member out everywhere (`sessionVersion` +1; the
self-service response says `signInAgain` and clears that device's cookie). The audit row — written in the same
transaction as the change, so a failed audit write is a failed change — records `unverified: true` and whether
sessions were revoked, with the addresses as keyed digests only (`oldEmailSha256`/`newEmailSha256`), never in clear.
There is no member verification flow, so the new address is a login nobody has proved they read. The Activity page's
Undo never restores a login address (an email-only change is refused with its reason; other fields in the same edit
are still put back) — change it again through the member's profile instead.

**Legacy duplicates.** `node scripts/readiness/login-identity-duplicates.mjs --env <file> [--tenant <slug>]` is read-only
and prints, per club, cross-table / user-user / member-member duplicate groups with record ids and a per-run keyed
digest (no addresses). Exit 0 none, 3 found, 1 failed. Production needs `--production` and is the operator's call.
Resolution is a human decision per group (correct one address through the normal routes); nothing auto-merges.

## Imports after a contact change

Correcting a member's address does not change who they are to an import. Their source identity is
`Member.externalRef` (`teamup:<email>|<name>`, written once by the first members import); no edit route rewrites it,
so a later TeamUp status refresh or attendance import with the original rows still finds the same member, and a
refresh never writes anything to a member (since 25 Oct 2026 it lists differences for staff to resolve by hand). The attendance import has one fallback: a row whose
key matches no externalRef is matched on name **and** the member's **current** address, and only when exactly one
member carries both. So after a correction, rows with the old address and no stored key stay **pending** for the
owner to decide (never matched to whoever holds that address now), and rows already carrying the new address match.
A saved person decision always wins, including "keep pending". Ambiguous rows are never resolved automatically.
Reset codes and sign-in/activation links sent to the old (or new) address in that club are retired when the address
changes; a waiver link is kept, and the same address in another club is untouched. Pinned by
`tests/integration/contact-email-change-imports-db.test.ts`, `tests/integration/token-scoping-db.test.ts` and
`tests/unit/import-matching-after-contact-change.test.ts`.

## Audit history

The application never updates or deletes an `AuditLog` row: no route edits history, and
`tests/unit/audit-actor-columns-immutability.test.ts` fails the build if an `auditLog` update or delete appears anywhere
except the retention cron. Retention is by age only: 12 months for ordinary rows, 6 years for `admin.*`, DSAR and
support rows (`auditLogRetentionWhere`). Operator rows carry `operatorId` and `requestId` columns (the step-up grant's
request id for a step-up action; the platform request id or a UUID otherwise). The database reality is different: the
database owner role and anyone with Neon console access can edit or delete history, and deleting a User or Operator sets
its attribution columns to null (`ON DELETE SET NULL`) while `metadata.actingAs` keeps the id. The log is therefore
**not tamper-evident**; it is a record kept by the application, not a proof against the database's administrators.

## Known gaps (not built here)

- Closed 8 Oct 2026 (lane S-staff): the owner's staff edit (`PATCH /api/staff/[id]`) now applies the club-wide
  collision check, the provisional mark, token retirement and digest-only audit, and the shared password strength rule.
  `/set-password` and `/reset-password` use `lib/password-policy.ts` too: one rule and one history length, **8**, on every
  door (set-password kept 5 before; reset-password now also refuses the current password).
  Also closed: creating a staff member (`POST /api/staff`) uses the same strength rule (the form says so); a role or
  address equal to the stored one is not a change, so a name-only save signs nobody out; the staff edit route is gated
  by `requireApiOwner`, so an owner session still owing its code, on a temporary password or not yet enrolled is
  refused inside the route as well as by `proxy.ts`.
- Closed 9 Oct 2026 (admin hub AH-01): the staff/member address check is no longer a bare read. Every writer takes the
  claim lock described in "What an email means" below, so two requests at the same instant (an owner edit and a member
  being added with the same address) cannot both pass. Still no database constraint: see the enforcement statement.
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
- Operator conflict resolution (9 Oct 2026): `app/api/admin/customers/[id]/login-email/check/route.ts`,
  `app/api/admin/customers/[id]/members/[memberId]/contact-email/route.ts`, `components/admin/ConflictPanel.tsx` (opened
  from `app/admin/tenants/[id]/LoginEmailCard.tsx`); step-up action `member.contact_email`. Tests
  `tests/unit/operator-hub-conflict-routes.test.ts`, `tests/unit/conflict-panel.test.tsx`,
  `tests/integration/operator-hub-conflict-db.test.ts`.
- Tests: `tests/unit/account-profile.test.ts`, `tests/unit/account-password.test.ts`,
  `tests/unit/operator-owner-profile.test.ts`, `tests/unit/staff-edit-account-rules.test.ts`,
  `tests/unit/password-policy-doors.test.ts`, `tests/integration/account-editing-db.test.ts`.
