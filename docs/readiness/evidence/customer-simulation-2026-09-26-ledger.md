# Customer simulation ledger — 26 September 2026 (synthetic club Riverbank Grappling; every step with the words seen; "-verified"/"-retry" rows supersede the row they name)

### S1-apply-form — PASS
- Feature: Signup: application form
- Where: /apply
- Saw: Back M MatFlow Get your gym on MatFlow Fill in the form below and we'll set up your account and send you your gym code within 1 business day. GYM NAME YOUR NAME EMAIL PHONE PRIMARY DISCIPLINE Select discipline... Brazilian Jiu-Jitsu (BJJ) Mixed Martial Arts (MMA) Muay Thai / Kickboxing Wrestling Judo Boxing No-Gi Grappling Multiple disciplines Other APPROXIMATE MEMBER COUNT Select range... Under 2
- Notes: phone horizontal overflow 0px
- Screens: S1-apply-form-desktop.png, S1-apply-form-phone.png

### S1-apply-submit — FAIL
- Feature: Signup: submit application
- Where: /apply
- Saw: Back M MatFlow Get your gym on MatFlow Fill in the form below and we'll set up your account and send you your gym code within 1 business day. GYM NAME YOUR NAME EMAIL PHONE PRIMARY DISCIPLINE Select discipline... Brazilian Jiu-Jitsu (BJJ) Mixed Martial Arts (MMA) Muay Thai / Kickboxing Wrestling Judo Boxing No-Gi Grappling Multiple disciplines Other APPROXIMATE MEMBER COUNT Select range... Under 2
- Notes: no confirmation copy found
- Screens: S1-apply-filled.png, S1-apply-received.png

### S2-operator-login — PASS
- Feature: Operator console: sign in
- Where: /admin/login
- Saw: already signed in
- Notes: reused the saved operator session
- Screens: 

### S2-approve — FAIL
- Feature: Operator console: approve an application
- Where: /admin/applications
- Saw: Approve this application? A live tenant and an owner account will be created, and an activation link will be emailed to the contact. Approving cannot be undone from this screen. Cancel Approve || MatFlow operator Dashboard Tenants Applications Billing Activity Security Sign out SUPER-ADMIN Gym Applications Pending All Reload Approved: slug riverbank-grappling, owner sam.rivers+mui2qf2w@example.testDismiss Riverbank Grappling NEW Sam Rivers - sam.rivers+mui2m5fk@example.test - +44 7700 900123 Brazilian Jiu-Jitsu (BJJ) - ~20–50 members - received 26 Sept 2026 Moving from a spreadsheet. Two l
- Notes: the application is still pending after confirming
- Screens: S2-applications-list.png, S2-approve-dialog.png, S2-approved.png

### S2-tenant-page — PASS
- Feature: Operator console: tenant detail
- Where: /admin/tenants
- Saw: Riverbank Grappling riverbank-grappling Sam Rivers sam.rivers+mui2qf2w@example.test 0 trial - 26/09/2026 View || MatFlow operator Dashboard Tenants Applications Billing Activity Security Sign out Back to tenants Riverbank Grappling slug: riverbank-grappling - created 26/09/2026 Login as owner Take over the owner account temporarily to investigate or fix a customer issue. Every action is audit-logged with both your operator context and Sam Rivers's id. Sam Rivers sam.rivers+mui2qf2w@example.test 2FA: not enro
- Notes: tenant cmui2twqv01nt1otg8ceab2cz club code riverbank-grappling
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
- Saw: MatFlow operator Dashboard Tenants Applications Billing Activity Security Sign out Back to tenants Riverbank Grappling slug: riverbank-grappling - created 26/09/2026 Login as owner Take over the owner account temporarily to investigate or fix a customer issue. Every action is audit-logged with both your operator context and Sam Rivers's id. Sam Rivers sam.rivers+mui2qf2w@example.test 2FA: not enro
- Notes: temporary password shown once on screen; the operator must send it to the owner out of band
- Screens: S4-tenant-detail-loaded.png, S4-reset-modal.png, S4-reset-result.png

### S5-owner-first-login — FAIL
- Feature: Login: club code, email, temporary password
- Where: /login
- Saw: STEP 1 OF 9 🏋️ WELCOME, SAM Set up your gym Let's get your gym ready in just a few steps. Start with the basics. GYM NAME We'll set your club's time zone to Europe/London, from this device. Change it any time in Settings → Waiver. Continue →
- Notes: typed club code refused (F-CS-2); via deep link: signed in -> http://localhost:3847/onboarding
- Screens: S5-login-club-code.png, S5-login-after-code.png, S5-login-credentials.png, S5-after-login.png

### D1-first-screens — PASS
- Feature: Onboarding: the first screens after sign-in
- Where: http://localhost:3847/onboarding
- Saw: Dashboard @ /dashboard
- Notes: 1 screens walked; ended at /dashboard
- Screens: D1-step-1.png

### D2-nav-desktop — PASS
- Feature: Navigation: every item the owner can reach
- Where: /dashboard
- Saw: Home (/dashboard), Schedule (/dashboard/timetable), Register (/dashboard/checkin), Members (/dashboard/members), Attendance (/dashboard/attendance), Ranks (/dashboard/ranks), Promotions (/dashboard/promotions), Notifications (/dashboard/notifications), Reports (/dashboard/reports), Conversion (/dashboard/attribution), Memberships (/dashboard/memberships), Payments (/dashboard/payments), Analysis (/dashboard/analysis), Settings (/dashboard/settings)
- Notes: 14 nav items visited
- Screens: D2--dashboard-1440.png, D2--dashboard-timetable-1440.png, D2--dashboard-checkin-1440.png, D2--dashboard-members-1440.png, D2--dashboard-attendance-1440.png, D2--dashboard-ranks-1440.png, D2--dashboard-promotions-1440.png, D2--dashboard-notifications-1440.png, D2--dashboard-reports-1440.png, D2--dashboard-attribution-1440.png, D2--dashboard-memberships-1440.png, D2--dashboard-payments-1440.png, D2--dashboard-analysis-1440.png, D2--dashboard-settings-1440.png

### D2-nav-phone — PASS
- Feature: Navigation: phone bottom nav and More sheet
- Where: /dashboard @375
- Saw: tabs: Home | Schedule | Register | Members | More ;; more: Show 18 ignore-listed frame(s)
- Notes: phone overflow 0px
- Screens: D2-phone-home.png, D2-phone-more.png

### D3-settings-tabs — PASS
- Feature: Settings: every tab and its controls
- Where: /dashboard/settings
- Saw: Overview: Overview / Branding / Revenue / Store / Staff / Account / Waiver / Integrations / Locations / Add location / Member Status / Gym Info / Club Store / Manage Staff || Branding: Overview / Branding / Revenue / Store / Staff / Account / Waiver / Integrations / Gym Name / Club Logo / Logo Size / RSmall / RNormal / RLarge / Theme Presets / Dark / Light / Classic BJJDark · Pro · Inter / Dojo BlackDark · Prestige · Montserrat / Fight NightDark · Energy · Oswald / Purple ReignDark · Elite · Plus Jakarta Sans / Forest WarriorDark · Natural · Barlow / CyberDark · Tech · Space Grotesk / MidnightDark · Minimal · DM Sans / Crimson GiDark · Bold · Rajdhani / Clean WhiteLight · Modern · Poppins / 
- Notes: 8 tabs: Overview, Branding, Revenue, Store, Staff, Account, Waiver, Integrations
- Screens: D3-settings-overview.png, D3-settings-branding.png, D3-settings-revenue.png, D3-settings-store.png, D3-settings-staff.png, D3-settings-account.png, D3-settings-waiver.png, D3-settings-integrations.png

### D4-add-member — PASS
- Feature: Dialog: Add member
- Where: /dashboard/members
- Saw: Add Member Full Name * Email Optional. Without an email this member can’t be sent a login invite, a waiver link or a payment reminder — you can add one later. Phone Membership No membership tiers yet. Create your price list in Memberships, then you can put members on it. You can still add this member now. Date of Birth Status Active Taster (trial) ATTRIBUTION Trial run by Signed up by (credit) Not
- Notes: 13 controls; Escape closes: true
- Screens: D4-add-member.png

### D4-add-class — PASS
- Feature: Dialog: Add class
- Where: /dashboard/timetable
- Saw: New class * required — everything else is optional Class Name * Coach Free-text (use coach name below) Sam Rivers (owner) Location Duration (mins) * Max Capacity Description + Select specific people (comp class) Colour Recurring Schedule * Add day No day added yet — a class with no day will not appear on the weekly timetable. Fill in: Class Name, at least one day. Cancel Create class
- Notes: 26 controls; Escape closes: true
- Screens: D4-add-class.png

### D4-add-membership-tier — PASS
- Feature: Dialog: Add membership tier
- Where: /dashboard/memberships
- Saw: Add tier Name * Description Price Currency GBP EUR USD Billing cycle Weekly Fortnightly Every 4 weeks Monthly Annual One-off / Drop-in Max classes/week Kids tier STRIPE LINKAGE (OPTIONAL) Paste the price_… and prod_… ids from your Stripe dashboard. Leave blank if members shouldn't self-subscribe to this tier. Stripe price id Stripe product id Cancel Create tier
- Notes: 18 controls; Escape closes: true
- Screens: D4-add-membership-tier.png

### D4-record-payment — PASS
- Feature: Dialog: Record payment
- Where: /dashboard/payments
- Saw: Record a payment Amount (£) Method Cash Bank transfer / external Comp (free) Exempt Other Notes (optional) Record payment
- Notes: 8 controls; Escape closes: true
- Screens: D4-record-payment.png

### D4-invite-staff — PASS
- Feature: Dialog: Invite staff
- Where: /dashboard/settings?tab=staff
- Saw: Add Staff Member Full Name * Email * Role * Manager — all access except billing Coach — attendance + members Admin — check-in + front desk Password (leave blank to auto-generate) Cancel Add Staff
- Notes: 11 controls; Escape closes: true
- Screens: D4-invite-staff.png

### D4-ranks-add — PASS
- Feature: Dialog: Ranks: add
- Where: /dashboard/ranks
- Saw: Add rank Discipline / art * BJJ + New discipline… Rank name * Position (order) Max stripes Belt colour Custom Cancel Add rank
- Notes: 20 controls; Escape closes: true
- Screens: D4-ranks-add.png

### D4-promotions-add — NOT AVAILABLE
- Feature: Dialog: Promotions: add
- Where: /dashboard/promotions
- Saw: Ready for promotion Members who have met the attendance and time-at-rank thresholds for their current belt. No promotions due Members will appear once they hit the attendance and time thresholds. Settings → Ranks
- Notes: no control matching /add|new|create/i on /dashboard/promotions
- Screens: 

### D4-notifications-create — PASS
- Feature: Dialog: Notifications: create
- Where: /dashboard/notifications
- Saw: New announcement Members see this in their portal feed. Title * Message * 0/2000 Image (optional) Add an image PNG, JPG or WebP · large photos are resized before upload Click to upload Pin to top Pinned posts always appear first for members Expiry How long members see this before it disappears from their feed No expiry 7 days 14 days 30 days Custom… Cancel Post announcement
- Notes: 14 controls; Escape closes: true
- Screens: D4-notifications-create.png

### O1-gym-name — PASS
- Feature: Onboarding step 1: gym name and timezone
- Where: /onboarding
- Saw: STEP 1 OF 9 🏋️ WELCOME, SAM Set up your gym Let's get your gym ready in just a few steps. Start with the basics. GYM NAME We'll set your club's time zone to Europe/London, from this device. Change it any time in Settings → Waiver. Continue →
- Notes: gym name prefilled: "Riverbank Grappling"; timezone is taken from the device and the copy says it can be changed in Settings > Waiver
- Screens: O1-gym-name.png

### O2-disciplines — PASS
- Feature: Onboarding step 2: disciplines
- Where: /onboarding
- Saw: STEP 2 OF 9 What do you teach? Select all that apply. This helps us set up your rank system and class templates. 🥋 BJJ 🥊 Boxing 🦵 Muay Thai ⚔️ MMA 👊 Kickboxing 🤼 Wrestling 🟡 Judo 🎽 Karate ⭐ Other Continue →
- Notes: Continue is disabled until a discipline is chosen (true); chose BJJ
- Screens: O2-disciplines-before.png, O2-disciplines-chosen.png

### O3-ranks — PASS
- Feature: Onboarding step 3: rank systems
- Where: /onboarding
- Saw: STEP 3 OF 9 Skip Set up your ranks Select the rank systems to add. You can customise them in Settings later. BJJ Belt System 5 ranks + Build a custom rank system Skip for now Continue →
- Notes: 0 rank systems preselected from the discipline
- Screens: O3-ranks.png

### O4-classes — FAIL
- Feature: Onboarding step 4: first classes
- Where: /onboarding
- Saw: 
- Notes: threw: locator.waitFor: Timeout 10000ms exceeded.
- Screens: O4-classes-before.png, O4-classes-filled.png

### O5-branding — FAIL
- Feature: Onboarding step 5: theme and logo
- Where: /onboarding
- Saw: 
- Notes: threw: locator.waitFor: Timeout 10000ms exceeded.
- Screens: O5-branding.png, O5-branding-chosen.png

### O6-about — FAIL
- Feature: Onboarding step 6: about the gym
- Where: /onboarding
- Saw: 
- Notes: threw: locator.waitFor: Timeout 10000ms exceeded.
- Screens: O6-about.png

### O7-payments — FAIL
- Feature: Onboarding step 7: how you take payments
- Where: /onboarding
- Saw: 
- Notes: threw: locator.isDisabled: Timeout 30000ms exceeded.
- Screens: O7-payments.png

### O8-secure — PASS
- Feature: Onboarding step 8: two-factor authentication
- Where: /onboarding
- Saw: STEP 4 OF 9 Skip Add your classes Set up your weekly timetable. You can add more from the Timetable page later. Mon Tue Wed Thu Fri Sat Sun to Add a class Skip for now Save 1 class →
- Notes: buttons: ; chose to save 2FA for later. NOTE: the owner signed in with an operator-issued temporary password and no step asks them to set their own.
- Screens: O8-secure.png

### O9-members — FAIL
- Feature: Onboarding step 9: bringing members across
- Where: /onboarding
- Saw: 
- Notes: threw: locator.click: Timeout 30000ms exceeded.
- Screens: O9-members.png

### O10-ready — FAIL
- Feature: Onboarding: the ready screen and first dashboard
- Where: /onboarding
- Saw: STEP 5 OF 9 Skip Make it yours Pick a colour theme and upload your logo. Your members will see this throughout the app. CHOOSE A THEME Dark Light Classic BJJ Dark · Pro Dojo Black Dark · Prestige Fight Night Dark · Energy Purple Reign Dark · Elite Forest Warrior Dark · Natural Cyber Dark · Tech Midnight Dark · Minimal Crimson Gi Dark · Bold LOGO (OPTIONAL) Upload logo MEMBERS PAGE PREVIEW R Riverb
- Notes: ready-screen buttons: ; landed /onboarding
- Screens: O10-ready.png, O10-first-dashboard.png

### O1-step — PASS
- Feature: Onboarding step 1
- Where: /onboarding
- Saw: Set up your gym — STEP 1 OF 9 🏋️ WELCOME, SAM Set up your gym Let's get your gym ready in just a few steps. Start with the basics. GYM NAME We'll set your club's time zone to Europe/London, from this device. Change it any time in Settings → Waiver. Continue →
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

### O4-step-mui3z6wc — FAIL
- Feature: Onboarding step 4
- Where: /onboarding
- Saw: Add your classes — STEP 4 OF 9 Skip Add your classes Set up your weekly timetable. You can add more from the Timetable page later. Mon Tue Wed Thu Fri Sat Sun to Add a class Skip for now Save 1 class →
- Notes: quick-add chips: Beginner/Intermediate/Advanced BJJ, No-Gi, Open Mat, Kids BJJ, Competition Prep, plus Add a class; 1 rows after two chips: Beginner BJJ; first capacity set to 2; continue: no-continue; now on step 4
- Screens: O4-classes.png, O4-classes-filled.png

### O4-step-mui42ztf — FAIL
- Feature: Onboarding step 4
- Where: /onboarding
- Saw: Add your classes — STEP 4 OF 9 Skip Add your classes Set up your weekly timetable. You can add more from the Timetable page later. Mon Tue Wed Thu Fri Sat Sun to Add a class Skip for now Save 1 class →
- Notes: quick-add chips: Beginner/Intermediate/Advanced BJJ, No-Gi, Open Mat, Kids BJJ, Competition Prep, plus Add a class; 1 rows after two chips: Beginner BJJ (the quick-add chips disappear after the first pick; a second class needs Add a class); Mon+Wed chosen; first capacity set to 2; continue: no-continue; now on step 4
- Screens: O4-classes.png, O4-classes-filled.png

### O4-step-mui48cv7 — PASS
- Feature: Onboarding step 4
- Where: /onboarding
- Saw: Add your classes — STEP 4 OF 9 Skip Add your classes Set up your weekly timetable. You can add more from the Timetable page later. Mon Tue Wed Thu Fri Sat Sun to Add a class Skip for now
- Notes: quick-add chips: Beginner/Intermediate/Advanced BJJ, No-Gi, Open Mat, Kids BJJ, Competition Prep, plus Add a class; 0 rows after two chips:  (the quick-add chips disappear after the first pick; a second class needs Add a class); Mon+Wed chosen; first capacity set to 2; continue: clicked; now on step 6
- Screens: O4-classes.png, O4-classes-filled.png

### O6-step — PASS
- Feature: Onboarding step 6
- Where: /onboarding
- Saw: Tell us about your gym — STEP 6 OF 9 Skip ONE LAST THING Tell us about your gym This helps us tailor MatFlow to your needs. HOW MANY MEMBERS DO YOU HAVE? 1–20 21–50 51–100 100+ WHAT ARE YOUR MAIN GOALS? (SELECT ALL THAT APPLY) Member management Attendance tracking Online payments Class scheduling Communications HOW DID YOU HEAR ABOUT US? Select an option Google / search So
- Notes: fields: ; continue: clicked; now on step 7
- Screens: O6-about.png, O6-about-filled.png

### O6-step-mui48d0i — FAIL
- Feature: Onboarding step 6
- Where: /onboarding
- Saw: Tell us about your gym — STEP 6 OF 9 Skip ONE LAST THING Tell us about your gym This helps us tailor MatFlow to your needs. HOW MANY MEMBERS DO YOU HAVE? 1–20 21–50 51–100 100+ WHAT ARE YOUR MAIN GOALS? (SELECT ALL THAT APPLY) Member management Attendance tracking Online payments Class scheduling Communications HOW DID YOU HEAR ABOUT US? Select an option Google / search So
- Notes: fields: ; continue: no-continue; now on step 6
- Screens: O6-about.png

### O1-step-mui4a91g — FAIL
- Feature: Onboarding step 1
- Where: /onboarding
- Saw: Set up your gym — STEP 1 OF 9 🏋️ WELCOME, SAM Set up your gym Let's get your gym ready in just a few steps. Start with the basics. GYM NAME We'll set your club's time zone to Europe/London, from this device. Change it any time in Settings → Waiver. Continue →
- Notes: gym name prefilled from the application; timezone taken from the device, copy says change it in Settings > Waiver; continue: clicked; now on step 1
- Screens: O1-gym-name.png

### O4-step-mui4flm7 — PASS
- Feature: Onboarding step 4
- Where: /onboarding
- Saw: Add your classes — STEP 4 OF 9 Skip Add your classes Set up your weekly timetable. You can add more from the Timetable page later. Mon Tue Wed Thu Fri Sat Sun to Add a class Skip for now
- Notes: quick-add chips: Beginner/Intermediate/Advanced BJJ, No-Gi, Open Mat, Kids BJJ, Competition Prep, plus Add a class; 0 rows after two chips:  (the quick-add chips disappear after the first pick; a second class needs Add a class); Mon+Wed chosen; first capacity set to 2; continue: clicked; now on step 6
- Screens: O4-classes.png, O4-classes-filled.png

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
- Notes: 2FA enrolment offered with a QR code and a 6-digit code box; buttons: Back / QOJ4VOPEBMIOK2PJ6ZL7G3BAXS6WYZCO / Enable two-factor → / Open Next.js Dev Tools; chose "Save for later — set up from your dashboard". The owner signed in with an operator-issued temporary password and no step asks them to set their own.; continue: clicked; now on step 9
- Screens: O8-secure.png

### O8-step-mui4gc04 — FAIL
- Feature: Onboarding step 8
- Where: /onboarding
- Saw: Secure your owner account — STEP 8 OF 9 STEP 8 OF 9 Secure your owner account Two-factor auth is strongly recommended for owners. Set it up now and you'll be prompted for a 6-digit code on every future sign-in. You can save for later and enrol from your dashboard whenever you're ready. Set up two-factor authentication Scan the QR code with Google Authenticator, 1Password, or 
- Notes: no save-for-later control found; continue: no-continue; now on step 8
- Screens: O8-secure.png

### O5-step — PASS
- Feature: Onboarding step 5
- Where: /onboarding
- Saw: Make it yours — STEP 5 OF 9 Skip Make it yours Pick a colour theme and upload your logo. Your members will see this throughout the app. CHOOSE A THEME Dark Light Classic BJJ Dark · Pro Dojo Black Dark · Prestige Fight Night Dark · Energy Purple Reign Dark · Elite Forest Warrior Dark · Natural Cyber Dark · Tech Midnight Dark · Minimal Crimson Gi Dark · Bold LOGO (O
- Notes: 2 theme cards; picked the second; logo upload offered (skipped); continue: clicked; now on step 6
- Screens: O5-branding.png, O5-branding-chosen.png

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

### O10-go-to-dashboard — FAIL
- Feature: Onboarding: ready screen to first dashboard
- Where: /onboarding
- Saw: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → R Riverbank Grappling MAIN Dashboard Timetable Mark Attendance Members Attendance ADMIN Ranks Promotions Notifications Reports Conversion Memberships Payments Analysis Settings MatFlow v1.0 R BACK OFFICE Dashboard Owner SR Sam Finish setting up your gym — 3 items remaining Connect Stripe Add a membership tier Ad
- Notes: the ready screen did not appear on reload; the wizard restarts at step 1 (progress is not resumed)
- Screens: 

### A1-location — PASS
- Feature: Settings > Overview: add a second location
- Where: /dashboard/settings
- Saw: WORKSPACE Settings Riverbank Grappling · Pro plan SR Sam Rivers sam.rivers+mui2qf2w@example.test Owner Overview Branding Revenue Store Staff Account Waiver Integrations Locations Where your classes run. One venue needs nothing here; add more and each class can name its venue. Name Address (optional) || toast: Location added
- Notes: inline form (Name, Address optional, Add/Cancel); the venue is listed
- Screens: A1-location-form.png, A1-location-after.png

### A2-branding — PASS
- Feature: Settings > Branding: choose a light theme
- Where: /dashboard/settings?tab=branding
- Saw: save: Save Branding || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → | Branding saved — member app updated
- Notes: picked the Clean White preset; the phone preview should reflect it
- Screens: A2-branding-before.png, A2-branding-after.png

### A3-waiver-tab — PASS
- Feature: Settings > Waiver: time zone, check-in window, waiver text
- Where: /dashboard/settings?tab=waiver
- Saw: WORKSPACE Settings Riverbank Grappling · Pro plan SR Sam Rivers sam.rivers+mui2qf2w@example.test Owner Overview Branding Revenue Store Staff Account Waiver Integrations Club time zone Decides which day Register calls today, which day a class is filed under, and when check-in opens. Set it to the zone your mats are in. TIME ZONE Africa/Abidjan Africa/Accra Africa/Addis Ababa Africa/Algiers Africa/A
- Notes: time zone save: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → | Time zone saved; window save: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → | Time zone saved; no waiver dialog
- Screens: A3-waiver-tab.png

### A4-staff-manager — PASS
- Feature: Settings > Staff: add a manager
- Where: /dashboard/settings?tab=staff
- Saw: roles offered: Manager — all access except billing | Coach — attendance + members | Admin — check-in + front desk || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → | Staff member added
- Notes: chose Manager — all access except billing; password set by the owner; 
- Screens: A4-staff-manager-dialog.png, A4-staff-manager-after.png

### A4-staff-coach — PASS
- Feature: Settings > Staff: add a coach
- Where: /dashboard/settings?tab=staff
- Saw: roles offered: Manager — all access except billing | Coach — attendance + members | Admin — check-in + front desk || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → | Staff member added
- Notes: chose Coach — attendance + members; password set by the owner; 
- Screens: A4-staff-coach-dialog.png, A4-staff-coach-after.png

### A4-staff-admin — FAIL
- Feature: Settings > Staff: add a admin
- Where: /dashboard/settings?tab=staff
- Saw: roles offered: Manager — all access except billing | Coach — attendance + members | Admin — check-in + front desk || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → | Invalid data
- Notes: chose Admin — check-in + front desk; password left blank (auto-generated); NOTE: the generated password is not shown anywhere and no mail leaves, so this person cannot sign in
- Screens: A4-staff-admin-dialog.png, A4-staff-admin-after.png

### A5-tier-monthly — FAIL
- Feature: Memberships: create tier Adult Monthly
- Where: /dashboard/memberships
- Saw: Add tier Name * Description Price Currency GBP EUR USD Billing cycle Weekly Fortnightly Every 4 weeks Monthly Annual One-off / Drop-in Max classes/week Kids tier STRIPE LINKAGE (OPTIONAL) Paste the price_… and prod_… ids from your Stripe dashboard. Leave blank if members shouldn't self-subscribe to  || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now →
- Notes: cycle options: Weekly | Fortnightly | Every 4 weeks | Monthly | Annual | One-off / Drop-in; chose Monthly; 
- Screens: A5-tier-monthly-dialog.png, A5-tier-monthly-after.png

### A5-tier-fourweekly — PASS
- Feature: Memberships: create tier Adult 4-weekly
- Where: /dashboard/memberships
- Saw: Add tier Name * Description Price Currency GBP EUR USD Billing cycle Weekly Fortnightly Every 4 weeks Monthly Annual One-off / Drop-in Max classes/week Kids tier STRIPE LINKAGE (OPTIONAL) Paste the price_… and prod_… ids from your Stripe dashboard. Leave blank if members shouldn't self-subscribe to  || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → | Tier created
- Notes: cycle options: Weekly | Fortnightly | Every 4 weeks | Monthly | Annual | One-off / Drop-in; chose Every 4 weeks; 
- Screens: A5-tier-fourweekly-dialog.png, A5-tier-fourweekly-after.png

### A5-tier-kids — PASS
- Feature: Memberships: create tier Kids 4-weekly
- Where: /dashboard/memberships
- Saw: Add tier Name * Description Price Currency GBP EUR USD Billing cycle Weekly Fortnightly Every 4 weeks Monthly Annual One-off / Drop-in Max classes/week Kids tier STRIPE LINKAGE (OPTIONAL) Paste the price_… and prod_… ids from your Stripe dashboard. Leave blank if members shouldn't self-subscribe to  || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → | Tier created
- Notes: cycle options: Weekly | Fortnightly | Every 4 weeks | Monthly | Annual | One-off / Drop-in; chose Every 4 weeks; 
- Screens: A5-tier-kids-dialog.png, A5-tier-kids-after.png

### A5-tier-annual — PASS
- Feature: Memberships: create tier Annual
- Where: /dashboard/memberships
- Saw: Add tier Name * Description Price Currency GBP EUR USD Billing cycle Weekly Fortnightly Every 4 weeks Monthly Annual One-off / Drop-in Max classes/week Kids tier STRIPE LINKAGE (OPTIONAL) Paste the price_… and prod_… ids from your Stripe dashboard. Leave blank if members shouldn't self-subscribe to  || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → | Tier created
- Notes: cycle options: Weekly | Fortnightly | Every 4 weeks | Monthly | Annual | One-off / Drop-in; chose Annual; 
- Screens: A5-tier-annual-dialog.png, A5-tier-annual-after.png

### A6-class — PASS
- Feature: Timetable: add a class with a recurring schedule and capacity
- Where: /dashboard/timetable
- Saw: New class * required — everything else is optional Class Name * Coach Free-text (use coach name below) Coach Mike Okoro (coach) Maya Chen (manager) Sam Rivers (owner) Location Duration (mins) * Max Capacity Description + Select specific people (comp class) Colour Recurring Schedule * Add day Sunday  || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → | Class created · 8 sessions added to the timetable
- Notes: wizard class Beginner BJJ present: true; days: Sunday/Monday/Tuesday/Wednesday/Thursday/Friday/Saturday, chose Tuesday; capacity 2
- Screens: A6-class-dialog.png, A6-class-after.png

### A7-member-alex — FAIL
- Feature: Members: add Alex Paid
- Where: /dashboard/members
- Saw: Add Member Full Name * Email Phone Membership Date of Birth Status Active Taster (trial) ATTRIBUTION Trial run by Signed up by (credit) Not recorded A staff member Brought by a member Other source Cancel Add Member || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now →
- Notes: no Membership select in the dialog; profile id (not reached)
- Screens: A7-member-dialog-filled.png

### A7-member-beth — PASS
- Feature: Members: add Beth Overdue
- Where: /dashboard/members
- Saw: Add Member Full Name * Email Phone Membership Date of Birth Status Active Taster (trial) ATTRIBUTION Trial run by Signed up by (credit) Not recorded A staff member Brought by a member Other source Cancel Add Member || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → | Beth Overdue added
- Notes: no Membership select in the dialog; profile id cmui4w78l01t41otgck5uqfis
- Screens: 

### A7-member-carl — PASS
- Feature: Members: add Carl Cancelled
- Where: /dashboard/members
- Saw: Add Member Full Name * Email Phone Membership Date of Birth Status Active Taster (trial) ATTRIBUTION Trial run by Signed up by (credit) Not recorded A staff member Brought by a member Other source Cancel Add Member || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now →
- Notes: no Membership select in the dialog; profile id cmui4wds601ta1otga3lwk6p9
- Screens: 

### A7-member-dana — PASS
- Feature: Members: add Dana Hold
- Where: /dashboard/members
- Saw: Add Member Full Name * Email Phone Membership Date of Birth Status Active Taster (trial) ATTRIBUTION Trial run by Signed up by (credit) Not recorded A staff member Brought by a member Other source Cancel Add Member || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now →
- Notes: no Membership select in the dialog; profile id cmui4wkvq01tg1otgmwzje4r6
- Screens: 

### A7-member-evan — FAIL
- Feature: Members: add Evan Unsigned
- Where: /dashboard/members
- Saw: Add Member Full Name * Email Phone Membership Date of Birth Status Active Taster (trial) ATTRIBUTION Trial run by Signed up by (credit) Not recorded A staff member Brought by a member Other source Cancel Add Member || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now →
- Notes: no tier; profile id (not reached)
- Screens: 

### A7-member-priya — FAIL
- Feature: Members: add Priya Patel
- Where: /dashboard/members
- Saw: Add Member Full Name * Email Phone Membership Date of Birth Status Active Taster (trial) ATTRIBUTION Trial run by Signed up by (credit) Not recorded A staff member Brought by a member Other source Cancel Add Member || toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now →
- Notes: no tier; profile id (not reached)
- Screens: 

### A7b-child-kidRavi — FAIL
- Feature: Members: add a child to a parent (Ravi Patel)
- Where: /dashboard/members/<parent>
- Saw: Add child to Priya Patel The child cannot log in. Use the supervised waiver flow to collect a signature. NAME * DATE OF BIRTH * Cancel Add child || toast: 
- Notes: child added from the Family card; no email asked for
- Screens: A7b-child-kidRavi-dialog.png, A7b-child-kidRavi-after.png

### A7b-child-kidSana — FAIL
- Feature: Members: add a child to a parent (Sana Patel)
- Where: /dashboard/members/<parent>
- Saw: Add child to Priya Patel The child cannot log in. Use the supervised waiver flow to collect a signature. NAME * DATE OF BIRTH * Cancel Add child || toast: 
- Notes: child added from the Family card; no email asked for
- Screens: A7b-child-kidSana-dialog.png, A7b-child-kidSana-after.png

### A8-kiosk-url — PASS
- Feature: Register: generate the kiosk URL
- Where: /dashboard/checkin
- Saw: Mark attendance Pick the session, then tick names or scan cards. The class on now is already selected. Nothing scheduled today. Add a class on the timetable and it appears here straight away. Kiosk Ch || after: Mark attendance Pick the session, then tick names or scan cards. The class on now is already selected. Nothing scheduled today. Add a class on the timetable and it appears here straight away. Kiosk Check-In iPad URL for self check-in. Disconnected from your admin login. Active Active since 26/09/202
- Notes: kiosk url shown on screen
- Screens: A8-kiosk-url.png

### A8-leaderboard — PASS
- Feature: Settings > Integrations: attendance leaderboard link
- Where: /dashboard/settings?tab=integrations
- Saw: WORKSPACE Settings Riverbank Grappling · Pro plan SR Sam Rivers sam.rivers+mui2qf2w@example.test Owner Overview Branding Revenue Store Staff Account Waiver Integrations Google Drive Read-only access to one designated folder. Used by the AI report to correlate your marketing/ops files with metrics. Connect Google Drive Kiosk Check-In Mount this URL on an iPad at the front desk so members can check 
- Notes: regenerated; the new URL is shown once. Usability: the URL cannot be viewed again later, only regenerated (which invalidates the TV)
- Screens: A8-leaderboard-shown.png

### A9-announcement — PASS
- Feature: Notifications: post an announcement
- Where: /dashboard/notifications
- Saw: toast: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → | Announcement posted
- Notes: an announcement is an in-app post; whether members are emailed is judged in the communications cell
- Screens: A9-announcement-dialog.png, A9-announcement-after.png

### A5b-kids-tier — PASS
- Feature: Memberships: edit a tier (mark it as a kids tier)
- Where: /dashboard/memberships
- Saw: toast: Tier updated
- Notes: Kids tier switch false -> true; table shows: Kids 4-weekly
- Screens: A5b-kids-tier-dialog.png, A5b-kids-tier-after.png

### A7c-membership-load — PASS
- Feature: Members > Add member: the Membership list loads
- Where: /dashboard/members
- Saw: Select… | Adult Monthly — £45.00 a month | Adult 4-weekly — £55.00 every 4 weeks | Kids 4-weekly — £30.00 every 4 weeks | Annual — £400.00 a year
- Notes: the Membership select appeared after 854 ms (a skeleton shows meanwhile)
- Screens: A7c-membership-loaded.png

### A7d-tier-alex — FAIL
- Feature: Member profile: put on a membership tier (Alex Paid)
- Where: /dashboard/members/<id>
- Saw: options: — None — | Adult Monthly — £45.00 a month | Adult 4-weekly — £55.00 every 4 weeks | Kids 4-weekly — £30.00 every 4 weeks | Annual — £400.00 a year || toast: 
- Notes: chose Adult Monthly — £45.00 a month; the profile does not show the tier
- Screens: A7d-tier-alex-form.png, A7d-tier-alex-after.png

### A7d-tier-beth — FAIL
- Feature: Member profile: put on a membership tier (Beth Overdue)
- Where: /dashboard/members/<id>
- Saw: options: — None — | Adult Monthly — £45.00 a month | Adult 4-weekly — £55.00 every 4 weeks | Kids 4-weekly — £30.00 every 4 weeks | Annual — £400.00 a year || toast: 
- Notes: chose Adult 4-weekly — £55.00 every 4 weeks; the profile does not show the tier
- Screens: A7d-tier-beth-form.png, A7d-tier-beth-after.png

### A7d-tier-carl — FAIL
- Feature: Member profile: put on a membership tier (Carl Cancelled)
- Where: /dashboard/members/<id>
- Saw: options: — None — | Adult Monthly — £45.00 a month | Adult 4-weekly — £55.00 every 4 weeks | Kids 4-weekly — £30.00 every 4 weeks | Annual — £400.00 a year || toast: 
- Notes: chose Adult Monthly — £45.00 a month; the profile does not show the tier
- Screens: A7d-tier-carl-form.png, A7d-tier-carl-after.png

### A7d-tier-dana — PASS
- Feature: Member profile: put on a membership tier (Dana Hold)
- Where: /dashboard/members/<id>
- Saw: options: — None — | Adult Monthly — £45.00 a month | Adult 4-weekly — £55.00 every 4 weeks | Kids 4-weekly — £30.00 every 4 weeks | Annual — £400.00 a year || toast: Profile updated
- Notes: chose Adult 4-weekly — £55.00 every 4 weeks; the profile now shows the tier
- Screens: A7d-tier-dana-form.png, A7d-tier-dana-after.png

### A7d-tier-evan — PASS
- Feature: Member profile: open the profile (Evan Unsigned)
- Where: /dashboard/members/<id>
- Saw: 
- Notes: profile id cmui4wt5801tm1otg9t6un96b
- Screens: A7d-profile-evan.png

### A7d-tier-priya — PASS
- Feature: Member profile: open the profile (Priya Patel)
- Where: /dashboard/members/<id>
- Saw: 
- Notes: profile id cmui4x1jd01ts1otgin9rvmzv
- Screens: A7d-profile-priya.png

### A7e-tier-check-alex — PASS
- Feature: Member profile: the saved tier survives a reload (Alex Paid)
- Where: /dashboard/members/<id>
- Saw: AP Alex Paid Adult Monthly Active Payment Paid Waiver missing Member since September 2026· Action needed Mark paid manually Edit 0 Total visits All-time check-ins 0 This month Current month 0 This week Current week Never Last visit No check-ins yet 0 Subscriptions Class follows Overview Attendance (
- Notes: tier was already saved (the first pass checked before Saving… finished); visible after reload: true
- Screens: A7e-tier-alex.png

### A7e-tier-check-beth — PASS
- Feature: Member profile: the saved tier survives a reload (Beth Overdue)
- Where: /dashboard/members/<id>
- Saw: BO Beth Overdue Adult 4-weekly Active Payment Paid Waiver missing Member since September 2026· Action needed Mark paid manually Edit 0 Total visits All-time check-ins 0 This month Current month 0 This week Current week Never Last visit No check-ins yet 0 Subscriptions Class follows Overview Attendan
- Notes: tier was already saved (the first pass checked before Saving… finished); visible after reload: true
- Screens: A7e-tier-beth.png

### A7e-tier-check-carl — PASS
- Feature: Member profile: the saved tier survives a reload (Carl Cancelled)
- Where: /dashboard/members/<id>
- Saw: CC Carl Cancelled Adult Monthly Active Payment Paid Waiver missing Member since September 2026· Action needed Mark paid manually Edit 0 Total visits All-time check-ins 0 This month Current month 0 This week Current week Never Last visit No check-ins yet 0 Subscriptions Class follows Overview Attenda
- Notes: tier was already saved (the first pass checked before Saving… finished); visible after reload: true
- Screens: A7e-tier-carl.png

### A7e-tier-check-dana — PASS
- Feature: Member profile: the saved tier survives a reload (Dana Hold)
- Where: /dashboard/members/<id>
- Saw: DH Dana Hold Adult 4-weekly Active Payment Paid Waiver missing Member since September 2026· Action needed Mark paid manually Edit 0 Total visits All-time check-ins 0 This month Current month 0 This week Current week Never Last visit No check-ins yet 0 Subscriptions Class follows Overview Attendance 
- Notes: tier was already saved (the first pass checked before Saving… finished); visible after reload: true
- Screens: A7e-tier-dana.png

### A7f-children-check — FAIL
- Feature: Members: a parent with two children (Family card)
- Where: /dashboard/members/<parent>
- Saw: PP Priya Patel Active Payment Paid Waiver missing Member since September 2026· Action needed Mark paid manually Edit 0 Total visits All-time check-ins 0 This month Current month 0 This week Current week Never Last visit No check-ins yet 0 Subscriptions Class follows Overview Attendance (0) Payments 
- Notes: Ravi listed: false (x0), Sana listed: false
- Screens: A7f-family-card.png

### A7f-children — PASS
- Feature: Members: a parent with two children (Family card)
- Where: /dashboard/members/<parent>
- Saw: Family card lists Ravi Patel (Kids, age 9, Paid, waiver missing) and Sana Patel (Kids, age 12, Paid, waiver missing), one row each, with Unlink actions
- Notes: the earlier FAIL row was the harness reading only the first 400 characters of the page; the screenshot A7f-family-card.png shows both children. Observation: a brand-new child with no tier and no payment is badged Paid.
- Screens: A7f-family-card.png

### J0-class-today — PASS
- Feature: Timetable: a class today (so check-in can be exercised) + Generate 4 weeks
- Where: /dashboard/timetable
- Saw: Class created · 8 sessions added to the timetable; dashboard tile TODAY’S CLASSES 1 · 0 booked · 2 spaces left; kiosk lists Saturday Open Mat 09:58–19:00
- Notes: the earlier FAIL row was the harness reading only the first 400 characters of the dashboard. Usability finding F-CS-9 (medium): the Add class dialog asks for Duration (mins) AND a start and end time per day; leaving the day row end at its default gave a 60-minute class that runs 09:58–19:00 on the kiosk and timetable. Two sources of truth for the class length.
- Screens: J0-class-dialog.png, J0-home-today.png, J5-kiosk-home.png

### J1-member-login-customer-path — BLOCKED
- Feature: Member login: the invite / sign-in link a member receives
- Where: /login
- Saw: Back R Riverbank Grappling riverbank-grappling Sign in to your account Sign in Email me a sign-in link Forgot password? || after requesting a link: Back R Riverbank Grappling riverbank-grappling Enter your email and we'll send you a sign-in link. Send sign-in link Use password instead
- Notes: The product queued an invite email for every member the owner added (invite_member, status failed: mail not configured) and offers no other way to give a member a password: no invite link or set-password action exists on the member profile. Magic-link and forgot-password are email too. With mail down, no member can reach the portal. Continued below via a labelled diagnostic (a password set directly for Alex and Priya).
- Screens: J1-member-login-phone.png, J1-member-magic-link.png

### J1-member-login-diagnostic — PASS
- Feature: DIAGNOSTIC: member signs in with a directly-set password
- Where: /login
- Saw: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Your action list 2 things to do Sign your waiver Every member signs once. Takes about a minute on the phone — the gym needs it on file before your next class. Suggested by MatFlow Add an emergency contact Someone we can call if you pick up an injury. Just a name and a number — saved straight from your profile. Sug
- Notes: landed /member/home; a dialog on first paint: true (the announcement?)
- Screens: J1-member-home-first-paint.png

### J2-member-waiver — FAIL
- Feature: Member portal: sign the liability waiver
- Where: /member/profile
- Saw: 
- Notes: threw: locator.click: Timeout 30000ms exceeded.
- Screens: J2-profile-before.png, J2-waiver-form.png

### J3-member-book — PASS
- Feature: Member portal: find today's class on the schedule and subscribe
- Where: /member/schedule
- Saw: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up 21–27 September Today MON 21 TUE 22 WED 23 THU 24 FRI 25 SAT 26 SUN 27 Saturday · 1 class 8 AM 9 AM 10 AM 11 AM 12 PM 1 PM 2 PM 3 PM 4 PM 5 PM 6 PM 7 PM 8 PM No classes today 8 AM 9 AM 10 AM 11 AM 12 PM 1 PM 2 PM 3 PM 4 PM 5 PM 6 PM 7 PM 8 PM Saturday Open Mat NEXT
- Notes: block state next; after Subscribe: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up 21–27 September Today MON 21 TUE 22 WED 23 THU 24 FRI 25 SAT 26 SUN 27 Saturday · 1 class 8 AM 9 A. Note: the sheet offers a class follow (Subscribe), not a booking for a session
- Screens: J3-schedule-today.png, J3-class-sheet.png, J3-class-subscribed.png

### J3-member-checkin — FAIL
- Feature: Member portal: self check-in to today's class
- Where: /member/home
- Saw: 
- Notes: threw: locator.click: Timeout 30000ms exceeded.
- Screens: 

### J4-cash-payment — PASS
- Feature: Member profile: record a cash payment
- Where: /dashboard/members/<id>?tab=payments
- Saw: Record payment Alex Paid Method Cash Bank transfer / external Comp (free) Exempt Other Description / Notes Amount (£) Record payment || methods: Cash/Bank transfer / external/Comp (free)/Exempt/Other || toast: Payment recorded || hub: Payment history 1 payment total Record payment Outstanding At the desk All payments Nobody owes you right now Every active member is up to date. Failed and overdue payments appear here.
- Notes: payment row on the profile: 1; the Payments hub should list it under All payments
- Screens: J4-record-payment.png, J4-payments-tab.png, J4-payments-hub.png

### J5-kiosk — FAIL
- Feature: Kiosk: members check in by name; a full class refuses
- Where: http://localhost:3847/kiosk/4z2yQM6Mjj_eoriMV83yd5Z9eVg04kWT
- Saw: 
- Notes: threw: locator.waitFor: Timeout 10000ms exceeded.
- Screens: J5-kiosk-home.png

### J5-register — PASS
- Feature: Register: staff sees who is checked in and the class fill
- Where: /dashboard/checkin
- Saw: register: Mark attendance Pick the session, then tick names or scan cards. The class on now is already selected. Session 09:58 · Saturday Open Mat NEXT Next Tick names Scan cards Saturday Open Mat · 09:58–19:00 · 0 checked in of 1 expected Alex Paid No waiver Last seen Never Add someone Kiosk Check-In iPad UR || attendance: Attendance Recent check-ins across all classes 0 This Month check-ins 0 This Week check-ins 0 Active Members this month — Top Class this month All QR Scan Admin Self Kiosk No attendance records found Showing 0 of 0 records
- Notes: expected: Alex (portal) and Dana (kiosk) present; Beth refused when the class was full
- Screens: J5-register.png, J5-attendance.png

### J6-reports — PASS
- Feature: Reports: the payment and the attendance appear
- Where: /dashboard/reports
- Saw: Reports Current owner snapshot, attendance trends, and class performance. Export CSV Window 4 weeks 8 weeks 12 weeks 16 weeks 24 weeks Class All classes Beginner BJJ Beginner BJJ Beginner BJJ Age group All Adults Kids Rate Check-ins per active member Members who attended Class fill rate — Check-ins per active member As of 09:27 Class composition Share of check-ins by class — Last 12 weeks No class
- Notes: read the tiles for £45 collected and the check-ins
- Screens: J6-reports.png

### J7-hold — PASS
- Feature: Member profile: put a membership on hold, then resume
- Where: /dashboard/members/<id>
- Saw: Put membership on hold No check-ins while on hold. The next payment is owed when the membership resumes. Resume on Leave blank for an open-ended hold; resume it from this menu. Cancel Put on hold || toast: On hold until 10 Oct 2026 || after: DH Dana Hold Adult 4-weekly Active On hold until 10 Oct 2026 Waiver missing Member since September 2026· Action needed Mark paid manually Edit 0 Total visits All-time check-ins 0 This month Current mo
- Notes: hold until 2026-10-10: profile says on hold; no Resume control
- Screens: J7-hold-dialog.png, J7-on-hold.png

### J8-cancel — PASS
- Feature: Member profile: cancel a member (status)
- Where: /dashboard/members/<id>
- Saw: options: Active/Inactive/Cancelled/Taster || toast: Profile updated || list: Print member cards Members 8 members · 8 need attention Add member 8 Total Members In this club 7 Paid Membership current 0 Overdue Needs chasing 8 Waivers Missing Paperwork risk 0 Tasters Convert soo
- Notes: profile after: CC Carl Cancelled Adult Monthly Cancelled Payment Paid Waiver missing Member since September 2026· Action needed Mark paid manually Edit 0 Total visits All-time
- Screens: J8-cancelled.png

### J9-parent-home — FAIL
- Feature: Parent portal: sign in, see the children
- Where: /member/home @375
- Saw: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Your action list 2 things to do Sign your waiver Every member signs once. Takes about a minute on the phone — the gym needs it on file before your next class. Sugges || profile: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Profile R Riverbank Grappling PP Priya Patel Sign your waiver Your gym needs this on file before your next class. Takes about a minute. Liability Waiver & Assumption
- Notes: both children listed: false; edit form has no emergency contact fields
- Screens: J9-parent-home.png, J9-parent-profile.png, J9-parent-edit.png

### K1-member-welcome — PASS
- Feature: Member portal: the welcome wizard on first sign-in (I train here)
- Where: /member/home @375
- Saw: What's your current belt? -> Which classes do you attend? -> Training preference? -> How did you find us? -> Any children training here? -> Health & Emergency Contact -> Liability Waiver -> Liability Waiver -> Health & Emergency Contact -> Liability Waiver -> Health & Emergency Contact
- Notes: 11 screens; waiver signed inside the wizard: false
- Screens: K1-w0.png, K1-w1.png, K1-w2.png, K1-w3.png, K1-w4.png, K1-w5.png, K1-w6.png, K1-w7.png, K1-waiver-filled.png, K1-w8.png, K1-waiver-filled.png, K1-w9.png, K1-w10.png, K1-waiver-filled.png, K1-w11.png, K1-profile-after.png

### K1-member-checkin — FAIL
- Feature: Member portal: Sign In to Class (self check-in)
- Where: /member/home @375
- Saw: 
- Notes: threw: locator.click: Timeout 30000ms exceeded.
- Screens: 

### K2-supervised-waiver-dana — FAIL
- Feature: Member profile: Open waiver on this device (Dana Hold)
- Where: /dashboard/members/<id>
- Saw: 
- Notes: threw: locator.fill: Timeout 30000ms exceeded.
- Screens: K2-waiver-dana-page.png

### K2-supervised-waiver-evan — FAIL
- Feature: Member profile: Open waiver on this device (Evan Unsigned)
- Where: /dashboard/members/<id>
- Saw: 
- Notes: threw: locator.fill: Timeout 30000ms exceeded.
- Screens: K2-waiver-evan-page.png

### K3-kiosk — PASS
- Feature: Kiosk: pick the class, tap your name; a full class refuses; an unsigned waiver is asked for
- Where: http://localhost:3847/kiosk/4z2yQM6Mjj_eoriMV83yd5Z9eVg04kWT
- Saw: Dana Hold: R Riverbank Grappling Class check-in ✉ Waiver required Dana hasn't signed the gym waiver yet. We'll send a link to their email address. Once they sign on their phone, check-in will continue automatica || Evan Unsigned: R Riverbank Grappling Class check-in ✉ Waiver required Evan hasn't signed the gym waiver yet. We'll send a link to their email address. Once they sign on their phone, check-in will continue automatica || Beth Overdue: R Riverbank Grappling Class check-in ✉ Waiver required Beth hasn't signed the gym waiver yet. We'll send a link to their email address. Once they sign on their phone, check-in will continue automatica
- Notes: expected: Dana checked in (2 of 2), Evan refused because the class is full, Beth asked to sign the waiver first
- Screens: K3-kiosk-after-class-dana.png, K3-kiosk-dana.png, K3-kiosk-after-class-evan.png, K3-kiosk-evan.png, K3-kiosk-after-class-beth.png, K3-kiosk-beth.png

### K3-register — PASS
- Feature: Register / Attendance / Reports after the check-ins
- Where: /dashboard/checkin
- Saw: register: Mark attendance Pick the session, then tick names or scan cards. The class on now is already selected. Session 09:58 · Saturday Open Mat NOW On now Tick names Scan cards Saturday Open Mat · 09:58–19:00 · 0 checked in of 1 expected Alex Paid No waiver Last seen || attendance: Attendance Recent check-ins across all classes 0 This Month check-ins 0 This Week check-ins 0 Active Members this month — Top Class this month All QR Scan Admin Self Kiosk No attendance records found Showing 0 of 0 records || reports: Reports Current owner snapshot, attendance trends, and class performance. Export CSV Window 4 weeks 8 weeks 12 weeks 16 weeks 24 weeks Class All classes Beginner BJJ Beginner BJJ 
- Notes: 
- Screens: K3-register.png, K3-attendance.png, K3-reports.png

### K5-parent-welcome — FAIL
- Feature: Parent portal: welcome wizard (I'm here to manage my child)
- Where: /member/home @375
- Saw: Any children training here? -> Health & Emergency Contact -> Liability Waiver -> Liability Waiver -> You're all set!
- Notes: 5 screens; My Family shows both children the desk linked: false
- Screens: K5-w0.png, K5-w1.png, K5-w2.png, K5-w3.png, K5-waiver-filled.png, K5-w4.png, K5-waiver-filled.png, K5-w5.png, K5-profile-after.png

### K5-parent-child-waiver — FAIL
- Feature: Parent portal: sign the waiver for a child
- Where: /member/family/<child> @375
- Saw: 
- Notes: threw: locator.waitFor: Timeout 10000ms exceeded.
- Screens: K5-child-page.png

### K5-parent-child-checkin — FAIL
- Feature: Parent portal: check a child in (Who's signing in?)
- Where: /member/home @375
- Saw: sheet: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Couldn't load your details — tap retry. Retry Your action list 1 thing to do Sign your waiver Every member signs once. Takes about a minute on the phone — the gym ne || after: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Couldn't load your details — tap retry. Retry Your action list 1 thing to do Sign your waiver Every member signs once. Takes about a minute on the phone — the gym ne
- Notes: the class is full (2 of 2) — the refusal wording for a child is the outcome to read
- Screens: K5-signin-sheet.png, K5-child-signed-in.png

### L1-member-waiver-inline — PASS
- Feature: Member portal: sign the waiver on the profile (inline form)
- Where: /member/profile @375
- Saw: toast: Add two-factor authentication to protect your account. Set up || member profile: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Profile R Riverbank Grappling AP Alex Paid Sign your waiver Your gym needs this on file before your next class. Tak
- Notes: canvas drawn: true; Sign waiver disabled before click: false; member side says signed: false; owner side: Waiver signed
- Screens: L1-waiver-form.png, L1-profile-after.png

### L2-member-checkin — FAIL
- Feature: Member portal: Sign In to Class (self check-in)
- Where: /member/home @375
- Saw: sheet: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Good morning, Alex Saturday 26 September NEXT CLASS Beginner BJJ Mon 28 Sept · 18:00–19:00 Sign In to Class Today's Classes 1 classes Saturday Open Mat 09:58–19:00 T || after: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Good morning, Alex Saturday 26 September NEXT CLASS Beginner BJJ Mon 28 Sept · 18:00–19:00 Sign In to Class Today's Classes 1 classes Saturday Open Mat 09:58–19:00 TBC Announcements Welcome to Riverbank Grappling Do
- Notes: 
- Screens: L2-signin-sheet.png, L2-signed-in.png

### L3-supervised-waiver-dana — FAIL
- Feature: Member profile: Open waiver on this device (Dana Hold)
- Where: /dashboard/members/<id>/waiver
- Saw: 
- Notes: threw: locator.click: Timeout 30000ms exceeded.
- Screens: 

### L3-supervised-waiver-evan — PASS
- Feature: Member profile: Open waiver on this device (Evan Unsigned)
- Where: /dashboard/members/<id>/waiver
- Saw: R Riverbank Grappling Membership waiver — please read carefully before signing Liability Waiver & Assumption of Risk Member: Evan Unsigned I acknowledge that martial arts and combat sports involve physical contact, which || after: R Riverbank Grappling Membership waiver — please read carefully before signing Liability Waiver & Assumption of Risk Member: Evan Unsigned I acknowledge that martial arts and combat sports involve phy
- Notes: emergency contact (Name/Phone/Relation) required first; Sign waiver disabled before click: false; profile now: Waiver signed
- Screens: L3-waiver-evan-filled.png, L3-waiver-evan-after.png

### L4-kiosk — PASS
- Feature: Kiosk: a signed member checks in; the class fills; unsigned is asked for a waiver
- Where: http://localhost:3847/kiosk/4z2yQM6Mjj_eoriMV83yd5Z9eVg04kWT
- Saw: Dana Hold: R Riverbank Grappling Class check-in ✉ Waiver required Dana hasn't signed the gym waiver yet. We'll send a link to their email address. Once they sign on their phone, check-in will continue automatically. Send waiver lin || Evan Unsigned: R Riverbank Grappling Class check-in ✓ Welcome, Evan! Saturday Open Mat || Beth Overdue: R Riverbank Grappling Class check-in ✉ Waiver required Beth hasn't signed the gym waiver yet. We'll send a link to their email address. Once they sign on their phone, check-in will continue automatically. Send waiver lin
- Notes: expected: Dana in (2 of 2 with Alex), Evan refused because full, Beth asked for a waiver (email)
- Screens: L4-kiosk-dana.png, L4-kiosk-evan.png, L4-kiosk-beth.png

### L4-register — PASS
- Feature: Register / Attendance / Reports after the check-ins
- Where: /dashboard/checkin
- Saw: register: Mark attendance Pick the session, then tick names or scan cards. The class on now is already selected. Session 09:58 · Saturday Open Mat NOW On now Tick names Scan cards Saturday Open Mat · 09:58–19:00 · 1 checked in of 2 expected Alex Paid Waiver Last seen Never Medical [] Evan Unsigned WALK-IN Kio || attendance: Attendance Recent check-ins across all classes 1 This Month check-ins 1 This Week check-ins 1 Active Members this month Saturday Open Mat Top Class this month All QR Scan Admin Self Kiosk Attendance records Member Class Date Time Method Evan Unsigned Saturday Open Mat 26 Sept 2026 09:58 Kiosk Showin || reports: Reports Current owner snapshot, attendance trends, and class 
- Notes: 
- Screens: L4-register.png, L4-attendance.png, L4-reports.png

### L5-parent-family — PASS
- Feature: Parent portal: My Family lists the children the desk linked
- Where: /member/profile @375
- Saw: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Profile R Riverbank Grappling PP Priya Patel Sign your waiver Your gym needs this on file before your next class. Takes about a minute. Liability Waiver & Assumption of Risk I acknowledge that martial arts and combat sports involve physical contact, which carries an inherent risk of injury. By signing this waiver, I voluntarily accept all risks associated with training and participation at Riverbank Grappling. I
- Notes: My Family section: true; both children listed: true
- Screens: 

### L5-parent-child-waiver — PASS
- Feature: Parent portal: sign the waiver for a child
- Where: /member/family/<child> @375
- Saw: before: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Back to profile Ravi Patel Age 9 · Kids BELT Not awarded yet WAIVER Missing THIS WEEK 0 THIS MONTH 0 STREAK 0wk ALL || toast: Add two-factor authentication to protect your account. Set up || right after: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Back to profile Ravi Patel Age 9 · Kids BELT Not awarded yet WAIVER Missing THIS WEEK 0 THIS MONTH 0 STREAK 0wk ALL TIME 0 Milestones Check in to your first class to || after reload: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Back to profile Ravi Patel Age 9 · Kids BELT Not a
- Notes: 
- Screens: L5-child-waiver-form.png, L5-child-page-after.png

### L5-parent-child-checkin — PASS
- Feature: Parent portal: check a child in (Who's signing in?)
- Where: /member/home @375
- Saw: sheet: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Your action list 1 thing to do Sign your waiver Every member signs once. Takes about a minute on the phone — the gym needs it on file before your next class. Suggested by MatFlow Good morning, Priya Saturday 26 Sept || after: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Your action list 1 thing to do Sign your waiver Every member signs once. Takes about a minute on the phone — the gym needs it on file before your next class. Suggested by MatFlow Good morning, Priya Saturday 26 Sept
- Notes: the class is full (Alex + Dana) so the expected outcome is a refusal in words for the child
- Screens: L5-signin-sheet.png, L5-child-signed-in.png

### M1-member-checkin-confirm — FAIL
- Feature: Member portal: Sign In to Class, then Confirm Sign In
- Where: /member/home @375
- Saw: sheet: Sign in to a class Select your class for today: Saturday Open Mat 09:58–19:00 · TBC Confirm Sign In Home Schedule Progress Profile || after: Sign in to a class Select your class for today: Saturday Open Mat 09:58–19:00 · TBC Home Schedule Progress Profile
- Notes: Confirm Sign In disabled before the class was picked: false
- Screens: M1-sheet.png, M1-after.png

### M2-supervised-waiver-dana — PASS
- Feature: Member profile (on hold): Open waiver on this device → sign
- Where: /dashboard/members/<id>/waiver
- Saw: Dana Hold · Adult 4-weekly · Active · On hold until 10 Oct 2026 · Waiver signed · Waiver and Compliance: Waiver signed 26 Sept 2026
- Notes: M2 signed the waiver and then timed out reloading the profile (dev-server latency); N3 found no button because the waiver was already signed. Evidence N3-dana-profile.png.
- Screens: N3-dana-profile.png, M2-waiver-dana-after.png

### M3-kiosk-full — PASS
- Feature: Kiosk: the class is full (2 of 2); an unsigned member is asked for a waiver
- Where: http://localhost:3847/kiosk/4z2yQM6Mjj_eoriMV83yd5Z9eVg04kWT
- Saw: Dana Hold (class button read: Saturday Open Mat 09:58–19:00): R Riverbank Grappling Class check-in Checking you in… || Beth Overdue (class button read: Saturday Open Mat 09:58–19:00): R Riverbank Grappling Class check-in Checking into Saturday Open Mat No match yet — keep typing. ← Back to classes
- Notes: Alex and Evan hold the two places; Dana should be refused in words; Beth has no waiver
- Screens: M3-kiosk-dana.png, M3-kiosk-beth.png

### M4-parent-own-waiver — FAIL
- Feature: Parent portal: the parent signs their own waiver (inline)
- Where: /member/profile @375
- Saw: 
- Notes: owner side: Liability waiver missing
- Screens: M4-waiver-form.png

### M4-parent-child-checkin — PASS
- Feature: Parent portal: check a child in (Who's signing in? then Confirm Sign In)
- Where: /member/home @375
- Saw: sheet: Sign in to a class Who's signing in? Priya Ravi Patel Sana Patel Select your class for today: Saturday Open Mat 09:58–19:00 · TBC Confirm Sign In Home Schedule Progress Profile || after: Sign in to a class Ravi Patel signed in! Saturday Open Mat Home Schedule Progress Profile
- Notes: Confirm disabled before pick: false; the class holds 2 of 2, so the honest outcome for Ravi is a refusal in words (or a kids-eligibility refusal)
- Screens: M4-child-sheet.png, M4-child-after.png

### M5-staff-reads — PASS
- Feature: Register, Attendance, Payments hub and Reports after the journeys
- Where: /dashboard/checkin
- Saw: register: Mark attendance Pick the session, then tick names or scan cards. The class on now is already selected. Session 09:58 · Saturday Open Mat NOW On now Tick names Scan cards Saturday Open Mat · 09:58–19:00 · 2 checked in of 2 expected Alex Paid Self Waiver Last se || attendance: Attendance Recent check-ins across all classes 2 This Month check-ins 2 This Week check-ins 2 Active Members this month Saturday Open Mat Top Class this month All QR Scan Admin Self Kiosk Attendance records Member Class Date Time Method Alex Paid Saturday Open || payments: Payment history 1 payment total Record payment Outstanding At the desk All payments Nobody owes you right now Every active member is up to d
- Notes: 
- Screens: M5-register.png, M5-attendance.png, M5-payments.png, M5-reports.png, M5-home.png

### M6-member-billing — PASS
- Feature: Member portal: billing page (cash member, no Stripe)
- Where: /member/billing @375
- Saw: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Profile Billing Your payment method, subscription and payment history. Billing & payment methods Your gym manages billing for your membership. For billing changes or cancellations, ask at Riverbank Grappling's front desk next time you're in. Payment history Last 100 payments on this account. £45.00 26 Sept 2026 · Cash — Adult Monthly, cash at the desk Paid Home Schedule Progress Profile
- Notes: bottom nav: Home | Schedule | Progress | Profile; /member/billing is NOT in the bottom nav (reached by URL only)
- Screens: M6-member-billing.png

### M1-member — PASS
- Feature: Member portal: Sign In to Class, then Confirm Sign In
- Where: /member/home @375
- Saw: register: Saturday Open Mat · 2 checked in of 2 expected · Alex Paid · Self
- Notes: the M1 row read the sheet 3 s after Confirm while the button still showed a spinner (M1-after.png); the register (M5-register.png) and the Attendance page show Alex checked in by method Self. Usability: the confirm took longer than 3 s on this dev server with no wording, only a spinner
- Screens: M1-after.png, M5-register.png

### N1-ravi-record-probe — FAIL
- Feature: Parent checks a child in: is the record on the staff side (register said 2 of 2 without Ravi)
- Where: /dashboard/attendance
- Saw: attendance: Attendance Recent check-ins across all classes 2 This Month check-ins 2 This Week check-ins 2 Active Members this month Saturday Open Mat Top Class this month All QR Scan Admin Self Kiosk Attendance records Member Class Date Time Method Alex Paid Saturday Open Mat 26 Sept 2026 09:58 Self Evan Unsigned Saturday Open Mat 26 Sept 2026 09:58 Kiosk Showing 2 of 2 records || ravi profile:  || register: Mark attendance Pick the session, then tick names or scan cards. The class on now is already selected. Session 09:58 · Saturday Open Mat NOW On now Tick names Scan cards Saturday Open Mat · 09:58–19:00 · 2 checked in of 2 expected Alex Paid Self Waiver Last seen Never Medical [] Evan Uns
- Notes: Ravi in Attendance list: false; Ravi profile shows the class: false; Ravi on the register: false. The portal said "Ravi Patel signed in!" for a class already at 2 of 2 capacity.
- Screens: N1-attendance.png

### N2-register-brackets-probe — PASS
- Feature: Register row detail: Medical flag and a raw [] next to Alex
- Where: /dashboard/checkin + Alex profile
- Saw: register row: Alex Paid Self || profile near Health: (no Health/Medical heading)
- Notes: raw "[]" on the register row: false; row HTML: <div class="flex flex-wrap items-center gap-2"><p class="truncate text-sm font-semibold text-tx-1">Alex Paid</p><span class="text-[10px] font-medium text-tx-3">Self</span></div>
- Screens: N2-alex-profile.png

### N3-supervised-waiver-dana — FAIL
- Feature: Member profile (on hold): Open waiver on this device → sign
- Where: /dashboard/members/<id>/waiver
- Saw: Mark paid manually / Edit / Overview / Attendance (0) / Payments (0) / Ranks (0) / Internal Notes / Photos / Start membership / Ad-hoc charge / Link existing / Add child
- Notes: no Open waiver on this device control on an on-hold member's profile
- Screens: N3-dana-profile.png

### N4-kiosk-hold-and-unsigned — PASS
- Feature: Kiosk: a member on hold, and a member with no waiver, at a class already 2 of 2
- Where: http://localhost:3847/kiosk/4z2yQM6Mjj_eoriMV83yd5Z9eVg04kWT
- Saw: Dana Hold: R Riverbank Grappling Class check-in Pick your class Saturday Open Mat 09:58–19:00 || Beth Overdue: R Riverbank Grappling Class check-in ✉ Waiver required Beth hasn't signed the gym waiver yet. We'll send a link to their email address. Once they sign on their phone, check-in will continue automatically. Send waiver linkCancel
- Notes: Dana is on hold until 10 Oct with a signed waiver; Beth has no waiver. Alex, Evan (and Ravi?) already hold the places of a 2-capacity class
- Screens: N4-kiosk-dana.png, N4-kiosk-beth.png

### N5-parent-own-waiver — PASS
- Feature: Parent portal: the parent signs their own waiver (inline)
- Where: /member/profile @375
- Saw: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Profile R Riverbank Grappling PP Priya Patel My Family Tap a child to see their progress and attendance RP Ravi Patel Age 9 No belt yet · 0 classes SP Sana Patel Age 12 No belt yet · 0 classes Add another child Belt updates managed by your coach · or ask Riverbank Grappling front desk PERSONAL DETAILS Edit NAME Pr
- Notes: owner side: Waiver signed
- Screens: N5-waiver-form.png, N5-waiver-after.png

### N6-manager-login-nav — PASS
- Feature: Manager session: login, nav, what a manager can reach
- Where: /login?club= @1440
- Saw: landed /dashboard || nav: Dashboard | Timetable | Mark Attendance | Members | Attendance | Ranks | Promotions | Notifications | Reports | Conversion | Payments | Home | Schedule | Register || Today at Riverbank Grappling Saturday 26 September Check-In Add Class Needs attention today 7 specific things to handle — tap any to action it 7 👋 Beth Overdue Not seen in 14+ days 👋 Dana Hold Not s
- Notes: the dialog said Manager = all access except billing
- Screens: N6-manager-home.png

### N6-manager-record-payment-double-submit — FAIL
- Feature: Manager records a cash payment; the button is pressed twice
- Where: /dashboard/members/<beth>
- Saw: BO Beth Overdue Adult 4-weekly Active Payment Paid Waiver missing Member since September 2026· Action needed Mark paid manually Edit 0 Total visits All-time check-ins 0 This month Current month 0 This week Current week Never Last visit No check-ins yet 0 Subscriptions Class follows Overview Attendan
- Notes: no Record payment control for the manager
- Screens: N6-beth-profile.png

### N6-manager-settings-reach — PASS
- Feature: Manager at Settings, Memberships, Payments, Reports, Staff
- Where: /dashboard/settings
- Saw: /dashboard/settings → /dashboard :: Today at Riverbank Grappling Saturday 26 September Check-In Add Class Needs attention today 7 specific things to handle — tap any to action  || /dashboard/settings?tab=revenue → /dashboard :: Today at Riverbank Grappling Saturday 26 September Check-In Add Class Needs attention today 7 specific things to handle — tap any to action  || /dashboard/settings?tab=staff → /dashboard :: Today at Riverbank Grappling Saturday 26 September Check-In Add Class Needs attention today 7 specific things to handle — tap any to action  || /dashboard/memberships → /dashboard :: Today at Riverbank Grappling Saturday 26 September Check-In Add Class Needs attention today 7 speci
- Notes: judge each against the role promise: all access except billing
- Screens: N6-manager-settings.png

### N7-coach-login-nav — PASS
- Feature: Coach session: login, nav, register
- Where: /login?club= @915
- Saw: landed /dashboard || nav: Dashboard | Timetable | Mark Attendance | Members | Attendance | Ranks | Home | Schedule | Register || register: Mark attendance Pick the session, then tick names or scan cards. The class on now is already selected. Session 09:58 · Saturday Open Mat NOW On now Tick names Scan cards Saturday Open Mat · 09:58–19:00 · 2 checked in of 
- Notes: the dialog said Coach = attendance + members
- Screens: N7-coach-home.png, N7-coach-register.png

### N7-coach-refused-routes — PASS
- Feature: Coach at owner-only routes: Settings, Memberships, Payments, Reports, Staff
- Where: /dashboard/settings
- Saw: /dashboard/settings → /dashboard :: Today at Riverbank Grappling Saturday 26 September Needs attention today 7 specific things to handle — tap any to action it 7 👋 Beth Overdu || /dashboard/memberships → /dashboard :: Today at Riverbank Grappling Saturday 26 September Needs attention today 7 specific things to handle — tap any to action it 7 👋 Beth Overdu || /dashboard/payments → /dashboard :: Today at Riverbank Grappling Saturday 26 September Needs attention today 7 specific things to handle — tap any to action it 7 👋 Beth Overdu || /dashboard/reports → /dashboard :: Today at Riverbank Grappling Saturday 26 September Needs attention today 7 specific things to handle — tap any to action i
- Notes: a refusal should be in words (not a blank page, not a silent redirect with no explanation)
- Screens: N7-coach-settings.png, N7-coach-payments.png

### N7-coach-marks-attendance — PASS
- Feature: Coach ticks a name on the register (Dana, on hold)
- Where: /dashboard/checkin
- Saw: found: 1 || toast:  || n cards Saturday Open Mat · 09:58–19:00 · 2 checked in of 2 expected Alex Paid Self Waiver Last seen Never Evan Unsigned WALK-IN Kiosk Waiver Last seen Never Add someone Dana Hold Marking… Kiosk disabled · ask the owner to manage
- Notes: on hold + full class: the honest outcome is a refusal or an override in words; count what the register says after
- Screens: N7-coach-dana-tick.png

### P1-comms-owner-view — PASS
- Feature: Notifications page: the announcement and any delivery state
- Where: /dashboard/notifications
- Saw: Announcements Post updates to your gym community New post Announcements Title Message Posted Status Welcome to Riverbank Grappling Doors open at 17:30. Please sign your waiver before your first class. 26 Sept 2026· 1h ago Posted Delete
- Notes: controls: New post | Title | Posted | Status | Delete | Welcome to Riverbank GrapplingDoors open at 17:30. Please sign your waiver before your first class.1h ago. Mail is unconfigured locally: does the screen say so anywhere?
- Screens: P1-notifications.png

### P1-comms-member-view — FAIL
- Feature: Member sees the announcement in the portal
- Where: /member/home @375
- Saw: modal on first paint:  || notifications page: 404 This page could not be found.
- Notes: 
- Screens: P1-member-home-modal.png, P1-member-notifications.png

### P2-export-payments — NOT AVAILABLE
- Feature: Payments: Export CSV downloads a file
- Where: /dashboard/payments
- Saw: Payment history 1 payment total Record payment Outstanding At the desk All payments Nobody owes you right now Every active member is up to date. Failed and overdue payments appear here.
- Notes: no Export control on this screen
- Screens: 

### P2-export-reports — PASS
- Feature: Reports: Export CSV downloads a file
- Where: /dashboard/reports
- Saw: file matflow-reports-2026-09-26.csv · 33 lines · header: Section,Metric,Value,Detail · row 2: Summary,Total members,8,
- Notes: check the header names are in words, money has a unit, no raw ids without names
- Screens: 

### P3-import-upload — NOT AVAILABLE
- Feature: Members: Import CSV (upload → preview)
- Where: /dashboard/members (Import)
- Saw: Print member cards Members 8 members · 5 need attention Add member 8 Total Members In this club 7 Paid Membership current 0 Overdue Needs chasing 3 Waivers Missing Paperwork risk 0 Tasters Convert soon All · 8 Needs Attention · 5 Waiver Missing · 3 Missing Phone · 2 Quiet (14d+) · 4 Kids · 2 Filters
- Notes: no Import control on the members screen
- Screens: 

### P4-stripe-connect — FAIL
- Feature: Settings > Revenue: Connect Stripe
- Where: /dashboard/settings?tab=revenue
- Saw: revenue tab: WORKSPACE Settings Riverbank Grappling · Pro plan SR Sam Rivers sam.rivers+mui2qf2w@example.test Owner Overview Branding Revenue Store Staff Account Waiver Integrations Stripe Connect Connect your Stripe account so members pay you directly — MatFlow never holds your funds. Connect Stripe How members || landed: http://localhost:3847/dashboard/settings?tab=revenue :: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → R Riverbank Grappling MAIN Dashboard Timetable Mark Attendance Members Attendance ADMIN Ranks Promotions Notifica
- Notes: did not reach Stripe
- Screens: P4-revenue-tab.png, P4-after-connect.png

### P5-public-pages — PASS
- Feature: Public: leaderboard link, club short URL, kiosk link (fresh device)
- Where: http://localhost:3847/leaderboard/kbW632dbFep59KdOotvxnCJTJj-aqRKd
- Saw: leaderboard: R Riverbank Grappling Attendance leaderboard · September 2026 1 Alex P. 1 SESSION 2 Dana H. 1 SESSION 3 Evan U. 1 SESSION Movement arrows start next month. || /riverbank-grappling → /login?club=riverbank-grappling :: Back R Riverbank Grappling riverbank-grappling Sign in to your account Sign in Email me a sign-in link Forgot password? || bad token: 404 This page could not be found.
- Notes: the leaderboard should show first name + initial only; the club URL should be the branded login
- Screens: P5-leaderboard.png, P5-slug-login.png

### P6-owner-2fa-enrol — FAIL
- Feature: Owner enrols two-factor authentication from the banner
- Where: /login/totp/setup
- Saw: Two-factor authentication is recommended. Set up now to protect your gym. Set up now → R Riverbank Grappling MAIN Dashboard Timetable Mark Attendance Members Attendance ADMIN Ranks Promotions Notifications Reports Conversion Memberships Payments Analysis Settings MatFlow v1.0 R BACK OFFICE Dashboard Owner SR Sam Finish setting up your gym — 1 item remaining Connect Stripe Today at Riverbank Grappl
- Notes: no text secret found beside the QR (a customer with no camera-phone cannot enrol)
- Screens: P6-2fa-setup.png

### N2-register-brackets — FAIL
- Feature: Register row detail: a red Medical flag with a raw [] next to Alex
- Where: /dashboard/checkin
- Saw: Alex Paid · Self · Waiver · Last seen Never · Medical · ⚠ []
- Notes: The register renders a red Medical flag and a warning triangle followed by the raw text []. Alex entered no medical conditions in the welcome wizard (his profile says Medical notes: None recorded), so the register shows a false alarm and leaks an empty JSON array. Evidence M5-register.png; N1 register text.
- Screens: M5-register.png

### Q1-child-checkin-wire — FAIL
- Feature: Parent checks a child in: what the server answered while the sheet said signed in
- Where: /member/home @375
- Saw: sheet: Sign in to a class Who's signing in? Priya Ravi Patel Sana Patel Select your class for today: Saturday Open Mat 09:58–19:00 · TBC A signed waiver is needed before checking in. Sign it in your profile  || wire: POST /api/checkin → 403 {"error":"A signed waiver is needed before checking in. Sign it in your profile or ask your gym.","reason":"waiver_unsigned"} || attendance: Attendance records Member Class Date Time Method Dana Hold Saturday Open Mat 26 Sept 2026 09:58 Admin · by Coach Mike Okoro Alex Paid Saturday Open Mat 26 Sept 2026 09:58 Self Evan Unsigned Saturday Open Mat 26 Sept 2026 09:58 Kiosk Showing 3 of 3 records
- Notes: sheet claimed signed in: false; Sana in the Attendance list: false
- Screens: Q1-sana-after.png

### Q2-kiosk-dana-wire — FAIL
- Feature: Kiosk: an on-hold member at a full class — what the server said and what the screen said
- Where: http://localhost:3847/kiosk/4z2yQM6Mjj_eoriMV83yd5Z9eVg04kWT
- Saw: 
- Notes: threw: locator.click: Timeout 30000ms exceeded.
- Screens: 

### Q3-register-after-coach — PASS
- Feature: Register after a coach ticked an on-hold member into a 2 of 2 class
- Where: /dashboard/checkin
- Saw: rds Saturday Open Mat · 09:58–19:00 · 3 checked in of 3 expected Alex Paid Self Waiver Last seen Never Medical [] Evan Unsigned WALK-IN Kiosk Waiver Last seen Never Dana Hold WALK-IN Admin Waiver Last seen Never Add someone Kiosk Check-In iPad URL for self check-in. Disconnected from your admin login. Active Active since 26/09/2026. The URL was shown once when you generated it; if you've lost it, regenerate to mint a new one. Regenerate URL Disable kiosk R
- Notes: Dana on the register: true; the leaderboard already showed Dana H. 1 session, so the coach's tick admitted her. Any warning was shown to the coach? none captured (N7: Marking… then nothing)
- Screens: Q3-register.png

### Q4-stripe-connect-continue — BLOCKED
- Feature: Settings > Revenue: Connect Stripe → Before connecting Stripe → Continue to Stripe
- Where: /dashboard/settings?tab=revenue
- Saw: dialog: Before connecting Stripe By continuing you agree to MatFlow's Platform Terms of Service, Acceptable Use Policy and Privacy Policy (matflow.studio/legal). You confirm that you (the gym) are the merchant of record for all payments collected via this account, and that MatFlow is a software platform — n || landed: https://connect.stripe.com/oauth/v2/authorize?client_id=ca_UQjg8IIm9jUVnjEN9wYIttkaIiJcLrBy&response_type=code&scope=read_write&state=f101a8 :: matflow matflow uses Stripe for secure payments. Return to matflow You're using a test account with test data. Skip setup by connecting a blank test account. Use blank account Get started with Stripe If you’re completing this form on be
- Notes: dependency: a Stripe account sign-in (real OAuth on Stripe's page). Card journeys continue as a labelled diagnostic, reported apart.
- Screens: Q4-stripe-landing.png

### Q5-owner-2fa-enrol — FAIL
- Feature: Owner enrols two-factor authentication (Settings > Account)
- Where: /dashboard/settings?tab=account
- Saw: 
- Notes: threw: Cannot read properties of undefined (reading 'generate')
- Screens: Q5-2fa-setup.png

### Q6-export-payments — NOT AVAILABLE
- Feature: Payments hub > All payments: Export CSV
- Where: /dashboard/payments
- Saw: Payment history 1 payment total Record payment Outstanding At the desk All payments All Paid Failed Refunded Disputed Pending Payment history Date Member Type Amount Status Description 26 Sept 2026 09:56 Alex Paid alex.paid+mui2qf2w@example.test Adult Monthly £45.00 Paid Cash — Adult Monthly, cash at the desk View payments
- Notes: no Export CSV under All payments either
- Screens: Q6-all-payments.png

### Q7-import-upload — FAIL
- Feature: Settings > Integrations: Import members (upload → preview)
- Where: /dashboard/settings?tab=integrations
- Saw: panel:  || toast: 
- Notes: 
- Screens: Q7-import-panel.png, Q7-import-after.png

### Q8-manager-record-payment-double — PASS
- Feature: Manager records a cash payment from the Payments tab; the button is pressed twice
- Where: /dashboard/members/<beth>?tab=payments
- Saw: toast: Payment recorded || wire: POST /api/payments/manual → 201 {"id":"cmui8gzrn02011otgbbwkyj5j","tenantId":"cmui2twqv01nt1otg8ceab2cz","memberId":"cmui4w78l01t41otgck5uqfis","stripeInvoiceId":null,"stripePaymentIntentId":null,"stripeChargeId":null,"amountPence":5500,"currency":"GBP","status":"succeeded","description":"Cash — Adult 4-weekly, cash (manager)","pa
- Notes: £55 rows after a double click: 1 (1 = protected; 2 = double charge recorded; -1 = no table)
- Screens: Q8-beth-payments-after.png

### Q9-member-announcement-reread — PASS
- Feature: Member portal: where an announcement lives after the first-paint dialog
- Where: /member/home @375
- Saw: home: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up Good morning, Alex Saturday 26 September NEXT CLASS Beginner BJJ Mon 28 Sept · 18:00–19:00 Sign In to Class Today's Classes 1 classes Saturday Open Mat 09:58–19:00 TBC Announcements Welcome to Riverbank Grappling Do || nav: Home | Schedule | Progress | Profile
- Notes: announcement text found on: /member/home
- Screens: 

### R1-child-checkin-full-class-wire — FAIL
- Feature: Parent checks a child in to a full class: server refusal vs the sheet's words
- Where: /member/home @375
- Saw: sheet: Sign in to a class Ravi Patel signed in! Saturday Open Mat Home Schedule Progress Profile || wire: POST /api/checkin → 409 {"error":"This class is full — 3 of 2 places are taken. Ask staff if there is room."} || attendance: Showing 3 of 3 records
- Notes: sheet claimed signed in: true; Ravi recorded: false. Mechanism (read after the fact, app/member/home/page.tsx): the sheet treats any 409 as success, and the server answers 409 for class_full, outside_window and already-checked-in, so the server's honest refusal wording never reaches the member.
- Screens: R1-ravi-after.png

### R2-kiosk-search-after-checkin — PASS
- Feature: Kiosk: a member who is already checked in searches for their name
- Where: http://localhost:3847/kiosk/4z2yQM6Mjj_eoriMV83yd5Z9eVg04kWT
- Saw: search: Class check-in ! Couldn't check you in Your membership is on hold until 10 Oct 2026 — ask staff to resume it early. Try again || after tap: (no Dana button) || wire: POST /api/kiosk/4z2yQM6Mjj_eoriMV83yd5Z9eVg04kWT/checkin → 403 {"error":"Your membership is on hold until 10 Oct 2026 — ask staff to resume it early.","reason":"on_hold"}
- Notes: in N4, before the coach ticked her, Dana's tap went Checking you in… → Pick your class with no words (an on-hold member, and a full class)
- Screens: R2-kiosk-dana-search.png

### R3-owner-2fa-enrol — FAIL
- Feature: Owner enrols two-factor authentication (Settings > Account)
- Where: /dashboard/settings?tab=account
- Saw: 
- Notes: threw: locator.fill: Timeout 30000ms exceeded.
- Screens: R3-2fa-setup.png

### R4-export-payments — PASS
- Feature: Payments: Export CSV (via View payments)
- Where: /dashboard/payments
- Saw: on /dashboard/settings?tab=revenue · file matflow-payments-2026-09-26.csv · 3 lines · header: Date,Member name,Member email,Amount (pence),Currency,Status,Description,Stripe invoice,Stripe payment intent,Refunded at,Refunded (pence) · row 2: 2026-09-26T10:15:01.139Z,Beth Overdue,beth.overdue+mui2qf2w@example.test,5500,GBP,succeeded,"Cash — Adult 4-weekly, cash (manager)",,,,
- Notes: the export lives at /dashboard/settings?tab=revenue, not on the Payments hub
- Screens: R4-export-where.png

### R5-import-upload — BLOCKED
- Feature: Settings > Integrations: Import members (upload → preview)
- Where: /dashboard/settings?tab=integrations
- Saw: before: Member CSV import Migrate members from MindBody, Glofox, Wodify, or any CSV. Dry-run preview before commit. Existing emails are skipped, never overwritten. Source Generic CSV MindBody Glofox Wodify TeamUp Standard headers: name, email, phone, dob, membership, status, joined CSV file (max 10MB) Uploa || button: Upload + preview || after: Member CSV import Migrate members from MindBody, Glofox, Wodify, or any CSV. Dry-run preview before commit. Existing emails are skipped, never overwritten. File uploads not configured Source Generic CSV MindBody Glofox Wodify TeamUp Standard headers: name, email, phone, dob, membership, status, joined CSV file (max 10MB) Upload + preview || toast: Fil
- Notes: dependency: BLOB_READ_WRITE_TOKEN is not set locally, so the upload cannot be stored.
- Screens: R5-import-panel.png, R5-import-after.png

### R6-stripe-connect-blank-test-account — FAIL
- Feature: Connect Stripe: Stripe's test-mode 'Use blank account' skip → back in MatFlow connected
- Where: /dashboard/settings?tab=revenue
- Saw: returned to https://matflow.studio/api/stripe/connect/callback?scope=read_write&code=ac_VKXostdqcKiTWLXDDiwBWpF0nbd6ybxr&state=6020e185e7927cd057a02e769fe7fb125aa96113c67b9f076912455e151c06c9%3Acmui2twqv01nt1otg8ceab2cz%3A1790418040934 || toast:  ||  || revenue tab: Stripe Connect Connect your Stripe account so members pay you directly — MatFlow never holds your funds. Connect Stripe How members pay Decides what the member shop offers. Pay at desk only Card payments online Allow members to manage their own billing Members will see your contact details instead of self-service billing. BILLING CONTACT (SHOWN WHEN SELF-SERVICE IS OFF) Save contact details Privac
- Notes: Stripe test mode offers a blank connected account on its own OAuth page; on live keys a real Stripe sign-in is required, so this proves MatFlow's side of the door, not the customer's Stripe onboarding
- Screens: R6-after-callback.png, R6-revenue-connected.png

### R7-card-subscription-doors — FAIL
- Feature: After connecting: Start membership (desk) and the member billing page (portal)
- Where: /dashboard/members/<alex> + /member/billing
- Saw: 
- Notes: threw: locator.click: Timeout 30000ms exceeded.
- Screens: R7-rail-impact.png

### S0-owner-2fa-enrol — PASS
- Feature: Owner enrols two-factor authentication (Settings > Account > Authenticator App)
- Where: /dashboard/settings?tab=account
- Saw: Set up Authenticator: QR + Manual key → I've scanned it → Enter the 6-digit code → Verify & Enable → Account tab: Authenticator App Enabled · Regenerate codes · Once enabled, 2FA cannot be turned off
- Notes: enrolled with the on-screen manual key (no camera needed). The harness regex missed the word Enabled; the screen shows it (S0-2fa-after.png).
- Screens: S0-2fa-code-step.png, S0-2fa-after.png

### T1-add-member-refresh-and-back — PASS
- Feature: Add member: refresh mid-form; browser Back after saving
- Where: /dashboard/members
- Saw: Refresh Test: 0 rows (No members match); Back Test: 1 row; members total 10
- Notes: counted table rows (05d). A refresh mid-form loses the draft silently with no warning (expected, noted as polish). Back after the save returned to the previous page and did not resubmit.
- Screens: T1-filled.png, T1-after-back.png

### T2-add-member-double-submit — PASS
- Feature: Add member: the button is pressed twice
- Where: /dashboard/members
- Saw: Dupe Test: 1 row after a double click; toast 'Dupe Test added'
- Notes: counted table rows (05d); the earlier text-hit count included the search heading
- Screens: T2-after.png

### T3-add-member-invalid-input — PASS
- Feature: Add member: 300-character name, a bad email, a duplicate email
- Where: /dashboard/members
- Saw: Alex Again profile links: 0; 300-char name profile links: 0. Wording: 300-char name → "Invalid data" (input kept, no field named); bad email → the browser's own "Please include an '@'"; duplicate → "A member with that email already exists"
- Notes: "Invalid data" for an over-long name does not say which field or the limit
- Screens: 

### T4-injected-500 — PASS
- Feature: A failed request on Members, Reports and the member Schedule: error state vs empty state
- Where: /dashboard/members
- Saw: members: Print member cards Couldn't check who's ready to move to an adult account — tap to retry Try again Members 8 members · 5 need attention Add member 8 Total Members In this club 7 Paid Membership current 0 Overdue Needs chasing 3 Waivers Missing Paperwork risk 0 || reports: Reports Current owner snapshot, attendance trends, and class performance. Export CSV Window 4 weeks 8 weeks 12 weeks 16 weeks 24 weeks Class All classes Beginner BJJ Beginner BJJ Beginner BJJ No-Gi Saturday Open Mat Age group All Adults Kids Rate Check-ins per || member schedule: RG Riverbank Grappling Add two-factor authentication to protect your account. Set up 21–27 September Today MON 21 TUE 22 WED 23 THU 24 FR
- Notes: honest error wording — members: true, reports: true, member schedule: true (false = the page looked empty or fine while the request failed)
- Screens: T4-members-500.png, T4-reports-500.png, T4-schedule-500.png

### T5-record-payment-timeout — PASS
- Feature: Record payment: the request is dropped, then retried
- Where: /dashboard/members/<alex>?tab=payments
- Saw: after the dropped request: dialog open true; wording: (none); amount kept: 12 || retry toast: Payment recorded || £12 rows: 1
- Notes: the dialog should stay open with the input kept and say to retry; the retry should record exactly one payment
- Screens: T5-timeout.png

### T6-expired-session-on-submit — FAIL
- Feature: Add member after the session has expired
- Where: /dashboard/members
- Saw: Expired Session profile links: 0; after Save with an expired session the dialog stayed open with no toast, no message and no redirect (T6-expired.png)
- Notes: nothing was saved and the customer was told nothing; the honest outcome is a sign-in prompt with the draft kept
- Screens: 

### T7-layout-phone — PASS
- Feature: Staff screens at 375px: horizontal overflow and small targets
- Where: /dashboard, /dashboard/members, /dashboard/members/cmui4vz0401sy1otg327bk1vc, /dashboard/timetable, /dashboard/settings, /dashboard/checkin, /dashboard/payments, /dashboard/reports, /dashboard/memberships
- Saw: /: overflow 0px, 0/29 targets under 44px || /members: overflow 0px, 1/10 targets under 44px || /members/cmui4vz0401sy1otg327bk1vc: overflow 0px, 2/11 targets under 44px, under 24px: Set member's picture || /timetable: overflow 0px, 2/18 targets under 44px || /settings: overflow 0px, 1/9 targets under 44px || /checkin: overflow 0px, 0/7 targets under 44px || /payments: overflow 0px, 4/4 targets under 44px || /reports: overflow 0px, 3/7 targets under 44px || /memberships: overflow 0px, 8/9 targets under 44px
- Notes: 0 screen(s) with horizontal page scroll; 44 px is the product's own floor (UI-RULES), 24 px is WCAG AA
- Screens: T7-phone-dashboard.png, T7-phone-members.png, T7-phone-timetable.png, T7-phone-settings.png, T7-phone-checkin.png

### T7-layout-tablet — PASS
- Feature: Staff screens at 915px: horizontal overflow and small targets
- Where: /dashboard, /dashboard/members, /dashboard/members/cmui4vz0401sy1otg327bk1vc, /dashboard/timetable, /dashboard/settings, /dashboard/checkin, /dashboard/payments, /dashboard/reports, /dashboard/memberships
- Saw: /: overflow 0px, 0/8 targets under 44px || /members: overflow 0px, 1/10 targets under 44px || /members/cmui4vz0401sy1otg327bk1vc: overflow 0px, 2/11 targets under 44px, under 24px: Set member's picture || /timetable: overflow 0px, 2/15 targets under 44px || /settings: overflow 0px, 1/9 targets under 44px || /checkin: overflow 0px, 0/6 targets under 44px || /payments: overflow 0px, 4/4 targets under 44px || /reports: overflow 0px, 6/7 targets under 44px || /memberships: overflow 0px, 13/14 targets under 44px, under 24px: Tier/Price/Cycle/Active members
- Notes: 0 screen(s) with horizontal page scroll; 44 px is the product's own floor (UI-RULES), 24 px is WCAG AA
- Screens: T7-tablet-dashboard.png, T7-tablet-members.png, T7-tablet-timetable.png, T7-tablet-settings.png, T7-tablet-checkin.png

### T7-layout-desktop — PASS
- Feature: Staff screens at 1440px: horizontal overflow and small targets
- Where: /dashboard, /dashboard/members, /dashboard/members/cmui4vz0401sy1otg327bk1vc, /dashboard/timetable, /dashboard/settings, /dashboard/checkin, /dashboard/payments, /dashboard/reports, /dashboard/memberships
- Saw: /: overflow 0px, 0/13 targets under 44px || /members: overflow 0px, 4/13 targets under 44px, under 24px: Member/Last Visit/Joined || /members/cmui4vz0401sy1otg327bk1vc: overflow 0px, 2/13 targets under 44px, under 24px: Set member's picture || /timetable: overflow 0px, 2/27 targets under 44px || /settings: overflow 0px, 1/9 targets under 44px || /checkin: overflow 0px, 0/9 targets under 44px || /payments: overflow 0px, 4/4 targets under 44px || /reports: overflow 0px, 6/8 targets under 44px || /memberships: overflow 0px, 13/14 targets under 44px, under 24px: Tier/Price/Cycle/Active members
- Notes: 0 screen(s) with horizontal page scroll; 44 px is the product's own floor (UI-RULES), 24 px is WCAG AA
- Screens: 

### T8-keyboard-login-and-dialog — PASS
- Feature: Keyboard: Tab through the login form; Tab and Escape inside the Add member dialog
- Where: /login?club= + Add member
- Saw: login tab order: input[password]:Password ✓fv → button[button]: ✓fv → button[submit]:Sign in ✓fv → button[button]:Email me a sign-in ✓fv → button[button]:Forgot password? ✓fv → nextjs-portal: ✗fv (no ring) → body:BackRRiverbank Gra ✗fv (no ring) || dialog tab order: in:input:Full Name → in:input:Email → in:input:Phone → in:input:Date of Birth → in:input:Date of Birth → in:input:Date of Birth → in:input:Date of Birth → in:select:ActiveTaster ( → in:select:Not recordedA  → in:button:Cancel → in:button:Close → in:input:Full Name
- Notes: focus left the dialog 0 time(s) in 12 Tabs; Escape closed it: true; ✓fv = :focus-visible matched
- Screens: T8-login-focus.png

### T9-club-context — PASS
- Feature: The club's name is visible on every staff screen
- Where: /dashboard, /dashboard/members, /dashboard/members/cmui4vz0401sy1otg327bk1vc, /dashboard/timetable, /dashboard/settings, /dashboard/checkin, /dashboard/payments, /dashboard/reports, /dashboard/memberships
- Saw: Riverbank Grappling appears on all screens
- Notes: 
- Screens: 

### T10-second-club-isolation — PASS
- Feature: A different club's owner tries Riverbank's member URLs; the seeded club's big screens render (read-only)
- Where: /login?club=totalbjj
- Saw: /dashboard/members/<riverbank-id> → /dashboard/members/<id> ::  || /dashboard/members/<riverbank-id>/waiver → /dashboard/members/<id>/waiver ::  || /dashboard/members/<riverbank-id>?tab=payments → /dashboard/members/<id>?tab=payments ::  || seeded club: /dashboard/members: 4674 ms, Print member cards Members 198 members · 197 need attention Add member 198 Total Members I || /dashboard/reports?weeks=12: 8970 ms, Reports Current owner snapshot, attendance trends, and class performance. Export CSV Windo || /dashboard/timetable: 2990 ms, Timetable 6 classes · Manage your schedule Generate 4 weeks Add class 21 Sept – 27 Sept MO || /dashboard/checkin: 4788 ms, Mark attendance Pick the session, the
- Notes: cross-club leaks: 0. The seeded club is read only; timings are dev-server (Turbopack) numbers, not production
- Screens: T10-cross-club.png, T10-totalbjj-members.png, T10-totalbjj-reports.png

### T1-T6-row-counts — PASS
- Feature: Members created by the transition cells, counted as rows
- Where: /dashboard/members
- Saw: Refresh Test: 0 profile link(s) || Back Test: 0 profile link(s) || Dupe Test: 0 profile link(s) || Alex Again: 0 profile link(s) || Expired Session: 0 profile link(s) || LLLLLLLLLL: 0 profile link(s)
- Notes: 
- Screens: T-verify-BackTest.png, T-verify-DupeTest.png

### N4-kiosk-on-hold — PASS
- Feature: Kiosk: a member on hold is refused in words
- Where: kiosk URL
- Saw: ! Couldn't check you in — Your membership is on hold until 10 Oct 2026 — ask staff to resume it early. Try again (server 403 on_hold)
- Notes: R2 captured the wording; N4's one-second polling only saw the reset to Pick your class, so the refusal screen clears itself within a few seconds — quick for a member reading it at the door
- Screens: R2-kiosk-dana-search.png
