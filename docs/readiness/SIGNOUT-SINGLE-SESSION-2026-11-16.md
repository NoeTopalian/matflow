# Single-session sign-out — release packet (16 Nov 2026)

Branch `fix/signout-this-session`, from `e2b11f46` (main as deployed 15 Nov). Not merged, not deployed. Deployment
needs Noe's word. Design: the code comments in `lib/session-id.ts`, `lib/session-signout.ts`, `lib/session-revocation.ts`.

## What changes for people

- **Sign out** ends the session on the server before the browser is told it worked. A copied cookie, a second tab or
  a response that was still on its way when the person signed out can no longer bring the session back.
- If the server cannot record the sign-out, the person sees "We couldn't sign you out. Try again." and stays signed
  in. Retrying is safe.
- Other devices of the same person stay signed in. **Sign out everywhere** is unchanged.
- **The one exception, accepted by Noe on 16 Nov 2026.** A session signed in *before* this release has no id of its
  own. Each is given an id derived from its person, the same on every copy. So signing out one pre-release session
  also ends that person's other pre-release sessions; their sessions signed in after the release are not affected.
  Deployment does not force anyone to sign in again, and there is no calendar end date: the effect disappears as old
  cookies expire (at most 30 days after their last use) or are signed out. Wherever the distinction matters, sign-out
  is described as "ends this session", not "this device only".

## 1. How long a revoked session can stay valid, and why cleanup cannot revive it

Every token is a 30-day JWT that is re-issued (expiry slid forward) on use. After sign-out records session id S at
time R, a token carrying S can still be *issued* only in three ways. Each is bounded:

| Path | Latest expiry of a token carrying S |
|---|---|
| A request whose revocation check passed just before R and whose response is sent after R (the late-response case, including the six routes that re-encode the cookie by hand after `auth()` / `requireApiStaff()` / the pending gate) | R + 30 days + the request's own duration |
| The database-outage path (SF-44, below): a token whose check cannot run is kept *without authority* and re-issued until 24 hours after its first failed check, then ended | first failure + 24 h + 30 days, where the first failure is no later than the old token's own expiry (≤ R + 30 days), so ≤ R + 61 days |
| Any other pass | none: the check runs on every Node pass and returns "revoked" for S, which ends the token and clears the cookie |

The record is kept for **62 days** (`REVOKED_SESSION_RETENTION_MS` = 2 × 30 d + 24 h + 1 d margin), so it outlives every
token that could carry S. Cleanup (`pruneExpiredRevocations`) deletes only records whose `expiresAt` has passed, so by
the time a record goes, every token carrying its id is past its own expiry and is rejected by Auth.js's signature
and expiry check before any database lookup. A repeated sign-out of S does not extend or shorten the record
(`ON CONFLICT DO NOTHING` keeps the first). Pre-release ids follow the same rule: a pre-release token without an id
can only exist with an expiry before deployment + 30 days, and every re-issue after deployment stamps the derived id.

**Exception: code that predates this release.** The bound holds only where this code runs. A deployment built before
it ignores `RevokedSession`: given a revoked cookie it grants access (if it has the production database) and re-issues
the cookie with a fresh 30 days, indefinitely, so after cleanup that cookie would work again on current code. See §5.

Independently confirmed on 16 Nov 2026 (focused review of `26b6faaf`: "confirmed on this code"; worst case R + 61 days
plus request time; pruning cannot revive a token; the only exception is code that does not read `RevokedSession`).

## 2. "Failed lookups refuse access" and the 24-hour outage allowance

They do not conflict. The allowance is **not** access. It bounds how long a cookie is *kept* while every request
made with it is refused:

- When the revocation check cannot run (database error, timeout, malformed row), `auth.ts` `jwt()` keeps the token,
  stamps `revalidateSince`, and grants no authority: `session()` returns no user, the exported `auth()` returns null
  for every page and API, `proxy.ts` answers a retryable 503 without clearing the cookie, and `GET /api/auth/session`
  forwards the same 503.
- The stamp is removed only after a check **succeeds**: in `auth.ts` `jwt()`, and in the two second-factor verify
  routes once their own check returned "ok". A successful check reads `RevokedSession` in the same statement as the
  person row, so a revoked session can never clear the stamp: it is ended instead.
- If no check succeeds within 24 hours of the first failure, the token is ended (null, cookie cleared).
- The two second-factor verify routes (`/api/auth/totp/verify`, `/api/member/totp/verify`) decode the half-signed-in
  token themselves; they call `refuseRevokedPendingToken`, which answers 503 on "unknown", spends nothing and
  re-issues nothing; only after "ok" do they spend the code and re-issue.
- Routes that decode the cookie directly were enumerated (`getToken`/`encode` call sites): the six re-encoders all
  pass `auth()` / `requireApiStaff()` / the pending gate first; the impersonate route only asks whether a session
  exists before minting a carrier; the sign-out route reads the id to record it. None grants access on an unchecked
  token.

So the paths that can use the allowance are exactly: every request through `auth()` / the proxy, and
`/api/auth/session`. None of them can bypass revocation, because the allowance only ever refuses.

## 3. Remaining review findings

Independent review (Opus, APPROVE WITH NITS). Findings 1, 2 and 4–8 were fixed in `518fba52`.

- **Finding 3 — LOW (release property). Old code does not enforce session revocation.** Retained production
  deployments carry the production secret and database and never read `RevokedSession`, and for a few seconds during
  an alias switch the old functions still answer the production domain. Disposition: no code change can fix code
  that is already deployed. Handled at release by §5 (retire the old production deployments) and stated plainly:
  Deployment Protection reduces who can reach them, it does not revoke anything.
- **Finding 9 — INFO (product decisions, no code change).**
  - (a) The pre-release coarse effect: now **decided** (Noe, 16 Nov 2026, above).
  - (b) Signing out during a database outage is refused and the cookie kept. That is required ("never signed out
    while the server still honours the session"); the token carries no authority meanwhile. On a shared computer the
    person cannot clear the browser until the database recovers. An optional second action ("Remove from this
    browser anyway; your session may still be active until we can confirm") was suggested. **Open: Noe's call;
    not built.**

## 4. Deployment sequence, database-role checks, recovery

**Sequence (migration before code).** Merging to `main` starts a production build whose first step,
`scripts/maybe-migrate.mjs`, runs `prisma migrate deploy` *before* `next build` against the build's database URL (it
refuses the production database in any build that is not a Vercel production deployment). The two migrations are
additive and run in one transaction each with bounded waits:

1. `20261116120000_revoked_session`: creates `RevokedSession` (sid, revokedAt, expiresAt; no tenant, no foreign
   keys), an `expiresAt` index, RLS enabled and forced, policy `bypass_only` (`app.bypass_rls = 'on'`).
2. `20261116120100_revoked_session_grant`: grants SELECT, INSERT, DELETE to `matflow_app` if that role exists.

While the build runs, the current deployment keeps serving and ignores the new table (compatible). The new code goes
live only after both migrations committed. If a migration fails, the build fails and the old code keeps serving; the
first migration may already have committed, which old code ignores, and the next build applies the rest. If the new code
ever ran without the table, every signed-in request would be refused as unavailable (503, fail closed): the order
above prevents that.

**Database-role checks (Noe, read-only, after the migration).**
- The runtime role can read the table through the bypass helper: one signed-in page loads (200, not 503).
- Where the restricted role exists: `has_table_privilege('matflow_app','"RevokedSession"','SELECT,INSERT,DELETE')` is
  true (the private packet records production's role setup).
- `relrowsecurity` and `relforcerowsecurity` are true for `RevokedSession`.

**Verification after deploy (Noe, signed in).** One page loads; sign out from the account menu lands on /login; the
browser's back button does not show the dashboard.

**Recovery.** Never Instant Rollback or Promote (runbook §4). Fix forward: a revert PR of the application commits,
merged and deployed. Reverted code ignores the table, so it is compatible; the table stays (harmless, pruned only by
this code). Reverting re-opens the late-response weakness for as long as the revert is live. No data migration
needs undoing.

## 5. Old deployments that could accept these cookies

Inventory taken 16 Nov 2026 (`vercel ls`, metadata only; private list in `.omc`): 5 production deployments and 44
preview deployments retained, oldest 13 Oct 2026. Anonymous requests to the production ones and a sample of
previews were redirected to Vercel's sign-in, so Deployment Protection is on today.

- **Preview deployments (44).** None has the production database. Every one is built from a commit descending from
  `75da8b57` (9 Oct 2026), which introduced the 24-hour outage bound (checked per commit, by ancestry and content).
  Their revocation check cannot run, so they grant nothing and cannot extend a cookie beyond §1's bound. Retiring
  merged-branch previews is hygiene, not required for this release. Detail in the private packet.
- **Production deployments (5, built from `e38ab547`, `fa28bb41`, `afc8efbb` twice, `e2b11f46`).** They hold the
  production database and secret and ignore `RevokedSession`. Each one is a place where a revoked cookie still works
  and can be refreshed indefinitely. **They must be retired** (deleted) once the release is live and checked.
  Protection hides them from people without Vercel team access; it is not revocation.
- **Recovery option kept:** fix forward from git (§4). No old deployment is needed for recovery, because Instant
  Rollback is not used.
- **Prepared for Noe's approval (destructive):** delete those five production deployments, after the release
  deployment is healthy and checked (§4). The exact deployment list is in the private packet.
- **The same rule applies to any process running code older than this release with production credentials** (for
  example an old checkout started locally against production): it ignores revocations. Never do that.
- A related environment recommendation is recorded in the private packet (Noe's action).

## Evidence

All on the test branch with synthetic clubs; no production access.

- Unit suite on `8fb322cd`: 662 files, 9,583 passed, 1 skipped. Lint 0 errors, `tsc` 0. Production builds of
  `518fba52`, `1cf2008a`, `8fb322cd` exit 0.
- Database suites, both roles (owner and `matflow_app`): 15 affected files on `2acbdaa1`; the six files touched by the
  review fixes again on `518fba52`; `revoked-session-db` covers the restricted-role access model.
- Browser: `signout-replay` 72 PASS / 0 FAIL / 14 NOTE (run `rmwiev6g3b6a3a0`, build of `8fb322cd`): replayed cookies
  refused after sign-out; late responses cannot restore access; other devices stay signed in; failed and lost
  sign-outs say so and retry; pre-release transition checks L1–L9. `round5-sign-out-everywhere` 6/0 on `518fba52`.
  Journeys record cookie names and sizes only.
- Mutations: three deliberate breaks of the fix make eight tests fail.

## Not verified

Production: the migration, Deployment Protection beyond today's anonymous probe, the role privileges. Browsers other
than Chromium.
