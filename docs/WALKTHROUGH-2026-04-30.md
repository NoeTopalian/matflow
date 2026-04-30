# MatFlow Live Walkthrough — 2026-04-30

Live Playwright browser tour of the running dev server (`http://localhost:3847`) against the seeded `totalbjj` tenant. The local working tree is even with `origin/main` (0 ahead, 0 behind) so this report reflects what is currently pushed.

**Test credentials (from `prisma/seed.ts`):**
- Tenant slug: `totalbjj`
- Owner: `owner@totalbjj.com` / `password123`
- Coach: `coach@totalbjj.com` / `password123`
- Admin: `admin@totalbjj.com` / `password123`
- Member (Blue Belt, monthly unlimited): `alex@example.com` / `password123`

Legend: ✅ working · ⚠️ partial / minor issue · ❌ broken / missing · 🔍 not yet tested

---

## TL;DR

The **owner / staff dashboard is largely solid** — every sidebar destination loads, KPIs are real, member CRUD reads work, settings tabs render, branding is wired. The **member portal is the weak side**: schedule grid is empty, profile fields don't bind, shop renders nothing, several "Loading…" states never resolve. There are also **two cross-cutting backend bugs** (`/api/coach/today` returns wrong slice; `engagement %` over-100 on Analysis) and **one frontend bug on the auth flow** (Forgot Password page hangs forever even though API succeeds).

Confirmed status of the audit items in `memory/project_opus_audit.md`:
- ✅ Fixed: C4 (sign-out), C6 (walk-in button), C11 (demo fallbacks)
- ❌ Still broken: C1 (member schedule), C2/C3 (member profile inputs/notification toggles persistence), C5 (member "Your Classes"), C8 (apply route), M3 (settings store doesn't persist), M4 (revenue widget)
- 🔍 Not retested this pass: C9 (pay_at_desk), C10 (uploads), H4/H5/H8/H9/H10

---

## Cross-cutting issues seen on every page

| # | Severity | Issue |
|---|----------|-------|
| X1 | low | Browser console: `manifest.webmanifest` syntax error on every page load (`app/manifest.ts` is misconfigured for Next 16). |
| X2 | low | Browser console: deprecated viewport metadata warning — `viewport` should move from the `metadata` export to a separate `viewport` export per Next 16. |
| X3 | low | URL-driven tab state is missing on `/dashboard/settings` — `?tab=integrations` doesn't switch tabs; tabs are pure client state. Means deep-links and refresh lose the tab. |

---

## Auth

### `/login` — tenant slug step ✅
- Two-step flow: tenant slug → email/password.
- `totalbjj` resolves to "Total BJJ" branding.
- "Apply for Account Creation" link goes to `/apply`. "Contact us" `mailto:`.

### `/login` — credentials step ✅
- Email + password fields, show/hide password toggle.
- "Sign in", "Email me a sign-in link", "Forgot password?" buttons all present.
- Owner login → `/dashboard`. Member login → `/member/home`.

### Magic link ✅
- Click "Email me a sign-in link" → dedicated screen with email input + "Send sign-in link".
- Submitting shows "Check your inbox — link expires in 30 minutes" success state.
- Note: email pre-fill from previous step does **not** carry across — user has to retype email on the magic-link screen.

### Forgot password ❌
- Click "Forgot password?" with email pre-filled → page shows **"Sending reset code…" indefinitely (never resolves)**.
- Direct call to `POST /api/auth/forgot-password` returns `200 {"ok":true}` in 170ms.
- **Diagnosis: frontend bug — the loading state isn't cleared after the fetch resolves.** Users will think the reset is broken even though the email was queued.

### Sign-out (audit C4) ✅
- Profile → "Sign Out" cleanly redirects to `/login`. No console errors.

### TOTP setup 🔍
- Visible in Settings → Account ("Two-Factor Authentication" with "Set up" button). Not exercised end-to-end this pass.

---

## Owner / Staff dashboard

### `/dashboard` ✅ (with one wrong "today" count — see X4)
Sidebar groups: **Main** (Dashboard, Today's Register, Timetable, Members, Attendance, Check-In) · **Admin** (Ranks, Notifications, Reports, Memberships, Analysis, Settings).

KPIs: **Owner To-Do (24)**, **Payments Due (0)**, **Today's Classes (3 — 0 booked / 36 spaces)**, **At-Risk Members (1)** all populate from real DB.

Owner To-Do list shows real counts: 12 missing waivers, 11 missing phones, 1 quiet member. Each row deep-links to `/dashboard/members?filter=…`.

Today's Classes block + Weekly Calendar both populate seeded ClassInstances correctly.

| X4 | medium | The dashboard "Today's Classes" block lists 3 classes for Thu 30 Apr (No-Gi 18:00, Beginner BJJ 10:00, Open Mat 18:00), but the seed only schedules No-Gi for Thursday — so somewhere extra ClassInstances exist for Beginner BJJ and Open Mat that don't correspond to a `ClassSchedule`. The Timetable page (which renders schedules) correctly shows only No-Gi for Thursday. → Either a seed/generate bug, or the dashboard uses a different filter than Timetable. |

### `/dashboard/coach` (Today's Register) ❌
- Page renders shell, but the list is **wrong**.
- `GET /api/coach/today` returns **No-Gi 2026-04-30 plus No-Gi 2026-04-29** — i.e. yesterday's instance is included, and today's other classes (Beginner BJJ, Open Mat) are missing.
- Same bug surfaces on the public `/checkin/totalbjj` page (which uses the same endpoint).

### `/dashboard/timetable` ✅
- 6 classes managed.
- Weekly grid renders all schedules correctly.
- "Generate 4 Weeks", "Add Class", per-class "Generate schedule instances" / edit / delete buttons all visible.

### `/dashboard/members` ✅
- 13 members listed. KPIs: 13 total · 13 Paid · 0 Overdue · 12 Waivers Missing · 0 Tasters.
- 5 filter tabs (All / Needs Attention / Waiver Missing / Missing Phone / Quiet 14d+) plus searchbox + Filters button.
- Table columns: Member · Membership · Payment · Waiver · Rank · Last Visit · Joined.

### `/dashboard/members/[id]` ✅
- Comprehensive member profile: 5 KPI tiles (Waiver / Payment / Last Visit / Joined / Membership), 5 stats tiles (50 visits all-time / 34 month / 1 week / 1 streak / 0 subs), 6 tabs (Overview / Attendance / Payments / Ranks / Classes / Notes).
- Mark paid manually, Edit, More-actions buttons; Family panel with Link existing / Add child.

### `/dashboard/attendance` ✅
- KPIs: 354 month / 1 week / 12 active / "Top class: Kids BJJ".
- Search + 4 method filters (All / QR Scan / Admin / Self) + table.

### `/dashboard/checkin` ✅
- Class loads (No-Gi 6PM Mat 1), shows roster with rank + membership chips, search.
- "Find Walk-In Member" toggles to "Walk-In Search Active" — **audit C6 fixed**.
- Has link to public `/checkin/totalbjj` QR page.

### `/dashboard/ranks` ✅
- BJJ discipline tab. 5 belts (White → Black) ordered correctly. Reorder, edit, delete buttons. "Use Preset" + "Add Rank".

### `/dashboard/notifications` ✅
- Effectively the announcements board. 6 seeded items, pinned highlighted, image preview, "Delete announcement" + "New Post".

### `/dashboard/reports` ✅
- Class-composition donut (No-Gi 22% · Kids BJJ 21% · Beginner BJJ 19% · Fundamentals 19% · Open Mat 18%).
- 12-week check-in sparkline.
- "AI Monthly Report" panel with "Generate now" button (loading state visible).
- "Initiatives" panel with Add (loading state).
- KPIs: 13 active members · 1 attendance this week (-98% vs last) · 4 new this month.
- "Export CSV" button up top.

### `/dashboard/memberships` ✅
- Loads, renders empty-state ("No membership tiers yet · Add tier"). Schema model exists; no seed data, so this is correct behaviour.

### `/dashboard/analysis` ⚠️
- Member-mix donut (13 active = 100%), 6-month engagement sparkline.
- KPIs: 13 active · 354 check-ins · **2723% Engagement** · 6 active classes.
- "Generate Your Monthly Report" CTA.
- **Bug:** Engagement reads `2723%` — formula likely sums daily-actives instead of dividing by total members, blowing past 100%.

### `/dashboard/settings` (8 tabs)
- **Overview ✅** — KPIs (13 members · 4 staff · 6 classes), gym info card, quick links.
- **Branding 🔍** — not opened this pass.
- **Revenue 🔍** — couldn't open without dismissing the Add Product drawer first; per audit M4 it's hardcoded fake numbers.
- **Store ⚠️** — Add Product side-drawer opens with Name / Price / Symbol / Category / In-Stock fields, but **there is no `POST /api/products` route** (only read-only `/api/member/products`) — confirms audit M3: the form opens but cannot persist. Also, `lib/products.ts` exports 8 items but the Settings → Store list shows only 5 (Hoodie, Sports Tape, Water Bottle missing) — there's a separate hardcoded list in the component.
- **Staff 🔍** — not opened.
- **Account ✅** — 2FA "Set up" button, check-in QR URL with copy/open, subscription tier chip, danger-zone "contact support" link.
- **Waiver 🔍** — not opened.
- **Integrations ✅** — Google Drive Connect button, Member CSV import (Generic / MindBody / Glofox / Wodify, file picker, Upload+preview disabled until file). **No Stripe Connect tile here** even though the schema has `stripeConnected`/`stripeAccountId` — Stripe wiring lives elsewhere or not surfaced.

---

## Member portal

### `/member/home` ✅ (with one missing class — see X4)
- Greeting, "Next class" card (Beginner BJJ tomorrow Fri 10:00).
- "Sign In to Class" button.
- "Today's Classes" widget shows 1 class (No-Gi 18:00) — consistent with the Timetable, which means the dashboard's "3 today" claim is the outlier.
- Announcements list (6, pinned, with images).
- Member onboarding CTA ("Welcome to the gym! Let's Go / Skip for now").
- Bottom nav: Home / Schedule / Progress / Profile.

### `/member/schedule` ❌ (audit C1)
- Renders a Mon-Sun day picker + hourly grid 7am–10pm.
- **No classes are rendered into the grid** even though `GET /api/member/classes` returns 6 classes.
- Subscribe / unsubscribe is not exercised because the grid is empty.

### `/member/progress` ⚠️
- Belt chip (Blue Belt 3/4 stripes, "Promoted by Coach Mike"), yearly progress bar (47 classes = 31%).
- KPIs: 3 this week · 9 this month · 47 this year · 8w current streak.
- "Most attended (90 days)": Beginner BJJ 18 / No-Gi 12 / Open Mat 9.
- **"Your Classes" heading renders with no body** — audit C5 still open. Should list the member's `ClassSubscription`s.

### `/member/profile` ⚠️ (multiple sub-issues)
- Renders gym header with link to `totalbjj.co.uk`.
- "My Journey" milestones (white belt / 2× stripes / first comp / blue belt / blue stripe / Add milestone) — looks great.
- Curriculum tile: "Beginner Foundations 13 of 19 techniques covered".
- Personal Details: Name (editable), Email (disabled, correct), **Phone (textbox empty)** — `GET /api/member/me` returns `phone: "07786809936"` but the input doesn't bind it. If the user clicks Save with the empty input, they'll wipe the stored phone. Audit C2 still open at the UI layer.
- Notifications toggles (Class reminders ON, Belt promotions ON, Gym announcements OFF) — switches render but persistence not verified this pass; audit C3 likely still open.
- Membership card with link "Manage subscription" → `https://totalbjj.co.uk` (external link only, consistent with owner-managed-billing default policy).
- **Three "Loading…" states never resolve to empty:**
  - Family ("My Family") — `GET /api/member/me/children` returns `[]` instantly, but UI keeps spinning.
  - Class packs ("Loading class packs…") — `GET /api/member/class-packs` returns `{owned:[], available:[]}` instantly, UI spins.
  - Payment history ("Loading…") — `GET /api/member/me/payments` returns `[]` instantly, UI spins.
- Sign Out works ✅.

### `/member/shop` ❌
- Renders header, cart icon, "All" filter chip, then **"No items in this category"** despite `GET /api/member/products` returning 8 products. UI does not render the API result.

### `/member/family/[childId]` 🔍
- Not exercised — Alex has no linked children.

### `/member/purchase/pack/[id]` 🔍
- Not exercised — no class packs seeded.

---

## Public / edge

### `/apply` ⚠️ (audit C8)
- Form renders correctly: Gym name / Your name / Email / Phone / Discipline (9 options) / Member count (5 ranges) / "Anything else?" / Submit + "Terms / Privacy" footer.
- Submit shows the **"Application received"** success page.
- Per audit C8 the route only `console.log`s — no DB write, no email. UI lies to the applicant.

### `/checkin/[slug]` (`/checkin/totalbjj`) ⚠️
- Loads tenant branding and "Today's Classes" list.
- Same bug as `/dashboard/coach`: lists No-Gi twice (today + yesterday) and is missing today's other classes — `/api/coach/today` is the broken upstream.
- "Ended" badge correctly applied to past classes.

### `/legal/terms`, `/legal/privacy`, `/legal/aup`, `/legal/subprocessors` ✅
- All four return HTTP 200 with substantive content (25–32 KB each).

### `/onboarding` 🔍
- Owner gets redirected to `/dashboard` (tenant `subscriptionStatus: active`). Member-side wizard is on `/member/home` and was not walked through this pass.

### `/preview` 🔍
- Not opened.

---

## Backend smoke checks (called via fetch from the page, results inline)

| Endpoint | Result |
|---|---|
| `GET /api/coach/today` (auth: owner) | ❌ Returns 2 entries, both No-Gi, dated 2026-04-30 and 2026-04-29. Should be just today's classes. |
| `GET /api/member/me` (auth: alex) | ✅ 200, full profile incl. phone. |
| `GET /api/member/me/payments` | ✅ 200, `[]`. |
| `GET /api/member/me/children` | ✅ 200, `[]`. |
| `GET /api/member/class-packs` | ✅ 200, `{owned:[],available:[]}`. |
| `GET /api/member/classes` | ✅ 200, 6 classes. |
| `GET /api/member/products` | ✅ 200, 8 products. |
| `GET /api/announcements` | ✅ 200, 6 announcements. |
| `POST /api/member/checkout` (empty cart) | ✅ 400 `{"error":"No items in cart"}` — input validation present. |
| `GET /api/checkin/members?slug=totalbjj` (no instanceId) | ✅ 400 `{"error":"instanceId required"}`. |
| `POST /api/auth/forgot-password` (alex@example.com) | ✅ 200 in 170ms `{"ok":true}` (UI doesn't act on it though). |
| `POST /api/apply` (via UI submit) | ⚠️ 2xx and shows success — but per audit C8 no DB write or email actually happens. |

---

## Priority bug list (only what was observed live this pass)

### P0 — user-visible breakage
- **B1.** Forgot Password screen hangs on "Sending reset code…" forever. API succeeds; UI bug. (`app/login/...` reset-password client component.)
- **B2.** `/api/coach/today` returns wrong slice (today + yesterday for one class, missing today's other classes). Affects both Today's Register dashboard and the public QR check-in page.
- **B3.** `/member/schedule` grid is empty — API returns data, UI doesn't render. (Audit C1.)
- **B4.** `/member/shop` shows empty state — API returns data, UI doesn't render.
- **B5.** `/member/profile` Phone field is empty even though API returns it; pressing Save would wipe the stored value. (Audit C2.)

### P1 — silent data integrity / wrong UI numbers
- **B6.** Three member-profile widgets stay on "Loading…" forever instead of rendering the (legitimately empty) results: Family, Class packs, Payment history.
- **B7.** Analysis page shows `Engagement: 2723%` — formula is wrong.
- **B8.** Dashboard "Today's Classes" lists classes that don't exist on Thursday's `ClassSchedule`. Investigate whether seed/generate creates orphan ClassInstances or whether the dashboard query is wrong.
- **B9.** Settings → Store: lib/products.ts has 8 items, the Settings UI hardcodes only 5, and the Add Product drawer cannot persist (no POST endpoint). Audit M3 stands.
- **B10.** `/apply` says "Application received" but doesn't persist (Audit C8).

### P2 — minor / dev-experience
- **B11.** `manifest.webmanifest` returns invalid JSON — every page logs a console error.
- **B12.** `viewport` metadata still under the `metadata` export — Next 16 deprecation warning every page load.
- **B13.** `?tab=...` query string on Settings doesn't drive the active tab.
- **B14.** Magic-link screen drops the email entered on the previous step — user retypes.

---

## What I did not test this pass

- Owner onboarding wizard end-to-end (tenant already onboarded).
- Member-side onboarding wizard (only the entry CTA seen).
- TOTP enrol / verify.
- Stripe Connect / Stripe Customer portal / subscription create / pay-at-desk order flow.
- File upload (audit C10 — Vercel-incompatible filesystem write).
- Class Packs purchase flow (no packs seeded).
- AI monthly report generation.
- CSV importer end-to-end (Generic/MindBody/Glofox/Wodify upload).
- Google Drive OAuth.
- `/preview` page.
- Per-member waiver page (`/dashboard/members/[id]/waiver`).
- Coach role-restricted views (logged in as owner only).
- Mobile viewport.

---

*Generated by walking the running app on 2026-04-30 19:30–19:45 BST. Cross-reference with `memory/project_opus_audit.md` for items audited 12 days earlier.*
