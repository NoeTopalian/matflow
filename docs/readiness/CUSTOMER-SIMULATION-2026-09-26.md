# Customer simulation — a new club signs up to MatFlow and runs a day

**Date:** 26 September 2026 · **Tree under test:** local main at `de1948a` plus the uncommitted working tree (38 local commits ahead of production `90868eb`, nothing pushed) · **Environment:** local dev server on `:3847`, Neon **test** branch `ep-hidden-salad`, `TESTING_MODE` on, mail unconfigured, no Blob token, Stripe test keys · **Method:** a real Chromium browser driven through the product's own screens only; every step has the words the customer saw and a screenshot.

---

## Could a new club set itself up and operate MatFlow today without developer assistance?

**NO.**

A new club cannot get from "approved" to "running" on its own. Three things stop it before the first class, independent of the environment:

1. **The owner never receives a way in.** Activation is an email magic link and nothing else. There is no in-app way for the owner to set a password. Locally no mail leaves; on production the sender domain is not verified, so the same link is not deliverable either. The only continuation was the operator console's "Reset password", which shows a temporary password once and never asks the owner to change it.
2. **The club's own login code does not work.** Approval mints the slug `riverbank-grappling`. The login page's club-code box strips the hyphen and answers "Club not found". The only working door is the `/login?club=riverbank-grappling` link, which nobody tells the owner about.
3. **Members have no way in without email.** Adding a member queues an invite email and shows no link, code or password on screen. Magic link and forgot-password are also email. With mail not delivering, no member, parent or child can reach the portal. (Member journeys below were continued with a labelled developer diagnostic: passwords set by script.)

And one thing that would embarrass the club on its first busy evening:

4. **The member portal says "signed in!" when the server refused.** A parent checking a child into a full class saw "Ravi Patel signed in!" while the server answered `409 This class is full — 3 of 2 places are taken`. No attendance was recorded. The portal treats every 409 as success, so full-class and outside-window refusals never reach the member.

With 1–3 fixed (delivering mail plus an on-screen fallback link, and the hyphen bug), the answer becomes **ONLY WITH THESE LIMITATIONS:**

- card payments need the owner to complete Stripe's own onboarding (a Stripe sign-in), which MatFlow cannot shortcut;
- CSV import needs the platform's file storage to be configured (a platform setting, not the club's);
- staff added with "leave blank to auto-generate" a password cannot sign in because the password is never shown and the invite is mail;
- a kiosk tablet cannot get an unsigned member past the waiver without email — the only remedy offered is "Send waiver link";
- the club-facing copy has several places where it is silent or wrong when things go wrong (details below).

---

## 1. What was configured and operated

One fictional club, driven entirely through the product's screens in separate browser sessions per role.

| Area | What was done (all through the UI) |
|---|---|
| **Signup** | `/apply` as "Riverbank Grappling" (owner Sam Rivers). Operator signed in at `/admin/login` (Bootstrap secret mode), approved the application. Owner activation mail: none arrives. Operator → tenant → Danger Zone → "Reset password" → temporary password. Owner logged in via `/login?club=riverbank-grappling`. |
| **Onboarding wizard** | All 9 steps completed (identity, branding, classes quick-add, tiers, kiosk, 2FA deferred, import skipped). |
| **Club** | Branding preset "Clean White"; timezone; check-in window; waiver text; a second location (inline form); kiosk URL and leaderboard URL minted; one announcement posted. |
| **Staff** | Manager (Maya Chen) and Coach (Mike Okoro) with owner-typed passwords. Admin/desk (Dee Desk) with "leave blank to auto-generate" → refused "Invalid data". |
| **Memberships** | Adult Monthly £45 (monthly), Adult 4-weekly £55 (every 4 weeks), Kids 4-weekly £30 (kids), Annual £400 (annual). Cycle options offered: Weekly, Fortnightly, Every 4 weeks, Monthly, Annual, One-off. |
| **Classes** | Beginner BJJ (Mon 18:00–19:00, coach), No-Gi, Saturday Open Mat with capacity 2 starting "now" for the check-in journeys. |
| **People** | Adults: Alex Paid, Beth Overdue, Carl Cancelled (cancelled at the desk), Dana Hold (on hold until 10 Oct 2026), Evan Unsigned. Parent Priya Patel with two children (Ravi 9, Sana 12) via the Family card. Two more adults from the transition tests (Back Test, Dupe Test). |
| **Money** | Cash £45 recorded for Alex (owner), cash £55 for Beth (manager, double-click test), cash £12 for Alex (dropped-request retry test). Stripe Connect attempted. |
| **Waivers** | Alex signed inline in the portal; Evan signed at the desk ("Open waiver on this device"); Dana signed at the desk while on hold; Priya signed inline; Ravi signed by his parent from the portal; Beth and Sana left unsigned on purpose. |
| **Check-ins** | Alex from the portal ("Confirm Sign In"); Evan at the kiosk; Dana ticked by the coach on the register; Ravi and Sana attempted by the parent; Dana, Beth, Carl, Priya at the kiosk. |
| **Comms** | Announcement read by a member on the portal home. Email queue read as a diagnostic. |
| **Exports** | Reports CSV; Payments CSV (found under Settings › Revenue). |
| **Import** | Settings › Integrations › Member CSV import: upload → "File uploads not configured". |
| **Security** | Owner 2FA enrolled from the on-screen manual key; recovery codes available; a fresh login afterwards. |
| **Substantial data** | The seeded club `totalbjj` (198 members) opened read-only as a second owner, for isolation and layout. |

Rows left on the test branch for inspection: tenant `cmui2twqv01nt1otg8ceab2cz` (`riverbank-grappling`): 10 members, 3 users, 3 attendance records, 3 payments. Three earlier "Riverbank Grappling" applications (failed first attempts) remain pending in the operator console.

---

## 2. Feature-by-feature results

Result vocabulary: **PASS** (worked as a customer would expect, with the words seen) · **FAIL** (broke, misled or went silent) · **BLOCKED** (could not be tested here; the dependency is named) · **NOT AVAILABLE** (no control exists on the screens) · **NOT TESTED** (in scope but not exercised; reason given). Screenshots are in the evidence folder named in §9.

### 2a. Signup, entry and onboarding

| Feature | Result | Evidence |
|---|---|---|
| Apply form (7 fields), phone width, submit | PASS | `S1-*`: 0 px overflow at 375; "Application received" confirmation |
| Apply confirmation copy | FAIL | Red banner: "We've recorded your application, but our notification system didn't respond — please email hello@matflow.studio". The customer's very first screen is an apology for the mail system. |
| Operator: sign in (Bootstrap secret), review, approve | PASS | "Approve this application?" → tenants list → tenant detail. Note: 5 wrong attempts locked the operator out for 15 minutes (rate limit) — correct, and it slowed the run. |
| Owner activation link | BLOCKED | dependency: outbound email. `EmailLog` shows the row `failed: RESEND_API_KEY not configured` (diagnostic read). No in-app alternative exists. |
| Operator "Reset password" (Danger Zone) | PASS with concern | Shows a temporary password once. The modal's reason box is labelled "Reason for impersonating this tenant" — wrong label for a password reset. The owner is never prompted to set their own password afterwards. |
| Owner login by club code | FAIL | Typed code `riverbank-grappling` → "Club not found" (the box strips non-alphanumerics; approval mints hyphenated slugs). `/login?club=riverbank-grappling` works. |
| Login page keyboard order and focus rings | PASS with polish | Tab order sensible, `:focus-visible` on every control; one unlabelled button (show/hide password) in the order. |
| Onboarding wizard, 9 steps | PASS | Every step completed; "Save N class →" saves quick-added classes. |
| Wizard progress after a refresh | FAIL | Restarts at step 1; nothing resumes. |
| Wizard step 4 quick-add chips | FAIL (minor) | Chips disappear after the first pick; cannot add a second preset class the same way. |
| Announcement modal on first portal paint | polish | The member's first screen is a dialog before content. |
| Two-factor "recommended" banner | polish | Persists on every staff screen; after enrolment it stays until the next sign-in. |

### 2b. Club setup

| Feature | Result | Evidence |
|---|---|---|
| Nav discovery (desktop 14 items; phone Home/Schedule/Register/Members/More) | PASS | `D2-*` |
| Settings tabs (Overview, Branding, Revenue, Store, Staff, Account, Waiver, Integrations) | PASS | `D3-*`; every dialog opens and Escape closes |
| Branding preset + phone preview | PASS | "Clean White" applied; login and portal recoloured |
| Timezone, check-in window, waiver text | PASS | toasts "Time zone saved" etc. |
| Second location | PASS | inline form on Overview |
| Add staff with a typed password (manager, coach) | PASS | both later signed in |
| Add staff with "leave blank to auto-generate" | FAIL | "Invalid data" — the server requires a password of 8+ characters; the placeholder promises otherwise. Even when typed, a generated password is never shown and the invite is mail. |
| Membership tiers (4, mixed cycles, kids switch) | PASS | table shows price, cycle in words, active-member count |
| Classes with schedule, coach, capacity | PASS with concern | Add class shows both a Duration field and per-day start/end times; the Open Mat came out 09:58–19:00 from a 60-minute duration. |
| Kiosk URL, leaderboard URL | PASS with concern | Each URL is shown once; afterwards only "Regenerate URL" (which invalidates the tablet/TV). |
| Promotions | NOT AVAILABLE | no add control on the Promotions screen |
| Google Drive integration | NOT TESTED | needs Google OAuth |

### 2c. People

| Feature | Result | Evidence |
|---|---|---|
| Add member (6 adults) | PASS | toast "<name> added"; Membership select loads after ~0.9 s skeleton |
| Assign a tier from profile › Edit › Membership Type | PASS | survives reload |
| Parent with two children via the Family card | PASS | `A7f-family-card.png`; Ravi and Sana listed once each |
| New child with no tier badged "Paid" | FAIL (honesty) | a child with no plan and no payment is shown as Paid |
| Hold with a date; resume | PASS | "On hold until 10 Oct 2026"; profile pill "Paused" |
| Cancel at the desk | PASS | status Cancelled |
| Member invites | BLOCKED | dependency: email. Every `invite_member` row failed (diagnostic). No on-screen link, code or password. |
| Member login | BLOCKED → continued by diagnostic | passwords set by script for Alex and Priya (developer step, reported in §7) |
| Member welcome wizard | PASS with concern | "I train here / I'm here to manage my child / Skip". The children step does not show the desk-linked children; "My Family" only appears if the parent picks "manage my child". |
| Add member: refresh mid-form | PASS (expected loss) | draft lost silently on reload |
| Add member: browser Back after save | PASS | no resubmit; one row |
| Add member: double click | PASS | one row ("Dupe Test") |
| Add member: 300-character name | FAIL (copy) | "Invalid data" — no field or limit named; input kept |
| Add member: bad email | PASS | browser's own "Please include an '@'…" |
| Add member: duplicate email | PASS | "A member with that email already exists" |
| Add member after the session expired | FAIL | Save does nothing: dialog stays open, no toast, no redirect, no words (`T6-expired.png`). Nothing saved. |

### 2d. Waivers

| Feature | Result | Evidence |
|---|---|---|
| Member signs inline (checkbox, typed name, drawn signature) | PASS | owner side "Waiver signed" (Alex, Priya) |
| Desk "Open waiver on this device" (emergency contact required) | PASS | Evan; Dana while on hold |
| Parent signs for a child from the portal | PASS | Ravi: "WAIVER Signed" |
| Kiosk meets an unsigned member | FAIL (journey) | "Waiver required — Beth hasn't signed the gym waiver yet. We'll send a link to their email address… Send waiver link / Cancel". The only remedy is email; no "sign here" or "ask staff" path on the tablet. |
| Child check-in with an unsigned child (Sana) | PASS (honest) with copy note | server 403 "A signed waiver is needed before checking in. Sign it in your profile or ask your gym." shown on the sheet. For a child the parent signs from the Family section, not "your profile". |

### 2e. The door: check-in, kiosk, register

| Feature | Result | Evidence |
|---|---|---|
| Member self check-in (sheet → class → Confirm Sign In) | PASS with concern | Alex recorded (register "Self"). The confirm spinner ran for more than 3 s with no words on this dev server. |
| **Portal claims success on a refused check-in** | **FAIL (critical)** | Ravi → "Ravi Patel signed in! Saturday Open Mat" while the wire said `409 This class is full — 3 of 2 places are taken. Ask staff if there is room.` No record. Mechanism: the sheet treats any 409 as success (full class, outside window, already checked in). `R1-ravi-after.png` |
| Kiosk: signed member checks in | PASS | "✓ Welcome, Evan!" |
| Kiosk: member on hold | PASS | "Couldn't check you in — Your membership is on hold until 10 Oct 2026 — ask staff to resume it early. Try again" (403 on_hold). The refusal clears itself after a few seconds. |
| Kiosk: cancelled member | polish | not listed at all; the screen shows "No match yet — keep typing" |
| Kiosk: parent taps their own name | observation | "Who's training today?" lists only the children (Ravi, Sana) — the parent herself is not offered |
| Kiosk: full class | NOT TESTED | no eligible signed, uncheck-in member remained; the portal's full-class refusal was captured instead |
| Staff register: tick a name | PASS with concern | Coach ticked Dana (on hold) into a class already at 2 of 2: admitted, no warning, no override wording. Register then reads "3 checked in of 3 expected" — capacity 2 is neither shown nor enforced on the register. |
| **Register row shows a raw `[]`** | **FAIL** | Alex's row: red "Medical" flag and "⚠ []" while his profile says "Medical notes: None recorded". A false alarm plus a leaked empty JSON array. `M5-register.png` |
| Register "Last seen Never" on a member checked in today | polish | Alex's row after his check-in |
| Attendance page, Reports, home after check-ins | PASS | 3 records listed with method (Self, Kiosk, Admin · by Coach Mike Okoro) |
| Leaderboard public page | PASS | "1 Alex P. · 2 Dana H. · 3 Evan U. · Movement arrows start next month"; bad token → 404 |
| Club short URL `/riverbank-grappling` | PASS | redirects to the branded login |

### 2f. Money

| Feature | Result | Evidence |
|---|---|---|
| Record cash at the desk (owner) | PASS | profile Payments tab + hub "All payments" |
| Manager records cash; button pressed twice | PASS | one £55 payment ("Payment recorded") |
| Record payment when the request is dropped | FAIL (silence) | dialog stays open, input kept, **no message at all**; the retry records exactly one payment (`T5-timeout.png`) |
| Member billing page (cash club) | PASS with concern | "Your gym manages billing… ask at Riverbank Grappling's front desk"; payment history £45.00 · Cash. The page is reachable by URL only — not in the bottom nav. |
| Payments export | PASS with concern | Found under Settings › Revenue (the hub's "View payments" link), not on the Payments screen. Header says "Amount (pence)" and rows carry 5500 for £55. |
| Reports export | PASS | `matflow-reports-2026-09-26.csv`, 33 lines, Section/Metric/Value/Detail |
| Stripe Connect | BLOCKED | The "Before connecting Stripe" terms dialog → Stripe's OAuth page. On the local server the OAuth return went to `https://matflow.studio/api/stripe/connect/callback` (the platform's registered redirect), which answered `{"ok":false,"error":"Unauthorized"}`; nothing was connected anywhere. On production a Stripe sign-in is required. |
| Card subscription, class pack, refund, failed renewal | BLOCKED | dependency: a connected account plus webhook delivery to a public URL. Developer-run evidence exists (§7). |
| Overdue / chase | NOT TESTED | needs a due date to pass |

### 2g. Staff roles

| Feature | Result | Evidence |
|---|---|---|
| Manager login and nav | PASS | Dashboard, Timetable, Mark Attendance, Members, Attendance, Ranks, Promotions, Notifications, Reports, Conversion, Payments |
| Manager vs the role promise "all access except billing" | FAIL (wording) | Manager reaches Payments and records payments; Settings and Memberships redirect silently to the dashboard |
| Coach login, register | PASS | Dashboard, Timetable, Mark Attendance, Members, Attendance, Ranks |
| Coach at Settings / Memberships / Payments / Reports | FAIL (silence) | every one silently redirects to the dashboard; no "you don't have access" wording |
| Ownership, last-owner guard | NOT TESTED | |

### 2h. Communications

| Feature | Result | Evidence |
|---|---|---|
| Post an announcement | PASS | Notifications page lists it "Posted" |
| Member reads it | PASS | on `/member/home` under "Announcements" (and as a dialog on first paint) |
| Any email (activation, invites, waiver link, staff) | BLOCKED | dependency: outbound email. The Notifications page gives no sign that mail is not delivering. |

### 2i. Import, integrations, security

| Feature | Result | Evidence |
|---|---|---|
| Member CSV import | BLOCKED (honest) | Settings › Integrations › "Upload + preview" → toast and inline "File uploads not configured" (503). Dependency: `BLOB_READ_WRITE_TOKEN`. Mapping/preview/commit NOT TESTED locally. |
| Owner 2FA enrolment | PASS | QR + "Manual key" → "I've scanned it" → 6-digit code → "Verify & Enable" → Account tab "Authenticator App · Enabled · 8 single-use codes". Whether the codes were displayed once at enrolment was not captured. |
| 2FA challenge at login | NOT TESTED | `TESTING_MODE` skips the challenge on localhost: a fresh email+password login went straight to the dashboard. Not a product verdict either way. |
| Login throttle / lockout | NOT TESTED | skipped by `TESTING_MODE` |
| Cross-club isolation | PASS | the seeded club's owner opening Riverbank member URLs got a plain 404 every time; no name leaked |
| Injected server failures | PASS | Members: "Couldn't check who's ready to move to an adult account — tap to retry · Try again"; Reports: error state; member Schedule: "Couldn't load your timetable — tap to retry" |

### 2j. Layout and accessibility

| Check | Result | Evidence |
|---|---|---|
| Horizontal overflow on 9 staff screens at 375 / 915 / 1440 | PASS | 0 px on every screen |
| Targets under 44 px at 375 | polish | Payments 4/4, Memberships 8/9, Reports 3/7 (table headers, sort controls); "Set member's picture" under 24 px on the profile |
| Add member dialog keyboard trap and Escape | PASS | 12 Tabs stay inside; Escape closes |
| Club name on every staff screen | PASS | |
| Seeded club (198 members) page loads on the dev server | observation | Members 4.7 s, Reports 9.0 s, Timetable 3.0 s, Register 4.8 s — Turbopack dev numbers, not production |

---

## 3. Broken or confusing journeys — reproduction steps

**F-1 · Apply confirmation apologises for the mail system (significant).** `/apply` → submit → red banner "our notification system didn't respond — please email hello@matflow.studio". Cause: no mail sender configured. The customer's first impression is a failure notice.

**F-2 · Club code with a hyphen cannot be typed (critical).** Approve any application whose name has two words → slug `two-words` → `/login` → type `two-words` → "Club not found". The box strips the hyphen. Fix at the source: mint alphanumeric codes, or accept hyphens in the box.

**F-3 · Owner activation is email-only (critical for unassisted setup).** Approve → no mail → the owner has nothing. Operator "Reset password" is the only path and never asks the owner to choose their own password.

**F-4 · Staff "leave blank to auto-generate" is refused (significant).** Settings › Staff › Add → leave password blank → "Invalid data". With a typed password the person can sign in only if told it out of band; nothing is shown on screen.

**F-5 · Members cannot reach the portal without email (critical).** Add a member → the invite queues (and fails locally) → no link/code shown → `/login` offers only password, magic link, forgot password — all need mail.

**F-6 · "Signed in!" on a refused check-in (critical).** Portal → Sign In to Class → pick a child → pick a class that is full → Confirm Sign In → "Ravi Patel signed in!" No record; the server said full. Same masking for "outside the check-in window" and "already checked in".

**F-7 · Register shows a raw `[]` and a false Medical flag (significant).** A member completes the welcome wizard without medical conditions → Mark Attendance → their row shows red "Medical" and "⚠ []".

**F-8 · Capacity is silent on the staff register (significant).** Class capacity 2 with 2 checked in → tick a third (on hold, even) → admitted with no warning; header reads "3 checked in of 3 expected".

**F-9 · Silent refusals for staff roles (significant).** Coach opens Settings/Memberships/Payments/Reports → bounced to the dashboard with no words. Manager: same for Settings and Memberships, while Payments is allowed despite "all access except billing".

**F-10 · Expired session on Save says nothing (significant).** Open Add member → session expires → Save → nothing happens, no message.

**F-11 · Dropped request on Record payment says nothing (significant).** Same pattern: the dialog stays open with the input, no words; the customer cannot tell whether money was recorded.

**F-12 · Kiosk waiver remedy is email-only (significant).** Kiosk → unsigned member → "Send waiver link" is the only button.

**F-13 · Add class: Duration and per-day times disagree (medium).** Add class → Duration 60 → per-day end time left at 19:00 → class saved 09:58–19:00.

**F-14 · Wizard restarts on refresh (medium).** Any step → F5 → step 1.

**F-15 · Kiosk/leaderboard URLs shown once (medium).** After closing the dialog the only control is Regenerate, which breaks the paired tablet/TV.

**F-16 · New child badged "Paid" with no plan (medium, honesty).**

**F-17 · "Invalid data" for an over-long name (polish).** No field or limit named.

**F-18 · Payments export hidden and in pence (polish).** Export lives under Settings › Revenue; "Amount (pence)".

**F-19 · Operator reset-password modal labelled "Reason for impersonating this tenant" (polish).** Also "Account / Bootstrap" login tabs mean nothing to a first-time operator.

**F-20 · Copy for a child's waiver refusal (polish).** "Sign it in your profile" — the parent signs from Family.

---

## 4. Blocked tests and their exact missing dependency

| Test | Dependency |
|---|---|
| Owner activation link, member invites, staff invite, kiosk "Send waiver link", forgot password, magic link | Outbound email: `RESEND_API_KEY` empty locally; on production the sender domain (`RESEND_FROM`/DMARC) is unset, so delivery is unproven there too |
| CSV import (upload → preview → commit → reconciliation) | `BLOB_READ_WRITE_TOKEN` (file storage) — the screen says "File uploads not configured" |
| Stripe Connect | the platform's registered OAuth redirect is `matflow.studio`, so a local server cannot receive the callback; on production, a Stripe sign-in by the owner |
| Card subscription, class pack purchase, refund, failed renewal, dispute — as customer journeys | a connected account plus Stripe webhook delivery to a public URL |
| Login throttle, lockout, the 2FA challenge at sign-in | `TESTING_MODE` (skips them on localhost) |
| Overdue / chase / renewal states | time (no due date passed during the run) |
| Google Drive integration | Google OAuth |
| Push notifications | not live in the product (manifest + minimal service worker only) |

---

## 5. Prioritised improvements

**Critical (a club cannot run unaided until these are done)**
1. Deliver mail on production (verified sender, DMARC) **and** give every invite a screen fallback: a copyable activation/invite link and a "show password once" for staff. Without this, owners, staff and members all depend on a channel that does not work today.
2. Fix the club-code door: mint alphanumeric codes at approval or accept hyphens in the box; show the club's login link on the approval email and on the operator's tenant page.
3. Stop the member sheet treating 409 as success; show the server's sentence ("This class is full — 3 of 2 places are taken…", "Check-in is only available from 30 min before…").
4. Give the owner an in-app "set your password" step after an operator reset, and an activation path that does not need the mail to arrive (an operator-visible one-time link).

**Significant**
5. Register: render medical notes as words or nothing (never `[]`), and only flag when there is something to read.
6. Register: show capacity ("2 of 2 places") and ask before admitting over capacity or an on-hold member; the coach should read the same sentences the kiosk uses.
7. Say it when a save fails: expired session → "You've been signed out — sign in again; your details are kept"; dropped request → "Couldn't reach MatFlow — nothing was recorded; try again". Both dialogs currently go silent.
8. Role gates in words: "Coaches can't open Settings — ask the owner" instead of a silent bounce; align the Manager promise with what a manager can actually do (Payments today).
9. Staff dialog: either honour "leave blank to auto-generate" (and show the password once) or remove the promise.
10. Kiosk waiver: offer "Sign on this tablet" or "Ask staff — they can sign you in at the desk" beside "Send waiver link".
11. Apply confirmation: never show the mail apology to the applicant; log it for the operator instead.

**Polish**
12. Resume the onboarding wizard after a refresh. 13. Keep the kiosk/leaderboard URL viewable (or re-showable after a re-auth). 14. One source of truth for class times (Duration or start/end). 15. Don't badge a plan-less child "Paid". 16. Name the field and limit in validation ("Name must be 100 characters or fewer"). 17. Put Payments export on the Payments screen and export pounds. 18. Fix the "Reason for impersonating this tenant" label; explain Account vs Bootstrap. 19. Child-waiver refusal copy for parents. 20. Clear the 2FA banner immediately after enrolment. 21. Billing in the member bottom nav. 22. Label the show-password button. 23. 44 px targets on table headers at phone width. 24. "Last seen" should update on the day's check-in.

---

## 6. Not tested

Overdue and chase flows; renewals; refunds and disputes through the UI; class-pack purchase; the shop; promotions; ranks; member self-cancel; hold auto-resume on the date; timezone effects on reports; kiosk full-class refusal for an adult (no eligible member remained); import mapping/preview/commit; the 2FA challenge at sign-in; throttle and lockout; ownership transfer; DSAR/erasure/retention; Google Drive; push; the operator's suspend/reactivate; second-location assignment on classes and tier venue eligibility; the portal's Progress and Schedule beyond a smoke read; email content and delivery states.

---

## 7. Developer-assisted diagnostics (kept apart; none turns a journey into a pass)

- **Member passwords set by script** (26 Sep, test branch): bcrypt hashes written for Alex Paid and Priya Patel so the member and parent sessions could be walked. The customer-facing verdict for member login remains BLOCKED (F-5).
- **`EmailLog` read** (26 Sep): every row for the club is `failed: RESEND_API_KEY not configured` — `application_received` once, `invite_member` once per adult added. `EmailLog` stores no body or link, and invite tokens are hashed, so nothing could be recovered from it even as a developer.
- **Row counts** (26 Sep, read-only): Riverbank tenant 10 members, 3 users, 3 attendance, 3 payments, Stripe not connected. The seeded club was opened only for page reads; the harness issued no write actions in that session.
- **Stripe accounts list** (26 Sep, test key, read-only): no new connected account exists; the "Use blank account" attempt never completed because the callback went to production and was refused. Nothing to delete.
- **Card journeys** were not re-run in this simulation. Developer-run evidence from the same week on the same test branch, on throwaway Custom test accounts created and deleted by script: `docs/readiness/evidence/stripe-family-e2e-2026-09-26.json` (parent pays for a child; the payer's card fails at renewal — which rows flip) and the lifecycle run of 24 Sep (`scripts/stripe-lifecycle-e2e.mjs`: failed renewal → overdue, dispute, refund, cancel at period end). Those prove the code path, not the customer's screens.

---

## 8. The five changes before onboarding the next real club

1. **Mail that arrives, plus screen fallbacks.** Verified sender on production, and a copyable link on every invite/activation dialog so a WhatsApp message can carry it.
2. **The club code door.** Alphanumeric codes or hyphen-tolerant input, and the login link shown to the owner and operator.
3. **Honest member check-in.** The sheet shows the server's refusal sentence; never "signed in!" on a 409.
4. **Silence removed where money and access are at stake.** Expired-session and dropped-request wording on Add member and Record payment; role bounces in words; register capacity and on-hold warnings.
5. **Register and staff hygiene.** No `[]`/false Medical flags; generated staff passwords shown once or the promise removed.

---

## 9. Closing summary

MatFlow's screens are largely coherent and honest when a request fails outright: injected server errors produced retryable error states on every page tried, forms kept their input, double clicks did not duplicate, layouts held at phone, tablet and desktop widths with no horizontal scroll, the keyboard works, one club cannot see another, and the desk journeys (tiers, cash, holds, cancellations, desk waivers, kiosk, register, reports, exports, 2FA) all completed. The owner wizard runs end to end.

What stops an unassisted club is the **entry**: every credential in the product travels by email, email does not deliver, and there is no screen fallback; and the club's own code cannot be typed. Behind the door, the product is **silent or wrong at the moments that matter most**: a refused check-in reported as success, a register that admits over capacity without a word and prints `[]` as a medical warning, staff bounced without explanation, and saves that fail without saying so. Together they are the difference between a club that runs itself and one that phones the developer on day one.

Evidence: ledger `ledger.jsonl` (174 unique steps: 110 PASS, 56 FAIL rows including harness retries that were later superseded by verified rows, 4 BLOCKED, 4 NOT AVAILABLE — the tables above are the curated verdicts) and 304 screenshots, copied to `.omc/sheets/customer-simulation-2026-09-26/` (git-ignored) and to the Desktop folder `MatFlow-Customer-Simulation-2026-09-26-screens/`. The step-by-step ledger with the words seen is `docs/readiness/evidence/customer-simulation-2026-09-26-ledger.md`.

---

## 10. Scope statement

This is one fictional club on a local development server against the Neon test branch, on 26 September 2026, at the local tree described above. It says nothing about ten clubs, about production behaviour under load, about the deployed revision `90868eb` (which predates most of this tree), or about the Total BJJ migration. Where the environment blocked a journey the dependency is named rather than inferred. No real member, real payment or real email was touched, and nothing on production was changed. One request did reach production: Stripe's OAuth page returned the Connect attempt to `https://matflow.studio/api/stripe/connect/callback` (the platform's registered redirect), which answered `{"ok":false,"error":"Unauthorized"}`; no account was connected and no mutation was observed. The product was not modified during the assessment.

**Correction (26 Sep 2026, after external review):** the closing summary's sentence "none of these is large to fix" was unsupported sizing and has been withdrawn; credential recovery, ambiguous payment outcomes and authorisation changes need careful implementation and regression testing. The fixes and their retest on a second fictional club are in `docs/readiness/CUSTOMER-SIMULATION-FIXES-2026-09-26.md`.
