# MatFlow System Page-by-Page Audit

Date: 2026-04-26
Scope: owner dashboard, member app, public flows, API/security, data model, page flow, redundancy, missing features, and recommended fixes.

## Executive Summary

MatFlow already has the bones of a serious owner/member gym system: authenticated owner dashboard, branded member app, timetable, attendance, reports, settings, waiver, Stripe integration, and member self check-in. The biggest opportunity now is to make the product feel less like separate feature islands and more like one operating system for the gym owner.

The main issues are:

- Repeated identity and status information across the sidebar, topbar, and page headers.
- Several pages present demo or local-only data beside live database data, which can confuse owners.
- Large client components make features harder to maintain and easier to break.
- Public lookup and check-in flows need stronger abuse protection before production.
- Signed waiver records need to store the exact document version and signer snapshot.
- Reports and Analysis overlap; Reports should be live operational metrics, while Analysis should become a stored monthly review.
- Several page-level guards rely on the dashboard layout instead of being explicit on each page.
- Settings is doing too much in one file and should be split into focused panels.

## Highest Priority Fixes

1. Harden public check-in.
   - Add rate limits to member lookup and check-in.
   - Stop returning raw member IDs from public lookup.
   - Use signed, short-lived QR or class check-in tokens.
   - Enforce class time windows server-side.

2. Separate live, demo, and placeholder features.
   - Any fake revenue, mock payments, local subscriptions, local shop orders, or static member app data should be clearly labelled or removed from production.
   - Owners should never think demo figures are real business data.

3. Add explicit page-level role guards.
   - Every dashboard page should guard itself, even if the dashboard layout also guards access.
   - This reduces future mistakes when routes are moved, embedded, or linked directly.

4. Refactor large client components.
   - `components/dashboard/SettingsPage.tsx` is too large and should be split first.
   - Other large files include member home, login, timetable, member profile, reports, ranks, and members list.

5. Fix waiver storage.
   - Store waiver title, content, version, signer name, signer account/member ID, IP address, user agent, and accepted timestamp at the time of signing.
   - Do not rely only on the current tenant waiver text plus a boolean accepted flag.

6. Improve owner shell layout.
   - Put workspace identity in the sidebar.
   - Put personal account controls in a compact topbar menu.
   - Group role/security status together.
   - Avoid repeating the gym name and user name in multiple places on the same screen.

## System-Wide UX and Product Notes

### Owner Shell

Current pattern:
- Sidebar shows club logo/name/plan.
- Topbar shows page title.
- Topbar also shows role chip, security chip on some pages, avatar, user name, and account dropdown.
- Some page bodies repeat title, gym name, or user status again.

Recommended pattern:
- Sidebar top: workspace identity only.
  - Club logo.
  - Club name.
  - Plan/status.
  - Optional compact switcher later if multiple clubs are supported.
- Topbar left: current page title and one-line contextual subtitle when useful.
- Topbar right: a single professional account cluster.
  - Role badge.
  - Security badge only when meaningful.
  - Avatar.
  - Name hidden or shortened if sidebar already shows identity.
  - Dropdown for profile, security, billing, sign out.
- Page body: do not repeat the same page title unless it introduces a different section.

For the rank badge, make it feel more premium:
- Use a compact pill with icon, role name, and subtle border.
- Owner: warm gold accent, shield/crown/key icon, text like `Owner`.
- Manager: blue or teal accent, `Manager`.
- Coach: green accent, `Coach`.
- Admin: neutral violet or slate accent, `Admin`.
- Member: simple neutral/member accent in the member app.
- Avoid a basic flat yellow bubble. Use restrained gradient, soft inner border, and consistent sizing.

### Visual Consistency

Current strengths:
- Dark interface is cohesive.
- Icon language is mostly consistent.
- Owner dashboard has a focused gym-management feel.

Current issues:
- Some pages use large card layouts with too much empty space.
- Reports and Analysis use blue while Dashboard uses green, which can be fine, but it needs intentional meaning.
- Font contrast is sometimes too low, especially secondary text on dark backgrounds.
- Some strings show encoding corruption in code/output, such as `â€”`, `â†’`, `Â£`, or emoji artifacts.
- Page titles are duplicated in topbar and page body.

Recommendations:
- Define page templates:
  - Operational page: dense toolbar + table/list + side panel.
  - Insight page: KPI strip + chart grid + action recommendations.
  - Settings page: tabs/sections + save status + dangerous actions separated.
  - Member page: mobile-first cards + clear next action.
- Use one metric card style across Dashboard, Reports, and Analysis.
- Use color meaning consistently:
  - Green: active/good/live.
  - Blue: insight/reporting.
  - Amber: attention/pending.
  - Red: risk/error.
- Clean encoding issues and prefer plain ASCII where possible.

### Data Trust

Several screens mix live data with demo/local/static data. This is risky for owner confidence.

Examples:
- Member profile mock payment history.
- Member schedule local subscriptions.
- Member shop static products and non-persistent pay-at-desk orders.
- Settings revenue demo values when Stripe is disconnected.
- Analysis says AI report, but the current experience appears templated unless backed by a real AI call.

Recommendation:
- Add a visible data source state where needed:
  - `Live`
  - `Demo`
  - `Not connected`
  - `Coming soon`
- Do not show fake business metrics in owner production pages.

## Page-by-Page Audit

## `/`

Purpose:
- Redirects users to `/dashboard`.

Quality:
- Simple and low risk.

Flow issue:
- Unauthenticated users are sent toward dashboard first, then redirected to login by dashboard layout.
- Members may pass through the wrong destination before reaching member home.

Fix:
- Redirect based on session:
  - Staff/owner roles -> `/dashboard`
  - Member -> `/member/home`
  - No session -> `/login`

## `/preview`

Purpose:
- Prototype or marketing preview page.

Quality:
- Useful for showing the product direction.

Issues:
- It is disconnected from the real app shell.
- It contains hardcoded demo data.
- It may be confusing if deployed publicly on Vercel.

Fix:
- Decide whether it is public marketing or internal preview.
- If internal, hide behind an environment flag or remove from production navigation.
- If public, make it look intentionally like a demo and avoid fake operational data that appears real.

## `/apply`

Purpose:
- Public application/contact form.

Quality:
- Good simple funnel.
- Clear enough for someone interested in the product.

Issues:
- Terms and privacy text appears but is not linked to real legal pages.
- Server route needs stronger validation and persistence.
- No public abuse protection.
- The promise of a response within one business day is not backed by visible workflow.

Security:
- Add server-side schema validation.
- Add IP/email rate limiting.
- Add spam protection if this page remains public.

Missing features:
- Store applications in the database or send them through a real email/CRM workflow.
- Owner/admin view for inbound applications, if this is meant to be operational.

Fix:
- Add an `Application` model or email integration.
- Add Zod validation on `/api/apply`.
- Add rate limiting.
- Link real legal pages or remove the legal sentence until ready.

## `/login`

Purpose:
- Club code lookup, login, forgot password, reset flow.

Quality:
- Strong product idea: users select their gym before authenticating.
- Good branded login flow for multi-tenant use.

Issues:
- Club code lookup can trigger repeated requests while typing.
- Demo branch should not redirect without a real session.
- Forgot-password/reset UI can imply email delivery even if email sending is not configured.
- The page is large and should be split.

Security:
- Tenant lookup should be rate-limited.
- Forgot-password rate limit should not rely only on memory for Vercel.
- Password reset tokens should be stored hashed.

Flow:
- Make forgot-password a deliberate action with a confirmation step.
- If member password login is supported, make that clear. If not, explain member access path.

Fix:
- Split into `ClubLookup`, `LoginForm`, `ForgotPasswordForm`, and `ResetPasswordForm`.
- Add production-safe email integration.
- Add database or KV-backed rate limiting.

## `/login/totp`

Purpose:
- Owner TOTP verification.

Quality:
- Clean focused security page.

Issues:
- Page can be visited directly without an obvious pre-check.
- Better UX would auto-submit once six digits are entered.

Security:
- TOTP verification is good in principle, but rate limiting should be backed by persistent storage in production.

Fix:
- Redirect away if there is no pending TOTP state.
- Auto-submit on complete code.
- Add backup codes for owner recovery.

## `/onboarding`

Purpose:
- Owner setup wizard for initial gym configuration.

Quality:
- Good idea and important for first-run experience.

Issues:
- Large page.
- Multiple API calls can leave setup half-complete if one later step fails.
- Client-generated IDs should use `crypto.randomUUID()` rather than `Math.random()`.
- Needs stronger resume/retry behavior.

Security/data:
- Owner-only guard is good.
- Upload depends on production Blob configuration.

Fix:
- Add a server-side onboarding completion endpoint that validates and commits setup in a controlled way.
- Save progress after each step.
- Add review screen before completion.
- Make completion idempotent.

## `/checkin/[slug]`

Purpose:
- Public QR check-in flow.

Quality:
- Valuable feature for classes.
- Good for quick member attendance.

Critical security issue:
- Public lookup can expose members.
- Public check-in can be abused if member IDs and class instance IDs are known.
- No strong class time window or token-based protection.

Fix:
- Replace raw member lookup with an opaque check-in token flow.
- Add signed QR tokens per tenant/class/session.
- Enforce that check-in is only allowed near the class time.
- Rate-limit lookup and check-in.
- Consider a second factor for self check-in, such as member PIN, date of birth, or app session.

## `/dashboard`

Purpose:
- Owner/staff home dashboard.

Quality:
- Strong gym-at-a-glance concept.
- Weekly calendar and key metrics are useful.

Issues:
- Some metrics overlap with Reports and Analysis.
- Page relies heavily on the layout guard.
- Empty states should point to the exact setup action needed.
- Query parameter naming around class vs instance can be confusing.

Redundancy:
- Active members, check-ins, and new members appear in several pages with slightly different meanings.

Fix:
- Use shared metric helpers for Dashboard, Reports, and Analysis.
- Add explicit page guard.
- Add stronger empty states:
  - No classes -> create timetable.
  - No generated instances -> generate next weeks.
  - No check-ins -> open admin check-in.

## `/dashboard/members`

Purpose:
- Member management list and add-member flow.

Quality:
- Core page for the owner.
- Search and filtering are valuable.

Issues:
- Component is large.
- Some typing uses `any`.
- Adding a member does not clearly create an app login or invite flow.
- Payment, waiver, and app setup status should be more visible.

Redundancy:
- Member status should not be duplicated in multiple unconnected formats. Use consistent chips.

Fix:
- Split list, filters, table, mobile cards, and add modal.
- Add status chips:
  - Active/inactive.
  - Waiver signed/missing.
  - Payment current/pending/not connected.
  - App invite sent/not sent.
- Add invite/password setup flow.

## `/dashboard/members/[id]`

Purpose:
- Member profile, attendance, rank, subscriptions, emergency information.

Quality:
- Rich page with useful operational context.

Issues:
- Mock payment history can be mistaken for real billing data.
- Sensitive medical/emergency information should be permissioned carefully.
- Linked accounts are presented but not complete.
- Rank changes and profile edits should be audit logged.

Security:
- Gate medical/emergency details to owner/manager/admin or an explicit permission.
- Add audit logs for rank promotions, notes, and sensitive edits.

Fix:
- Replace mock payments with live Stripe status or label as demo.
- Add a real linked account/guardian model before showing child account management as real.
- Add action timeline:
  - Joined.
  - Waiver signed.
  - Rank promoted.
  - Membership changed.
  - Last check-in.

## `/dashboard/timetable`

Purpose:
- Manage weekly classes and generated instances.

Quality:
- Important and useful owner feature.

Issues:
- Class instance generation logic appears in more than one API route.
- Time validation needs server enforcement that end time is after start time.
- Role behavior should be clearer for coach/admin read-only access.

Flow:
- Owners need to know whether future class instances have been generated.

Fix:
- Centralize instance generation in one service.
- Add a "schedule health" panel:
  - This week generated.
  - Next 4 weeks generated.
  - Missing/cancelled instances.
- Add bulk edit and duplicate class actions.
- Validate class times server-side.

## `/dashboard/attendance`

Purpose:
- Recent attendance and attendance summary.

Quality:
- Useful operational history.

Issues:
- Needs pagination and date range filtering.
- Current summaries should be based on shared reporting logic.
- Export is important for owners.

Fix:
- Add date range selector.
- Add CSV export.
- Add filters by member, class, method, and date.
- Link attendance rows to member profile and class instance.

## `/dashboard/checkin`

Purpose:
- Staff/admin check-in station.

Quality:
- Practical owner/staff workflow.

Issues:
- Role permissions may be inconsistent between sidebar, page, and API.
- Query parameter naming should distinguish class ID from instance ID.
- If no class instances exist, the user needs a direct next action.

Fix:
- Align role access across nav, page, and API.
- Support `classId` and `instanceId` explicitly.
- Add "generate today's classes" for owner/manager when empty.
- Add check-in audit trail for manual check-ins.

## `/dashboard/ranks`

Purpose:
- Manage rank systems.

Quality:
- Important for BJJ-specific product fit.

Issues:
- Deleting ranks that are in use needs a clear pre-check.
- Reordering should be transactional.
- Rank visuals should preview how they appear in member app and profile.

Fix:
- Show usage count before delete.
- Disable delete or require reassignment if members/classes use the rank.
- Add drag-and-drop reorder backed by one transaction.
- Add belt preview and member-facing preview.

## `/dashboard/notifications`

Purpose:
- Currently behaves more like announcements than notifications.

Quality:
- Useful communication feature.

Issues:
- Sidebar says Notifications but page feature is Announcements. Naming mismatch.
- Manager may be allowed to create announcements, but upload route may only allow owner uploads.
- No targeting, read receipts, expiry, or scheduled publishing.

Fix:
- Rename to Announcements, or split Notifications and Announcements.
- Align upload permissions with announcement permissions.
- Add target audience:
  - All members.
  - Adults.
  - Kids/guardians.
  - Rank group.
  - Class subscribers.
- Add schedule, expiry, pinned state, and read receipts.

## `/dashboard/reports`

Purpose:
- Live owner metrics and operational reporting.

Quality:
- This should become the owner's daily health dashboard.
- The chart/card concept is good.

Issues:
- Needs clearer decision support, not only charts.
- Needs date range controls.
- Reports and Analysis overlap.
- Some charts lack context: what is good, bad, or changing?

Recommended layout:
- Top summary strip:
  - Active members.
  - Net new members.
  - Check-ins.
  - Average attendance per class.
  - Capacity utilization.
  - Revenue if Stripe is connected.
- Status panel:
  - Growth trend.
  - Attendance trend.
  - Classes needing attention.
  - Members at risk.
- Main charts:
  - Attendance by week.
  - New members by month.
  - Class utilization.
  - Check-in method mix.
  - Rank distribution.
- Action list:
  - Classes below target.
  - Members missing waiver.
  - Members inactive for 14/30 days.
  - Capacity conflicts.

Fix:
- Add date range selector.
- Add CSV export.
- Add drill-down links from chart rows to Members, Attendance, or Timetable.
- Keep Reports factual and live. Move narrative recommendations to Analysis.

## `/dashboard/analysis`

Purpose:
- Monthly review and recommendation engine.

Quality:
- Good idea, especially for owner coaching and business insight.

Issues:
- It overlaps with Reports.
- If no real AI is connected, "AI Monthly Report" may feel misleading.
- Engagement percentage can become nonsensical if formula is not clear.
- Generated reports should be stored and reviewable later.

Fix:
- Rename to "Monthly Review" unless real AI is active.
- Use Reports metrics as the single source of truth.
- Ask owner questions only for things the system cannot infer.
- Store generated reports in DB with:
  - date range.
  - metrics snapshot.
  - owner answers.
  - generated recommendations.
  - version/history.
- Remove any unsafe HTML rendering. Render structured markdown safely or use a sanitizer.

## `/dashboard/settings`

Purpose:
- Owner control center for gym settings, branding, subscription, staff, waiver, store, and account/security.

Quality:
- Feature coverage is broad and useful.

Major issue:
- `SettingsPage.tsx` is too large and does too much.

Redundancy:
- Gym identity, plan, branding preview, account details, and subscription status appear in several places.

Security:
- Owner-only guard is good.
- Staff invite flow needs to be production-ready.
- SVG upload should be removed or sanitized.
- Generated staff passwords should be replaced by invite/reset flow.

Data issues:
- Branding preview/localStorage behavior can diverge from saved database settings.
- Store settings/products need to clearly persist or be labelled as setup-only/demo.
- Revenue tab should not show fake numbers as if live.

Waiver issues:
- Current tenant-level waiver fields are useful, but signed member records need a snapshot of the exact waiver signed.

Fix:
- Split into:
  - `SettingsOverview`
  - `BrandingSettings`
  - `BusinessSettings`
  - `StaffSettings`
  - `WaiverSettings`
  - `BillingSettings`
  - `StoreSettings`
  - `SecuritySettings`
- Add save status per section.
- Add unsaved changes prompts.
- Add audit logs for all sensitive changes.
- Remove SVG upload support.
- Replace generated passwords with email invites and forced password setup.

## `/member`

Purpose:
- Redirects to member home.

Quality:
- Simple.

Fix:
- Redirect based on auth role:
  - Member -> `/member/home`
  - Staff -> `/dashboard`
  - No session -> `/login`

## `/member/home`

Purpose:
- Member landing page with today's classes, announcements, waiver, onboarding, and check-in.

Quality:
- Strong member app direction.
- Good potential for daily engagement.

Issues:
- Page is too large.
- Onboarding progress appears to use localStorage and should be member/tenant-specific.
- Waiver signing lacks document snapshot.
- Demo data can hide backend issues.
- Class check-in must be enforced server-side by time window and eligibility.

Flow:
- The main member question is "What should I do next?" The page should make one next action obvious:
  - Sign waiver.
  - Check in to current class.
  - Book/subscribe to class.
  - View progress.

Fix:
- Split into:
  - `MemberHomeHeader`
  - `TodayClasses`
  - `WaiverPrompt`
  - `AnnouncementsList`
  - `OnboardingModal`
  - `CheckInSheet`
- Store onboarding completion in the database.
- Add signed waiver snapshot.
- Add stronger empty states when no classes or announcements exist.

## `/member/schedule`

Purpose:
- Member class schedule and subscriptions.

Quality:
- Visually polished and mobile-friendly.

Issues:
- Subscription behavior appears local/static unless connected to a persisted API.
- Gesture/ref logic is complex and has lint issues.
- Needs clearer relationship between subscribing, booking, and check-in.

Fix:
- Add persistent `ClassSubscription` model/API if subscriptions are real.
- Add booking/waitlist only if the business rules need it.
- Move swipe logic into a hook.
- Fix refs being updated during render.
- Add class details sheet with coach, capacity, rank suitability, and next dates.

## `/member/progress`

Purpose:
- Member training progress and attendance.

Quality:
- Valuable retention feature.

Issues:
- Subscribed classes may be inferred from attendance rather than real subscription data.
- Rank history should come from actual rank promotion history.
- Demo fallback can make missing data look valid.

Fix:
- Use real `RankHistory`.
- Add attendance streaks, monthly trend, class mix, and rank progress.
- Add next milestone or coach note when available.
- Avoid showing fake values in production.

## `/member/profile`

Purpose:
- Member account, personal details, emergency info, preferences, linked profiles.

Quality:
- Good coverage for member self-service.

Issues:
- Child/linked profiles appear local/demo unless backed by database models.
- Notification toggles need persistence.
- Website/support links should come from tenant settings, not hardcoded values.
- Profile image controls need real upload or should be hidden.

Security/privacy:
- Medical and emergency data must be handled carefully.
- Changes should be audited where appropriate.

Fix:
- Persist notification preferences.
- Add linked account/guardian model if supporting parents and children.
- Pull gym website/contact from tenant settings.
- Add profile photo upload with safe image types only.

## `/member/shop`

Purpose:
- Member store and checkout.

Quality:
- Nice product concept and useful for gym monetisation.

Issues:
- Product list appears static unless fully connected to Settings/store data.
- Pay-at-desk checkout creates no durable order record.
- Stripe checkout needs order/inventory integration.
- No owner fulfilment workflow.
- Uses browser alerts instead of app-native feedback.

Security/data:
- Checkout should require a member session, not just any authenticated user.
- Server must validate prices, quantities, stock, and tenant.

Fix:
- Add `Product`, `Order`, and `OrderItem` models.
- Persist pay-at-desk orders.
- Add owner order fulfilment page.
- Connect Settings store products to member shop.
- Replace alerts with toast/sheet confirmation.

## Shared Components and Layout

### `Topbar`

Issues:
- Repeats user and role information already visible elsewhere.
- Account cluster can feel basic.
- Role chip should be more premium and consistent across roles.

Fix:
- Create a single `AccountMenu` component:
  - role badge.
  - security status.
  - avatar.
  - dropdown.
- Hide duplicate name when space is limited.
- Add professional role badge variants.

### `Sidebar`

Issues:
- Sidebar has workspace identity and plan, which is good, but topbar also repeats identity/user data.
- Navigation labels should match actual page purpose, especially Notifications vs Announcements.

Fix:
- Keep club identity in sidebar.
- Add collapsed/mobile behavior with full account access.
- Rename pages for clarity.

### Metric Cards

Issues:
- Dashboard, Reports, and Analysis use similar metrics with different styling and sometimes different definitions.

Fix:
- Create shared `MetricCard`, `TrendBadge`, and `EmptyMetricState`.
- Use shared data helpers so numbers match across pages.

## API and Security Audit

## Authentication and Authorization

Strengths:
- Auth system has role support.
- Owner TOTP exists.
- Session invalidation exists.
- Dashboard layout blocks members from owner dashboard.

Issues:
- Many pages rely on layout guard and then use non-null session assumptions.
- RBAC is repeated across API routes.
- Some rate limits are in memory, which is weak on Vercel serverless.
- Demo mode must never be enabled in production.

Fix:
- Add central helpers:
  - `requireSession()`
  - `requireRole([...])`
  - `requireTenant()`
  - `requireOwner()`
- Add explicit guards to each dashboard page.
- Use Redis/KV/database-backed rate limiting.

## Public Lookup and Check-In

Critical risks:
- Member enumeration.
- Unauthenticated check-in abuse.
- Guessable or discoverable IDs.
- No durable rate limit.

Fix:
- Signed QR session token.
- Opaque member check-in token.
- Rate limits by IP, tenant, and token.
- Time window enforcement.
- Optional member PIN/date-of-birth confirmation.

## Uploads

Risk:
- SVG uploads are dangerous if served publicly.

Fix:
- Remove `image/svg+xml` from allowed upload types.
- Randomize uploaded file names.
- Validate size and content type.
- Consider image transformation/rasterization for logos.

## Stripe

Strengths:
- Webhook signature verification is present.
- Connect account flow exists.

Issues:
- Webhook idempotency should be added.
- Store checkout needs order persistence.
- Revenue UI should separate connected/live from demo.

Fix:
- Add `StripeEvent` table with event ID unique constraint.
- Store checkout orders before redirecting to Stripe.
- Reconcile order status from webhook.

## Password Reset and TOTP

Issues:
- Reset tokens should be hashed.
- In-memory rate limits are weak on Vercel.
- TOTP setup returns the raw secret during setup. This is acceptable only during setup and should not be retrievable later.

Fix:
- Hash reset codes.
- Store attempt counters in KV/database.
- Add backup codes.
- Add owner recovery process.

## Waiver

Current:
- Tenant stores waiver title/content.
- Member stores accepted flag, accepted timestamp, and IP address.

Problem:
- If the waiver text changes later, old signed waivers cannot prove exactly what the member accepted.

Fix:
- Add a signed waiver snapshot model or fields:
  - waiverTitleSnapshot.
  - waiverContentSnapshot.
  - waiverVersion.
  - signerName.
  - signerMemberId.
  - signerUserId if applicable.
  - acceptedAt.
  - ipAddress.
  - userAgent.
  - tenantId.
- Keep old signed snapshots immutable.
- Add owner-visible waiver status and export.

## Audit Logging

Current:
- Audit log model exists but sensitive actions are not consistently logged.

Fix:
- Log:
  - member create/edit/delete.
  - rank promotion.
  - check-in create/delete/manual override.
  - waiver content update.
  - staff invite/create/edit/delete.
  - settings changes.
  - Stripe connect/disconnect.
  - password/security changes.

## Data Model and Architecture

Recommended additions or improvements:
- `SignedWaiver` or waiver snapshot fields.
- `ClassSubscription` if member subscriptions are real.
- `Product`, `Order`, `OrderItem` if shop is real.
- `StripeEvent` for webhook idempotency.
- `Application` for public apply form.
- `Invite` for staff/member account setup.
- `NotificationPreference` for member settings.
- `Guardian/LinkedAccount` if child accounts are real.

Recommended service modules:
- `lib/authz.ts` for role checks.
- `lib/rate-limit.ts` backed by KV/database in production.
- `lib/reports.ts` as single source for reporting metrics.
- `lib/class-instances.ts` for generation logic.
- `lib/audit-log.ts` for mutation audit logging.
- `lib/uploads.ts` for upload validation.

## Vercel Production Notes

Because this will run on Vercel:

- Do not rely on process memory for rate limits or security counters.
- Do not rely on local filesystem writes.
- Use Vercel Blob or another object store for uploads.
- Use a persistent database for tokens, audit logs, orders, and signed waivers.
- Keep webhook handlers idempotent.
- Ensure environment variables are set for:
  - `NEXTAUTH_SECRET`
  - `NEXTAUTH_URL`
  - database URL
  - Stripe secret and webhook secret
  - Blob token
  - email provider credentials if password reset/invites are enabled
- Move viewport metadata to the supported Next.js export format.

## Suggested Implementation Roadmap

## Phase 1: Trust and Security

- Harden public check-in and lookup.
- Add persistent rate limiting.
- Remove SVG upload support.
- Add signed waiver snapshots.
- Add Stripe webhook idempotency.
- Add explicit page-level guards.
- Add audit logging for sensitive mutations.

## Phase 2: Owner Experience

- Redesign topbar/account cluster and role badges.
- Rename Notifications to Announcements or split the feature.
- Improve dashboard empty states.
- Rebuild Reports as a live operational command center.
- Make Analysis a stored monthly review.
- Remove or label demo data in owner pages.

## Phase 3: Maintainability

- Split `SettingsPage.tsx`.
- Split member home, login, timetable, reports, members list, and member profile.
- Centralize RBAC, reports, class generation, audit logging, uploads, and rate limiting.
- Fix lint issues and encoding corruption.

## Phase 4: Member App Completion

- Persist schedule subscriptions.
- Persist shop orders and owner fulfilment.
- Persist notification preferences.
- Add linked account/guardian support only if it is real.
- Improve member progress with rank history and attendance milestones.

## Claude Implementation Prompt

Use this prompt when asking Claude to start implementation:

```text
Please implement Phase 1 of the MatFlow audit in SYSTEM_PAGE_BY_PAGE_AUDIT.md.

Focus only on production trust and security:
1. Harden public check-in and member lookup with persistent rate limiting, signed/opaque check-in tokens, and server-side class time window enforcement.
2. Remove SVG upload support and keep uploads limited to safe raster image types.
3. Add signed waiver snapshot storage so each accepted waiver stores title, content, version, signer details, IP, user agent, and accepted timestamp.
4. Add Stripe webhook idempotency using a persisted Stripe event table.
5. Add explicit page-level role guards to all dashboard pages.
6. Add audit logging for sensitive owner/staff actions where the AuditLog model should already support it.

Do not redesign the UI yet except where needed to support the security work. Keep changes Vercel-safe: no in-memory security state for production, no local filesystem writes, and no fake/demo data presented as live production data.
```

