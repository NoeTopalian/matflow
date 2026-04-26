# MatFlow — App Improvement Backlog

_Last updated: 2026-04-26_

---

## 🔴 P0 — Quick Wins (do now)

### 1. Sidebar nav order: Timetable before Members
**File:** `components/layout/Sidebar.tsx` — swap Timetable and Members in `navItems`.  
Current: Dashboard → Members → Timetable  
Desired: Dashboard → Timetable → Members

### 2. Members: Birthday / Date of Birth field
**Files:** `components/dashboard/MembersList.tsx`, `app/dashboard/members/[id]/page.tsx`, add member modal  
- `dateOfBirth` already exists in Prisma schema but is never exposed in UI  
- Show formatted age + DOB in member detail card (e.g. "26 Apr 1998 · 28 yrs")  
- Show birthday badge / cake icon in the members list row when today is their birthday  
- Dashboard widget: "Upcoming birthdays this week" (members with birthday in next 7 days)

### 3. Members: Account type (Adult / Junior / Kids)
**Files:** `prisma/schema.prisma`, members API, add/edit modal  
- Add `accountType` enum field to `Member` model: `adult | junior | kids`  
- Show coloured badge in member list and detail view  
- Kids accounts visually distinct (e.g. star icon or yellow badge)  
- Filter tab on members page alongside Active / Inactive etc.  
- Controls whether member can self-check-in without parental flag (future)

---

## 🟠 P1 — High Value

### 4. Class stats drawer (timetable click)
**Files:** `components/dashboard/TimetableManager.tsx`, new `ClassStatsDrawer` component, `app/api/classes/[id]/instances/route.ts`  
- Clicking a class pill in the timetable opens a stats drawer (not the edit form — separate button for edit)  
- Stats to show per class:
  - **Attendance trend**: last 8 weeks, bar chart (attendees per session)  
  - **Average attendance** vs max capacity (fill rate %)  
  - **Most popular day/time** for classes that run on multiple days  
  - **Top attenders**: 3–5 members who attend most  
  - **Last session**: date + headcount  
  - **Next session**: date + current bookings  
- For classes with multiple schedule slots (e.g. Fundamentals BJJ on Mon + Wed):  
  - Default: combined stats across all slots  
  - Toggle to split by day/slot (Mon sessions vs Wed sessions)  
- Data source: `GET /api/classes/[id]/instances` already returns last 30 instances with attendance count — extend to return 12 weeks + member breakdown

### 5. Attendance page: per-class breakdown
**File:** `app/dashboard/attendance/page.tsx` / `AttendanceView`  
- Add a "By Class" tab alongside the current records table  
- Shows each class with: total check-ins this month, avg per session, fill rate  
- Clicking a class row opens the same ClassStatsDrawer from improvement #4

### 6. Dashboard: Upcoming birthdays widget
**File:** `components/dashboard/DashboardStats.tsx`, `app/dashboard/page.tsx`  
- New stat card or sidebar panel: "Birthdays this week" with member name + age turning  
- Pull from `Member.dateOfBirth` where month+day falls within next 7 days

### 7. Dashboard: Revenue snapshot
**File:** `components/dashboard/DashboardStats.tsx`  
- When Stripe is connected: show MRR, active subscriptions, failed payments  
- Pulls from existing Stripe webhook data stored in DB (or live Stripe API call)

---

## 🟡 P2 — UX Polish

### 8. Timetable: Class pill shows capacity fill
- On each day column pill, show a thin fill-bar or "12/18" capacity badge  
- Requires fetching today's instance (or nearest upcoming) for that class  
- Could be lazy-loaded so it doesn't slow initial page render

### 9. Members list: Birthday column / upcoming filter
- Sort or filter by upcoming birthday  
- Show 🎂 emoji or cake icon next to name when birthday is within 7 days  
- Export CSV that includes DOB and account type

### 10. Check-In: Kids safeguarding flag
- When a member with `accountType: "kids"` checks in, show a distinct banner  
- Optionally require a coach to confirm (toggle in settings)

### 11. Notifications: Birthday auto-message
- Auto-generate a notification or email to members on their birthday  
- Simple toggle in Settings → Notifications

### 12. Member profile: Emergency contact visible in check-in
- When coach opens a member's card during check-in, surface emergency contact + medical notes  
- Already stored in DB (`emergencyContactName`, `emergencyContactPhone`, `medicalConditions`)

### 13. Timetable: Colour-coded capacity state on day column
- Day column header shows a subtle dot if any class that day is near-full (>80%)  
- Helps owner spot bottlenecks at a glance

---

## 🔵 P3 — Future / Bigger Builds

### 14. Booking system
- Members book into specific class instances from the member portal  
- Waiting list when at capacity  
- Email/push confirmation

### 15. Automated rank progression suggestions
- After N sessions + time-in-grade, surface a "ready to grade?" flag on member profile  
- Coach can approve and log promotion directly

### 16. Parent portal (for kids accounts)
- Separate login flow for parents  
- View child's attendance, rank progress, upcoming classes  
- Sign digital waiver on behalf of child

### 17. Coach app / view
- Simplified interface for coaches: just their classes for the day, attendance list, check-in button  
- No access to financial or admin data

---

## Implementation Order (recommended)

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 1 | Nav reorder | 2 min | Low |
| 2 | Birthday DOB field | 1 hr | High |
| 3 | Account type (Adult/Kids) | 2 hr | High |
| 4 | Class stats drawer | 4 hr | Very High |
| 5 | Attendance per-class tab | 2 hr | Medium |
| 6 | Birthday dashboard widget | 1 hr | Medium |
| 7 | Revenue snapshot | 2 hr | High (if Stripe connected) |
