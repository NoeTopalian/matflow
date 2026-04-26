# TeamUp Competitive Gap Report for MatFlow

Date: 2026-04-26
Source: User-provided TeamUp feature page notes plus MatFlow code/product audit.
Purpose: Turn the TeamUp comparison, strategic addendum, and PWA discussion into a clean roadmap document for MatFlow.

## 1. MatFlow Product Positioning

MatFlow is a white-label gym management platform built for Brazilian Jiu-Jitsu and martial arts clubs.

It has two connected products:

- Owner/admin backend: a command center for members, timetable, attendance, check-ins, ranks, staff, announcements, waivers, reports, branding, subscriptions, and payments.
- Member app: a mobile-friendly portal for class schedules, check-ins, progress, announcements, waivers, profile management, and shop purchases.

The strongest positioning is not "generic fitness management software." TeamUp is already broad there. MatFlow's sharper wedge is:

> The operating system for martial arts gyms, with belt/rank progression, grading readiness, family/kids workflows, attendance, waivers, check-ins, and gym-branded member experience built around how martial arts clubs actually run.

Strategic implication:

- MatFlow should cover the commercial table stakes that owners expect from TeamUp.
- MatFlow should differentiate on martial-arts depth rather than trying to clone every generic fitness feature first.
- The fastest path to revenue is likely: Tier 1 table stakes + BJJ/martial-arts-specific depth.

## 2. TeamUp vs MatFlow Feature Gap Report

Legend:

- Missing: not present in MatFlow today.
- Partial: present as a limited, demo, local-only, or incomplete version.
- Covered: already meaningfully present and not included as a priority gap.

## 2.1 Customer Lifecycle and CRM

### Missing: self-service signup with configurable signup form

TeamUp allows prospects to move from interested to registered to paying without staff manually creating the record.

MatFlow today:

- `/apply` is a fixed lead-capture form for gym owners/prospects.
- Members are created from the owner dashboard.
- There is no public member self-signup to payment flow.

Gap:

- Public member signup.
- Configurable signup fields per gym.
- Signup to checkout pipeline.
- Owner approval or auto-approval settings.

### Missing: automated customer journey statuses

TeamUp tracks customer lifecycle stages and lets owners target each stage.

MatFlow today:

- Member status is a flat value such as active, inactive, cancelled, or taster.
- No lifecycle automation.
- No at-risk detection.
- No automated segment transitions.

Gap:

- Lead, trial, active, at-risk, paused, cancelled, lost, and reactivated states.
- Rules that move members between states.
- Segment filters for campaigns and owner actions.

### Missing: customer referral programme

MatFlow today has no referral code, attribution, or reward model.

Gap:

- Referral links/codes.
- Referrer attribution.
- Reward rules.
- Owner reporting for referral performance.

### Missing: custom forms beyond waivers

MatFlow has editable waiver text, but not a general form builder.

Gap:

- Custom form builder.
- Field types.
- Form responses.
- Per-form acceptance/completion tracking.
- Member profile linkage.

## 2.2 Classes and Scheduling

### Missing: appointments and private sessions

TeamUp treats appointments as distinct from group classes.

MatFlow today:

- Supports recurring group classes and generated class instances.
- No one-to-one private session model.

Gap:

- Appointment type.
- Instructor availability.
- Private booking flow.
- Appointment payments.
- Cancellation and reschedule rules.

### Missing: online classes and video meeting integration

MatFlow today has no Zoom/Meet link generation and no online class workflow.

Gap:

- Video meeting URL on class or instance.
- Optional Zoom or Google Meet integration.
- Coach-facing start link.
- Member-facing join link with booking/access rules.

### Missing: on-demand video library

MatFlow has no content library for recorded lessons or training content.

Gap:

- Video/content CMS.
- Member-facing library.
- Access rules by membership or rank.
- Video hosting/transcoding strategy.

### Missing: automated booking messages and follow-ups

MatFlow does not yet have a real transactional email system wired through the product.

Gap:

- Booking confirmation emails.
- Class reminders.
- Cancellation/reschedule notices.
- Post-class follow-ups.
- Template system.
- Scheduled jobs.

### Partial: register view with attendee detail

MatFlow has attendance records and check-ins, but not a coach register for a specific upcoming class showing expected attendees and context.

Gap:

- Class instance register.
- Booked/expected attendees.
- Attendance status.
- Member context such as membership type, medical notes, waiver status, rank, last visit.
- Coach-safe privacy controls.

### Missing: penalty system

MatFlow has no late-cancel, no-show, strike, or penalty automation.

Gap:

- Late cancellation rules.
- No-show tracking.
- Strike count.
- Automatic restriction or fee rules.
- Owner override/audit log.

## 2.3 Memberships

### Missing: class packs and prepaid plans

TeamUp supports recurring memberships, prepaid plans, and class packs.

MatFlow today:

- Stripe recurring subscription work exists or is planned.
- No class credit balance.
- No prepaid expiry.

Gap:

- Pack model, such as 10 classes valid for 90 days.
- Credit decrement on attendance or booking.
- Expiry handling.
- Top-up flow.
- Owner-visible balance.

### Missing: granular membership allotments

MatFlow does not enforce limits like "3 classes per week" or "only fundamentals classes."

Gap:

- Membership plan eligibility rules.
- Limits per day, week, month, year, or billing cycle.
- Eligible class types/ranks.
- Booking and check-in enforcement.

### Missing: membership freeze/pause workflow

MatFlow has payment status values, but not a full freeze workflow.

Gap:

- Owner/member freeze request.
- Stripe pause collection.
- Scheduled resume.
- Freeze reason.
- Freeze history.

### Additional membership gaps

- Notice-period cancellation.
- Upgrade/downgrade with proration.
- Peak/off-peak access rules.
- Prorated first-month billing.
- Annual upfront payment with discount.
- Account credit/store credit balances.
- Expiring-card update email.
- Multi-rate VAT/tax support.

## 2.4 Payments

### Missing: Direct Debit

For UK martial arts gyms, Direct Debit is often cheaper and more familiar than card subscriptions.

MatFlow today:

- Stripe card payments/subscriptions are the main direction.
- No BACS Direct Debit or GoCardless flow is implemented.

Gap:

- Stripe BACS Direct Debit or GoCardless integration.
- Mandate setup.
- Payment confirmation timing.
- Failed mandate/payment handling.

### Missing: in-person payments

MatFlow has a pay-at-desk concept in the shop, but no actual card-present payment flow.

Gap:

- Stripe Terminal or equivalent.
- Reader pairing.
- Card-present transaction.
- Reconciliation into member/order ledger.

### Missing: discount and promo codes

MatFlow has no discount code model.

Gap:

- Discount code model.
- Redemption limits.
- Expiry.
- Applicable plans/products.
- Stripe coupon/promotion code mirror where needed.
- Member-side redemption UI.

### Missing: customer billing portal

MatFlow should allow members to manage payment methods and subscription billing through a hosted portal.

Gap:

- Stripe Billing Portal session creation.
- Member-facing "Manage billing" action.
- Owner visibility of billing status.

### Missing: refunds and dispute handling

Gap:

- Refund endpoint.
- Refund permission rules.
- Refund audit trail.
- Dispute webhook handling.
- Evidence collection UI later.

### Missing: payment ledger

MatFlow needs a durable payment history, not only Stripe state.

Gap:

- Payment table.
- Webhook writes.
- Member-visible payment history.
- Owner-visible payment history.
- Offline/manual payment entries.

### Additional payment gaps

- Failed-payment dunning with retry schedule.
- Auto-suspend after repeated payment failure.
- Manual cash/cheque payment recording.
- Gift cards and vouchers.
- Outstanding balance collection workflow.
- Tax/VAT handling per product or plan.

## 2.5 Communications

### Missing: SMS notifications

MatFlow has no SMS provider integration.

Gap:

- Twilio, MessageBird, or similar provider.
- Opt-in/opt-out management.
- SMS templates.
- Booking reminders and account alerts.

### Missing: push notifications

MatFlow currently has no push token registration or push delivery infrastructure.

Gap:

- PWA push or native push later.
- Push token storage.
- Scheduled and instant push triggers.
- Member notification preferences.

### Missing: in-app messaging

MatFlow has one-way announcements, not messaging.

Gap:

- Message thread model.
- Owner/member messaging.
- Optional member-to-member messaging.
- Moderation and reporting tools.

### Partial: custom email templates

Email is not wired as a first-class product system yet.

Gap:

- Transactional email provider.
- Template editor.
- Merge fields.
- Branded previews.

### Missing: email campaigns and broadcasts

Gap:

- Segmented broadcast composer.
- Send queue.
- Delivery/open/click tracking.
- Suppression and unsubscribe handling.

## 2.6 Native and Custom-Branded Apps

TeamUp's custom branded app is a major selling point. MatFlow is currently web-only.

Missing:

- Native iOS app.
- Native Android app.
- White-label app store submission process.
- Per-tenant app branding.
- Module visibility by membership group.
- Native push notifications.
- Native in-app messaging.
- Embedded video/on-demand content.

Recommended MatFlow approach:

- Do not start with full native white-label apps.
- Build a strong PWA first.
- Make it installable on iOS and Android.
- Use web-like deployment so updates appear when users reopen the app.
- Add native app store wrappers only once customer demand proves the need.

## 2.7 Integrations and API

### Missing: public API

MatFlow has internal API routes, but no documented public API.

Gap:

- API key model.
- Scopes.
- Public docs.
- Rate limiting.
- Webhook events.

### Missing: Zapier integration

Gap:

- Zapier triggers:
  - new member.
  - booking created.
  - payment received.
  - waiver signed.
- Zapier actions:
  - create member.
  - send message.
  - create lead.

### Missing: calendar sync

Gap:

- Per-member iCal feed.
- Per-class calendar export.
- Google Calendar integration later.

### Missing: reputation management

Gap:

- Post-class review prompts.
- Google review request flow.
- Owner reputation dashboard.

## 2.8 Family and Child Accounts

MatFlow has some account-type fields and UI concepts, but not full family account persistence.

Gap:

- Parent-child relationship model.
- Parent dashboard.
- Parent books for child.
- Parent signs waiver for minor.
- Shared billing.
- One Stripe customer paying for multiple members.

This is a high-value martial arts feature because kids classes and family memberships are common.

## 2.9 Staff and Access Control

### Missing: coach self-service class management

MatFlow has roles and class instructor fields, but coaches do not clearly manage their own classes.

Gap:

- Coach can manage only their assigned classes.
- Coach can view their own register.
- Coach can mark attendance.
- Owner controls coach permissions.

### Missing: granular access control

MatFlow has fixed roles.

Gap:

- Custom roles.
- Permission grid by resource/action.
- Role templates.
- Audit log for permission changes.

## 2.10 Reporting

MatFlow has Reports and Analysis pages, but the full business intelligence layer is not complete.

Gap:

- Real data wired into all charts.
- CSV/Excel export.
- Scheduled owner digests.
- Churn/retention analysis.
- Cohort reports.
- Lead conversion reports.
- Class utilization reports.
- Coach payroll/commission reports.

## 2.11 Onboarding, Migration, and Support

### Missing: data import/migration

TeamUp sells assisted import/migration as part of onboarding.

Gap:

- CSV/Excel importer.
- Member import.
- Attendance history import.
- Class timetable import.
- Stripe customer matching/import support where possible.

### Missing: free trial signup without card

MatFlow has trial-like subscription states, but not a complete self-service trial pipeline.

Gap:

- Public trial signup.
- Trial tenant creation.
- Trial expiry.
- Upgrade path.

### Operational gaps

These are not purely code features, but they matter competitively:

- Live human support.
- Comparison pages for SEO.
- Resource/content marketing.
- Case studies and testimonials.
- Awards/social proof.

## 3. Prioritised Gap-Closing Backlog

This ranking is based on likely commercial impact divided by build cost for a UK martial arts gym buyer comparing MatFlow with TeamUp.

## Tier 1: Table Stakes

MatFlow will feel incomplete against TeamUp without these:

1. Member self-signup to checkout.
2. Class packs and prepaid plans.
3. Direct Debit through Stripe BACS or GoCardless.
4. Discount/promo codes.
5. Stripe Billing Portal for member self-service.
6. Transactional email provider.
7. Booking confirmations and class reminders.
8. Coach register view.
9. CSV importer for members, classes, and attendance.
10. Payment ledger.

## Tier 2: Strong Upsell and Retention Features

These deepen the product and improve retention:

1. Real family/child accounts.
2. Membership allotments, such as X classes per week.
3. Membership freeze/pause.
4. Refunds and dispute handling.
5. SMS notifications.
6. Public API and Zapier.
7. Calendar sync.
8. Real reports with CSV export.
9. Appointments/private lessons.
10. Failed-payment dunning.

## Tier 3: Headline Differentiators

These are major projects and should not block early revenue:

1. Native iOS and Android apps.
2. Fully custom-branded app store apps.
3. On-demand video library.
4. In-app messaging.
5. Push notifications.
6. Penalty system.
7. Referral programme.
8. Reputation management.
9. Online classes and Zoom integration.
10. Multi-location support.

## 4. MatFlow Advantages Against TeamUp

MatFlow already has several advantages that are more specific to martial arts than TeamUp's generic fitness positioning.

## 4.1 Belt and Rank System

TeamUp does not strongly market a native belt/stripe/grading workflow.

MatFlow can own:

- Rank systems per discipline.
- Belt colours and ordering.
- Stripe tracking.
- Promotion history.
- Grading readiness.
- Attendance-driven promotion eligibility.
- Coach notes tied to rank progression.

This should become a headline product advantage.

## 4.2 Martial-Arts-Specific Onboarding

MatFlow can adapt setup around:

- BJJ.
- Judo.
- MMA.
- Karate.
- Kids classes.
- Rank structures.
- Class types.
- Grading cadence.

Generic gym systems usually require owners to hack this through custom fields.

## 4.3 Family and Kids Workflows

Kids classes are commercially important for martial arts clubs.

MatFlow can differentiate with:

- Parent account.
- Child profiles.
- Parent-paid memberships.
- Parent-signed waivers.
- Book-for-child flow.
- Child attendance and rank progression.

## 4.4 Security and Compliance Posture

MatFlow has the start of a strong owner security story:

- Role-based access.
- Owner two-factor authentication.
- Audit log model.
- Stripe Connect Standard direction.
- Tenant isolation.

This should be finished and then marketed as a trust advantage.

## 4.5 Stripe Connect Standard

If MatFlow uses Stripe Connect Standard and the gym is the merchant of record, MatFlow can reduce its own legal/payment liability compared with models where the platform holds funds directly.

This should be paired with:

- Clear terms.
- Stripe-hosted payment flows.
- No card data touching MatFlow servers.
- Webhook-based ledger.
- No manual custody of funds.

## 5. Strategic Recommendation

MatFlow should not try to copy TeamUp feature-for-feature immediately.

TeamUp's strength is breadth:

- Generic fitness feature set.
- Mature payments.
- Native/custom-branded app.
- Communications.
- Integrations.
- Migration and support.

MatFlow's better early wedge is depth:

- Martial arts operations.
- Rank progression.
- Grading workflows.
- Attendance and eligibility.
- Family/kids accounts.
- Coach registers.
- Waivers.
- Branded member PWA.

Recommended strategy:

1. Build Tier 1 table stakes so the product can sell credibly.
2. Go deeper than TeamUp on martial arts workflows.
3. Use a PWA as the mobile strategy before native apps.
4. Keep pricing simple and honest.
5. Delay expensive native white-label apps until there is revenue or strong customer demand.

## 6. Pricing Strategy Note

TeamUp's pricing is positioned around active member count rather than gating major features behind tiers. That is a selling point because buyers do not feel punished for needing basic tools.

MatFlow should decide this before launch.

Recommended default:

- Use simple per-active-member pricing.
- Keep core features available on the main plan.
- Charge separately for heavy-cost add-ons only where justified, such as SMS volume, custom native app, migration service, or advanced AI reports.

Avoid:

- Hiding essential features like payments, waivers, reports, or timetable behind confusing tiers.
- Creating a pricing model that feels cheaper at first but worse once the owner needs normal gym functionality.

## 7. PWA and Mobile Strategy

## 7.1 Why PWA First

TeamUp's native/custom-branded app is a major gap, but building full native white-label apps is expensive and slow.

For MatFlow, a PWA is the better first move because:

- It works from the same Next.js product.
- It can be installed to iOS and Android home screens.
- Updates deploy like a website.
- Members do not need app store updates.
- It is cheaper to build and maintain.
- It is good enough for short, task-based gym app sessions.

Target member experience:

- Member opens the installed MatFlow icon.
- App opens full-screen.
- Fresh data loads when online.
- If a new version was deployed, the app refreshes on open or shortly after.
- If offline, the member sees the last known safe read-only data with a stale indicator.

## 7.2 PWA Update Strategy

Use auto-refresh-on-open for app code updates.

Reason:

- Gym member sessions are short.
- They usually open the app to check a schedule, check in, or view progress.
- A silent refresh on open is less annoying than an update banner.

Recommended behavior:

- When the app opens, check for a new service worker/app version.
- If a new version exists, activate it quickly.
- Refresh the app shell automatically before the member starts a task.
- Avoid forced refresh while a member is mid-booking, mid-payment, or editing a profile.

## 7.3 PWA Caching Rules for MatFlow

Service workers do not automatically know what is stale. MatFlow must define route-specific cache behavior.

### App shell: stale-while-revalidate

Use for:

- Main app pages.
- HTML/app shell.
- JS/CSS app assets where appropriate.

Behavior:

- Load quickly from cache.
- Check the network in the background.
- Update cache for next open.

### Static assets: cache-first

Use for:

- Icons.
- Fonts.
- Static images.
- Versioned Next.js static files.

Behavior:

- Serve from cache when available.
- Fetch from network only if missing.

### Timetable, member, booking reads: network-first

Use for dynamic read APIs:

- Class schedule.
- Timetable.
- Member profile.
- Membership status.
- Announcements.
- Progress data.
- Booking availability.

Behavior:

- Try network first.
- If network succeeds, show fresh data and update cache.
- If network fails, show cached data only with a visible stale/offline indicator.

This is critical for timetables. If Sean updates Tuesday's schedule, an online member opening the app on Tuesday should see the new server version, not Monday's cached version.

### Writes: network-only

Use for:

- Booking a class.
- Cancelling a booking.
- Checking in.
- Updating profile.
- Signing a waiver.
- Changing notification settings.
- Creating shop orders.

Behavior:

- Send to server only.
- If offline, fail clearly or offer retry.
- Do not let users believe a write succeeded when it only exists locally.

### Payments: never cache

Use network-only and no-store behavior for:

- Stripe checkout.
- Billing portal.
- Payment methods.
- Subscription status changes.
- Payment history.
- Refunds.

Behavior:

- Always fetch live from server/Stripe-backed state.
- Do not store sensitive payment responses in service worker caches.

## 7.4 Offline UX Rules

For v1:

- Offline read-only timetable is acceptable if clearly marked stale.
- Offline payments are not allowed.
- Offline bookings are not allowed.
- Offline profile updates are not allowed unless a proper sync queue is built later.
- Offline waiver signing should not be allowed for legal certainty.
- Offline check-in should not be allowed unless a dedicated signed offline token system is designed later.

Recommended copy:

- "You are offline. Showing last updated schedule from 14:32."
- "Reconnect to book or check in."
- "This information may have changed since it was last updated."

## 8. Combined Product Roadmap

## Phase 1: Credible Commercial Core

Goal: make MatFlow sellable to a real UK martial arts gym.

Build:

- Member self-signup.
- Stripe Billing Portal.
- Direct Debit.
- Payment ledger.
- Class packs.
- Transactional email.
- Coach register.
- CSV import.
- Waiver snapshot storage.
- Hardened public check-in.

## Phase 2: Martial-Arts Depth

Goal: become obviously better than TeamUp for martial arts clubs.

Build:

- Family/child accounts.
- Parent-paid memberships.
- Parent-signed waivers.
- Grading readiness.
- Rank progression timeline.
- Coach promotion notes.
- Attendance-driven eligibility.
- Class-level rank requirements.

## Phase 3: Owner Growth Tools

Goal: help the gym owner grow and retain members.

Build:

- Lead pipeline.
- Trial to active conversion.
- At-risk member detection.
- Referral programme.
- Re-engagement emails.
- Real reports.
- Class utilization insights.
- Discount/promo codes.

## Phase 4: Mobile and Engagement

Goal: close the app-experience gap without overbuilding too early.

Build:

- Installable PWA.
- Service worker caching.
- Push notifications.
- SMS notifications.
- Calendar sync.
- In-app messaging later.
- Native wrapper only after demand is proven.

## 9. Claude Implementation Prompts

## Prompt A: TeamUp Gap-Closing Roadmap

```text
Please turn TEAMUP_COMPETITIVE_GAP_REPORT.md into a buildable MatFlow roadmap.

Focus on Phase 1 only:
1. Member self-signup to checkout.
2. Stripe Billing Portal.
3. Direct Debit through Stripe BACS or GoCardless.
4. Payment ledger.
5. Class packs.
6. Transactional email.
7. Coach register.
8. CSV import.
9. Waiver snapshot storage.
10. Hardened public check-in.

For each item, define the minimum viable user flow, database changes, API routes, UI changes, security requirements, and acceptance tests. Keep the roadmap Vercel-safe and avoid fake/demo production data.
```

## Prompt B: PWA Install and Caching Setup

```text
Please create a technical implementation plan for MatFlow's PWA setup.

Use TEAMUP_COMPETITIVE_GAP_REPORT.md as context.

The goal is an installable member app with safe caching:
1. App shell uses stale-while-revalidate.
2. Static assets use cache-first.
3. Timetable/member/API reads use network-first with cache fallback and a visible stale/offline indicator.
4. Booking/check-in/profile/waiver writes are network-only.
5. Payment routes are never cached.
6. App updates refresh on open where safe.

Do not implement native apps. Plan a PWA-first approach using the current Next.js/Vercel setup.
```

