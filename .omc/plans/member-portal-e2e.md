# MatFlow Member Portal -- End-to-End Implementation Plan

**Created:** 2026-04-18
**Status:** APPROVED -- consensus reached after 5 iterations
**Estimated complexity:** MEDIUM-HIGH

---

## RALPLAN-DR Summary

### Principles (5)

1. **Demo-first resilience** -- Every API route must return realistic fallback data when the DB is empty or unreachable. The UI must never break on a fresh install.
2. **Minimal surface area** -- Change only the files needed. Do not refactor working patterns or introduce new abstractions.
3. **Seed as source of truth** -- The seed script is the canonical dataset for development. All demo fallbacks should be consistent with seeded data.
4. **Real data when available** -- When a seeded DB exists and a member is logged in with a real `memberId`, prefer computed real data over demo constants.
5. **Existing pattern compliance** -- Follow the codebase's established patterns: demo-tenant check for demo mode, try/catch fallback to demo data, `localStorage` for branding, `useState` + `useEffect` + `fetch` for client data loading.

### Decision Drivers (Top 3)

1. **Sign-in flow requires classInstanceId** -- The `/api/checkin` endpoint expects a `classInstanceId`, but the home page's class list from `/api/member/schedule` returns `classId-scheduleId` composite IDs. The sign-in sheet must resolve a real `classInstanceId` for today's date.
2. **Streak calculation is the only hardcoded-zero stat** -- All other stats (thisWeek, thisMonth, thisYear, totalClasses) are already computed from real DB data. Only `streakWeeks: 0` on line 109 of `/api/member/me/route.ts` is hardcoded.
3. **Seed already exists but needs more announcements** -- The seed creates only 1 announcement. The spec requires 5+ for a realistic feel.

### Viable Options

**Option A: Incremental file-by-file fixes (RECOMMENDED)**
- Fix each work item in its specific file(s)
- Pros: Minimal risk, each change is independently testable, no architectural changes
- Cons: Slightly more files touched than a refactor approach

**Option B: Extract shared demo-data module**
- Create a `lib/demo-data.ts` shared module, refactor all fallbacks to import from it
- Pros: Single source of truth for demo data
- Cons: Touches 10+ files unnecessarily, risks breaking existing 28+ fallbacks, over-engineering for current needs
- **Invalidated:** Violates Principle 2 (minimal surface area) and the constraint "don't break existing demo fallbacks"

**Selected: Option A** -- Incremental fixes are lower risk and directly address each work item without unnecessary refactoring.

---

## ADR

- **Decision:** Incremental file-level fixes across 9 work items
- **Drivers:** Risk minimization, spec compliance, existing pattern compliance
- **Alternatives considered:** Shared demo-data module (invalidated due to unnecessary scope)
- **Why chosen:** Each fix is independently verifiable, follows existing codebase patterns, and does not risk breaking the 28+ existing demo fallbacks
- **Consequences:** Some demo data duplication remains across files (acceptable trade-off); schedule page retains internal 1-7 convention until API wiring phase
- **Follow-ups:** Schedule page convention migration (0-6 throughout) when it gets API wiring; shared demo-data module if codebase grows significantly

---

## Context

MatFlow is a BJJ gym management SaaS with a Next.js 16 app router frontend, Prisma + SQLite backend, and NextAuth v5 JWT auth. The member portal has 5 sections (Home, Schedule, Profile, Progress, Shop) plus an admin Settings page. The codebase already has extensive demo fallback patterns. A seed script exists at `prisma/seed.ts` but needs enrichment. Several features are partially wired but not fully functional.

## Work Objectives

Get all 5 member portal sections + admin Settings working end-to-end with seeded data, demo fallbacks, and real data paths all functional.

## Guardrails

### Must Have
- All 5 member sections render without errors on both seeded DB and empty DB
- Sign-in to class creates a real AttendanceRecord
- Streak calculation returns a real number (not hardcoded 0)
- Demo fallbacks return realistic data (not empty arrays)
- Admin settings save persists to DB

### Must NOT Have
- Stripe integration (pay-at-desk only)
- Email service integration
- Breaking changes to existing demo fallbacks
- New npm dependencies
- Architecture redesign or file reorganization

---

## Task Flow

### Phase 1: Data Foundation (Seed Enrichment)

#### Task 1.1: Enrich seed script
**File:** `prisma/seed.ts`

**Changes:**
- Add 4 more announcements (currently 1, need 5+). Specific titles:
  1. (keep existing) "Welcome to MatFlow"
  2. (pinned, imageUrl) "Regional Championship — Register Now"
  3. "New No-Gi Class Starting Monday"
  4. "Holiday Closure — Dec 25-26"
  5. "Seminar: Bernardo Faria — Saturday 10am"
  6. "Founding Member Deal — 20% Off Annual Membership"
- **Do NOT change existing `dayOfWeek` values** — seed uses 1=Mon...6=Sat consistent with JS `getDay()` 1-6 convention. No Sunday classes are seeded.
- **Add backward ClassInstance generation** (currently the seed only generates instances forward from today). Add a loop that generates instances going 60 days backward using the same pattern as forward generation (`startDate = today - 60 days`, `endDate = today`). Without past instances, the attendance query at `seed.ts:274-278` produces zero records regardless of lookback window — streak always returns 0.
- Extend attendance query lookback from 30 to 60 days back (after backward instances exist)
- Add member login credentials to console output: `alex@example.com / password123 (club: totalbjj)`
- **Rollback:** `npx prisma db push --force-reset && npx prisma db seed`

**Acceptance criteria:**
- [ ] `npx prisma db seed` runs without errors
- [ ] DB contains exactly 6 announcements (1 pinned with imageUrl)
- [ ] DB contains 60+ days of attendance records for seeded members
- [ ] Console output includes member login credentials

**Estimated lines changed:** ~50

---

### Phase 2: API Fixes

#### Task 2.1: Fix streak calculation
**File:** `app/api/member/me/route.ts`

**Algorithm (Monday-start weeks):**
```ts
// After the existing Promise.all at ~line 80, add:
const sixtyDaysAgo = new Date(); sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 364);
const attendanceDates = await prisma.attendanceRecord.findMany({
  where: { memberId, checkInTime: { gte: sixtyDaysAgo } },
  select: { checkInTime: true },
  orderBy: { checkInTime: 'desc' }
});

// Group into Monday-start week buckets (ISO week key: "YYYY-Www")
// Use the same Monday-start formula already used in 5+ places in this codebase
// (app/api/member/me/route.ts:75, dashboard/stats, reports, etc.)
const getWeekKey = (d: Date) => {
  const date = new Date(d);
  date.setHours(0,0,0,0);
  const offset = (date.getDay() + 6) % 7; // (getDay()+6)%7 maps Sun→6, Mon→0, ..., Sat→5
  date.setDate(date.getDate() - offset);   // rewind to Monday
  return date.toISOString().split('T')[0]; // "YYYY-MM-DD" of that Monday = unique week key
};

const weekSet = new Set(attendanceDates.map(r => getWeekKey(r.checkInTime)));

// Walk back from current week, count consecutive weeks with ≥1 attendance
let streak = 0;
const today = new Date();
for (let w = 0; w <= 52; w++) {
  const check = new Date(today);
  check.setDate(today.getDate() - w * 7);
  if (weekSet.has(getWeekKey(check))) { streak++; } else if (w > 0) { break; }
}
// Replace: streakWeeks: 0  with: streakWeeks: streak
```

**Edge cases:**
- Zero attendance → `streakWeeks: 0` (loop finds no weeks)
- Current partial week with attendance counts as 1 streak week (w=0 check)
- Capped at 52 weeks (1 year lookback, bounded query)
- Demo fallback still returns `streakWeeks: 8`

**Acceptance criteria:**
- [ ] Member with attendance in current week + 3 prior consecutive weeks → `streakWeeks: 4`
- [ ] Member with no attendance → `streakWeeks: 0`
- [ ] Demo user (no memberId) → `streakWeeks: 8` (unchanged demo response)

**Estimated lines changed:** ~30

---

#### Task 2.2a: Fix dayOfWeek in home page consumer
**File:** `app/member/home/page.tsx:600-603`

**Why this fix is needed (evidence):**
- Admin `TimetableManager.tsx:228` renders `<option key={i} value={i}>` iterating `DAYS_FULL = ["Sunday","Monday",...]` indexed 0-6 → Sunday class stored as `dayOfWeek=0`
- Admin API `app/api/classes/route.ts:18` validates `z.number().int().min(0).max(6)` → confirms DB stores 0-6
- `todayDow()` at line 600-603 converts Sunday `getDay()=0` to 7 → filter `c.dayOfWeek === dow` compares 0 !== 7 → Sunday classes never appear

**Change:** In `todayDow()`, return raw `new Date().getDay()` (0-6). Remove the `d === 0 ? 7 : d` conversion.

**Do NOT change:**
- `app/member/schedule/page.tsx` — uses self-consistent 1-7 internal convention across `currDow`/`prevDow`/`nextDow`/`DayGrid`/demo data. Only add a TODO comment at line ~286: `// Internal 1=Mon...7=Sun convention — migrate to 0-6 when API wiring is added`
- `app/api/classes/route.ts` (stays 0-6)
- `app/api/instances/generate/route.ts` (stays using `getDay()`)
- Seed dayOfWeek values

**Also:** Fix misleading comment at `app/api/member/schedule/route.ts:64` from `// 1=Mon ... 7=Sun` to `// 0=Sun, 1=Mon ... 6=Sat`

**Acceptance criteria:**
- [ ] A Sunday class (dayOfWeek=0) appears on the home page when viewed on a Sunday
- [ ] Mon-Sat class filtering is unaffected
- [ ] Schedule page now-indicator still functions correctly (unchanged)

**Estimated lines changed:** ~5

---

#### Task 2.2b: Wire class sign-in to create real AttendanceRecord
**Files:** `app/api/member/schedule/route.ts`, `app/member/home/page.tsx`
**Must be implemented in this order: schedule route first, then home page.**

**Sub-task 1 — Add `?date` parameter and `classInstanceId` to schedule route:**

Add an optional `date` query parameter (`YYYY-MM-DD` format). When provided:
```ts
const dateParam = searchParams.get('date'); // e.g. "2026-04-18"
if (dateParam) {
  const startOfDay = new Date(dateParam); startOfDay.setHours(0,0,0,0);
  const endOfDay   = new Date(dateParam); endOfDay.setHours(23,59,59,999);
  const todayInstances = await prisma.classInstance.findMany({
    where: { tenantId, date: { gte: startOfDay, lt: endOfDay }, cancelled: false },
    select: { id: true, classId: true, startTime: true }
  });
  // For each schedule entry, find matching instance by classId + startTime
  // Attach classInstanceId: string | null
}
```
When `date` is absent, do not attach `classInstanceId` (backward-compatible — schedule page uses route without date param).

**Sub-task 2 — Wire `signIn()` in home page:**

Home page fetches today's classes using the date parameter: `fetch('/api/member/schedule?date=' + today.toISOString().split('T')[0])`.

`signIn()` at line ~508:
```ts
async function signIn(cls: TodayClass) {
  if (!cls.classInstanceId) {
    // null classInstanceId = demo mode OR real tenant with no instance generated yet
    // In both cases: disable button and show "Class not available for sign-in" message
    // rather than silently skipping. Only show success animation if classInstanceId exists.
    setError('Class not available for sign-in'); return;
  }
  setIsLoading(true);
  try {
    const res = await fetch('/api/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ classInstanceId: cls.classInstanceId, checkInMethod: 'self' })
    });
    if (res.status === 409) { setError('Already checked in to this class'); return; }
    if (!res.ok) { setError('Sign-in failed, please try again'); return; }
    setDone(true);
  } finally { setIsLoading(false); }
}
```

Add `isLoading: boolean` and `error: string | null` to the sign-in sheet state.

**Acceptance criteria:**
- [ ] Tapping "Confirm Sign In" on a seeded class creates an AttendanceRecord in the DB with `checkInMethod = "self"`
- [ ] Tapping again shows inline error "Already checked in to this class"
- [ ] In demo mode (no classInstanceId), success animation plays without any API call
- [ ] Loading spinner visible while POST is in-flight
- [ ] Sign-in sheet class list unaffected by this change

**Estimated lines changed:** ~55 (schedule route: ~20, home page: ~35)

---

#### Task 2.3: Announcements demo fallback
**File:** `app/api/announcements/route.ts`

Change the catch block (and empty-result path) from returning `[]` to returning 5 demo announcements matching the seed data style. Content should match Task 1.1 announcement titles.

**Note:** The home page `app/member/home/page.tsx:644` only replaces demo announcements when `data.length > 0`. Returning demo announcements from the API on empty DB is consistent with this: the API-level fallback ensures both the home page and any other consumer get realistic data.

**Acceptance criteria:**
- [ ] With empty DB, `GET /api/announcements` returns 5 demo announcements
- [ ] First item is pinned (has `pinned: true`)
- [ ] With seeded DB, real announcements are returned

**Estimated lines changed:** ~25

---

### Phase 3: Member Pages

#### Task 3.1: Profile — wire real member data
**File:** `app/member/profile/page.tsx`

The page already fetches `/api/member/me` and sets name/email/phone. Three additional sections use hardcoded values:

**Add state:**
```ts
const [belt, setBelt] = useState({ name: 'Blue Belt', color: '#3b82f6', stripes: 3 });
const [membershipType, setMembershipType] = useState('Monthly Unlimited');
const [memberSince, setMemberSince] = useState('September 2025');
```

**In the existing `/api/member/me` fetch**, after setting name/email/phone:
```ts
if (data.belt) setBelt(data.belt);
if (data.membershipType) setMembershipType(data.membershipType);
if (data.joinedAt) setMemberSince(
  new Date(data.joinedAt).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
);
```

**Replace hardcoded values:**
- Line 371: `background: "#3b82f6"` → `background: belt.color`
- Line 372: `"Blue Belt · 3 stripes"` → `` `${belt.name} · ${belt.stripes} stripe${belt.stripes !== 1 ? 's' : ''}` ``
- Line ~461: `"Monthly Unlimited"` → `{membershipType}`
- Line ~469: `"September 2025"` → `{memberSince}`

**Acceptance criteria:**
- [ ] Seeded member `alex@example.com` sees their actual belt color swatch, belt name, and stripe count
- [ ] Seeded member sees their real membership type and join date formatted as "Month YYYY"
- [ ] Demo user (no session memberId) sees defaults: blue belt, "Monthly Unlimited", "September 2025"

**Estimated lines changed:** ~20

---

#### Task 3.2: Progress — wire "Your Classes" via schedule API
**File:** `app/member/progress/page.tsx`

`DEMO_SUBSCRIBED_CLASSES` is currently used directly at line ~160, not via state. There is no subscription API, so the class list will show all tenant classes from `/api/member/schedule` as a proxy.

**Change:**
```ts
// Replace direct DEMO_SUBSCRIBED_CLASSES usage with state:
const [subscribedClasses, setSubscribedClasses] = useState(DEMO_SUBSCRIBED_CLASSES);

useEffect(() => {
  fetch('/api/member/schedule')
    .then(r => r.json())
    .then(data => {
      if (Array.isArray(data) && data.length > 0) {
        // Map schedule entries to the display shape expected by the section
        // Map to existing DEMO_SUBSCRIBED_CLASSES shape: { id, name, day, time, coach }
      const mapped = data.slice(0, 4).map((c: any) => ({
          id: c.id || c.name,
          name: c.name,
          day: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][c.dayOfWeek],
          time: c.startTime,
          coach: c.coach || 'Coach'
        }));
        setSubscribedClasses(mapped);
      }
    })
    .catch(() => {}); // keep demo data on error
}, []);
```

**Acceptance criteria:**
- [ ] With seeded DB, "Your Classes" shows real class names and times from the schedule API
- [ ] With empty DB (API returns demo classes), demo class names still display
- [ ] Stats grid (thisWeek, streak etc.) still loads correctly from `/api/member/me`

**Estimated lines changed:** ~25

---

#### Task 3.3: Shop — remove Stripe branding in pay-at-desk mode
**File:** `app/member/shop/page.tsx`

Add at component top:
```ts
const payAtDesk = !process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
```

In the checkout button area:
- If `payAtDesk`: render `<span>Place Order</span>` (no Apple icon, no "Powered by Stripe" text)
- If Stripe configured: render existing `<Apple />` icon + "Pay" + "Powered by Stripe"

**Acceptance criteria:**
- [ ] With no `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` env var: button shows "Place Order", no Apple icon, no "Powered by Stripe"
- [ ] Checkout flow proceeds to order confirmation with reference number
- [ ] Cart add/remove/quantity still works

**Estimated lines changed:** ~15

---

### Phase 4: Admin + Feature Visibility

#### Task 4.1: Verify admin settings save flow
**File:** `components/dashboard/SettingsPage.tsx` (verification only)

`saveBranding()` already: uploads logo, saves to localStorage, PATCHes `/api/settings`. The PATCH handler validates and updates Tenant. **No code changes required** — verify end-to-end manually.

**Acceptance criteria:**
- [ ] Changing theme preset + clicking "Save Branding" persists colors to DB
- [ ] Hard refresh loads saved colors (sourced from `/api/me/gym`, not just localStorage)
- [ ] Member portal theme reflects saved branding

**Estimated lines changed:** 0

---

#### Task 4.2: Feature visibility
**Files:**
- `app/dashboard/analysis/page.tsx` — add role check after existing session check:
  ```ts
  if (session.user.role !== 'owner') redirect('/dashboard');
  ```
- `app/dashboard/reports/page.tsx` — add "Coming Soon" banner at top of page content (below existing header, above any stats/tables)

**Acceptance criteria:**
- [ ] Non-owner user navigating to `/dashboard/analysis` is redirected to `/dashboard`
- [ ] Owner user can access `/dashboard/analysis` without redirect
- [ ] `/dashboard/reports` shows a visible "Coming Soon" banner

**Estimated lines changed:** ~15

---

## Detailed File Change Summary

| File | Task | Change Description | Est. Lines |
|------|------|--------------------|------------|
| `prisma/seed.ts` | 1.1 | Add 5 more announcements, extend attendance to 60d | ~50 |
| `app/api/member/me/route.ts` | 2.1 | Implement Monday-start week-walk-back streak, cap 52 | ~30 |
| `app/member/home/page.tsx` | 2.2a | Fix `todayDow()` to raw `getDay()` (0-6) | ~3 |
| `app/member/schedule/page.tsx` | 2.2a | Add TODO comment only | ~1 |
| `app/api/member/schedule/route.ts` | 2.2a/2.2b | Fix comment + add `?date` param + classInstanceId query | ~21 |
| `app/member/home/page.tsx` | 2.2b | Wire `signIn()` to POST `/api/checkin`, loading/error states | ~35 |
| `app/api/announcements/route.ts` | 2.3 | Return 5 demo announcements on empty/error | ~25 |
| `app/member/profile/page.tsx` | 3.1 | Add 3 state vars, wire belt/membership/joinDate | ~20 |
| `app/member/progress/page.tsx` | 3.2 | Add state+useEffect for "Your Classes" via schedule API | ~25 |
| `app/member/shop/page.tsx` | 3.3 | Remove Stripe branding in pay-at-desk mode | ~15 |
| `app/dashboard/analysis/page.tsx` | 4.2 | Add owner-only redirect | ~5 |
| `app/dashboard/reports/page.tsx` | 4.2 | Add "Coming Soon" banner | ~10 |
| **TOTAL** | | | **~240** |

---

## Success Criteria (End-to-End Verification)

1. `npx prisma db seed` populates DB with 6 announcements, 12 members, 60+ days attendance
2. Member logs in as `alex@example.com / password123` (club: `totalbjj`) and:
   - **Home:** today's classes visible, "Sign In to Class" creates AttendanceRecord, announcements show (5+)
   - **Schedule:** weekly view correct Mon-Sun, now-indicator on current day
   - **Profile:** real belt, membership type, join date
   - **Progress:** real streak (not 0), real stats, classes from schedule API
   - **Shop:** products, cart, "Place Order" button, order confirmation
3. All 5 sections render without errors on fresh empty DB (demo data fallbacks)
4. Admin settings save persists branding to DB; member portal reflects it
5. `/dashboard/analysis` blocks non-owners
6. `/dashboard/reports` shows "Coming Soon" banner

---

## Execution Order

1. **Task 1.1** (seed) — must come first
2. **Task 2.1, 2.2a, 2.2b, 2.3** (API fixes) — sequential within 2.2b; others parallel
3. **Task 3.1, 3.2, 3.3** — parallel, depend on Phase 2 APIs
4. **Task 4.1, 4.2** — parallel, independent of Phase 3

---

## Open Questions

None. All Architect and Critic amendments incorporated:
- dayOfWeek fix kept (admin stores Sunday=0 via TimetableManager 0-6 indexing); fix is in consumer
- Schedule page left alone with TODO (self-consistent 1-7 internal convention)
- ClassInstance retrieval specified: `?date` param, `gte`/`lt` date range, backward-compatible
- Streak algorithm: Monday-start weeks, single query, cap 52, defined edge cases
- `checkInMethod: 'self'` added to sign-in POST body
- Task 3.2 scoped to state+useEffect only; uses all schedule classes as proxy (no subscription API)
- Acceptance criteria added per task
- "Powered by Stripe" + Apple icon removal explicitly specified for shop
