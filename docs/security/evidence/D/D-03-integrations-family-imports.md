# D-03 Imports, family links and integrations (SEC-054, 055, 056, 089–096)

Lane D, 9 Oct 2026. Same branch/HEAD as D-01. No network calls were made to Stripe, Resend, Vercel or Anthropic.

## SEC-054 Import overwrites security state: PASS (unit + existing DB)
The refresh writes exactly `status, paymentStatus, cancelledAt, membershipType, membershipTierId` plus provenance
(`refreshWrite`). It never writes the email, password, factors, sessionVersion, externalRef, guardian columns, tenant or accountType.
It matches only on `externalRef`, so a corrected email does not change matching. DSAR erase nulls `externalRef`, so an erased record is never refreshed
(it is reported "not in MatFlow"). A MatFlow hold (`paused`) is kept. A file older than the recorded standing is refused. The
members import only creates rows (`skipDuplicates` + pre-check by address). Its one member write is the refresh's.
The attendance import writes no member columns. `tests/unit/sec-d-import-security-state.test.ts` has 7 cells (the static scan asserts
it found the real write, so it is not vacuous). Existing DB proofs: `contact-email-change-imports-db` (owner + restricted, exit 0)
and lane B's `sec-b-sean-imported-cancelled-db`.
Observation, not a security defect: a refresh moves `status` cancelled→active when TeamUp says active. Member status
does not gate sign-in (auth.ts refuses on TENANT status only), so this is standing, not access.

## SEC-055 Concurrent / replayed / interrupted imports: PASS (DB, two connections, both roles)
Attendance: `sec-d-attendance-misbinding-db` SEC-055 cell. Two `commit` calls at once give exactly one 202. Two `step` calls at
once give one working, one busy (lease). Replayed commit gives 409. Replayed step returns done. A second job over the same file leaves
bookings/attendance unchanged (60/60). Interrupted: the existing `attendance-import-engine` fault injection inside a batch
transaction (owner + restricted, exit 0). Members import: claim by conditional `updateMany` plus a rival re-check (code
review; covered by existing unit tests `import-commit-integrity`).

## SEC-056 Family / guardian confusion: PASS (code review + existing tests); two observations
Imports never grant guardianship. A kid resolved to a parent by a shared address, or a draft from an emergency contact, is
written `guardianConfirmedAt: null`. Every parent-acts-for-child read spreads `CONFIRMED_GUARDIAN` (`lib/guardianship.ts`),
including `blob-image`. The attendance import never creates or reads links. The refresh never writes them.
Unlink/promote are per-request DB state, and no JWT caches children (`auth.ts` has no child claims), so revocation is immediate.
Tests run: family-authority, family-authority-routes, guardian-confirm-route, import-teamup-refresh,
import-commit-integrity (with the webhook suites: 7 files, 120 tests, green).
Observations (members/DSAR routes are not lane D files): (O1) `promote-to-adult` nulls `parentMemberId` but leaves
`guardianConfirmedAt` set. No current writer re-links without setting the confirmation, so this is inert. Proposal: null both.
(O2) The DSAR-erase and member-delete "reassign children" paths move `parentMemberId` and keep the old confirmation state. This is an
explicit staff/operator choice of new parent, but the audit does not mark the new link as confirmed by that actor.

## SEC-089 Forged / replayed webhooks: PASS (unit, REAL stripe library)
`app/api/stripe/webhook`: raw body (`req.text()`), `stripe.webhooks.constructEvent` (default tolerance 300 s), 400
without a secret, tenant from the signed `event.account` (an unknown account throws a retryable error, so no write), idempotency
via a unique `StripeEvent.eventId` inside the same transaction. `tests/unit/sec-d-stripe-webhook-signature.test.ts` has 9 cells:
positive control, no signature, wrong secret, stale timestamp (−600 s), re-serialised body, tampered `account`, replay,
unhandled type, no secret. **Mutant** (constructEvent replaced by `JSON.parse`) failed 4 cells. It was reverted, and `git diff` is empty.
Resend (`app/api/webhooks/resend`, svix): 401 on a bad signature, 503 in production without a secret. Existing
`resend-webhook.test.ts` is green. Residual: it accepts unsigned events when `NODE_ENV !== "production"` and no secret is set (local
only). Production `RESEND_WEBHOOK_SECRET` is unset per lane E, so the endpoint is 503 there.

## SEC-090 Payment / entitlement manipulation: code review PASS; Stripe test-mode run NOT RUN
Member self-subscribe validates `priceId` against the club's active `MembershipTier`. The staff route (owner/manager) uses
prices from the club's own connected account. Class-pack/shop entitlements are minted only from signed webhooks, with
`metadata.tenantId` cross-checked against the account's tenant (existing C2 tests). Amounts come from server-side prices
(`serverPrice`, owner-created packs/plans). NOT RUN: an end-to-end Stripe test-mode run needs a test-mode connected account.
`.env.test` holds an `sk_test_` key (prefix checked only), but no connected test account was available to this lane.
Evidence needed: Checkout with a tampered price/pack id in test mode, then an assertion of no entitlement.

## SEC-091 Mail delivery holds: PASS (process-level, real sendEmail + real Resend SDK + interceptor :4604); one finding
`tests/unit/sec-d-mail-holds.test.ts`: positive control first (EMAIL_DELIVERY=on, dummy key, `RESEND_BASE_URL` set to the
interceptor: count +1, EmailLog `sent`). Then each hold leaves the count unchanged: `off`, misconfigured value (`false`),
provisional recipient, recipient lookup failure (fails closed), recent bounce, no key. There is no queue re-sender (`queued` is
only in-flight in `sendEmail`). Inventory: `lib/email.ts` is the only Resend transport in app/lib/components/auth.
**SEC-D-F3 (Low, OPEN, not a lane D file):** `scripts/test-resend.mjs` reads the repo `.env` (production keys) and sends
through Resend directly, ignoring `EMAIL_DELIVERY`. It is operator-run, never deployed. It is the same class as lane B's SEC-B-F1. Fix: delete it,
or make it refuse unless `EMAIL_DELIVERY=on` and the recipient is `delivered@resend.dev`. It is pinned in the inventory test, so the list can only shrink.

## SEC-092 Service identity scoping (code review; account-side UNKNOWN)
- Stripe: one platform `sk_` secret, used per club with the `stripeAccount` header. Its compromise reaches every connected
  Standard account via Connect. Proposal: a restricted key (`rk_`) limited to subscriptions, invoices, checkout, billing
  portal, accounts read, payment methods read. The key type in Vercel is UNKNOWN (names only).
- Resend: `RESEND_API_KEY`. Whether it is "sending access" for `send.matflow.studio` only is UNKNOWN (dashboard).
- Blob: `BLOB_READ_WRITE_TOKEN` is store-wide read/write across all tenants. Tenant isolation is by path prefix in code only
  (`blob-image`). It is stored Non-sensitive in Vercel (lane E). Proposal: mark it Sensitive. A per-tenant store is not available.
- Webhook secrets are separate per provider. `CRON_SECRET` and `ANTHROPIC_API_KEY` are unset (cron/AI inert).

## SEC-093 AI features: APPLICABLE (present, inactive). Code review PASS, residual Low
`lib/ai-causal-report.ts` (Anthropic Messages API, no tools) via `app/api/reports/generate` (owner/manager, 5/hour/club)
and `app/api/cron/monthly-reports` (CRON_SECRET, unset → 503). Inactive while `ANTHROPIC_API_KEY` is unset. The prompt holds the club's
own counts, initiative notes and indexed Drive excerpts (800 chars each, max 20). All of these are tenant-scoped and visible to the requester already.
Output is stored and rendered as React text (`MonthlyReportView.tsx`, no HTML). Residual: indirect prompt injection via
initiative/Drive text can make a report misleading (integrity only). There are no tools, actions or cross-tenant data to exfiltrate.
`max_tokens` is bounded. Not tested live (no key, and no third-party calls in this campaign).

## SEC-094 / 095 / 096 (manual / tabletop; NOT RUN, evidence required)
- 094 Developer endpoint: lane E E-F1 (local Node 25 EOL), and the repo `.env` holds production keys used by scripts
  (`test-resend.mjs`, B's SEC-B-F1). Evidence needed: disk encryption, OS/Node patch level, credential storage, 2FA on
  GitHub/Vercel/Neon/Stripe/Resend (lane E: UNKNOWN), and a removal plan for prod keys in the working tree.
- 095 Social engineering / recovery fraud: tabletop scripts are needed for "owner lost phone", "caller claims to be Sean",
  "member asks to change a child's guardian", "email change to a new address". Each needs the out-of-band verification step and
  the audit row that proves it. Evidence: a written runbook plus a dry run with Noe, without real credentials.
- 096 Physical / provider / unknown: provider outage or account suspension (Vercel, Neon, Stripe, Resend), lost devices,
  a single human holding every privileged role (ASSET-INVENTORY). Evidence: provider status/contacts list, break-glass
  access record, a second trusted holder decision (Noe's), restore drill (lane F).
