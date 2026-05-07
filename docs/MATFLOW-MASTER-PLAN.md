# MatFlow — Master Feature Plan

Single source of truth for what exists, what's planned, and how each piece is supposed to work. Read top-to-bottom before changing anything large.

Last updated: 2026-05-06

---

## 1. Surface map

Three independent surfaces, each with its own auth model and UX language:

| Surface | URL | Audience | Auth | Theme |
|---|---|---|---|---|
| Owner / staff product | `/dashboard/*` | Gym owners, managers, coaches | NextAuth (email/password + TOTP) on tenant `User` rows | Dark, branded per-tenant |
| Member portal | `/member/*` | Gym members | NextAuth on `Member` rows | Dark, branded per-tenant |
| Operator console | `/admin/*` | Platform operator (Noe) | Operator email/password + TOTP (v1.5) **OR** legacy `MATFLOW_ADMIN_SECRET` cookie (v1, fallback) | White, intentionally distinct |

The visual difference between operator-white and product-dark is a feature, not a bug — the operator should always know which surface they're in.

---

## 2. Operator console (`/admin/*`) — current state

### Pages
- `/admin/login` — tabbed: Account (Operator email + password + optional TOTP) / Bootstrap (legacy secret)
- `/admin` — dashboard: active gyms, trial cohort, pending applications, locked owners, broken Stripe, failed payments, recent audit
- `/admin/tenants`, `/admin/tenants/[id]` — list + detail (snapshot stats, login-as-owner, danger zone)
- `/admin/applications` — gym application queue (approve / reject)
- `/admin/billing` — billing overview
- `/admin/activity` — audit log feed
- `/admin/security` — operator's own TOTP enrolment

### Auth invariants (security)
- Operator login (v1.5): bcrypt verify, rate-limit 5/15min per IP, lockout 5 fails → 15 min, sessionVersion-based revocation, HMAC-signed session cookie that does NOT contain the credential
- TOTP: short-lived `matflow_op_challenge` cookie issued only after password success; verified via `/api/admin/auth/operator-totp`; consumed on success, replaced by `matflow_op_session`
- Edge gate (`proxy.ts`): Web Crypto HMAC verify of session cookie OR exact-match secret cookie OR `x-admin-secret` header
- Page-shell gate: server components call `isAdminPageAuthed()` which does the full DB-backed sessionVersion check
- Logout: clears all 3 cookies (legacy, session, challenge)

### Audit identity
Wired through `/api/admin/impersonate`, `/api/admin/create-tenant`, `/api/admin/applications/[id]/{approve,reject}`. Stamps the real `Operator.id`. Other operator routes still pass `SENTINEL_OPERATOR_ID` — backlog item to thread `getOperatorContext` through them.

### Known gaps
- No operator self-service password change route
- No operator account list / management page (only one row exists today)
- Light-theme migration is complete on operator pages but page layouts are dense rather than spacious — visual polish backlog
- No "client health" rollup yet on `/admin/tenants/[id]` (Stripe state, overdue payments, waiver completion, etc.)

---

## 3. Owner / staff product (`/dashboard/*`) — current state

Tenant-scoped. Every API route uses `withTenantContext(tenantId, fn)` so RLS policies enforce isolation as a backstop.

### Pages
- `/dashboard` — overview
- `/dashboard/members` — member CRUD with search, pagination, status filters
- `/dashboard/check-in` — kiosk-style check-in
- `/dashboard/classes` — schedule + class CRUD
- `/dashboard/payments` — payment ledger + manual refund + void packs (recently shipped)
- `/dashboard/announcements` — gym-wide announcements
- `/dashboard/reports` — analytics
- `/dashboard/settings/*` — branding, integrations, billing, waiver, etc.

### Auth invariants
- NextAuth v5 JWT sessions (`__Secure-authjs.session-token` on prod)
- TOTP mandatory for owner role on production (`requireTotpSetup` flag)
- The cookie-name v5 migration bug (commits `be8f599`, `93eb3b5`) is fixed
- `withTenantContext` wraps all tenant-scoped reads/writes; `withRlsBypass` reserved for true platform/operator queries

### Known gaps
- Some routes still leak raw `error.message` to clients — backlog hardening
- Member list pagination is in but not always used by callers — sweep needed
- Reports module has limited time ranges
- No native bulk-import UI (admin import endpoint exists but no in-product surface)

---

## 4. Member portal (`/member/*`) — current state

### Pages
- `/member/home` — landing
- `/member/schedule` — book classes
- `/member/progress` — belt promotions, attendance
- `/member/shop` — class packs, products

### Auth invariants
- NextAuth on `Member` table
- Optional self-billing
- Magic-link login supported (`/api/magic-link/*`)
- Cookie name fix shipped, magic-link finalisation now uses v5 cookie name

### Known gaps
- Limited account-settings surface for members
- No native referral system

---

## 5. First-time owner onboarding — current state and remaining gaps

### Current state (9 stages, shipped)

The onboarding wizard at `/onboarding` ([components/onboarding/OwnerOnboardingWizard.tsx](../components/onboarding/OwnerOnboardingWizard.tsx), ~1380 lines) walks the owner through 9 stages then a final summary. PIPELINES.md §1.6 has the canonical breakdown with file:line citations; here is the current order:

1. **Identity** — confirm gym name (`PATCH /api/settings { name }`)
2. **Discipline** — multi-select from BJJ, Boxing, Muay Thai, MMA, Kickboxing, Wrestling, Judo, Karate, Other (drives stage-3 presets)
3. **Rank System** — pick rank presets per discipline (BJJ has 4 stripes, others 0); persisted via `POST /api/ranks`
4. **Timetable** — add classes (name, coach, location, days, times, capacity); persisted via `POST /api/classes` then `POST /api/instances/generate`
5. **Branding** — pick a colour theme from 12 presets or custom, upload logo, pick logo size; persists colours/font/logoUrl/logoSize
6. **Questionnaire** — gym size, goals, referral source; stored in `Tenant.onboardingAnswers`
7. **Payment Rail** — choose `pay_at_desk` or `stripe`; if Stripe, redirects through Connect OAuth
8. **TOTP Enrolment** — mandatory for owner role: scan QR, verify code, save 8 recovery codes
9. **Member Import** — `manual` (defer) / `white_glove` (CSV upload to ops queue) / `self_serve` (member invites)
10. **Final summary** → "Go to Dashboard"; sets `Tenant.onboardingCompleted = true`

**Wizard v2 re-entry:** the dashboard `SetupBanner` ([app/dashboard/page.tsx:12-48](../app/dashboard/page.tsx#L12-L48)) detects post-onboarding gaps (no Stripe, no membership tiers, no classes, no members) and links back to `/onboarding?resume=1` so the owner can revisit skipped steps without rerunning the whole wizard.

**Edge proxy gate:** `requireTotpSetup` owners are pinned to `/login/totp/setup` for every request *except* the onboarding API surface, so the in-wizard TOTP step (stage 8) doesn't fight the gate. Once TOTP enrolment succeeds, the JWT is re-encoded to clear the flag.

### Remaining gaps (not yet in the wizard)

The 9 stages above cover identity, scheduling, payments, security, and member import — enough to take a first booking and first payment. The wizard is **operationally complete for v1**. Items below are next-tier polish:

1. **Contact + legal** — billing contact email, privacy contact email, address/country/timezone/currency, privacy/terms/waiver URLs (currently defaults are used). Worth adding when a tenant has compliance pressure.

2. **Membership tiers** — `MembershipTier` rows are creatable post-wizard via `/dashboard/memberships`, but a 3-template pre-fill in the wizard (Trial / Monthly Unlimited / Class Pack 10) would shorten time-to-first-payment. The dashboard `SetupBanner` flags this as a gap today, so the friction is already surfaced.

3. **Newsletter integration** — see Section 6 for the build-vs-Mailchimp decision. Not in the wizard yet.

### Out of scope for the wizard (post-onboarding settings)
- Advanced reports config
- Operator-level integrations (Google Calendar sync etc.)
- Payment method changes
- Waiver versioning

---

## 6. Newsletter integration — the choice

Two paths. Pick one.

### Option A: Mailchimp (third-party)

**Pros**
- Battle-tested deliverability (no IP warming, no DKIM/SPF setup)
- Pre-built templates, segmentation, automation flows
- Compliance handled (GDPR, CAN-SPAM, unsubscribe)
- Free tier generous for under 500 contacts

**Cons**
- Per-tenant API key complexity (each owner has their own Mailchimp account, or you use a single MC account and segment by tag — the latter has scaling issues)
- Subscriber data flows out of MatFlow (privacy implications, especially under UK GDPR if member data crosses to MC)
- Cost scales with member count
- Brittle if Mailchimp changes API

**Implementation sketch**
- Owner connects their Mailchimp account via OAuth (or pastes an API key)
- New members auto-added to a per-tenant audience as tagged contacts
- "Send newsletter" button in dashboard → MC's transactional API
- Sync goes one-way: MatFlow → MC (don't try to sync MC unsubscribes back)

### Option B: Custom (Resend + your own templates)

**Pros**
- Full ownership of subscriber data — no third-party data flow
- One Resend API key for the whole platform (you already have Resend wired for transactional email per the existing `/api/webhooks` mention)
- Control over deliverability, branding, segmentation logic
- No per-tenant config — works out of the box for every gym

**Cons**
- You build the templating layer, the unsubscribe management, the segmentation, the analytics
- Compliance is your responsibility (you're the data controller, not a processor)
- Deliverability tuning is your job (warmup, complaint loop monitoring)
- ~2-3 weeks of build time

**Implementation sketch**
- New `Campaign` model: tenantId, name, subject, htmlBody, plainBody, audience filter, scheduledAt, sentAt
- New `CampaignDelivery` model: campaignId, memberId, sentAt, openedAt, clickedAt, unsubscribedAt
- Editor in dashboard with pre-built templates (drag/drop or markdown-based)
- Dispatcher: cron job (Vercel cron) reads `Campaign` rows where `scheduledAt <= now AND sentAt IS NULL`, fans out via Resend in batches
- Public unsubscribe URL: `/u/<token>` (token signed, contains memberId + campaignId), updates `Member.gymAnnouncements = false` or per-list opt-out

### Recommendation

**Option B (custom).** Reasons:
1. Owners trust YOU with their member data — making them set up a Mailchimp account is friction and a privacy red flag
2. You already operate Resend for transactional email — adding marketing is an incremental cost, not a new vendor
3. Subscriber list IS the gym's most valuable asset; surrendering it to MC weakens the long-term defensibility of the platform
4. UK GDPR is materially simpler when data stays in MatFlow's controller relationship
5. Custom can be built minimal and grow — Mailchimp can't be made simpler than it is

Trade-off accepted: ~2-3 weeks of build vs. a long-term moat.

If the user is in a hurry to ship newsletters, integrate Mailchimp as a transitional measure with a documented intent to migrate to custom.

---

## 7. Security stance — the rules every feature must follow

Stable rules, copy these into every PR description if needed:

1. **Tenant-owned resources stay tenant-scoped.** Never `findUnique({ where: { id } })` on a tenant resource — always include `tenantId` in the where clause OR use `withTenantContext`.
2. **Operator routes accept either auth path.** `isAdminAuthed(req)` short-circuits through header → legacy cookie → operator session. New /admin/* routes must call this — never a custom check.
3. **No raw `error.message` to clients.** Catch, log internally, return a generic message. Existing routes that leak this are tracked as a backlog hardening sweep.
4. **Money writes are transactional.** `prisma.$transaction` for any flow that touches Payment + another model.
5. **Append-only for audit / money.** Don't UPDATE Payment.status to "void" — create a new refund row referencing the original.
6. **Paginate every list query.** No unbounded `findMany` on Member, Payment, AuditLog, etc. Use cursor or skip/take with explicit limits.
7. **Prefer `_count` over loaded relation arrays for summary metrics.** Faster, lighter, no privacy risk of accidentally including row data.
8. **Cookie names are v5 (`__Secure-authjs.session-token`, `matflow_op_session`, `matflow_op_challenge`, `matflow_admin`).** Never reintroduce v4 names.
9. **Rate-limit every auth surface.** 5 attempts per IP per 15 min minimum on login endpoints.
10. **Sessions are revocable.** Bumping `sessionVersion` invalidates all tokens for that subject (Operator, User, Member).

---

## 8. Verification approach

The 147-failing baseline test suite is its own debt; that's a separate project (~4–8 hours of triage). For new work, the rule is:

- Ship adds a unit test or E2E test for the new behaviour
- The wider 147-failing count must not increase
- TypeScript `tsc --noEmit -p tsconfig.json` must be clean

Production smoke tests live in `scripts/playwright-verify-v1.5-admin.mjs`. That script runs end-to-end against `https://matflow.studio` and is the canonical way to confirm operator auth + TOTP works after any change. Run it after every operator-surface deploy.

---

## 9. Recommended execution order (next 4 sessions)

1. **Session N (this one):** This document. Plan only.
2. **Session N+1:** Operator-side audit-identity sweep — thread `getOperatorContext` through every remaining `/api/admin/*` route. Small, mechanical, high security value.
3. **Session N+2:** Owner-onboarding wizard redesign — Sections 5.4 through 5.8 (legal, classes, tiers, members import). Skip newsletter for now.
4. **Session N+3:** Newsletter (Option B) — `Campaign` + `CampaignDelivery` models, editor stub, Resend dispatcher, unsubscribe URL. MVP only.
5. **Session N+4:** Client health rollup on `/admin/tenants/[id]` + light-theme polish across operator pages.

The 147-failing test triage is a parallel track — schedule it post-exams or as filler in any session that has spare cycles.

---

## 10. Open decisions (need user input)

- **Newsletter:** Option A (Mailchimp) or Option B (custom)? Recommendation = B.
- **Wizard step ordering:** Pre-fill class types and tiers (faster but more opinionated) or empty start (slower but neutral)? Recommendation = pre-fill with edit/delete.
- **Operator account list page:** Build now (1h) or defer until there's a second operator? Recommendation = defer; you're the only operator today.
- **147-failing tests:** Triage in this session sequence or defer to post-exams? Recommendation = defer; exam season takes priority.

This document is a living artefact — when one of these decisions is made, the section above it should be updated to reflect "decided X because Y" rather than "open decision."
