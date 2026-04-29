# MatFlow — Owner Site Inventory (2026-04-29)

Page-by-page map of everything an owner / staff / coach can reach in MatFlow. For each page I've captured what it does, who can see it, what works, what doesn't, and where the implementation lives. Cross-references to the two audit docs ([docs/AUDIT-2026-04-27.md](docs/AUDIT-2026-04-27.md), [PRODUCTION_QA_AUDIT.md](PRODUCTION_QA_AUDIT.md)) point at deeper detail.

## How to read this doc

Every page entry has:

- **Path / File** — URL and source location.
- **Purpose** — one sentence.
- **Role gating** — which auth helper is used, and which roles pass.
- **Data shown** — main entities and stats on the page.
- **Key actions** — every interactive element. Marked **✅ working**, **⚠️ partial**, or **❌ dead**.
- **API endpoints** — the routes the page hits (server-side or client-side).
- **Sub-components** — major child components.
- **Known issues** — severity-tagged, with current open/closed status as of today.
- **Mobile / responsive** — what the page does on small screens.
- **States handled** — empty / loading / error.

Severity legend: **P0** = launch blocker, **P1** = serious workflow bug, **P2** = polish, **P3** = future improvement.

---

## Production status snapshot (2026-04-29)

| Area | Status |
|---|---|
| Auth / login / sessions | ✅ Working |
| Multi-tenant data isolation | ✅ Enforced |
| Dashboard role gating (proxy + page-level) | ✅ Working |
| Stripe Connect + webhooks | ✅ Webhook handler reachable (commit `c075575`) |
| QR check-in | ✅ Landing page reachable (commit `c075575` + `79afaab`) |
| Legal pages | ✅ Public (commit `c075575`) |
| Database (Neon, pgbouncer pooled) | ✅ Connected |
| Migrations applied | ✅ 16 migrations, two new today (MonthlyReport unique, AttendanceRecord.tenantId + 4 indexes) |
| Outbound email | ⚠️ Off — `RESEND_API_KEY` not set |
| Resend status webhook | ⚠️ 503 — `RESEND_WEBHOOK_SECRET` not set |
| Monthly cron | ⚠️ 503 — `CRON_SECRET` not set |
| Claude AI causal report | ⚠️ Off — `ANTHROPIC_API_KEY` not set |
| Google Drive integration | ⚠️ Off — `GOOGLE_CLIENT_ID/SECRET` not set |

---

## Shared infrastructure

### Layout

- **File:** [app/dashboard/layout.tsx](app/dashboard/layout.tsx)
- **Purpose:** Root layout for every `/dashboard/*` route. Splits into desktop (Sidebar + Topbar) and mobile (MobileNav bottom tabs) renders.
- **Role gating:** Layout-level `auth()` redirects unauth → `/login`. Members redirect to `/member/home`. Owners with `tenant.onboardingCompleted === false` redirect to `/onboarding`.
- **Data shown:** Tenant logo, name, primary/secondary/text colors, current user name + role + email.
- **Sub-components:** `Sidebar`, `Topbar`, `MobileNav`, `ThemeProvider`.
- **Known issues:**
  - **P2** — Sidebar accepts an unused `plan?: string` prop ([components/layout/Sidebar.tsx](components/layout/Sidebar.tsx)). Dead code; drop in polish pass.
- **Mobile / responsive:** ✅ Full — `hidden md:flex` desktop sidebar, `md:hidden` mobile bottom nav with safe-area padding for iPhone notch/home indicator.

### Sidebar

- **File:** [components/layout/Sidebar.tsx](components/layout/Sidebar.tsx)
- **Purpose:** Left-side desktop navigation. Branding header + role-filtered nav items.
- **Role filter:** Coaches see fewer admin entries (no Settings, Analysis, Notifications).
- **Key actions:**
  - Dashboard / Today's Register / Timetable / Members / Attendance / Check-In / Ranks / Notifications / Reports / Analysis / Settings — each `<Link>` ✅ working with active-state highlighting.
- **Known issues:** P2 dead `plan` prop (above).
- **Mobile / responsive:** Hidden on `<md`.

### Topbar

- **File:** [components/layout/Topbar.tsx](components/layout/Topbar.tsx)
- **Purpose:** Header bar with logo + page title + account dropdown.
- **Key actions:**
  - **Sign out** — calls `signOut()`. ✅ working.
  - **Sign out all devices** — POSTs `/api/auth/logout-all` (bumps `sessionVersion` invalidating every JWT) then `signOut()`. ✅ working.
- **Known issues:** None blocking. `[needs browser test]` for role-pill rendering with extreme tenant brand colors.
- **Mobile / responsive:** Hidden on `<md`.

### MobileNav

- **File:** [components/layout/MobileNav.tsx](components/layout/MobileNav.tsx)
- **Purpose:** Mobile bottom tab bar — Home, Schedule, Members, Check-In, More.
- **Role filter:** Check-In hidden for coaches (matches dashboard/checkin gate).
- **Key actions:**
  - Primary tab links ✅ working.
  - **More** sheet — bottom drawer with Attendance, Ranks, Notifications, Reports, Analysis, Settings + Sign out. ✅ working with backdrop dismiss.
- **Known issues:** None flagged.
- **Mobile / responsive:** ✅ Designed mobile-first.

---

## Dashboard pages

### 1. `/dashboard` — Home

- **File:** [app/dashboard/page.tsx](app/dashboard/page.tsx)
- **Purpose:** Landing page after login. Eight stat cards + this week's class calendar.
- **Role gating:** `requireStaff()` → owner / manager / coach / admin.
- **Data shown:**
  - Stats: `totalActive`, `newThisMonth`, `attendanceThisWeek`, `attendanceThisMonth`, `waiverMissing`, `missingPhone`, `paymentsDue`, `atRiskMembers` (no check-in in last 14 days).
  - Calendar: today's week of classes (Mon–Sun), each with name, coach, time, location, capacity, enrolled count.
- **Key actions:** Read-only. Calendar items navigate to per-class detail pages where wired.
- **API endpoints:** Server-side Prisma queries only (no fetch).
- **Sub-components:** `DashboardStats` (recently redesigned in commit `b811589`), `WeeklyCalendar`.
- **Known issues:**
  - **P1 ✅ Closed** (commit `c075575`) — was using `include: { attendances: { select: { id: true } } }` then `.length` (N+1). Now uses `_count: { select: { attendances: true } }`.
  - **P1 ✅ Closed** (commit `c075575`) — DB-error catch was silent. Now `console.error("[dashboard]", e)` before showing empty state.
  - **P2** — DashboardStats redesign (commit `b811589`) was a WIP iteration with no browser regression test. `[needs browser test]`.
- **Mobile / responsive:** ✅ Stats stack, calendar adapts.
- **States handled:** Empty arrays render zeros (acceptable). Errors logged.

### 2. `/dashboard/members` — Members list

- **File:** [app/dashboard/members/page.tsx](app/dashboard/members/page.tsx)
- **Purpose:** Searchable, filterable list of every member in the tenant.
- **Role gating:** `requireStaff()`.
- **Data shown:** Name, email, phone, membership type, status, payment status, waiver accepted, account type, DOB, joined date, last visit, current rank.
- **Key actions:** Search box, status / payment / waiver filters, ghost-member chip (Quiet 14d+), pagination — all ✅ working.
- **API endpoints:** Server-side Prisma read (the page-level query uses includes; the separate `/api/members` REST endpoint that supports cursor pagination is not used by this page yet).
- **Sub-components:** `MembersList`.
- **Known issues:**
  - **P2** — Mobile column hiding may truncate "Method" / "Last Visit" columns. `[needs browser test]`.
  - **P2** — After add/edit/delete, list isn't auto-refetched (no SWR mutation). Other open tabs see stale data.
- **Mobile / responsive:** Mobile-first table with horizontal scroll fallback.
- **States handled:** Empty list = friendly empty state.

### 3. `/dashboard/members/[id]` — Member detail

- **File:** [app/dashboard/members/[id]/page.tsx](app/dashboard/members/[id]/page.tsx)
- **Purpose:** Single member's full profile, attendance, payments, ranks, notes.
- **Role gating:** `requireStaff()`.
- **Data shown:** Profile fields, last 50 attendances, full payment ledger (real, not demo), rank achievement history, notes, emergency contact, medical conditions, waiver status.
- **Key actions:**
  - **Edit profile** form ✅ working.
  - **Add rank** dropdown ✅ working.
  - **Record manual payment** ✅ working (transactional via US-005 — Payment.create + Member.update wrapped in `$transaction`).
  - **More actions** menu ✅ working — Mark inactive, Resend waiver link.
  - **Message** button ✅ removed (US-008 deslop pass — was dead JSX).
- **API endpoints:** `PATCH /api/members/[id]`, `POST /api/payments/manual`, `POST /api/members/[id]/rank`, `GET /api/members/[id]/payments`.
- **Sub-components:** `MemberProfile` (~1500 lines).
- **Known issues:**
  - **P2** — No optimistic concurrency on PATCH; two staff editing the same member silently overwrite each other.
- **Mobile / responsive:** ✅ Form grid `grid-cols-1 sm:grid-cols-2`.
- **States handled:** Yes.

### 4. `/dashboard/timetable` — Timetable

- **File:** [app/dashboard/timetable/page.tsx](app/dashboard/timetable/page.tsx)
- **Purpose:** Class CRUD + recurring schedules + instance generation.
- **Role gating:** `requireStaff()`.
- **Data shown:** Classes (name, coach, location, duration, capacity, color, description, required rank), their schedules (day-of-week + start/end times), active flag.
- **Key actions:** Add / edit / delete class, add / edit schedule, generate instances forward — all ✅ working.
- **API endpoints:** `POST /api/classes`, `PATCH /api/classes/[id]`, `DELETE /api/classes/[id]`, `POST /api/instances/generate` (now batched via `createMany({skipDuplicates:true})` — US-009).
- **Sub-components:** `TimetableManager`.
- **Known issues:** None blocking. `[needs browser test]` for mobile layout.
- **Mobile / responsive:** Designed for desktop primarily.
- **States handled:** Form validation with zod.

### 5. `/dashboard/checkin` — Today's check-in

- **File:** [app/dashboard/checkin/page.tsx](app/dashboard/checkin/page.tsx)
- **Purpose:** Real-time attendance marking for today's class instances.
- **Role gating:** `requireRole(["owner", "manager", "admin"])` — **coaches excluded** (they have `/dashboard/coach` instead).
- **Data shown:** Today's class instances (name, coach, location, time, capacity, color), members enrolled in selected class, checked-in status.
- **Key actions:** Tap a member to toggle attendance; switch class via top picker — ✅ working.
- **API endpoints:** `POST /api/checkin` (admin path), `DELETE /api/checkin?classInstanceId=&memberId=` to unmark.
- **Sub-components:** `AdminCheckin`.
- **Known issues:**
  - **P2 ✅ Mitigated today** — `/api/checkin/members` endpoint was unbounded; now cursor-paginated (default 200, max 500).
- **Mobile / responsive:** ✅ Mobile-first.
- **States handled:** Yes.

### 6. `/dashboard/coach` — Coach register

- **File:** [app/dashboard/coach/page.tsx](app/dashboard/coach/page.tsx)
- **Purpose:** Coach-flavored "today's register" — different layout from admin check-in, focuses on the class the coach is teaching.
- **Role gating:** `requireStaff()` (coaches included).
- **Data shown:** Delegated to `CoachRegister` — today's classes for this coach, attendance counts (using `_count` after US-010), waitlist if any.
- **Key actions:** Mark / unmark attendance per class — ✅ working.
- **API endpoints:** `GET /api/coach/today`, `POST /api/coach/instances/[id]/attendance`, `GET /api/coach/instances/[id]/register`.
- **Sub-components:** `CoachRegister`.
- **Known issues:** None blocking.
- **Mobile / responsive:** ✅ Mobile-aware.
- **States handled:** Yes.

### 7. `/dashboard/attendance` — Attendance ledger

- **File:** [app/dashboard/attendance/page.tsx](app/dashboard/attendance/page.tsx)
- **Purpose:** Read-only attendance history (last 100 records) + summary stats.
- **Role gating:** `requireStaff()`.
- **Data shown:** Recent records (member name, class, date, time, check-in method) + summary (this-week count, this-month count, unique members this month, top class).
- **Key actions:** None — read-only.
- **API endpoints:** Server-side Prisma read.
- **Sub-components:** `AttendanceView`.
- **Known issues:**
  - **P2** — DB error caught silently (no `console.error`). Same pattern as the dashboard fix — will resolve in audit P3 polish pass.
- **Mobile / responsive:** ✅ Mobile-first.
- **States handled:** Empty list shows friendly state; errors silently fall through.

### 8. `/dashboard/notifications` — Announcements

- **File:** [app/dashboard/notifications/page.tsx](app/dashboard/notifications/page.tsx)
- **Purpose:** Create / pin / delete gym-wide announcements (visible to members on `/member/home`).
- **Role gating:** `requireOwnerOrManager()` — **owner + manager only**, not coaches/admin.
- **Data shown:** All announcements (title, body, image, pinned flag, created date), ordered pinned-first then newest, capped at 50.
- **Key actions:** Add / edit / delete / pin-toggle — all ✅ working.
- **API endpoints:** `POST/PATCH/DELETE /api/announcements/[id]`, `POST /api/announcements`.
- **Sub-components:** `AnnouncementsView`.
- **Known issues:**
  - **P2** — `/api/announcements/[id]` GET still uses post-update `findUnique({where:{id}})` for the read-back. Tenant-scoped at the mutation step so safe in context, but defensive scoping pending in P3 cleanup.
- **Mobile / responsive:** ✅ Mobile-aware.
- **States handled:** Yes.

### 9. `/dashboard/ranks` — Ranks

- **File:** [app/dashboard/ranks/page.tsx](app/dashboard/ranks/page.tsx)
- **Purpose:** CRUD rank templates per discipline (BJJ, Judo, etc.). Order, color, max-stripes per rank.
- **Role gating:** `requireRole(["owner", "manager", "coach"])` — admin excluded.
- **Data shown:** Ranks ordered by discipline + order index.
- **Key actions:** Add / edit / delete rank — all ✅ working.
- **API endpoints:** `POST /api/ranks`, `PATCH /api/ranks/[id]`, `DELETE /api/ranks/[id]`.
- **Sub-components:** `RanksManager`.
- **Known issues:** None blocking.
- **Mobile / responsive:** ✅ Mobile-aware.
- **States handled:** Yes.

### 10. `/dashboard/reports` — Reports

- **File:** [app/dashboard/reports/page.tsx](app/dashboard/reports/page.tsx)
- **Purpose:** Charts + member trends + payment summary + class utilization.
- **Role gating:** Inline check — `if (!["owner", "manager"].includes(session.user.role)) redirect("/dashboard")`. Owner + manager only.
- **Data shown:** Aggregations from `lib/reports.ts` (member growth, attendance heatmap, revenue, top classes, initiatives panel).
- **Key actions:** Chart filters, date-range picker, generate-report button (creates a `MonthlyReport` row).
- **API endpoints:** `GET /api/reports`, `POST /api/reports/generate`.
- **Sub-components:** `ReportsView`, `InitiativesPanel`.
- **Known issues:**
  - **P1 ✅ Mitigated today** — `lib/reports.ts` was unbounded `findMany`; now hard-capped at `take: 10000` (attendance) + `take: 5000` (members) with `console.warn` on truncation.
  - **P1 ⚠️ Open** — Claude AI causal report endpoint `/api/reports/generate` calls `generateMonthlyReport()` which throws if `ANTHROPIC_API_KEY` is unset.
- **Mobile / responsive:** Charts adapt; `[needs browser test]`.
- **States handled:** Yes.

### 11. `/dashboard/analysis` — Analysis (owner-only)

- **File:** [app/dashboard/analysis/page.tsx](app/dashboard/analysis/page.tsx)
- **Purpose:** Owner-only deep insights — member growth trend, 6-month check-in trend, status breakdown, MoM compare.
- **Role gating:** Inline — `if (session.user.role !== "owner") redirect("/dashboard")`. Owner only.
- **Data shown:** KPIs (totalMembers, newThisMonth, newLastMonth, checkinsThisMonth, checkinsLastMonth, activeClasses), charts (monthlyTrend, membersByStatus), gym name, current month label.
- **Key actions:** Read-only insights view.
- **API endpoints:** Server-side Prisma aggregations.
- **Sub-components:** `AnalysisView`.
- **Known issues:**
  - **P2** — Catches DB error silently like attendance page.
- **Mobile / responsive:** Charts adapt; `[needs browser test]`.
- **States handled:** Empty state; errors silent.

### 12. `/dashboard/settings` — Settings (owner-only)

- **File:** [app/dashboard/settings/page.tsx](app/dashboard/settings/page.tsx)
- **Purpose:** Tenant configuration — branding, waiver, staff roster, Stripe Connect, integrations, TOTP, subscription details.
- **Role gating:** Inline — `if (session.user.role !== "owner") redirect("/dashboard")`. Owner only.
- **Data shown:**
  - Tenant: name, slug, logo, colors, subscription status/tier, created date.
  - Counts: members (broken down by status), staff, active classes.
  - Staff roster: name, email, role, created date.
  - Stripe Connect: connected flag, account ID, BACS toggle.
  - Waiver: editable title + content (interpolates gym name via `buildDefaultWaiverTitle/Content` in [lib/default-waiver.ts](lib/default-waiver.ts)).
  - Current user TOTP enabled flag.
- **Key actions:**
  - Edit branding (logo upload, colors, font) ✅ working.
  - Edit waiver text ✅ working.
  - Stripe Connect connect / disconnect ✅ working (gated by ToS gate; live-test pending).
  - Staff CRUD (add / edit / delete with `sessionVersion` bump on role change — US-005) ✅ working.
  - TOTP setup / verify / disable ✅ working.
  - Google Drive connect ⚠️ throws "OAuth not configured" without env vars.
  - **Reset onboarding** — `POST /api/owner/reset-onboarding` flips `Tenant.onboardingCompleted = false` so the wizard fires again. ✅ working.
- **API endpoints:** Many — `PATCH /api/settings`, `POST /api/staff`, `PATCH /api/staff/[id]`, `DELETE /api/staff/[id]`, `POST /api/auth/totp/setup`, `POST /api/stripe/connect`, `POST /api/stripe/disconnect`, `POST /api/drive/connect`, `POST /api/owner/reset-onboarding`, `POST /api/upload`.
- **Sub-components:** `SettingsPage` (the largest component in the codebase — 130 hot-paths logged).
- **Known issues:**
  - **P1 ⚠️ Open** — Drive integration env vars unset; click → 500 with generic message (US-001 + the apiError follow-up keep the real error server-side).
  - **P2** — Member self-billing flag deferred ([project memory](C:\Users\NoeTo\.claude\projects\c--Users-NoeTo-Desktop-matflow\memory\project_billing_ownership_default.md)). Currently any authenticated member can hit `/api/stripe/portal` if they discover the URL.
- **Mobile / responsive:** ✅ Mobile-aware (recent fix for tab visibility).
- **States handled:** Yes.

---

## Onboarding

### 13. `/onboarding` — Owner setup wizard

- **File:** [app/onboarding/page.tsx](app/onboarding/page.tsx)
- **Purpose:** Multi-step wizard a new gym owner completes after signup. Sets gym name, picks disciplines, configures ranks, defines classes, picks branding, answers operational questions.
- **Role gating:** Page-level — `if (!session?.user) redirect("/login")`, `if (session.user.role !== "owner") redirect("/dashboard")`, redirects to `/dashboard` if `tenant.onboardingCompleted === true`.
- **Data shown:** 6 steps (gym name → disciplines → rank presets → classes → branding → operational Q&A about gym size, goals, referral source).
- **Key actions:** Each step's form submits and advances ✅ working. Final submit flips `Tenant.onboardingCompleted = true`.
- **API endpoints:** `PATCH /api/settings`, `POST /api/ranks` (per rank preset), `POST /api/classes` (per class), `POST /api/upload` (logo), `POST /api/instances/generate` after classes are added.
- **Sub-components:** `OwnerOnboardingWizard`.
- **Known issues:**
  - **P0 ✅ Closed (with caveat)** — Page is correctly gated: it requires a session, so `/onboarding` 307→`/login` for unauth users is **intentional**. Earlier I'd flagged this as a P0 in PRODUCTION_QA_AUDIT.md but it was a misclassification — the route was never meant to be public.
- **Mobile / responsive:** ✅ Bottom-sheet pattern (`fixed inset-0 z-50`).
- **States handled:** Wizard step state managed locally; form validation via zod.

---

## Critical issues cross-reference

| Severity | Issue | Status (today) | Source |
|---|---|---|---|
| **P0** | Stripe webhook 307→login | ✅ Closed `c075575` | PRODUCTION_QA_AUDIT.md |
| **P0** | Resend webhook 307→login | ✅ Closed `c075575` | PRODUCTION_QA_AUDIT.md |
| **P0** | QR check-in landing 307→login | ✅ Closed `c075575` | PRODUCTION_QA_AUDIT.md |
| **P0** | Legal pages 307→login | ✅ Closed `c075575` | PRODUCTION_QA_AUDIT.md |
| **P0** | `/onboarding` 307→login | ✅ Misclassification — correct behaviour | PRODUCTION_QA_AUDIT.md |
| **P0** | `RESEND_API_KEY` unset | ⚠️ Open | PRODUCTION_QA_AUDIT.md |
| **P0** | DATABASE_URL got nulled by my CLI fix | ✅ Closed (you fixed via Vercel dashboard) | This session |
| **P1** | Dashboard N+1 attendances | ✅ Closed `c075575` | PRODUCTION_QA_AUDIT.md |
| **P1** | Dashboard silent catch | ✅ Closed `c075575` | PRODUCTION_QA_AUDIT.md |
| **P1** | `/checkin/[slug]` 404 (force-dynamic + logged catch) | ✅ Closed `79afaab` | This session |
| **P1** | Resend webhook handler 503 in prod | ⚠️ Open until secrets set | PRODUCTION_QA_AUDIT.md |
| **P1** | Cron 503 — `CRON_SECRET` unset | ⚠️ Open | This session |
| **P1** | Claude AI cron throws | ⚠️ Open until `ANTHROPIC_API_KEY` set | PRODUCTION_QA_AUDIT.md |
| **P1** | Drive integration unconfigured | ⚠️ Open until `GOOGLE_CLIENT_ID/SECRET` set | PRODUCTION_QA_AUDIT.md |
| **P2** | CSP `unsafe-eval` | Open | next.config.ts |
| **P2** | Optimistic concurrency missing on PATCH | Open | docs/AUDIT-2026-04-27.md WP-E |
| **P2** | Sidebar `plan?` dead prop | Open | This doc |
| **P2** | Member self-billing flag deferred | Open | project memory |
| **P3** | Mobile / a11y polish (E.164, DOB bounds, OTP inputmode, aria-labels) | Open | docs/AUDIT-2026-04-27.md WP-G |

---

## Owner-only operational notes

- **Reset owner onboarding** — `POST /api/owner/reset-onboarding` (no body). Flips `Tenant.onboardingCompleted = false` and clears `onboardingAnswers`. Owner sees the wizard again on next dashboard visit. **Does NOT** delete members, classes, ranks, branding, attendances, payments, or waivers.
- **TOTP enrollment** — Owner-only via `Settings` page. Once enrolled, every login requires the TOTP code (the proxy sets `totpPending = true` until verified at `/login/totp`).
- **Stripe Connect** — Settings → Revenue tab. Includes ToS gate (links to `/legal/terms` which is now public). The owner is the merchant of record; MatFlow is the platform. Every customer-facing Stripe call passes `stripeAccount: tenant.stripeAccountId`.
- **BACS Direct Debit** — owner-controlled toggle (`Tenant.acceptsBacs`). Required to allow `bacs_debit` in `/api/stripe/create-subscription`.
- **Member self-billing default = OFF** — per saved memory: `Tenant.memberSelfBilling` flag is deferred but is the right default. Until the flag exists, the member-side Stripe Customer Portal link is technically reachable; gate before launch.
- **Audit log** — every sensitive action (waiver sign, manual payment, role change, refund, tenant create) writes to `AuditLog` with `tenantId`, `userId`, `action`, `entityType`, `entityId`, `metadata`, `ipAddress`, `userAgent`.

---

## Summary

**Pages inventoried:** 13 owner-side routes + 4 shared layout components.

**Role distribution:**
- Owner-only: 3 (`/dashboard/analysis`, `/dashboard/settings`, `/onboarding`)
- Owner + manager: 2 (`/dashboard/notifications`, `/dashboard/reports`)
- Owner / manager / admin (no coaches): 1 (`/dashboard/checkin`)
- Owner / manager / coach (no admin): 1 (`/dashboard/ranks`)
- All staff (`requireStaff`): 6 (`/dashboard`, `/dashboard/members`, `/dashboard/members/[id]`, `/dashboard/timetable`, `/dashboard/coach`, `/dashboard/attendance`)

**Mobile coverage:** ✅ Full — every page has `md:` breakpoints. Bottom-tab nav + sheet drawer for mobile primary navigation.

**Working at production today:** Auth, member CRUD, payments (manual + Stripe via webhook), check-in (admin + QR), classes + timetable, attendance, ranks, branding, waivers, reset onboarding.

**Blocked by environment configuration (you set these):**
- `RESEND_API_KEY` + `RESEND_WEBHOOK_SECRET` → outbound email
- `CRON_SECRET` → monthly cron
- `ANTHROPIC_API_KEY` → Claude AI causal report
- `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` → Drive integration

**Pending feature work** (in todo list, not blocking launch):
- Magic-link login (WP1)
- Owner-supervised waiver flow (WP3)
- `Tenant.memberSelfBilling` flag
- /apply spam protection
- Audit P2/P3 polish (56 items, mostly mobile/a11y/schema cleanup)

The product is **ready for closed-beta onboarding** of one real gym pending Resend setup. Email-dependent features (forgot-password, payment-failed notifications) won't reach members until `RESEND_API_KEY` lands; everything else works.
