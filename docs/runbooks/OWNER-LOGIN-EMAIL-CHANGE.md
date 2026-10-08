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
