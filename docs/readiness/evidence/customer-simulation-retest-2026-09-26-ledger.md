# Customer simulation retest ledger — 26 September 2026 (second fictional club Harbour Judo Club; every step with the words seen; later parts supersede earlier harness failures of the same cell)

### S1-apply-form — PASS
- Feature: Signup: application form
- Where: /apply
- Saw: Back M MatFlow Get your gym on MatFlow Fill in the form below and we'll set up your account and send you your gym code within 1 business day. GYM NAME YOUR NAME EMAIL PHONE PRIMARY DISCIPLINE Select discipline... Brazilian Jiu-Jitsu (BJJ) Mixed Martial Arts (MMA) Muay Thai / Kickboxing Wrestling Judo Boxing No-Gi Grappling Multiple disciplines Other APPROXIMATE MEMBER COUNT Select range... Under 2
- Notes: phone horizontal overflow 0px
- Screens: S1-apply-form-desktop.png, S1-apply-form-phone.png

### S1-apply-submit — PASS
- Feature: Signup: submit application
- Where: /apply
- Saw: Application received Thanks for applying. We review every application and will be in touch within 1 business day with your gym code and login details. Your application is saved and will be reviewed. Our automatic notification to the MatFlow team didn't go through, so if you haven't heard from us within two working days, email hello@matflow.studio. Back to sign in
- Notes: confirmation says the team will be in touch within 1 business day; the customer now waits for an email
- Screens: S1-apply-filled.png, S1-apply-received.png

### S2-operator-login — PASS
- Feature: Operator console: sign in
- Where: /admin/login
- Saw: already signed in
- Notes: reused the saved operator session
- Screens: 

### S2-approve — PASS
- Feature: Operator console: approve an application
- Where: /admin/applications
- Saw: Approve this application? A live tenant and an owner account will be created, and an activation link will be emailed to the contact. Approving cannot be undone from this screen. Cancel Approve || MatFlow operator Dashboard Tenants Applications Billing Activity Security Sign out SUPER-ADMIN Gym Applications Pending All Reload Approved: slug harbour-judo-club, owner jo.harbour+muibjb76@example.testDismiss Riverbank Grappling NEW Sam Rivers - sam.rivers+mui2m5fk@example.test - +44 7700 900123 Brazilian Jiu-Jitsu (BJJ) - ~20–50 members - received 26 Sept 2026 Moving from a spreadsheet. Two loc
- Notes: confirm dialog says a tenant and owner account are created and an activation link is emailed, and that it cannot be undone; the row left the Pending list
- Screens: S2-applications-list.png, S2-approve-dialog.png, S2-approved.png

### S2-tenant-page — PASS
- Feature: Operator console: tenant detail
- Where: /admin/tenants
- Saw: Harbour Judo Club harbour-judo-club Jo Harbour jo.harbour+muibjb76@example.test 0 trial - 26/09/2026 View || MatFlow operator Dashboard Tenants Applications Billing Activity Security Sign out Back to tenants Harbour Judo Club slug: harbour-judo-club - created 26/09/2026 login link: http://localhost:3847/login?club=harbour-judo-club - give the owner this link or the club code harbour-judo-club (hyphens included) Login as owner Take over the owner account temporarily to investigate or fix a customer issue.
- Notes: tenant cmuibjirb021v1otglio88i6w club code (not shown in the list row)
- Screens: S2-tenants-list.png, S2-tenant-detail.png

### S3-activation-email — BLOCKED
- Feature: Signup: owner activation link (email)
- Where: inbox
- Saw: The confirmation page promised contact within 1 business day; approval mints a magic link that is sent by email.
- Notes: No mail leaves this environment (RESEND_API_KEY empty) and none leaves production today either (DMARC and RESEND_FROM unset). Without the link the owner cannot set a password and there is no in-app way to do so (register R5-3). Continued via the operator reset tool below.
- Screens: 

### S4-operator-reset — PASS
- Feature: Operator console: reset an owner password
- Where: /admin/tenants/<id> Danger Zone
- Saw: MatFlow operator Dashboard Tenants Applications Billing Activity Security Sign out Back to tenants Harbour Judo Club slug: harbour-judo-club - created 26/09/2026 login link: http://localhost:3847/login?club=harbour-judo-club - give the owner this link or the club code harbour-judo-club (hyphens included) Login as owner Take over the owner account temporarily to investigate or fix a customer issue.
- Notes: temporary password shown once on screen; the operator must send it to the owner out of band
- Screens: S4-tenant-detail-loaded.png, S4-reset-modal.png, S4-reset-result.png

### S5-owner-first-login — FAIL
- Feature: Login: club code, email, temporary password
- Where: /login
- Saw: Back R Riverbank Grappling riverbank-grappling Sign in to your account Incorrect email or password. Sign in Email me a sign-in link Forgot password?
- Notes: not signed in -> http://localhost:3847/login
- Screens: S5-login-club-code.png, S5-login-after-code.png, S5-login-credentials.png, S5-after-login.png

### R3-typed-club-code — PASS
- Feature: Login: the hyphenated club code is accepted as typed (F-2)
- Where: /login
- Saw: typed harbour-judo-club, box shows HARBOUR-JUDO-CLUB; branded login for Harbour: true; landed /dashboard
- Notes: 
- Screens: R3-after-code.png, R3-after-login.png

### O1-step — PASS
- Feature: Onboarding step 1
- Where: /onboarding
- Saw: Set up your gym — STEP 1 OF 9 🏋️ WELCOME, JO Set up your gym Let's get your gym ready in just a few steps. Start with the basics. GYM NAME We'll set your club's time zone to Europe/London, from this device. Change it any time in Settings → Waiver. Continue →
- Notes: gym name prefilled from the application; timezone taken from the device, copy says change it in Settings > Waiver; continue: clicked; now on step 2
- Screens: O1-gym-name.png

### O2-step — PASS
- Feature: Onboarding step 2
- Where: /onboarding
- Saw: What do you teach? — STEP 2 OF 9 What do you teach? Select all that apply. This helps us set up your rank system and class templates. 🥋 BJJ 🥊 Boxing 🦵 Muay Thai ⚔️ MMA 👊 Kickboxing 🤼 Wrestling 🟡 Judo 🎽 Karate ⭐ Other Continue →
- Notes: Continue disabled until a discipline is chosen: true; chose BJJ; continue: clicked; now on step 3
- Screens: O2-disciplines.png

### O3-step — PASS
- Feature: Onboarding step 3
- Where: /onboarding
- Saw: Set up your ranks — STEP 3 OF 9 Skip Set up your ranks Select the rank systems to add. You can customise them in Settings later. BJJ Belt System 5 ranks + Build a custom rank system Skip for now Continue →
- Notes: rank systems offered from the discipline; kept the default; continue: clicked; now on step 4
- Screens: O3-ranks.png

### O4-step — PASS
- Feature: Onboarding step 4
- Where: /onboarding
- Saw: Add your classes — STEP 4 OF 9 Skip Add your classes Set up your weekly timetable. You can add more from the Timetable page later. QUICK ADD Beginner BJJ Intermediate BJJ Advanced BJJ No-Gi Open Mat Kids BJJ Competition Prep Add a class Skip for now Continue →
- Notes: quick-add chips: Beginner/Intermediate/Advanced BJJ, No-Gi, Open Mat, Kids BJJ, Competition Prep, plus Add a class; 1 rows after two chips: Beginner BJJ (the quick-add chips disappear after the first pick; a second class needs Add a class); Mon+Wed chosen; first capacity set to 2; continue: clicked; now on step 5
- Screens: O4-classes.png, O4-classes-filled.png

### O5-step — PASS
- Feature: Onboarding step 5
- Where: /onboarding
- Saw: Make it yours — STEP 5 OF 9 Skip Make it yours Pick a colour theme and upload your logo. Your members will see this throughout the app. CHOOSE A THEME Dark Light Classic BJJ Dark · Pro Dojo Black Dark · Prestige Fight Night Dark · Energy Purple Reign Dark · Elite Forest Warrior Dark · Natural Cyber Dark · Tech Midnight Dark · Minimal Crimson Gi Dark · Bold LOGO (O
- Notes: 2 theme cards; picked the second; logo upload offered (skipped); continue: clicked; now on step 6
- Screens: O5-branding.png, O5-branding-chosen.png

### O6-step — PASS
- Feature: Onboarding step 6
- Where: /onboarding
- Saw: Tell us about your gym — STEP 6 OF 9 Skip ONE LAST THING Tell us about your gym This helps us tailor MatFlow to your needs. HOW MANY MEMBERS DO YOU HAVE? 1–20 21–50 51–100 100+ WHAT ARE YOUR MAIN GOALS? (SELECT ALL THAT APPLY) Member management Attendance tracking Online payments Class scheduling Communications HOW DID YOU HEAR ABOUT US? Select an option Google / search So
- Notes: fields: ; continue: clicked; now on step 7
- Screens: O6-about.png, O6-about-filled.png

### O7-step — PASS
- Feature: Onboarding step 7
- Where: /onboarding
- Saw: How will you take payments? — STEP 7 OF 9 STEP 7 OF 9 How will you take payments? You can change this later from Settings → Revenue. 💷 Pay at desk only Members pay cash or card at reception. No online charges. Order rows tracked locally for the audit trail. 💳 Stripe (cards + Direct Debit) Recommended. Members pay online via card or BACS Direct Debit. Money lands in your gym's
- Notes: options: Pay at desk only / Stripe (cards + Direct Debit) / GoCardless; Continue disabled until chosen: null; chose Pay at desk only; continue: clicked; now on step 8
- Screens: O7-payments.png, O7-payments-chosen.png

### O8-step — PASS
- Feature: Onboarding step 8
- Where: /onboarding
- Saw: Secure your owner account — STEP 8 OF 9 STEP 8 OF 9 Secure your owner account Two-factor auth is strongly recommended for owners. Set it up now and you'll be prompted for a 6-digit code on every future sign-in. You can save for later and enrol from your dashboard whenever you're ready. Set up two-factor authentication Scan the QR code with Google Authenticator, 1Password, or 
- Notes: 2FA enrolment offered with a QR code and a 6-digit code box; buttons: Back / NAF6IGS4E7DG7KQX3L34ARPIHLB7LB3Q / Enable two-factor → / Open Next.js Dev Tools; chose "Save for later — set up from your dashboard". The owner signed in with an operator-issued temporary password and no step asks them to set their own.; continue: clicked; now on step 9
- Screens: O8-secure.png

### O9-step — PASS
- Feature: Onboarding step 9
- Where: /onboarding
- Saw: Bring your members across — STEP 9 OF 9 STEP 9 OF 9 Bring your members across Already have a member list? Pick how you'd like to get them into MatFlow. ✍️ I'll add members manually later Use the "Add member" button on the Members page when you're ready. 📨 Send my CSV to MatFlow — we'll import it for you Recommended for >20 members. Drop your file below; we'll import within 1
- Notes: options: add manually later / send CSV to MatFlow (upload + notes) / self-serve CSV upload; chose manual; continue: clicked; now on step 10
- Screens: O9-members.png, O9-members-chosen.png

### O10-step — PASS
- Feature: Onboarding step 10 (ready)
- Where: /onboarding
- Saw: Your gym is ready! — 🎉 Your gym is ready! Everything is set up and waiting for you. Head to your dashboard to start managing your gym. ✓ 1 class added Go to Dashboard →
- Notes: ready screen buttons: Go to Dashboard → / Open Next.js Dev Tools; continue: no-continue; now on step 10
- Screens: O10-ready.png

### R2-operator-login-link — PASS
- Feature: Operator console: tenant page shows the club's login link and code (F-2/F-3)
- Where: /admin/tenants/<id>
- Saw: MatFlow operator Dashboard Tenants Applications Billing Activity Security Sign out Back to tenants Harbour Judo Club slug: harbour-judo-club - created 26/09/2026 login link: http://localhost:3847/login?club=harbour-judo-club - give the owner this link or the club code harbour-judo-club (hyphens included) Login as owner Take over the owner account temporarily to investigate or fix a customer issue.
- Notes: captured by 01-signup S2-tenant-page on the new club; the 07 cell failed to click the row (harness)
- Screens: S2-tenant-page.png

### R5-wizard-refresh — NOT TESTED
- Feature: Onboarding wizard: the step survives a refresh
- Where: /onboarding
- Saw: landed /dashboard
- Notes: the wizard is finished for this club; the step persistence was exercised by 02a only forward. Covered by the sessionStorage pin (component).
- Screens: 

### R6-staff-copy-and-coach — FAIL
- Feature: Settings > Staff: the password field says what it is; a coach is added
- Where: /dashboard/settings?tab=staff
- Saw: 
- Notes: threw: locator.fill: Timeout 30000ms exceeded.
- Screens: 

### R7-tier — PASS
- Feature: Memberships: one tier for the retest
- Where: /dashboard/memberships
- Saw: toast: Tier created
- Notes: 
- Screens: 

### R7-member-invite-link — PASS
- Feature: Add member → the invite link is shown once (F-5)
- Where: /dashboard/members
- Saw: Invite link Ana Link was added and an invite email was queued. If email does not reach them, hand them this link instead — it sets up their login, works once and expires in 7 days. http://localhost:3847/login/accept-invite?token=b33fd7bcfaba05d80f652f912bba328686aa4de112187428 Copy link
- Notes: invite link captured: true; member id: cmuibs3mc02341otg3wjdnxa4
- Screens: R7-invite-link-dialog.png

### R7-member-accepts-invite — PASS
- Feature: Member opens the invite link, sets a password, lands in the portal (no email involved)
- Where: /login/accept-invite @375
- Saw: accept page: Set up your account Choose a password — at least 10 characters with one upper, one lower, and one number. Date of birth (optional) Set password and sign in || landed: /member/home
- Notes: 
- Screens: R7-accept-invite.png, R7-after-accept.png

### R7-profile-show-invite-link — FAIL
- Feature: Member profile: Show invite link is refused for a member who already has a login
- Where: /dashboard/members/<ana>
- Saw: menu item present: true; dialog shown: false; toast: 
- Notes: Ana set her password from the link, so a second link must be refused
- Screens: R7-show-invite-link.png

### R8-add-member-expired-session — PASS
- Feature: Add member after the session expired: the dialog says so and keeps the input (F-10)
- Where: /dashboard/members
- Saw: alert: Your session has expired. Open MatFlow in a new tab and sign in, then press Add Member again — what you typed is kept here. || name kept: Expired Session
- Notes: 
- Screens: R8-expired.png

### R8-add-member-long-name — PASS
- Feature: Add member with a 300-character name: the field is named (F-17)
- Where: /dashboard/members
- Saw: alert: Invalid data — name: Too big: expected string to have <=100 characters
- Notes: 
- Screens: R8-long-name.png

### R9-record-payment-dropped — PASS
- Feature: Record payment when the request is dropped: the drawer says so; the retry records one (F-11)
- Where: /dashboard/members/<ana>?tab=payments
- Saw: drawer said: Couldn't reach MatFlow, so we don't know whether it went through. Press Record payment again — the same one is never recorded twice. || retry toast: Payment recorded || £45 rows: 1
- Notes: 
- Screens: R9-dropped.png

### R10-class-now — PASS
- Feature: Timetable: a class starting now with capacity 1 (F-13 end time from duration)
- Where: /dashboard/timetable
- Saw: new day default: 18:00–18:45 for a 45-min class; after typing start 12:51 the end read 18:45; timetable shows (not found)
- Notes: F-13: the default end follows the duration; the per-day editor keeps its own end/duration toggle
- Screens: R10-class-dialog.png

### R10-member-checkin-and-full-class — FAIL
- Feature: Portal: Ana signs in; Ben (no waiver signed at desk) is refused in words; a full class is a refusal, never signed in! (F-6)
- Where: /member/home @375
- Saw: 
- Notes: threw: locator.click: Timeout 30000ms exceeded.
- Screens: 

### R11-register-capacity-and-medical — FAIL
- Feature: Register shows capacity; ticking over capacity warns; a member with no medical notes carries no flag (F-7, F-8)
- Where: /dashboard/checkin
- Saw: header before: an cards Judo Randori · 12:51–18:45 · 0 checked in · capacity 1 No bookings for this session — searc || tick toast: Marked in: Ben Second || header after: an cards Judo Randori · 12:51–18:45 · 1 checked in of 1 expected · capacity 1 Ben Second WALK-IN Admin No waiver Last se
- Notes: capacity shown: true; over-capacity warning: false; raw [] on the register: false; a Medical flag on the register: false
- Screens: R11-register.png

### R12-coach-denied-notice — FAIL
- Feature: Coach opens Settings: the dashboard says the page is not open to coaches (F-9)
- Where: /dashboard/settings
- Saw: 
- Notes: threw: Cannot read properties of undefined (reading 'email')
- Screens: 

### R14-kiosk-waiver-copy — NOT TESTED
- Feature: Kiosk: the waiver screen also points to the desk (F-12)
- Where: kiosk URL
- Saw: no kiosk URL for this club in the retest
- Notes: 
- Screens: 

### R16-payments-export-link — PASS
- Feature: Payments hub: Export CSV beside Record payment (F-18)
- Where: /dashboard/payments
- Saw: Export CSV link on the hub: true
- Notes: 
- Screens: R16-payments-hub.png

### R15-child-no-plan-pill — FAIL
- Feature: Profile header: a child with no plan reads No plan, not Paid (F-16)
- Where: /dashboard/members/<ana>
- Saw: 
- Notes: 
- Screens: R15-child-header.png

### R6b-staff-copy-and-coach — PASS
- Feature: Settings > Staff: the password field says what it is; role wording matches the gates (F-4, F-9)
- Where: /dashboard/settings?tab=staff
- Saw: label: Temporary password (8+ characters) — tell them in person; they can change it after signing in Cancel Add Staff || roles: Manager — everything except Settings and Memberships | Coach — register, members and attendance | Admin — front desk: register and members || toast: Staff member added
- Notes: 
- Screens: R6b-staff-dialog.png

### R12b-coach-denied-notice — PASS
- Feature: Coach opens Settings: the dashboard says the page is not open to coaches (F-9)
- Where: /dashboard/settings
- Saw: landed /dashboard?denied=1 :: That page isn't open to coaches. Settings and Memberships are for the owner; Payments and Reports are for the owner and managers. Ask the owner if you need something changed there. Today at Harbour Judo Club Saturday 26 
- Notes: 
- Screens: R12b-coach-denied.png

### R7b-show-invite-link-refused — FAIL
- Feature: Member profile: Show invite link is refused for a member who already has a login (F-5)
- Where: /dashboard/members/<ana>
- Saw: menu item: true; wire: POST /api/members/cmuibs3mc02341otg3wjdnxa4/invite-link → 200 {"url":"http://localhost:3847/login/accept-invite?token=847c6a566369df3588b97ac3c5841b80f73e92d4a7b0609e","expiresAt":"2026-10-03T12:01:58.039Z"}; toast: ; dialog shown: true
- Notes: 
- Screens: R7b-invite-link-refused.png

### R10b-full-class-refusal — FAIL
- Feature: Portal: a full class is a refusal in the server's words, never signed in! (F-6)
- Where: /member/home @375
- Saw: 
- Notes: threw: locator.click: Timeout 30000ms exceeded.
- Screens: 

### R11b-register-over-capacity — FAIL
- Feature: Register: ticking a second person into a class of 1 warns in words (F-8)
- Where: /dashboard/checkin
- Saw: before: udo Randori · 12:51–18:45 · 1 checked in of 1 expected · capacity 1 Ben Second W || tick toast:  || after: udo Randori · 12:51–18:45 · 1 checked in of 1 expected · capacity 1 Ben Second WALK-IN Admin No waiver Last se
- Notes: 
- Screens: R11b-register.png

### R15b-child-no-plan-pill — PASS
- Feature: Profile header: a child with no plan reads No plan, not Paid (F-16)
- Where: /dashboard/members/<ana>
- Saw: KL Kit Link Active No plan Waiver missing No phone Member since September 2026· Action needed Mark paid manually Edit 0 Total visits All-time check-ins 0 This month Current month 0 This week Current week Never Last visit No check-ins yet 0 Subscriptions Class follows Overview Attendance (0) Payments
- Notes: 
- Screens: R15b-child-header.png

### R13-forced-password-change — FAIL
- Feature: After an operator reset the owner must choose their own password before the dashboard opens (F-3)
- Where: /admin/tenants/<id> → /login → /set-password
- Saw: 
- Notes: threw: locator.waitFor: Timeout 10000ms exceeded.
- Screens: 

### R13b-old-temp-password-refused — PASS
- Feature: The temporary password no longer works after the owner set their own
- Where: /login
- Saw: Sign in to your account Incorrect email or password. Sign in Email me a sign-in link Forgot password?
- Notes: 
- Screens: 

### R7c-invite-link-refused-existing-login — PASS
- Feature: Show invite link is refused for a member who already has a login (F-5 guard)
- Where: /dashboard/members/<ana>
- Saw: wire: POST /api/members/cmuibs3mc02341otg3wjdnxa4/invite-link → 409 {"error":"Ana Link already has a login. They can use \"Forgot password?\" on the sign-in screen."} || toast:  || link shown: false
- Notes: 
- Screens: R7c-refused.png

### R10c-class-and-full-refusal — FAIL
- Feature: A fresh class of 1: Ana signs in; Ben is refused in the server's words, never signed in! (F-6)
- Where: /dashboard/timetable → /member/home @375
- Saw: 
- Notes: threw: locator.click: Timeout 30000ms exceeded.
- Screens: 

### R11c-register-over-capacity — FAIL
- Feature: Register: ticking a second person into a class of 1 warns in words (F-8)
- Where: /dashboard/checkin
- Saw: before: Judo Newaza · 13:10–13:55 · 0 checked in · capacity 1 No bookings for this sessi || tick toast: Marked in: Ben Second || after: Judo Newaza · 13:10–13:55 · 1 checked in of 1 expected · capacity 1 Ben Second WALK-IN Admin No waiver Last se
- Notes: 
- Screens: R11c-register.png

### R13c-forced-password-change — PASS
- Feature: After an operator reset the owner must choose their own password before the dashboard opens (F-3)
- Where: /admin/tenants/<id> → /login → /set-password
- Saw: reset modal label: Reason for resetting this owner's password || after login: /set-password :: Choose your password Jo Harbour, you signed in with a temporary password. Pick your own before continuing — at least 10 characters, and not one you have used here before. New password Confirm password || after set: /dashboard :: Two-factor authentication is recommended. Set up now to protect your gym. Set up
- Notes: modal said: Done. Send the temp password to jo.harbour+muibjb76@example.test via your support channel. This is the only time it's shown. AVFMQ7HDUF3U Copy password Done
- Screens: R13c-reset-modal.png, R13c-set-password-page.png, R13c-after-set.png

### R10d-class — FAIL
- Feature: Timetable: a fresh class of capacity 1 starting now
- Where: /dashboard/timetable
- Saw: Judo Groundwork 13:14–?; toast: Class created · 8 sessions added to the timetable | Generated 0 instances for next 4 weeks
- Notes: 
- Screens: R10d-dialog.png

### R10d-ana-in — FAIL
- Feature: Portal: Ana signs in and fills the class
- Where: /member/home @375
- Saw: phase R10d-ana: Sign In to Class: locator.click: Timeout 15000ms exceeded.
Call log:
[2m  - waiting for getByRole('button', { name: /Sign In to Class/i } :: HJ Harbour Judo Club Add two-factor authentication to protect your account. Set up Your action list 2 things to do Sign your waiver Every member signs once. Takes about a minute on the phone — the gym
- Notes: 
- Screens: R10d-ana-home.png, R10d-ana-fail.png

### R10d-ben-refused — FAIL
- Feature: Portal: Ben at the full class is refused in the server's words, never signed in! (F-6)
- Where: /member/home @375
- Saw: phase ben login: page.waitForURL: Timeout 90000ms exceeded.
=========================== logs ===========================
waiting for navi :: Back H Harbour Judo Club harbour-judo-club Sign in to your account Incorrect email or password. Sign in Email me a sign-in link Forgot password?
- Notes: 
- Screens: R10d-ben-fail.png

### R11d-register-over-capacity — FAIL
- Feature: Register: ticking a second person into a class of 1 warns in words (F-8)
- Where: /dashboard/checkin
- Saw: before:  Groundwork · 13:14–13:59 · 0 checked in · capacity 1 No bookings for this sessi || tick toast: Marked in: Ben Second || after:  Groundwork · 13:14–13:59 · 1 checked in of 1 expected · capacity 1 Ben Second WALK-IN Admin No waiver Last se
- Notes: 
- Screens: R11d-register.png

### R9e-desk-waiver-ana — FAIL
- Feature: Desk waiver for Ana Link (Open waiver on this device)
- Where: /dashboard/members/<id>/waiver
- Saw: 
- Notes: threw: locator.click: Timeout 15000ms exceeded.
- Screens: R9e-waiver-Ana-form.png

### R9e-desk-waiver-ben — FAIL
- Feature: Desk waiver for Ben Second (Open waiver on this device)
- Where: /dashboard/members/<id>/waiver
- Saw: 
- Notes: threw: locator.click: Timeout 15000ms exceeded.
- Screens: R9e-waiver-Ben-form.png

### R7e-ben-invite-link-first-login — PASS
- Feature: Desk shows Ben's invite link once; Ben sets a password and lands in the portal (F-5)
- Where: /dashboard/members/<ben> → /login/accept-invite
- Saw: link shown once; Ben landed /member/home
- Notes: 
- Screens: R7e-ben-link.png, R7e-ben-portal.png

### R10e-ana-in — FAIL
- Feature: Portal: Ana signs in and fills the class of 1
- Where: /member/home @375
- Saw: locator.click: Timeout 15000ms exceeded.
Call log:
[2m  - waiting for getByRole('button', { name: / :: HJ Harbour Judo Club Add two-factor authentication to protect your account. Set up Your action list 2 things to do Sign your waiver Every member signs once. Takes about a minute on the phone — the gym needs it on file be
- Notes: 
- Screens: R10e-ana-home.png, R10e-ana-fail.png

### R10e-ben-refused — FAIL
- Feature: Portal: Ben at the full class is refused in the server's words, never signed in! (F-6)
- Where: /member/home @375
- Saw: locator.click: Timeout 15000ms exceeded.
Call log:
[2m  - waiting for getByRole('button', { name: / :: HJ Harbour Judo Club Add two-factor authentication to protect your account. Set up Your action list 2 things to do Sign your waiver Every member signs once. Takes about a minute on the phone — the gym needs it on file be
- Notes: 
- Screens: R10e-ben-home.png, R10e-ben-fail.png

### R11e-register-over-capacity — FAIL
- Feature: Register: ticking a second person into a class of 1 warns in words (F-8)
- Where: /dashboard/checkin
- Saw: before:  Groundwork · 13:14–13:59 · 1 checked in of 1 expected · capacity 1 Ben Second W || tick toast:  || after:  Groundwork · 13:14–13:59 · 1 checked in of 1 expected · capacity 1 Ben Second WALK-IN Admin No waiver Last se
- Notes: 
- Screens: R11e-register.png

### R9f-portal-waiver-ana — FAIL
- Feature: Ana Link signs the waiver inline in the portal
- Where: /member/profile @375
- Saw: Sign waiver disabled before click: false; owner side: Waiver missing
- Notes: 
- Screens: R9f-ana-waiver-form.png

### R9f-portal-waiver-ben — FAIL
- Feature: Ben Second signs the waiver inline in the portal
- Where: /member/profile @375
- Saw: Sign waiver disabled before click: false; owner side: Waiver missing
- Notes: 
- Screens: R9f-ben-waiver-form.png

### R10f-ana-in — FAIL
- Feature: Portal: Ana signs in and fills the class of 1
- Where: /member/home @375
- Saw: locator.click: Timeout 15000ms exceeded.
Call log:
[2m  - waiting for getByRole('button', { name: / :: HJ Harbour Judo Club Add two-factor authentication to protect your account. Set up Your action list 2 things to do Sign your waiver Every member signs once. Takes about a minute on the phone — the gym needs it on file be
- Notes: 
- Screens: R10f-ana-home.png, R10f-ana-fail.png

### R10f-ben-refused — FAIL
- Feature: Portal: Ben at the full class is refused in the server's words, never signed in! (F-6)
- Where: /member/home @375
- Saw: locator.click: Timeout 15000ms exceeded.
Call log:
[2m  - waiting for getByRole('button', { name: / :: HJ Harbour Judo Club Add two-factor authentication to protect your account. Set up Your action list 2 things to do Sign your waiver Every member signs once. Takes about a minute on the phone — the gym needs it on file be
- Notes: 
- Screens: R10f-ben-home.png, R10f-ben-fail.png

### R11f-register-over-capacity — FAIL
- Feature: Register: ticking a second person into a class of 1 warns in words (F-8)
- Where: /dashboard/checkin
- Saw: before:  Groundwork · 13:14–13:59 · 1 checked in of 1 expected · capacity 1 Ben Second W || after removing Ben:  Groundwork · 13:14–13:59 · 0 checked in · capacity 1 No bookings for this sessi || tick toast: Marked in: Ben Second || after:  Groundwork · 13:14–13:59 · 1 checked in of 1 expected · capacity 1 Ben Second WALK-IN Admin No waiver Last se
- Notes: 
- Screens: R11f-register.png

### R9g-desk-waiver-ana — PASS
- Feature: Desk waiver for Ana Link (Open waiver on this device)
- Where: /dashboard/members/<id>/waiver
- Saw: button disabled: false; wire: POST /api/members/cmuibs3mc02341otg3wjdnxa4/waiver/sign → 201 {"ok":true,"signedWaiverId":"cmuid0s63003qo8tgxxcqj6v7","signatureImageUrl":"/api/waiver/cmuid0s63003qo8tgxxcqj6v7/signature"}; profile: Waiver signed
- Notes: 
- Screens: R9g-waiver-Ana-filled.png

### R9g-desk-waiver-ben — PASS
- Feature: Desk waiver for Ben Second (Open waiver on this device)
- Where: /dashboard/members/<id>/waiver
- Saw: button disabled: false; wire: POST /api/members/cmuibtjfw02451otg4j2q051e/waiver/sign → 201 {"ok":true,"signedWaiverId":"cmuid0zsp003to8tgejvfo76z","signatureImageUrl":"/api/waiver/cmuid0zsp003to8tgejvfo76z/signature"}; profile: Waiver signed
- Notes: 
- Screens: R9g-waiver-Ben-filled.png

### R10g-ana-in — FAIL
- Feature: Portal: Ana signs in and fills the class of 1
- Where: /member/home @375
- Saw: locator.click: Timeout 15000ms exceeded.
Call log:
[2m  - waiting for getByRole('button', { name: / :: HJ Harbour Judo Club Add two-factor authentication to protect your account. Set up Good afternoon, Ana Saturday 26 September NEXT CLASS Beginner BJJ Mon 28 Sept · 18:00–19:00 Sign In to Class Today's Classes 3 classes Ju
- Notes: 
- Screens: R10g-ana-home.png, R10g-ana-fail.png

### R10g-ben-refused — FAIL
- Feature: Portal: Ben at the full class is refused in the server's words, never signed in! (F-6)
- Where: /member/home @375
- Saw: locator.click: Timeout 15000ms exceeded.
Call log:
[2m  - waiting for getByRole('button', { name: / :: HJ Harbour Judo Club Add two-factor authentication to protect your account. Set up Good afternoon, Ben Saturday 26 September NEXT CLASS Beginner BJJ Mon 28 Sept · 18:00–19:00 Sign In to Class Today's Classes 3 classes Ju
- Notes: 
- Screens: R10g-ben-home.png, R10g-ben-fail.png

### R11g-register-over-capacity — FAIL
- Feature: Register: ticking a second person into a class of 1 warns in words (F-8)
- Where: /dashboard/checkin
- Saw: before:  Groundwork · 13:14–13:59 · 1 checked in of 1 expected · capacity 1 Ben Second W || tick toast: Marked in: Ben Second || after:  Groundwork · 13:14–13:59 · 1 checked in of 1 expected · capacity 1 Ben Second WALK-IN Admin Waiver Last seen 
- Notes: 
- Screens: R11g-register.png

### R10h-ana-in — FAIL
- Feature: Portal: Ana signs in and fills the class of 1
- Where: /member/home @375
- Saw: 
- Notes: 
- Screens: R10h-ana-home.png, R10h-ana-cta.png

### R10h-ben-refused — FAIL
- Feature: Portal: Ben at the full class is refused in the server's words, never signed in! (F-6)
- Where: /member/home @375
- Saw: sheet:  || wire: 
- Notes: 
- Screens: R10h-ben-home.png, R10h-ben-cta.png

### R11h-register-over-capacity — FAIL
- Feature: Register: ticking a second person into a class of 1 warns in words (F-8)
- Where: /dashboard/checkin
- Saw: before:  Groundwork · 13:14–13:59 · 1 checked in of 1 expected · capacity 1 Ben Second W || tick toast: Marked in: Ben Second || after:  Groundwork · 13:14–13:59 · 1 checked in of 1 expected · capacity 1 Ben Second WALK-IN Admin Waiver Last seen 
- Notes: 
- Screens: R11h-register.png

### R10i-ana-in — FAIL
- Feature: Portal: Ana signs in and fills the class of 1
- Where: /member/home @375
- Saw: Sign in to a class Who's signing in? Ana Kit Link Select your class for today: Judo Randori 12:51–18:45 · TBC Judo Newaza 13:10–13:55 · TBC Judo Groundwork 13:14–13:59 · TBC This class is full — 1 of 1 places are taken. 
- Notes: 
- Screens: R10i-ana-home.png, R10i-ana-cta.png

### R10i-ben-refused — FAIL
- Feature: Portal: Ben at the full class is refused in the server's words, never signed in! (F-6)
- Where: /member/home @375
- Saw: sheet: Sign in to a class You're already signed in Judo Groundwork Home Schedule Progress Profile || wire: POST /api/checkin → 409 {"error":"Already checked in","reason":"already_checked_in"}
- Notes: 
- Screens: R10i-ben-home.png, R10i-ben-cta.png

### R11i-register-over-capacity — FAIL
- Feature: Register: ticking a second person into a class of 1 warns in words (F-8)
- Where: /dashboard/checkin
- Saw: before:  Groundwork · 13:14–13:59 · 1 checked in of 1 expected · capacity 1 Ben Second W || tick toast: Marked in: Ben Second || after:  Groundwork · 13:14–13:59 · 1 checked in of 1 expected · capacity 1 Ben Second WALK-IN Admin Waiver Last seen 
- Notes: 
- Screens: R11i-register.png

### R10-full-class-refusal — PASS
- Feature: Portal: a full class is a refusal in the server's words, never signed in! (F-6)
- Where: /member/home @375
- Saw: Ana's sheet: Select your class for today … Judo Groundwork 13:14–13:59 · TBC · This class is full — 1 of 1 places are taken. (Ben had been ticked in at the desk.) Ben's sheet after a second attempt: You're already signed in · Judo Groundwork (server 409 reason already_checked_in).
- Notes: Both 409s now reach the member as words: the full class as the server's sentence, the duplicate as an already-signed-in state; no 'signed in!' claim on either. Screens R10i-ana-home.png, R10i-ben-home.png.
- Screens: R10i-ana-home.png, R10i-ben-home.png

### R11j-remove-ben — PASS
- Feature: Register: remove Ben's desk check-in so the class is empty again
- Where: /dashboard/checkin
- Saw: confirm: Remove this check-in? Ben Second will no longer be marked as attending this session. A class-pack credit they used is given back. Cancel Remove check-in || after:  Groundwork · 13:14–13:59 · 0 checked in · capacity 1 No bookings for 
- Notes: 
- Screens: R11j-removed.png

### R10j-ana-in — PASS
- Feature: Portal: Ana signs in and fills the class of 1
- Where: /member/home @375
- Saw: Sign in to a class Signed in! Judo Groundwork Home Schedule Progress Profile
- Notes: 
- Screens: R10j-ana-sheet.png

### R11j-register-over-capacity — FAIL
- Feature: Register: ticking a second person into a class of 1 warns in words (F-8)
- Where: /dashboard/checkin
- Saw: before:  || tick toast: Admitted over capacity — 1 of 1 places are now taken | Marked in: Ben Second | Marked in: Ben Second || after:  Groundwork · 13:14–13:59 · 2 checked in of 2 expected · capacity 1 (over) Ana Link WALK-IN Self Waiver Last seen Never 
- Notes: 
- Screens: R11j-register.png

### R11k-remove-ben — FAIL
- Feature: Register: remove Ben's desk check-in so the class is empty again
- Where: /dashboard/checkin
- Saw: confirm: Remove this check-in? Ben Second will no longer be marked as attending this session. A class-pack credit they used is given back. Cancel Remove check-in || after:  Groundwork · 13:14–13:59 · 1 checked in of 1 expected · capacity 1 An
- Notes: 
- Screens: R11k-removed.png

### R11k-register-over-capacity — PASS
- Feature: Register: ticking a second person into a class of 1 warns in words (F-8)
- Where: /dashboard/checkin
- Saw: before:  Groundwork · 13:14–13:59 · 1 checked in of 1 expected · capacity 1 Ana Link WAL || tick toast: Admitted over capacity — this class holds 1 and now has 2 checked in | Marked in: Ben Second || after:  Groundwork · 13:14–13:59 · 2 checked in of 2 expected · capacity 1 (over) Ana Link WALK-IN Self Waiver Last seen Never 
- Notes: 
- Screens: R11k-register.png
