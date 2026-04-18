# Deep Interview Spec: MatFlow — Fully Working Member Portal

## Metadata
- Interview ID: matflow-fully-working-001
- Rounds: 6
- Final Ambiguity Score: 18%
- Type: brownfield
- Generated: 2026-04-18
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.85 | 0.35 | 0.298 |
| Constraint Clarity | 0.80 | 0.25 | 0.200 |
| Success Criteria | 0.80 | 0.25 | 0.200 |
| Context Clarity | 0.80 | 0.15 | 0.120 |
| **Total Clarity** | | | **0.818** |
| **Ambiguity** | | | **~18%** |

---

## Goal
Get the MatFlow **member portal** fully functional end-to-end, with demo data fallbacks so the UI never breaks on an empty DB. Admin dashboard scope is limited to the **settings/branding page** saving to the DB. All 5 member portal sections must work: Home, Schedule, Profile, Progress, Shop.

---

## Constraints
- **No Stripe integration yet** — shop uses demo products + pay-at-desk confirmation flow
- **No email service** — password reset logs to console (dev only), not a blocker
- **Local SQLite DB** — already configured via Prisma, just needs to be seeded
- **Demo data fallbacks** — every API route must return realistic mock data when DB is empty or a user has no records
- **Admin dashboard** — only Settings page needs to fully work; other admin pages stay as-is
- **No full offline mode** — demo fallbacks are for empty DB, not network-disconnected use
- **POS terminal integration** (Stripe Terminal) noted as future stretch goal — not in scope now

---

## Non-Goals
- Stripe payment processing (future)
- Email delivery (Resend/SendGrid) for password reset or gym applications
- Full admin dashboard (members CRUD, timetable, attendance, ranks, reports, analysis)
- Real analytics/reporting
- Native app / PWA offline mode
- Stripe Terminal / physical POS trigger (captured as future feature)

---

## Acceptance Criteria

### Member Portal — Home
- [ ] Page loads with member's name, belt rank, and attendance stats (this week / month / year / total)
- [ ] Streak weeks shows a calculated value (not hardcoded 0)
- [ ] Today's classes list loads from `/api/member/schedule` (filtered to current day)
- [ ] When DB is empty, demo classes appear (not a blank screen)
- [ ] Announcements load from `/api/announcements` (pinned first)
- [ ] When DB has no announcements, demo announcements appear
- [ ] "Sign In to Class" button opens sheet, shows selectable classes
- [ ] Selecting a class and confirming POSTs to `/api/checkin`, creates AttendanceRecord in DB
- [ ] Success toast confirms sign-in; attendance stats update on next load
- [ ] Onboarding modal appears for new members (localStorage `bjj_onboarded` not set)

### Member Portal — Schedule
- [ ] Weekly view shows Mon–Sun with all classes for the tenant
- [ ] Week prev/next navigation works
- [ ] Clicking a class opens EventSheet with class details
- [ ] Subscribe/unsubscribe toggle works (or shows demo state gracefully)
- [ ] "Almost full" / "Full" capacity badges show correctly
- [ ] Falls back to demo schedule when DB is empty

### Member Portal — Profile & Progress
- [ ] Profile shows real member data: name, email, belt, membership type, joined date
- [ ] Attendance history shows real records (or demo records if empty)
- [ ] Belt journey / rank history visible
- [ ] Progress page: belt journey chart, technique checklist render without errors
- [ ] Demo fallback for all data when member has no records

### Member Portal — Shop
- [ ] Products display from demo data (hardcoded is fine)
- [ ] Category filter buttons work
- [ ] Add to cart works (client-side state)
- [ ] Cart sidebar opens, shows items, quantity adjustable
- [ ] Checkout button POSTs to `/api/member/checkout`
- [ ] With no Stripe key: returns order ref, shows "Pay at desk" confirmation screen
- [ ] No crash or blank screen at any point in the flow

### Admin Settings (minimal)
- [ ] Branding tab: color pickers, logo upload, font selector all functional
- [ ] Save button calls `/api/settings` and persists to DB
- [ ] Member portal reads updated branding from DB on next load (via `/api/me/gym`)
- [ ] localStorage `gym-settings` syncs from API response

### Demo Data / Local Memory
- [ ] SQLite DB seeded with: 1 tenant (totalbjj), demo staff users, 5–10 demo members, 3–5 classes with schedules, 10+ attendance records, 5+ announcements, rank system (BJJ belts)
- [ ] All API routes return demo data when DB query returns empty results
- [ ] No blank screens anywhere in the member portal

---

## Features to Assess / Potentially Cut

Based on codebase analysis, these features are candidates for hiding/simplification:

| Feature | Recommendation | Reason |
|---------|---------------|--------|
| `/dashboard/analysis` | Hide (owner-only gate it) | Pure demo data, no real logic — misleads users |
| `/dashboard/reports` | Keep but mark as "coming soon" | Complex CSV/PDF export not implemented |
| Children tracking (profile) | Keep as demo-only display | Low effort, adds perceived value |
| Notifications page | Keep as demo-only | The model exists, just no delivery |
| Password reset email | Keep UI, log to console | Expected to work when email added |
| Streak calculation | **Must fix** | Currently hardcoded to 0 — embarrassing |
| `bjj_onboarded` questionnaire | Simplify to 2–3 steps | 6 steps is too many for a gym app |

---

## Assumptions Exposed & Resolved

| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| "Local memory" meant offline mode | Asked directly | Means demo data fallbacks — SQLite already runs locally |
| Shop needs Stripe | Asked directly | Demo products + pay-at-desk is the target; Stripe is future |
| Only member portal mattered | Asked directly | Admin settings also needed so branding persists |
| Sign-in was UI-only | Asked directly | Must write AttendanceRecord to DB |
| POS trigger idea (user raised) | Researched | Valid: Stripe Terminal integration — spec as future stretch |

---

## Technical Context (Brownfield)

- **Auth:** `auth.ts` — NextAuth Credentials, checks User then Member table, JWT 1yr TTL
- **Database:** `prisma/schema.prisma` — SQLite local (`better-sqlite3`), PostgreSQL production (`pg`)
- **Broken:** `streakWeeks: 0` hardcoded in `app/api/member/me/route.ts:109`
- **Broken:** Class sign-in sheet in `app/member/home/page.tsx` — modal opens but API call unclear/missing
- **Broken:** Products hardcoded in `app/api/member/products/route.ts` — no DB connection
- **Broken:** Settings save in `components/dashboard/SettingsPage.tsx` — save handler needs verification
- **Demo data:** 28+ instances of demo fallbacks throughout codebase — extend, don't remove
- **Local memory keys:** `gym-settings` (branding), `bjj_onboarded` (onboarding flag)
- **Theme sync:** `app/member/layout.tsx` reads localStorage first, then syncs from `/api/me/gym`

---

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| Member | core domain | id, name, email, belt, status, tenantId | has many AttendanceRecords, has MemberRank |
| Class | core domain | name, coach, location, capacity, tenantId | has ClassSchedules, ClassInstances |
| AttendanceRecord | core domain | memberId, instanceId, method, createdAt | belongs to Member + ClassInstance |
| Announcement | supporting | title, body, pinned, imageUrl, tenantId | belongs to Tenant |
| Product | supporting | name, price, category, imageUrl | (demo data, no DB model yet) |
| Cart | supporting | items[], total | client-side only (useState) |
| Tenant | external system | slug, name, colors, fonts, logoUrl | has Members, Classes, Announcements |
| RankSystem | supporting | discipline, belts[], stripes | MemberRank links Member to RankSystem |

---

## Implementation Priority Order

1. **DB Seed** — Create `prisma/seed.ts` with realistic demo data (tenant, members, classes, attendance, announcements, ranks)
2. **Fix streak calculation** — `app/api/member/me/route.ts:109` — calculate from AttendanceRecord dates
3. **Wire class sign-in** — `app/member/home/page.tsx` sign-in sheet → POST `/api/checkin`
4. **Demo fallbacks audit** — Ensure every API route returns demo data when DB empty
5. **Admin settings save** — Verify `SettingsPage.tsx` save button calls `/api/settings` correctly
6. **Shop flow** — Demo products display + cart state + pay-at-desk checkout confirmation
7. **Profile/Progress real data** — Connect to real member data with demo fallback

---

## Future: POS Terminal Integration (Stretch Goal)
The user suggested: "automatically trigger a pay machine to open so the customer can pay."
- **Option A:** Stripe Terminal — physical card reader SDK, connects to Stripe account
- **Option B:** Square POS integration — Square SDK triggers the Square app/terminal
- **Option C:** SMS payment link — send member a Stripe payment link via SMS at checkout
- Recommended path: **Stripe Terminal** (already using Stripe SDK), implement post-deployment

---

## Interview Transcript

<details>
<summary>Full Q&A (6 rounds)</summary>

### Round 1
**Q:** When you say 'fully working', what's the primary experience that must work end-to-end first?
**A:** Member portal (Recommended)
**Ambiguity:** ~55%

### Round 2
**Q:** When you said 'local memory until we have it on the server' — what exactly needs to be stored locally?
**A:** Demo data as fallback (show realistic demo data when DB is empty, so UI never breaks)
**Ambiguity:** ~43%

### Round 3
**Q:** Which member portal sections are essential vs which could be cut or hidden?
**A:** All four: Home, Schedule, Profile+Progress, Shop
**Ambiguity:** ~34%

### Round 4
**Q:** For the shop, what's the target working state?
**A:** Recommended — demo products + pay-at-desk (user also raised POS trigger idea for future)
**Ambiguity:** ~28%

### Round 5
**Q:** Does the admin dashboard need to be functional, or just the member-facing side?
**A:** Settings + branding only
**Ambiguity:** ~25%

### Round 6
**Q:** For class sign-in: when a member taps 'Sign In to Class' and selects a class — what should actually happen?
**A:** Record attendance in DB (POST to /api/checkin, real AttendanceRecord)
**Ambiguity:** ~18% ✅

</details>
