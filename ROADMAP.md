# MatFlow — Full Development Roadmap

> **App name:** TBD — to be decided once the app is fully operational locally.
> **Current status:** ~75% complete on core functionality. Multi-tenant, auth, CRUD, dashboard, member portal all exist. Payments, email, offline caching, and production hardening are outstanding.

---

## Phase 0 — Current State (What Works Today)

### Owner Dashboard ✅
- Login with club code + email + password
- JWT sessions (1 year), multi-tenant scoping
- Member list with rank + stripes badges
- Member detail page (attendance history, rank, subscriptions)
- Timetable management (add/edit/delete classes, schedules)
- Rank system management (belts, stripes, presets)
- Announcements (CRUD)
- Attendance records view
- Admin check-in interface
- Dashboard KPI stats
- Settings page (gym name, branding, colours)
- Analysis page (owner-only)
- Reports page (shell — no data yet)

### Member Portal ✅
- Login (email + password + club code)
- Home page (today's classes, announcements, quick sign-in)
- Schedule page
- Profile page (belt, membership, join date)
- Progress page (streak, belt card, attendance stats)
- Shop page (pay-at-desk mode without Stripe)
- QR code check-in (public, tenant-scoped)

### Infrastructure ✅
- Next.js 16 App Router, TypeScript, Tailwind CSS v4
- Prisma ORM + SQLite (local), PostgreSQL-ready
- NextAuth v5 JWT sessions
- Multi-tenant architecture
- 44 automated tests (Vitest)
- Demo fallbacks when DB unavailable

---

## Phase 1 — Core Functionality Completion

> **Goal:** Every button does something real. No dead ends, no hardcoded data leaking into production.

### 1.1 Member Home — Remove Hardcoded Demo Data
- [ ] Replace `DEMO_TODAY_CLASSES` with real schedule API data
- [ ] Replace `DEMO_ANNOUNCEMENTS` with real announcements API
- [ ] Member onboarding questionnaire (5-step modal) must save to DB — currently saves to `localStorage` only
  - Save belt, goals, training frequency to `Member` model on submit
  - Mark onboarding complete so modal doesn't reappear

### 1.2 Member Profile — Wire All Fields
- [ ] Edit name, phone — save via `PATCH /api/members/[id]`
- [ ] Belt/rank display pulled from real `MemberRank` table (done — verify)
- [ ] Membership type and join date from real DB (done — verify)
- [ ] Children profiles — currently hardcoded demo data, no DB backing

### 1.3 Member Progress
- [ ] Attendance stats (thisWeek, thisMonth, thisYear, totalClasses) — wire to real API
- [ ] Belt progress bar based on real `stripes` count from DB
- [ ] Rank history timeline — `RankHistory` model exists, no UI yet — build timeline

### 1.4 Member Shop
- [ ] Products list from real DB (`/api/member/products`) — currently unclear if wired
- [ ] Cart state management
- [ ] Order submission to DB
- [ ] Payment — Phase 3

### 1.5 Dashboard Reports
- [ ] `/dashboard/reports` — currently a shell. Wire to `/api/reports`
- [ ] Show: monthly attendance totals, membership revenue, class popularity
- [ ] CSV export button

### 1.6 Dashboard Analysis
- [ ] Owner-only. Wire charts to real attendance/revenue data
- [ ] Retention metrics, peak hours, most popular classes

### 1.7 Notifications
- [ ] In-app notifications — `Notification` model exists, no send/receive logic
- [ ] Mark as read
- [ ] Notification bell badge with unread count

### 1.8 Waitlist
- [ ] `ClassWaitlist` model exists — build UI in timetable and member schedule
- [ ] Auto-promote from waitlist when spot opens

### 1.9 Staff Management
- [ ] `POST /api/staff` exists — build "Add Staff" UI in Settings
- [ ] Role assignment (owner, manager, coach, admin)
- [ ] Deactivate staff accounts

### 1.10 Password Reset Flow
- [ ] `/api/auth/forgot-password` exists — needs email provider (Phase 2)
- [ ] Reset token UI — `/reset-password?token=xxx` page
- [ ] Token expiry enforcement

---

## Phase 2 — Security & Authentication

> **Goal:** Production-grade auth. No demo bypasses, no hardcoded credentials, no leaked tenant data.

### 2.1 Remove Demo Bypass
- [ ] `auth.ts` demo fallback (lines 82-103) — disable in production via `NODE_ENV` check
  - Keep for local dev only: `if (process.env.NODE_ENV !== 'production')`
- [ ] Remove hardcoded `password123` accounts from production seed
- [ ] Ensure `DEMO_RESPONSE` in API routes only fires in dev/demo mode

### 2.2 Owner Account Security
- [ ] Enforce strong password on account creation (min 12 chars, complexity)
- [ ] Password history — `PasswordHistory` model exists, enforce no reuse of last 5
- [ ] Session invalidation on password change — revoke all active JWTs
- [ ] Account lockout after N failed login attempts (store in DB or Redis)
- [ ] Optional: 2FA via TOTP (authenticator app) for owner accounts

### 2.3 Role-Based Access Control Audit
- [ ] Verify every API route checks `session.user.role` before returning data
- [ ] Verify every dashboard page gate is enforced server-side (not just UI)
- [ ] Coach: can view members, record attendance — cannot edit settings or view reports
- [ ] Admin: can manage members/classes — cannot view analysis
- [ ] Owner: full access

### 2.4 Tenant Isolation Audit
- [ ] Every DB query that returns member/class/attendance data must filter by `tenantId`
- [ ] Run integration tests to confirm cross-tenant data leakage is impossible
- [ ] Existing tests cover checkin-delete and cross-tenant-stats — expand coverage

### 2.5 Input Validation & Security
- [ ] All API routes use Zod schemas for request validation (audit remaining routes)
- [ ] Sanitise all user-facing text fields (prevent XSS in announcements/names)
- [ ] Rate limiting on login endpoint (prevent brute force) — middleware or Upstash
- [ ] CSRF protection — NextAuth handles this for auth routes, verify for custom APIs
- [ ] File upload validation (`/api/upload`) — restrict to images, max size, virus scan (future)

### 2.6 Secrets & Environment
- [ ] `AUTH_SECRET` must be a cryptographically random 32+ char string in production
- [ ] Rotate `AUTH_SECRET` process documented
- [ ] Never commit `.env` — `.gitignore` confirmed
- [ ] Separate `.env.local` (dev) and production env vars documented
- [ ] All required env vars documented in `.env.example`

### 2.7 HTTPS & Headers
- [ ] Force HTTPS in production (handled by hosting platform)
- [ ] Security headers: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `CSP`
- [ ] Add `next.config.js` security headers

### 2.8 Audit Log
- [ ] `AuditLog` model exists — wire to critical actions:
  - Member created/deleted
  - Belt promotion
  - Payment recorded
  - Settings changed
  - Staff role changed
- [ ] Audit log viewer in Settings (owner-only)

---

## Phase 3 — Payment Integration (Stripe)

> **Goal:** Gym owners can collect membership payments. Members pay via card. Owner sees payment status per member.

### 3.1 Stripe Setup
- [ ] Add `STRIPE_SECRET_KEY` + `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` + `STRIPE_WEBHOOK_SECRET` to env
- [ ] Test in Stripe sandbox first (use `sk_test_...` keys)
- [ ] Wire up existing `/api/member/checkout` route — currently returns mock when no key

### 3.2 Membership Tiers (per gym)
- [ ] New `MembershipTier` model: `id, tenantId, name, priceInPence, billingInterval, stripePriceId`
- [ ] Settings page: owner can create/edit/delete tiers
- [ ] "Add Member" form: select membership tier at creation

### 3.3 Member Onboarding Payment Flow
- [ ] Owner creates member → chooses:
  - **"Send Invite"** → email with link to set password + complete Stripe checkout
  - **"Set Up Now"** → QR code appears → member scans on own phone → Stripe checkout
- [ ] Stripe Checkout Session created server-side with `mode: "subscription"`
- [ ] On success: `member.paymentStatus` → `"paid"`, `member.status` → `"active"`
- [ ] Store `stripeCustomerId` + `stripeSubscriptionId` on `Member` model

### 3.4 Stripe Webhooks
- [ ] `POST /api/webhooks/stripe` — handle:
  - `checkout.session.completed` → activate member
  - `invoice.payment_succeeded` → update paymentStatus to paid
  - `invoice.payment_failed` → update paymentStatus to overdue, notify owner
  - `customer.subscription.deleted` → update status to cancelled
- [ ] Verify webhook signature with `STRIPE_WEBHOOK_SECRET`

### 3.5 Payment Dashboard
- [ ] Members list: show `paymentStatus` badge (paid / overdue / paused / free)
- [ ] Member detail page: payment history tab (Stripe invoices)
- [ ] Dashboard stats: monthly revenue, overdue count
- [ ] "Mark as paid (cash)" button for cash-paying members (manual override)

### 3.6 Stripe Connect (Multi-gym)
- [ ] Each gym connects their own Stripe account via Stripe Connect
- [ ] `Tenant` model: add `stripeAccountId`
- [ ] Settings page: "Connect Stripe" button → OAuth flow
- [ ] Payments go directly to gym's bank account
- [ ] MatFlow platform fee taken via `application_fee_amount`

---

## Phase 4 — Email & Notifications

> **Goal:** Members and owners receive emails for key events.

### 4.1 Email Provider Setup
- [ ] Choose provider: **Resend** (recommended — simple API, generous free tier) or SendGrid
- [ ] Add `RESEND_API_KEY` to env
- [ ] Create `lib/email.ts` with `sendEmail(to, subject, html)` helper

### 4.2 Transactional Emails
- [ ] **Member invite** — "You've been added to [Gym Name]. Set up your account →"
- [ ] **Password reset** — "Reset your MatFlow password →"
- [ ] **Welcome email** — sent when member status becomes active
- [ ] **Payment failed** — sent to member when Stripe invoice fails
- [ ] **Payment receipt** — sent on successful payment
- [ ] **Belt promotion** — "Congratulations! You've been promoted to [Belt] 🎉"

### 4.3 Owner Notifications
- [ ] New member joined
- [ ] Payment failed (member name + tier)
- [ ] Low class capacity warnings
- [ ] Weekly summary digest

---

## Phase 5 — Local Data Caching (Offline-First)

> **Goal:** App data loads instantly from local cache. Only re-fetches when data has changed. Works on slow connections.

### 5.1 SWR / React Query for Client-Side Caching
- [ ] Install `swr` or `@tanstack/react-query`
- [ ] Replace all `useEffect + fetch` calls with SWR hooks
- [ ] Configure: `staleTime: 5 minutes`, `cacheTime: 30 minutes`
- [ ] Key data to cache:
  - Timetable/classes (rarely changes)
  - Announcements (changes occasionally)
  - Member schedule (changes weekly)
  - Member profile stats (changes daily)

### 5.2 Service Worker (PWA)
- [ ] Install `next-pwa` package
- [ ] Configure service worker in `next.config.js`
- [ ] Cache strategy per route type:
  - **Static assets** (JS/CSS/images): Cache-first (never re-fetch)
  - **API data** (timetable, announcements): Stale-while-revalidate
  - **Auth routes**: Network-only (never cache)
- [ ] Offline fallback page — "You're offline. Cached data shown."

### 5.3 PWA Manifest
- [ ] `public/manifest.json` — app name, icons, theme colour, display: standalone
- [ ] App icons: 192×192, 512×512 (PNG)
- [ ] `apple-touch-icon` for iOS home screen
- [ ] `theme-color` meta tag matches gym's `primaryColor`
- [ ] Splash screen

### 5.4 Background Sync
- [ ] Member check-in while offline → queued → syncs when connection restored
- [ ] Uses Service Worker Background Sync API

### 5.5 Local Storage Strategy
- [ ] Timetable data: cached in IndexedDB via service worker (survives page refresh)
- [ ] User profile: cached in SWR (in-memory, re-hydrated on mount)
- [ ] Last-seen announcements: localStorage (mark as read persists offline)
- [ ] Cache invalidation: ETag or `updatedAt` timestamp comparison

---

## Phase 6 — Mobile App

> **Goal:** Members and owners can install MatFlow on their phone like a native app.

### 6.1 PWA Install (Phase 5 prerequisite)
- [ ] PWA manifest + service worker = installable on iOS and Android
- [ ] "Add to Home Screen" prompt shown to members on first visit
- [ ] No App Store submission required

### 6.2 iOS-Specific
- [ ] `apple-mobile-web-app-capable` meta tag
- [ ] `apple-mobile-web-app-status-bar-style`
- [ ] Safe area insets for iPhone notch (`env(safe-area-inset-*)`)
- [ ] Test on Safari iOS — PWA install flow

### 6.3 Android-Specific
- [ ] Chrome install banner (automatic with valid manifest + service worker)
- [ ] Test on Chrome Android

### 6.4 Push Notifications (Future)
- [ ] Web Push API — browser asks permission
- [ ] Send push via Resend or dedicated push service
- [ ] Use cases: class reminder 1hr before, belt promotion, payment due

### 6.5 Native App (Future Phase)
- [ ] If PWA is insufficient: React Native (Expo) sharing business logic
- [ ] App Store + Play Store submission
- [ ] Requires Apple Developer account ($99/yr) + Google Play account ($25 one-time)

---

## Phase 7 — Production Deployment & Global Scale

> **Goal:** App runs reliably for multiple gyms worldwide.

### 7.1 Database
- [ ] Migrate from SQLite → **PostgreSQL** (already supported via Prisma adapter)
- [ ] Recommended: **Supabase** (free tier, Postgres, auth integration) or **Neon** (serverless Postgres)
- [ ] Connection pooling via PgBouncer (Supabase includes this)
- [ ] DB backups — automated daily

### 7.2 Hosting
- [ ] Deploy to **Vercel** (zero-config Next.js hosting, global CDN)
- [ ] Or **Railway** / **Render** for more control
- [ ] Environment variables set in hosting dashboard (not in `.env`)
- [ ] Production branch: `main` → auto-deploy on push

### 7.3 Domain & SSL
- [ ] Custom domain: `matflow.io` or chosen name
- [ ] SSL: automatic via Vercel/Cloudflare
- [ ] Per-gym subdomains: `totalbjj.matflow.io` → tenant routing via slug

### 7.4 CDN & Performance
- [ ] Static assets served from CDN (Vercel handles automatically)
- [ ] Image optimisation via `next/image` (already used)
- [ ] Bundle analysis: `@next/bundle-analyzer` — find and fix large imports

### 7.5 Monitoring
- [ ] Error tracking: **Sentry** (free tier) — captures runtime errors
- [ ] Uptime monitoring: **BetterUptime** or similar
- [ ] Performance: Vercel Analytics (built-in)
- [ ] Logs: Vercel log drain or Logtail

### 7.6 Multi-Region (Future)
- [ ] US + UK + EU data residency
- [ ] GDPR compliance for EU members (data deletion, export)
- [ ] Stripe supports all three regions natively

---

## Phase 8 — App Name & Branding

> **Goal:** Name the app, build the public landing page, launch-ready branding.

### 8.1 Name Decision
- [ ] Decide on app name (currently "MatFlow")
- [ ] Check domain availability
- [ ] Register domain
- [ ] Update `manifest.json`, `<title>`, all meta tags

### 8.2 Landing Page (`/`)
- [ ] Current landing page is placeholder — build real marketing page
- [ ] Sections: Hero, Features, Pricing, How it works, FAQ, CTA
- [ ] Pricing tiers for gym owners (monthly SaaS fee)
- [ ] "Book a demo" or "Get started free" CTA

### 8.3 Gym Onboarding
- [ ] `POST /api/admin/create-tenant` exists — build self-service signup flow
- [ ] Owner signs up → creates gym → gets `totalbjj.matflow.io`
- [ ] Initial setup wizard: upload logo, set colours, create first membership tier
- [ ] Pre-populated with demo data so owner sees a working app immediately

---

## Phase 9 — Data Handling & Privacy

> **Goal:** Member data is handled responsibly and legally.

### 9.1 GDPR (EU) / UK GDPR
- [ ] Privacy policy page
- [ ] Cookie consent banner (minimal — JWT is not a tracking cookie)
- [ ] Data export: member can request all their data as JSON/CSV
- [ ] Data deletion: member or owner can delete member account + all associated data
- [ ] Data retention policy: how long attendance records are kept

### 9.2 Local Temporary Data
- [ ] Onboarding questionnaire: currently `localStorage` → move to DB (Phase 1.1)
- [ ] Draft announcements: autosave to `localStorage` while typing
- [ ] Form state: `localStorage` for multi-step forms (survives page refresh)
- [ ] Clear local data on logout

### 9.3 Sensitive Data Handling
- [ ] `passwordHash` — bcrypt with cost factor 12 (already implemented)
- [ ] Payment card data — never stored in MatFlow DB (Stripe handles everything)
- [ ] Stripe customer ID stored (non-sensitive reference)
- [ ] No logging of passwords or tokens

---

## Summary — Phase Order & Priority

| Phase | Priority | Effort | Blocks |
|---|---|---|---|
| Phase 1 — Core functionality | **Critical** | Medium | Everything |
| Phase 2 — Security | **Critical** | Medium | Production launch |
| Phase 3 — Payments (Stripe) | High | High | Revenue |
| Phase 4 — Email | High | Low | Member onboarding |
| Phase 5 — Data caching | Medium | Medium | Mobile feel |
| Phase 6 — Mobile/PWA | Medium | Low (PWA) | Phase 5 |
| Phase 7 — Deployment | High | Medium | Going live |
| Phase 8 — App name/branding | Medium | Low | Marketing |
| Phase 9 — Data/privacy | Medium | Low | Legal compliance |

**Recommended build order:** 1 → 2 → 4 → 7 → 3 → 5 → 6 → 8 → 9

---

*Last updated: 2026-04-18*
