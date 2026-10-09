# Owner login email: provisional now, real address later

Applies to every staff login email, and in particular to the first real club owner, whose initial login is an address
supplied by MatFlow rather than one he has been shown to read. Added 7 Oct 2026.

Who may edit which field of a staff account (name, login email, password, authenticator, role), the pre- and
post-activation handover paths and recovery are in [ACCOUNT-EDITING.md](ACCOUNT-EDITING.md) (8 Oct 2026). The owner's
login email can also be changed from **My account** (`/dashboard/account`), which every staff role can reach.

## Is email actually off? Check before relying on this page

**Production sends email until `EMAIL_DELIVERY=off` is set.** The switch (`lib/email-delivery.ts`) defaults to ON when
the variable is unset, so deploying this code changes nothing about mail on its own. It is off only after
`EMAIL_DELIVERY=off` is set in the production environment (Vercel) **and** the app is redeployed. Both Login email cards
read the live switch and say which state they are in; anything below that says "email is off" applies only once it is.

Before the first real owner's first sign-in, in this order: (1) set `EMAIL_DELIVERY=off` and redeploy; (2) mark his login
email provisional on the operator card. Until both are done, his first sign-in from a new device can send a new-device
alert (`lib/login-event.ts`) to the address on file.

## What "provisional" means

A login email does two jobs: it is the identifier typed at sign-in, and normally it is a mailbox the person controls.
When MatFlow cannot vouch for the second job, the account is marked **provisional** (`User.loginEmailProvisionalSince`
is set; `isLoginEmailProvisional` in `lib/login-email.ts`). While it is set:

| Door | Behaviour |
|---|---|
| Password + authenticator sign-in | Works exactly as before. This is the only way in. |
| Forgot password | Answers exactly as for an unknown address. No code is created or sent. Audited `auth.password_reset.refused_provisional`. |
| Reset password with an old code | Refused as an expired code; the code is burned. Audited. |
| Sign-in link request | Answers exactly as for an unknown address. No link is created or sent. Audited `auth.magic_link.refused_provisional`. |
| Sign-in or activation link already issued | Refused as an expired link; the link is consumed. Audited. |
| Google (or any external provider) | Refused. Audited `auth.external_signin.refused_provisional`. |
| Members' sign-in links | Never use a provisional owner address as Reply-To. |

The mark says nothing about the person, only about the mailbox. It never changes the user id, role, club, password,
authenticator, recovery codes or audit history. The club's public contact address (Settings → Contact email) is a
separate field and is not a login.

An address WITHOUT the mark is not thereby verified: MatFlow has never verified any mailbox. The operator card says
"Not marked provisional — mailbox not verified by MatFlow" for exactly that reason.

Who sets it: the operator ("Mark provisional" or "Change login email" on the club's operator page) and the owner's own
change (there is no verification flow yet, so a new address is provisional too). Who clears it: an operator only, as
their own attestation (below).

## Self-service change (the owner, signed in)

Settings → Account → Login email → **Change login email**.

1. Enter the new address, the current password and a current authenticator code. Both are required. The code is single
   use: a code already used for this confirmation is refused, so wait for the next one. The code used here is spent, so
   the sign-in that follows the change needs the authenticator's NEXT code — the card says so.
2. The address is normalised (trimmed, lower-cased) and must not be the login of any other staff user or the address of
   any member **in the same club**. A collision is refused (409) without saying whose address it is. The same address in
   a different club is allowed: sign-in resolves the club first, then the address.
3. On success, in one database transaction: the email changes; it is marked provisional; every outstanding reset code and
   sign-in/activation link for the old **and** the new address is retired; `sessionVersion` is bumped; an audit row
   `user.login_email.changed` records SHA-256 digests of both addresses (never the addresses).
4. **Every device is signed out, this one included** (the response also clears this browser's session cookie). The
   owner signs in again with the new address, the same password and the same authenticator. Chosen over re-issuing the
   session so the new identifier is proven at once and no live session carries the old address.

Refused: support (impersonation) sessions, a sign-in still owing its authenticator code, a temporary-password session,
and an account without an authenticator.

API: `GET/POST /api/account/login-email` (`app/api/account/login-email/route.ts`).

## Operator-assisted change, mark and confirm

Operator console → the club → **Login email** card. Each action needs: a named operator signed in with MFA, a fresh
authenticator code (step-up `owner.login_email`, bound to this club, this owner **and this action** — a code bought
for "Mark provisional" cannot be spent on "Change login email"), and a reason of at least 10 characters. The change and its audit row are one transaction; if the audit row cannot be written nothing changes.

- **Mark provisional** — use when the address on file has not been proven to be the owner's. Retires outstanding reset
  codes and sign-in links for it. Audit `admin.owner.login_email.marked_provisional`.
- **Change login email** — when the owner cannot use self-service (for example, lost access to the old address is not a
  problem, but they are locked out of the dashboard). **Verify the owner first** exactly as in
  [SUPPORT-IDENTITY-VERIFICATION.md](SUPPORT-IDENTITY-VERIFICATION.md), and write how in the reason. An address typed by
  an operator proves nothing about who reads it, so the new address is provisional. Same guarantees as self-service
  (collision rules, tokens retired, every session signed out). Audit `admin.owner.login_email.changed` with digests.
  The change only applies if the owner's address is still the one the route read; if it changed in between (for
  example the owner changed it themselves), the answer is 409 and nothing changes — reload the page and check.
- **Confirm mailbox** (clear provisional) — MatFlow has no verification-link flow (whether or not email is switched on),
  so it cannot verify the mailbox itself. Clearing the mark is **the operator's attestation only**: tick "You are confirming you verified this mailbox yourself" and state
  how in the reason (for example: a message sent from your own mail client to that address, answered with a detail only
  the owner knows, during a call-back on the number on file). Audit `admin.owner.login_email.cleared_provisional` with
  `verification: "operator_attestation"`. If you cannot verify the mailbox, leave the mark on: the owner loses only
  reset-by-email and sign-in links, and the operator recovery routes below still work.

Who may authorise: any named MatFlow operator for mark; change and confirm need the verification above, and a change
for an owner whose phone AND mailbox are both unreachable goes to Noe (documentary proof, as the identity runbook says).
Note: "email from the address on file" is **not** a verification channel while that address is provisional.

API: `POST /api/admin/customers/[id]/login-email` with `{ action: "mark_provisional" | "clear_provisional" | "change", reason, attestMailboxVerified?, newEmail? }`
and the step-up grant in `x-matflow-step-up` (`app/api/admin/customers/[id]/login-email/route.ts`).

## Resolving a conflict (the address belongs to a member record)

Typical case: the owner should sign in with an address that an **imported member** of the same club already holds (the
import created a member row for the owner's own address, or the club typed it onto someone else). Club screens and the
owner's self-service answer "That email address is already in use at this club" and never say whose — on purpose. Only
the operator console says who holds it.

1. **Check.** Login email card → Change login email → type the address → **Check address**. The answer is "Free in this
   club", or the conflict panel: club, owner, and the holder (member or staff; name; status; whether they can sign in —
   a password, or a live invite / sign-in / reset link for that address; a link to the record; its id). A legacy
   duplicate (two rows on one address) shows only a count: stop and review those records with the club; nothing here
   resolves it. A **staff** holder is the club's to change in Settings → Staff; this workflow moves members only.
2. **Verify the relationship independently.** A matching name is **not** proof that the member row is the owner, nor
   that the address is really the owner's. Call the club back on the number you already hold (never a number given in
   the request) or verify in person, exactly as in [SUPPORT-IDENTITY-VERIFICATION.md](SUPPORT-IDENTITY-VERIFICATION.md).
   Establish: whose address it is; which address the member should have instead; whether the member is the owner
   themselves, a family member, or someone else. Tick "I verified independently" and write how — that note becomes the
   audit reason. **Shared-family exception:** a family that shares one inbox is legitimate. If the member is (say) the
   owner's child or partner and the family wants to keep the shared address as the member's **contact**, do not move it
   through this workflow: give the owner a different login address instead. A shared payer address imported as
   `unverifiedEmail` is not a login and is never a conflict.
3. **Change the member's contact address** (dialog: the member's new address, reason, an authenticator code). What it
   changes: the member's `email` only. If the member had no password, every outstanding invite, sign-in link and reset
   code for the old and the new address in this club is retired (a waiver link is kept) — they stay unable to sign in
   until the club invites them at the new address. If the member could sign in, they are signed out everywhere and the
   new address is recorded as unverified. What it never changes: the import identity (`externalRef`, so refresh and
   attendance imports still find the same person), status, password, authenticator and recovery codes, memberships,
   family links, attendance and payment history. Nothing is merged.
4. **Re-check** happens automatically. If the address is still held (someone else took it, or another row holds it too),
   stop and look again.
5. **Change the owner's login address** with a **separate, fresh** code ("your authenticator code works once; wait for
   the next code"). This is the ordinary operator change above: provisional, tokens retired, owner signed out everywhere.
6. The panel lists each step with its outcome and ids. Tell the club to re-invite the member at their new address if
   they need app access.

**Half-done is stated honestly.** Steps 3 and 5 are separate transactions. If step 3 succeeded and step 5 did not, the
panel says "Step 1 done, step 2 not done" and offers to resume; a reload of the page resumes at step 5 with a fresh
check (the page address carries the member id, never a code or an address). A request is never retried automatically.
If a response is lost (network drop after you pressed the button), **Re-send the same confirmation**: the route answers
"already applied" from its record instead of changing anything twice. A confirmation is spent once; a used one is never
accepted again.

**Undoing step 3** is a new, separately authorised operation: run the member change again back to the old address (it is
free again only if the owner has not taken it). It is not undoable from the Activity log.

APIs: `POST /api/admin/customers/[id]/login-email/check` `{ email }`;
`POST /api/admin/customers/[id]/members/[memberId]/contact-email` `{ newEmail, reason, version }` with a grant for
`member.contact_email` (target `<club>/<member>/change`, change `{ newEmail }`). Audit `admin.login_email.checked`
(keyed digest only) and `admin.member.contact_email.changed`. Pinned by `tests/unit/operator-hub-conflict-routes.test.ts`,
`tests/unit/conflict-panel.test.tsx` and, on the test branch, `tests/integration/operator-hub-conflict-db.test.ts`.

## Recovery while provisional

There is no reset by email. If the owner loses the password, the operator uses **Force password reset** (temporary
password via the verified channel, forced change at next sign-in); if they lose the authenticator, **Reset owner 2FA**
(they re-enrol at next sign-in). Both are audited and step-up protected; see SUPPORT-IDENTITY-VERIFICATION.md.

## Rollback

Change it back the same way (self-service or operator "Change login email" to the previous address). The same rules
apply: fresh code, collision check, tokens retired, every session signed out, audited. The rolled-back address is
provisional again; confirm it with the operator attestation if it had been confirmed before. Tested on disposable clubs:
`tests/integration/login-email-change-db.test.ts` (change → old address refused, new address + same authenticator
accepted, same user id; rollback → the reverse; replayed code refused; collisions refused; same address in another club
allowed).

## Verification (machine-enforced, 9 Oct 2026)

Do not judge a change by eye or by a script that prints lines and exits 0. Two read-only scripts give the verdict as
their exit code (0 = every check passed; 1 = any check failed, was missing, malformed or timed out; 2 = refused before
connecting). Each prints one JSON summary on stdout and human lines on stderr, and never prints an address, credential,
session value, password hash, authenticator secret or recovery code. In a pipeline use `set -o pipefail` (or read
`$?` / `$LASTEXITCODE` directly): the exit code is the verdict, not the text.

**1. The change itself — `scripts/readiness/owner-login-change-check.mjs`.**

1. Write a private file **outside the repository** (the script refuses one inside it), for example
   `%LOCALAPPDATA%\matflow-readiness\<club>-addresses.json`:
   `{ "runSecret": "<at least 32 random characters>", "ownerOriginalEmail": "…", "ownerTargetEmail": "…",
   "memberOriginalEmail": "…", "memberTargetEmail": "…" }` (the member pair only when a member's contact address is
   changed first). Addresses are never accepted on the command line. Keep the file until verification is done, then
   delete it; never commit it.
2. Before any change:
   `node scripts/readiness/owner-login-change-check.mjs baseline --tenant <slug> --owner-id <User.id> --member-id <Member.id> --expect-email-file <private file> --expect-host <Neon endpoint id> --env <env file>`
   (`--no-member` instead of `--member-id` when no member is involved). `--expect-host` is the exact Neon endpoint id
   (for example `ep-hidden-salad-abom7cg4` for the test branch); any other endpoint is refused — no substring guessing.
   The baseline is written outside the repository (default `%LOCALAPPDATA%\matflow-readiness\`, refused inside the
   repo, never overwritten without `--overwrite`) and holds ids plus HMAC fingerprints keyed with the private
   runSecret — no addresses, hashes or secrets. Baseline refuses (exit 1, nothing written) if the owner's or member's
   current address is not the "original" in the private file.
3. Make the change (self-service, or the operator route(s)).
4. After it: the same command with `verify --path self-service|operator` (and `--operator-id <Operator.id>` for the
   operator path).

What verify asserts, each a named check: same tenant, owner and member ids; owner role; the owner's login equals the
target (keyed digest); provisional **set and freshly stamped** — both routes set `loginEmailProvisionalSince` in the
change transaction (`app/api/account/login-email/route.ts`; operator `change` in
`app/api/admin/customers/[id]/login-email/route.ts`), so the expectation is the same for both paths; password hash,
authenticator flag/secret, recovery codes, `mustChangePassword` and password-history **ids** unchanged;
`sessionVersion` exactly baseline + 1 (any other delta fails and names it); the member keeps its status, externalRef,
credentials, imported-membership ids and contents, attendance ids and guardian links, and its address is the expected
contact address; in THIS club exactly one User (the owner) holds the target and no Member does (the same address in
another club is legitimate); no live reset code or `login` / `first_time_signup` link for either original address in
this club (`waiver_open` ignored); audit rows after the baseline matched by exact action (`user.login_email.changed`
or `admin.owner.login_email.changed`, and `admin.member.contact_email.changed` when a member is named), subject,
actor (`operatorId` column, or none for self-service), a request id carried by exactly one row, distinct request ids
for the two steps, old/new digests equal to the private addresses; and no audit metadata contains any of the private
addresses (compared against the addresses themselves, not an "@" scan).

Audit correlation reads `AuditLog.operatorId` / `requestId` (migration `20261009010000_audit_operator_request`)
when the columns exist and falls back to `metadata.actingAs` / `metadata.requestId` when they do not; the summary's
`auditPath` says which (`columns` or `metadata-fallback`).

The read is one `REPEATABLE READ READ ONLY` transaction with a statement timeout, selecting only the columns each check
needs, then rolled back. It sets `app.bypass_rls` locally for the one tenant lookup by slug, then runs every other
query in the tenant's RLS context, so it also works as the restricted role (`--db-var RESTRICTED_DATABASE_URL`).
Timestamps are read as UTC text (Prisma stores UTC without a zone; reading them as local time shifted rows by the
machine's offset — caught on the test-branch proof run).

**2. The release — `scripts/readiness/release-verify.mjs`.**

`node scripts/readiness/release-verify.mjs --target production --sha <full sha> --base-url https://matflow.studio --tenant <slug> --env-file-for-migrations <env file> --expect-host <Neon endpoint id> --expect-migrations local --expect-operator-login --operator-session-file <private file holding the operator session cookie value>`

Asserts: Vercel's production target is exactly `--sha` and READY (`vercel api`, run with `MSYS_NO_PATHCONV=1`);
`/api/health` is 200 with `{status:"ok", db:"ok"}`; every expected migration is finished and not rolled back;
the club lookup reports `emailDelivery: "off"`; each legacy shared-secret transport (`x-admin-secret` header,
`matflow_admin` cookie, `POST /api/admin/auth/login`) answered with the application's own 401/403 JSON to a
well-formed credential — a random 64-hex value on production (state the result as "transport closed"); a redirect,
an edge wall, a same-origin refusal, a 5xx or a 429 is INCONCLUSIVE and fails; and the authenticated operator check
returns 200 JSON (a redirect fails). Operator access is required evidence on production: without a session file the
check fails rather than passing.

On a TEST server only (`--target test`, loopback URL): `--legacy-credential-file <private>` sends the real legacy value
(refused for production); and the delivery boundary is observed — start the server with
`RESEND_BASE_URL=http://127.0.0.1:4599` and a dummy `RESEND_API_KEY`, run
`node scripts/readiness/release-verify.mjs mail-interceptor --port 4599`, and pass
`--mail-counter-url http://127.0.0.1:4599 --mail-trigger-file <private file with a non-provisional synthetic address>`:
after a forgot-password request the interceptor count must be 0 and no `EmailLog` row may be queued/sent since.
Run a positive control first (the same request with `EMAIL_DELIVERY=on` must raise the count to 1) to show the
interceptor is wired; a count of 0 without that control proves nothing. Not yet run on a server (9 Oct 2026).

## When email delivery is switched on (future work — not built)

Listed, not built. Enabling Resend must not, on its own, change any of the above. Before a provisional address can be
verified by email, separate work is needed:

1. A verification-link flow: an authenticated owner requests it; a single-use, short-lived, hashed token is sent to the
   address; following it (while signed in, with a fresh authenticator code) clears `loginEmailProvisionalSince` and is
   audited. Changing the email again invalidates any outstanding verification token.
2. Sender configuration and delivery checks (domain, DMARC), and explicit enablement of customer communication.
3. A decision on whether verified mailboxes regain reset-by-email and sign-in links for elevated roles, given the
   authenticator remains mandatory.
4. Notification to the OLD address on change, once it can be sent safely.

Until then, provisional addresses stay provisional unless an operator attests otherwise.
