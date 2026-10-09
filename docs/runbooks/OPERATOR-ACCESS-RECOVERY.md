# Operator access and recovery

Applies from the operator auth hardening change (lane A, 6 Oct 2026), the review fixes (lane H, 6 Oct 2026: the
enrolment ticket, durable operator sign-in rows, step-up on suspension) and the operator allowlist (admin hub lane B,
9 Oct 2026). Until those changes are deployed, production still accepts the shared secret and any operator row; see
"Rollout" below for the order that avoids a lock-out.

## How operator access works

| Credential | Where it works | What it grants |
|---|---|---|
| Operator email + password | everywhere | nothing on its own: a short-lived challenge (enrolled operator) or enrolment cookie (not yet enrolled) |
| Enrolment ticket (printed by `operator-access.mjs create` / `recover`) | authenticator set-up only | with the enrolment cookie, the right to enrol ONE authenticator. 30 minutes, single use, stored only as a SHA-256 hash. Without it the password cannot enrol anything |
| Authenticator code at sign-in | everywhere | the full operator session (`matflow_op_session`, 8 hours, revoked by `sessionVersion`). Every sign-in writes a durable `admin.operator.signed_in` audit row first; if that row cannot be written, no session is issued |
| Authenticator code again (step-up) | Danger Zone | one 5-minute, single-use grant for one action on one club (password reset, 2FA reset, member 2FA reset, ownership transfer, deletion, suspension). The `admin.operator.step_up` row is written durably before the grant exists |
| `MATFLOW_ADMIN_SECRET` (header, cookie, `/api/admin/auth/login`) | development and test only | nothing on Vercel production, any `NODE_ENV=production` build, or anything on the production database. No variable re-enables it; `ALLOW_ADMIN_SECRET_HEADER` can only close it further in development |
| Being named in `OPERATOR_ALLOWED_IDS` | every environment where it is set; production always | a precondition, not a credential: everything above is refused for an operator whose `Operator.id` is not in the list. In production an unset or empty list admits NOBODY |

Every authenticator code is single use across all server instances (the last accepted time-step is stored on the
operator row). Sign-out bumps `sessionVersion`, so it signs that operator out on every device and kills copied cookies.

There is no HTTP emergency door. The only emergency path is `scripts/operator-access.mjs`, run by someone holding the
database credentials. It writes an audit row (`AuditLog`, `tenantId` null, `metadata.via = "local-script"`, the reason and
the machine user) for every change, in the SAME transaction as the change: if the row cannot be written, nothing changes.
The enrolment ticket is never written to the audit row or anywhere else; only its hash and expiry are on the operator row.

## The operator allowlist (`OPERATOR_ALLOWED_IDS`)

MFA proves that someone holds a factor; it does not prove the someone is Noe. A second `Operator` row with a password and
an authenticator (created by anyone holding database credentials, or by a future bug) used to have full operator power,
because "only Noe" meant "only one row exists". Now the deployment names the operators it trusts.

- **Value:** comma-separated `Operator.id`s (the immutable row id printed by `operator-access.mjs list`), whitespace
  trimmed, exact and case-sensitive match. Never an email: emails change and a club account can share one.
- **Where:** Vercel → Settings → Environment Variables → `OPERATOR_ALLOWED_IDS`, **Production** (and Preview if operators
  sign in there). A change takes effect on the next deployment, so redeploy after editing it.
- **Production rule:** `NODE_ENV=production`, `VERCEL_ENV=production` or the production database (the same detection that
  closes the shared secret, `isProductionLikeProcess` in `lib/operator-auth.ts`): unset, empty or separator-only means
  nobody. Development/test: unset means everyone (local tooling and the unit suites); a set list is enforced. A local
  `next start` runs with `NODE_ENV=production`, so the local production-mode browser run needs the variable in
  `.env.test` too.
- **Where it is enforced:** `resolveOperatorFromCookie` (every operator route and page goes through it, after the MFA
  session checks and before any target lookup); the two session mints (`/api/admin/auth/operator-totp` after a valid
  code, `/api/admin/auth/operator-totp/setup` before enrolment changes anything); and the `/admin` page fence in
  `proxy.ts` (an edge copy, pinned by `tests/unit/operator-allowlist.test.ts`). Sign-out ignores it, so a de-listed
  operator can still be signed out everywhere.
- **What a refusal looks like:** 403 "This operator account is not permitted to use the operator console." at sign-in
  and enrolment; the route's ordinary 401/403 elsewhere; a redirect to `/admin/login` for pages. Each refused request
  writes one durable `admin.operator.refused` row (`tenantId` null, `entityId` = a keyed digest `opd_…` of the operator
  id, `metadata.reason = "not_allowlisted"`, `metadata.stage` = `session`, `session_mint` or `enrolment`). The row never
  holds the raw id; the digest is HMAC-SHA-256 with `AUTH_SECRET` (`operatorIdDigest`), so someone holding that secret
  can match it to a known id. A failed row write never turns into access.
- **Known limit:** a live support (impersonation) session is checked against the operator's own session in
  `lib/impersonation.ts`, which does not read the allowlist yet; a support session started before an operator was
  de-listed can run to its 30-minute end. Run `revoke` (below) for that operator to end it at once.

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
   **Allowlist first:** `create` prints the new operator's id. Before enrolling, add it to `OPERATOR_ALLOWED_IDS` in
   Vercel Production and redeploy; a non-allow-listed operator is refused at enrolment (nothing changes, the ticket is
   not spent). If the 30 minutes run out while the deploy finishes, run `recover` for a new ticket.
4. Check: `node scripts/operator-access.mjs list --confirm-host <endpoint>` (same `DATABASE_URL`) shows `authenticator=yes`
   and the id. With `OPERATOR_ALLOWED_IDS` set in that shell to the Vercel value it also shows `allowlisted=yes`.

`scripts/seed-operator-noe.mjs` (the older way) still works but reads `.env`, has a hard-coded address and writes no audit
row. Prefer `operator-access.mjs`.

## Sign in (every day)

1. `/admin/login` → email + password → "Two-factor check" → code from the authenticator → console.
2. A Danger Zone action asks for a fresh code in its dialog. Each code works once; if it is refused, wait for the next one.

## Lost authenticator, or suspected compromise (offline recovery)

This is the phone-loss path. It is an authentication path, so it needs independent, strong evidence: possession of the
production database credentials (Neon), which only the account owner holds. There is deliberately no other way:

- no unauthenticated "lost my phone" link, and no operator recovery codes accepted by any HTTP route;
- no admin or shared secret (`MATFLOW_ADMIN_SECRET` grants nothing in production);
- no email-only factor removal (nothing mails an operator a reset);
- the operator id does not change, so the allowlist still applies and need not be edited.

Status: the script and the ticket are tested against the Neon TEST branch
(`tests/integration/operator-enrolment-ticket-db.test.ts`, owner role and restricted role, 9 Oct 2026); a full recovery
against production has NOT been rehearsed. If the Neon account itself is lost, operator recovery depends on Neon's own
account recovery (see "Who controls what" below).

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

## Session precedence: a support session and an operator session in one browser

A browser can hold an operator session (`matflow_op_session`) and a support session (club identity carrying
`impersonatedBy`) at once. Enforced in `proxy.ts` with `lib/support-session.ts`; pinned by
`tests/unit/operator-allowlist.test.ts`:

1. **On the operator plane the support context wins, and is refused.** While support is live, every operator API route
   and method answers 403 `supportReadOnly` and every `/admin` page redirects to `/dashboard`, even with a valid,
   allow-listed operator cookie. Only the two exits pass: `DELETE /api/admin/impersonate` (end support) and
   `POST /api/admin/auth/logout`. End support first, then use the console.
2. **The operator cookie gives nothing on the club plane.** Club routes read only the Auth.js session: during support
   they stay read-only (non-GET → 403), and an operator cookie with no club session gets 401 (API) or `/login` (pages).
   Only operator-plane code (`app/api/admin/**`, `app/admin/**`, `lib/operator-*.ts`, `lib/admin-auth.ts`) and the
   support binding (`lib/impersonation.ts`) read the operator cookie.

## Legacy shared-secret transports (inventory, 9 Oct 2026)

| Transport | Read in | Production behaviour |
|---|---|---|
| `x-admin-secret` header | `lib/admin-auth.ts` `checkAdminHeader` | refused before comparison (`sharedAdminSecretPermitted()` is false); `lib/audit-log.ts` only notes its presence on development rows |
| `matflow_admin` cookie | `lib/admin-auth.ts` `checkAdminCookie`; `proxy.ts` `/admin` fence | refused before comparison in both places |
| `POST /api/admin/auth/login` body `{ secret }` | that route only | 403 before the body is read; no cookie set |
| query string, other body fields | nowhere | never read; a secret there opens nothing, even in development |
| debug or fallback routes | none exist | none |
| `ALLOW_ADMIN_SECRET_HEADER` | `lib/admin-auth.ts` | can only close the header further in development; re-opens nothing |

No HTTP route creates an `Operator` row: only `scripts/operator-access.mjs` and the older `scripts/seed-operator-noe.mjs`
do, and both need direct database credentials. Pinned by a static scan in `tests/unit/operator-allowlist.test.ts`.

## Rate limits on operator credential doors

All are DB-backed (`lib/rate-limit.ts`, table `RateLimitHit`), so they hold across serverless instances. They fall back
to per-instance memory only when the database is unreachable, and then sign-in fails anyway (it needs the database).

| Door | Buckets |
|---|---|
| password (`operator-login`) | `admin:operator-login:<ip>` 5 per 15 min; plus the account lockout (5 failures, 15 min) |
| sign-in code (`operator-totp`) | `admin:operator-totp-ip:<ip>` 20 per 15 min; `admin:operator-totp:<operator>` 5 per 10 min; wrong codes count towards the lockout |
| enrolment (`operator-totp/setup`) | `admin:operator-totp-setup-ip:<ip>` 20 per 15 min on GET and POST (added 9 Oct 2026); `admin:operator-totp-setup:<operator>` 5 per 10 min |
| step-up (`step-up`) | `admin:operator-step-up:<operator>` 5 per 10 min |
| development secret (`login`) | `admin:login:<ip>` 5 per 15 min (route refused in production) |
| recovery | no HTTP door; the script needs database credentials |

## Phishing-resistant MFA (recorded, not built)

TOTP codes can be phished in real time. The phishing-resistant path is passkeys (WebAuthn), bound to the
`matflow.studio` origin. What it would take here:

- The operator plane does not use NextAuth, so NextAuth's experimental WebAuthn provider does not apply; use
  `@simplewebauthn/server` and `@simplewebauthn/browser` directly.
- An additive `OperatorCredential` table (credential id, public key, sign counter, transports, created and last used).
- Registration only from a live MFA session plus a fresh step-up, audited; at least two credentials (phone and a hardware
  key) so one loss is not a lock-out.
- Authentication replaces the code step at `operator-totp` and at step-up with an assertion: RP ID `matflow.studio`,
  origin check, single-use short-lived challenge stored hashed (like the step-up nonce), counter check.
- Recovery stays the script (`recover` would clear credentials as it clears TOTP).

Until then the control is TOTP with single-use codes plus the allowlist. Real-time phishing of a code remains a known
residual risk.

## Who controls what (no values here)

Each line is a separate way into the platform; keep the recovery for each one independent of the others.

| Asset | Where configured | Who holds it |
|---|---|---|
| Hosting, environment variables (incl. `OPERATOR_ALLOWED_IDS`, `AUTH_SECRET`), deployments | Vercel project | Noe; confirm no other team members [[NEEDS VERIFICATION]] |
| Source repository, CI, deploy-on-push (`main` auto-deploys and migrates production) | GitHub | Noe; confirm collaborators and deploy keys [[NEEDS VERIFICATION]] |
| Database (production and test branches), database roles | Neon project | Noe; operator recovery depends on this account |
| DNS and the `matflow.studio` domain | registrar / DNS provider | [[NEEDS VERIFICATION]] |
| Recovery email for the accounts above | the provider of the address on those accounts | Noe, with its own MFA [[NEEDS VERIFICATION]] |
| Operator console accounts | `Operator` rows plus `OPERATOR_ALLOWED_IDS` | Noe's operator id only |
| Session signing (`AUTH_SECRET` / `NEXTAUTH_SECRET`) | Vercel env | anyone with Vercel env access |
| Email sending (`RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`) | Resend account plus Vercel env | Noe |
| Payments (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CLIENT_ID`) | Stripe account plus Vercel env | Noe |
| Scheduled jobs (`CRON_SECRET`) | Vercel env and Vercel cron | Vercel scheduler |
| File storage (`BLOB_READ_WRITE_TOKEN`) | Vercel Blob | Vercel project |
| Google sign-in (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`) | Google Cloud console plus Vercel env | [[NEEDS VERIFICATION]] |
| Error reporting (`SENTRY_DSN`) | Sentry project | [[NEEDS VERIFICATION]] |
| Legacy `MATFLOW_ADMIN_SECRET` | Vercel env; grants nothing in production after the hardening deploy | rotate or delete (below) |

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

Allowlist (9 Oct 2026), BEFORE pushing the commit that introduces it:

A. With the production database URL for one command: `node scripts/operator-access.mjs list --confirm-host <endpoint>`;
   note Noe's `id=`.
B. Vercel → Production → set `OPERATOR_ALLOWED_IDS` to that id (only that id). Old builds ignore the variable, so setting
   it first is safe, and the new build starts with it.
C. Push / deploy. Smoke: Noe signs in at `/admin/login` and the console loads; no new `admin.operator.refused` row for
   him. A second operator row, if one exists, is refused (403 at sign-in).
D. If the console refuses Noe after the deploy, the variable is missing, misspelt or not yet redeployed: fix the value
   and redeploy. There is no other door; do not re-open the shared secret.

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
