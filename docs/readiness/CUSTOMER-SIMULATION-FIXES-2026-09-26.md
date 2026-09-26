# Customer simulation — fixes and retest

**Date:** 26 September 2026 (afternoon) · **Source register:** `CUSTOMER-SIMULATION-2026-09-26.md` (F-1 to F-20) and the external review of it · **Candidate:** local main, commits `9ae3d6f`, `c6517c5`, `9065510` on top of `3fb8a29` (nothing pushed, nothing deployed) · **Environment:** local dev server on `:3847` started through the guarded launcher (`.env.test` with override → Neon test branch `ep-hidden-salad`, `TESTING_MODE` on, mail unconfigured, no Blob token, Stripe test keys) · **Retest club:** a second fictional club, **Harbour Judo Club** (owner Jo Harbour), created through `/apply` → operator approval → operator reset → the typed club code → the nine-step wizard, then operated through the screens only.

---

## 1. What the review changed about the plan

The review's corrections were adopted: the pence export was not treated as a defect (discoverability was); no token-recovery endpoint was added and the invite link is a one-time, audited, owner/manager-only workflow rather than a general "copy any credential" control; the kiosk waiver copy points at the desk's own signing screen, not at a bypass; the original report's "no production system was touched" sentence was corrected (the Stripe OAuth return did reach the production callback and was refused) and its "none of these is large to fix" sizing was withdrawn. The register override policy was kept (staff may still admit over capacity or on hold) and made visible instead of silent.

One environment slip of my own is recorded in §6 because it affected the retest and would have mattered had it lasted: a dev-server restart done with a bare `next dev` loaded `.env` (production `AUTH_SECRET`, and production mail and Stripe keys) instead of `.env.test`. It ran for about six minutes against the test database; no member, email or Stripe action ran in that window; it was stopped and relaunched through the guarded launcher; a memory note now pins the rule.

## 2. Findings → status

| Finding | Fix | Retest on Harbour Judo Club | Status |
|---|---|---|---|
| F-6 portal "signed in!" on a refused check-in | One helper returns every refusal with a machine `reason` (`lib/checkin-refusal.ts`); every door (member sheet, kiosk, register) decides through `lib/checkin-outcome.ts`: success only for a committed record or the server's own already-checked-in answer, never by status code or sentence parsing | Ana at a class of 1 already taken: sheet read **"This class is full — 1 of 1 places are taken. Ask staff if there is room."** (server 409 `class_full`), no "signed in!"; Ben's second attempt read **"You're already signed in"** (409 `already_checked_in`) | **VERIFIED** |
| F-2 hyphenated club code refused | Login box keeps letters, digits and hyphens and unwraps a pasted login link (`lib/club-code.ts`); server slugs unchanged | Owner typed `harbour-judo-club` on `/login` → branded login → signed in with the temporary password | **VERIFIED** |
| F-5 members have no way in without email | Add member shows the create route's one-time invite link once; profile action "Show invite link" (owner/manager, same `first_time_signup` token, earlier unused invites voided, refused for children, no-email rows and members who already have a login, audited) | Ana: link shown after Add member → opened on a phone → "Set up your account" → password set → landed in the portal. Ben: link from the profile → same. A second link for Ana refused with **409 "Ana Link already has a login. They can use "Forgot password?"…"** (the first version of the guard checked the staff table; fixed and re-verified) | **VERIFIED** |
| F-3 owner never asked to set their own password after an operator reset | `User.mustChangePassword` (additive migration `20260926130000`); the operator reset sets it; the dashboard layout sends the person to `/set-password` until `POST /api/auth/set-password` clears it (10+ characters, no reuse of current or recent, audited, session kept) | Operator reset → owner signed in with the temporary password → landed on **"Choose your password — Jo Harbour, you signed in with a temporary password…"** → set → `/dashboard`; the old password then refused | **VERIFIED** |
| F-7 register prints a red Medical flag and raw `[]` | `lib/medical-notes.ts` reads every historical shape (free text, JSON list, empty list, null) at the register route boundary and in the panel and profile; the welcome wizard writes null for an empty list | Register rows for Ana and Ben carry no Medical flag and no `[]` | **VERIFIED** |
| F-8 register admits over capacity / on hold silently | Header shows `capacity N` and `(over)`; the check-in route returns `overCapacity`; the panel toasts **"Admitted over capacity — this class holds 1 and now has 2 checked in"**; ticking an on-hold member asks first ("Admit anyway"); staff override policy unchanged | Ana in from the portal (1 of 1), desk ticked Ben: toast above, header **"2 checked in of 2 expected · capacity 1 (over)"** | **VERIFIED** (on-hold confirm: unit of the panel only, no on-hold member on the retest club — NOT RUN) |
| F-10 expired session on Add member says nothing | `lib/save-failure.ts`: the dialog shows an alert and keeps the input | Cookies cleared before Save → **"Your session has expired. Open MatFlow in a new tab and sign in, then press Add Member again — what you typed is kept here."**, name kept | **VERIFIED** |
| F-11 dropped request on Record payment says nothing | Same helper, with the idempotent wording because the route dedupes on the requestId the drawer holds across retries | Request aborted → **"Couldn't reach MatFlow, so we don't know whether it went through. Press Record payment again — the same one is never recorded twice."** → retry → one £45 row | **VERIFIED** |
| F-17 "Invalid data" for a 300-character name | The dialog shows the field-level sentence from the route | **"Invalid data — name: Too big: expected string to have <=100 characters"** (the server's own text; readable, though it could say "Name must be 100 characters or fewer") | **VERIFIED** (copy could be friendlier) |
| F-9 coach/manager silently bounced | `requireRole` redirects to `/dashboard?denied=1`; the dashboard shows a notice naming the roles | Coach opened Settings → dashboard with **"That page isn't open to coaches. Settings and Memberships are for the owner; Payments and Reports are for the owner and managers…"** | **VERIFIED** |
| F-4 staff "leave blank to auto-generate" | Field relabelled **"Temporary password (8+ characters) — tell them in person; they can change it after signing in"**; role options now describe the real gates (Manager — everything except Settings and Memberships; Coach — register, members and attendance; Admin — front desk: register and members) | Dialog read as above; coach added and signed in | **VERIFIED** (copy) |
| F-1 apply confirmation alarms the applicant | Saved-but-not-notified keeps `ok: false` (nobody was told) but reads as a next step; the page shows the confirmation with that sentence under it | Unit-pinned (existing apply test suite green); the retest club's application followed this path locally (mail unconfigured) — the confirmation screen was produced by the harness's apply cell before this change and was not re-captured | **FIXED, unit-verified; screen not re-captured** |
| F-13 duration and per-day times disagree | A new schedule day ends at start + duration; the per-day editor defaults to duration mode so the end moves with the start | New day for a 45-minute class defaulted to 18:00–18:45; a class typed to start now read 13:14–13:59 | **VERIFIED** |
| F-14 wizard restarts on refresh | Step kept in `sessionStorage` for the tab | Not re-exercised (the retest club's wizard ran forward only) | **FIXED, NOT RETESTED** |
| F-16 plan-less child badged "Paid" | Header pill reads **"No plan"** when there is no membership | Kit Link (child, no plan): "Active · No plan · Waiver missing" | **VERIFIED** |
| F-18 payments export hidden | "Export CSV" beside "Record payment" on the Payments hub | Present | **VERIFIED** |
| F-19 operator reset modal label | "Reason for resetting this owner's password"; result text says the owner will be asked to choose their own password; tenant page shows the club's login link and code | Seen in the operator console | **VERIFIED** |
| F-12 kiosk waiver remedy email-only | Copy adds "Or ask staff at the desk — they can open the waiver on the desk screen for you to sign now" (the existing supervised signing, not a bypass) | Not re-run at a kiosk (no kiosk URL minted on the retest club) | **FIXED, NOT RETESTED** |
| F-20 child-waiver refusal copy | "Sign it in your profile (for a child, from Family) or ask your gym." | Unit-pinned in the refusal helper | **FIXED** |
| F-15 device links shown once | Not changed: tokens are stored hash-only, so re-showing them would mean weakening storage; a pairing/rotation workflow is deferred | — | **OUTSTANDING (by design, deferred)** |

New during the retest: the member's inline waiver form refuses **"Emergency contact name, phone, and relation are required before signing."** while offering no fields for them (the desk page has them). Honest, but a dead end on the phone for a member who skipped the welcome wizard. Recorded as **F-21 (medium), outstanding**.

## 3. Gates on the final tree

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npm run lint` | eslint clean; UI-RULES ratchet at or below baseline (the one new raw button was moved onto the Button primitive; no new hex) |
| `npx vitest run` | final tree: 253 files passed, 0 failed (2286 tests; 27 files skip without the DB). One run in between caught the new set-password form's inputs without accessible names — fixed with aria-labels before this line was written |
| `npm run build` | compiled, 164 static pages |
| New unit pins | `checkin-outcome` (11), `customer-sim-fixes` (13), `set-password-route` (4) |
| Migration | `20260926130000_user_must_change_password` applied to the test branch (additive, constant default); RLS unaffected (no new table) |
| E2E lanes (touched surfaces) | Eleven assess lanes re-run one file at a time on the test branch, all green warm: la-1 login/club-code 26, lb-2 staff+nav 30, lc-1 members 27, lc-2 families 16, ld-2 attendance/register/kiosk 26, le-1 cash/tiers 44, lf-1 portal 35, lg-1 operator 33, lh-1 holds 10, lh-3 door 5, a0-1 apply→wizard 24. Six failures on the first (cold-server) pass were all setup/teardown hook timeouts (cleared warm) plus two stale families expectations from the earlier child-move policy (fixed: 55aa063, 4eb3026) and lb-2's five-login hook budget (e0aa0a6). No product cell failed; no server death |

## 4. Coverage summary (unique requirements, not ledger rows)

Verified on the second club: F-2, F-3, F-4, F-5, F-6, F-7, F-8, F-9, F-10, F-11, F-13, F-16, F-17, F-18, F-19. Fixed and unit-pinned but not re-driven on a screen: F-1, F-12, F-14, F-20. Outstanding: F-15 (deferred by design), F-21 (new). The retest ledger (`docs/readiness/evidence/customer-simulation-retest-2026-09-26-ledger.md`, 80 unique cells, harness failures superseded by later parts) and 99 screenshots (`.omc/sheets/customer-simulation-retest-2026-09-26/`, Desktop copy `MatFlow-Customer-Simulation-Retest-2026-09-26-screens/`) carry the words seen.

## 5. Still blocked or untested, with the dependency

| Item | Dependency / reason |
|---|---|
| Emailed activation, invites, waiver links, forgot password | outbound mail on production (sender verification); locally none leaves. The screen fallbacks above do not replace it |
| Stripe Connect and card journeys as customer journeys | the platform's OAuth redirect points at production; a local server cannot receive the callback; webhook delivery needs a public URL. Developer-run evidence stands as before |
| CSV import upload → preview → commit | `BLOB_READ_WRITE_TOKEN`; the screen says "File uploads not configured" |
| 2FA challenge at sign-in, throttle, lockout | `TESTING_MODE` skips them on localhost; a production-build run with it off was not done in this session |
| Overdue / renewal / hold auto-resume | time or a controlled clock; not attempted |
| On-hold override confirmation on the register | no on-hold member on the retest club; the dialog is code-reviewed only |
| Kiosk journeys on the retest club | no kiosk URL minted on Harbour Judo Club |

## 6. Verdicts

- **Unaided setup (new club, no developer):** still **NO**, for one reason now instead of four: activation, member invites and staff onboarding depend on email that does not deliver. With mail delivering, the club code, the owner's own password, the invite fallback at the desk and honest check-ins are in place.
- **Assisted setup (operator approves, resets, hands over the temporary password and the login link; desk hands members their invite link):** **YES** on the local candidate, proven on a second club from `/apply` to a member's first login and first refusal.
- **Daily operations (desk, register, kiosk, portal check-in, cash, holds, cancellations, waivers, exports):** **YES with the limitations in §5**; the silent failures found in the morning are now sentences.
- **Financial and provider journeys (cards, Stripe Connect, webhooks):** **BLOCKED locally**, unchanged.
- **Security:** no bypass added; the invite link is owner/manager-only, single-use, expiring, audited, refused for existing logins; the forced password change keeps the session the reset already re-issued; the environment slip in §1 is recorded and pinned as a rule.
- **Production release readiness:** **NOT READY** — nothing pushed; production still runs `90868eb`; mail sender verification, `CRON_SECRET` and a production-build run with `TESTING_MODE` off remain Noe's gates.

All currently unblocked work completed: **YES** for the F-1…F-20 register (F-15 deferred by design, F-21 new and open). Unpushed: 4 commits on top of `3fb8a29`, plus this report. Not deployed. Ten-club capacity and Sean's migration remain separate gates, untouched by this work.
