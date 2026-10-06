# Operator access and recovery

Applies from the operator auth hardening change (lane A, 6 Oct 2026) and the review fixes (lane H, 6 Oct 2026: the
enrolment ticket, durable operator sign-in rows, step-up on suspension). Until that change is deployed, production still
accepts the shared secret; see "Rollout" below for the order that avoids a lock-out.

## How operator access works

| Credential | Where it works | What it grants |
|---|---|---|
| Operator email + password | everywhere | nothing on its own: a short-lived challenge (enrolled operator) or enrolment cookie (not yet enrolled) |
| Enrolment ticket (printed by `operator-access.mjs create` / `recover`) | authenticator set-up only | with the enrolment cookie, the right to enrol ONE authenticator. 30 minutes, single use, stored only as a SHA-256 hash. Without it the password cannot enrol anything |
| Authenticator code at sign-in | everywhere | the full operator session (`matflow_op_session`, 8 hours, revoked by `sessionVersion`). Every sign-in writes a durable `admin.operator.signed_in` audit row first; if that row cannot be written, no session is issued |
| Authenticator code again (step-up) | Danger Zone | one 5-minute, single-use grant for one action on one club (password reset, 2FA reset, member 2FA reset, ownership transfer, deletion, suspension). The `admin.operator.step_up` row is written durably before the grant exists |
| `MATFLOW_ADMIN_SECRET` (header, cookie, `/api/admin/auth/login`) | development and test only | nothing on Vercel production, any `NODE_ENV=production` build, or anything on the production database. No variable re-enables it; `ALLOW_ADMIN_SECRET_HEADER` can only close it further in development |

Every authenticator code is single use across all server instances (the last accepted time-step is stored on the
operator row). Sign-out bumps `sessionVersion`, so it signs that operator out on every device and kills copied cookies.

There is no HTTP emergency door. The only emergency path is `scripts/operator-access.mjs`, run by someone holding the
database credentials. It writes an audit row (`AuditLog`, `tenantId` null, `metadata.via = "local-script"`, the reason and
the machine user) for every change, in the SAME transaction as the change: if the row cannot be written, nothing changes.
The enrolment ticket is never written to the audit row or anywhere else; only its hash and expiry are on the operator row.

## Create the first operator

1. Get the production database URL from Neon (pooled or direct; do not paste it anywhere else).
2. From the matflow root, in a shell that will be closed afterwards:
   `DATABASE_URL='<url>' node scripts/operator-access.mjs create --email <you> --name "<name>" --reason "first operator" --confirm-host <neon endpoint id>`
   The password is printed once; save it in your password manager. Or set `OPERATOR_PASSWORD` for this one command.
   An **enrolment ticket** (`xxxx-xxxx-…`, 32 characters) is also printed once. It works once and expires after 30
   minutes. Do not paste it into chat, tickets or notes; it is only for the next step.
3. Within 30 minutes open `https://matflow.studio/admin/login` and sign in with that email and password. The page asks
   for the enrolment ticket: paste it, press "Continue". It then shows a QR code: scan it with your authenticator app,
   type the 6-digit code, press "Turn on and sign in". You are now in the console. The ticket is spent.
   If the ticket expired, run `recover` (below) for a new password and a new ticket. Without a valid ticket the
   password alone cannot enrol an authenticator, so a leaked password is not enough to take over an unenrolled operator.
4. Check: `node scripts/operator-access.mjs list --confirm-host <endpoint>` (same `DATABASE_URL`) shows `authenticator=yes`.

`scripts/seed-operator-noe.mjs` (the older way) still works but reads `.env`, has a hard-coded address and writes no audit
row. Prefer `operator-access.mjs`.

## Sign in (every day)

1. `/admin/login` → email + password → "Two-factor check" → code from the authenticator → console.
2. A Danger Zone action asks for a fresh code in its dialog. Each code works once; if it is refused, wait for the next one.

## Lost authenticator, or suspected compromise (offline recovery)

1. With the production database URL in the environment for one command:
   `DATABASE_URL='<url>' node scripts/operator-access.mjs recover --email <operator> --reason "<what happened>" --confirm-host <endpoint>`
   This replaces the password (printed once), clears the authenticator, cancels any outstanding step-up grant and support
   session, unlocks the account, revokes every session, and prints a new one-time enrolment ticket (30 minutes).
2. Within 30 minutes sign in, enter the ticket and enrol the new authenticator (as in "Create", step 3).
3. If compromise is suspected, also review the operator activity (`/admin/activity`) and AuditLog rows with
   `metadata.actingAs = <operator id>` since the last known-good time.

## Revoke every session of an operator (without changing anything else)

- From the console: sign out (it revokes all of that operator's sessions).
- Offline: `node scripts/operator-access.mjs revoke --email <operator> --reason "<why>" --confirm-host <endpoint>`.

## Support sessions ("View as … (read-only)")

1. `/admin/tenants/<club>` → "View as … (read-only)" → reason (at least 10 characters) + a fresh authenticator code.
   The session lasts 30 minutes, is bound to your own operator session, and refuses every change (any non-GET is a 403).
2. You do NOT need to be signed in to a club in the same browser. When the browser has no club (Auth.js) session, the
   start also sets an identity-less **carrier** session cookie (`supportCarrier`) so the app can switch the browser to the
   owner's view. The carrier is never a session by itself: as soon as support is not active — "End support session", the 30
   minutes run out, your operator session ends or is revoked, the owner's password/2FA changes, or the club is suspended —
   the browser is signed out of the club view (it does not fall back to any identity).
3. If the browser already had a club session, that session is kept aside during support and handed back when support ends.
4. End support from the banner ("End support session") or the console. Ending it clears the support cookie AND the club session
   cookie in that browser, and the server-side nonce, so a copied support cookie is dead everywhere. `revoke` and
   `recover` (above) also end any live support session of that operator.

## Rotate or remove `MATFLOW_ADMIN_SECRET`

After this change the secret grants nothing in production, so it is no longer a production credential. Still:

1. Rotate it now if it has ever been shared, pasted or logged: Vercel → Settings → Environment Variables →
   `MATFLOW_ADMIN_SECRET` → new value from `openssl rand -hex 32`. Old `matflow_admin` cookies are refused in production
   regardless.
2. `lib/env-guards.ts` no longer requires it at boot in production (6 Oct 2026), so it can be deleted from Vercel
   production once this build is deployed. Until then (the deployed build still requires it), keep a long random value
   there; that is harmless.
3. Local development keeps its own value in `.env.local` / `.env.test` for tooling.

## Rollout (so the deploy cannot lock the operator out)

Before deploying the hardening commit:

0. The deploy carries two additive Operator migrations (`20261006010000_operator_auth_hardening` and
   `20261006050000_operator_enrolment_ticket`, plus `20261006040000_support_session_binding`). `operator-access.mjs`
   from this commit writes the ticket columns, so run it against production only AFTER the deploy has migrated it.
1. Make sure a named operator exists in production AND has an authenticator enrolled:
   `node scripts/operator-access.mjs list` → `authenticator=yes` for at least one operator.
   After the deploy an operator WITHOUT an authenticator can only enrol with a ticket, i.e. via `recover` (which also
   replaces the password). Enrol before the deploy if you can.
   - If the operator exists but has no authenticator, sign in at `/admin/login` on the CURRENT build ("Account" tab) and
     enrol at `/admin/security`. On the current build that page enrols an operator session that was opened with the
     password.
   - If no operator exists, run `create` (above) first, then enrol.
2. Confirm you can sign in with password + code on the current build.
3. Deploy. Every existing operator session is invalidated by the deploy (the session signature changed); sign in again
   with password + code. The shared secret stops working.
4. Smoke: `/admin/login` shows no "Bootstrap" tab; `POST /api/admin/auth/login` answers 403; a Danger Zone dialog asks
   for a code.

Rollback note: rolling the application back re-opens the shared-secret door (the old code accepts it). If a rollback is
needed, first rotate `MATFLOW_ADMIN_SECRET` in Vercel to a fresh value nobody holds, so the old door has no usable key.
