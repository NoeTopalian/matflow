# Owner Onboarding Wizard — Implementation Plan

**Date:** 2026-04-18
**Complexity:** MEDIUM-HIGH
**Scope:** 6 files to create/modify, ~700 lines of new code, 1 schema migration

---

## Context

MatFlow needs a full-page, multi-step onboarding wizard that new gym owners go through on first login. The wizard guides them through setting up their gym: name, discipline selection, rank system, timetable, and branding. The codebase already has all the required API endpoints (`POST /api/ranks`, `POST /api/classes`, `POST /api/instances/generate`, `POST /api/upload`, `PATCH /api/settings`) and UI patterns (login page multi-step flow, RanksManager presets, SettingsPage theme presets). This is primarily a front-end assembly task with a small schema addition and two routing changes.

---

## Work Objectives

1. Add `onboardingCompleted` flag to Tenant model and expose it through the settings API
2. Gate the dashboard so unfinished owners are redirected to `/onboarding`
3. Build a 5-step wizard + completion screen as a single client component
4. Reuse existing API endpoints and preset data (no new backend logic beyond the flag)

---

## Guardrails

### Must Have
- Wizard only appears for `role === "owner"` users where `tenant.onboardingCompleted === false`
- All 5 steps render and navigate correctly (forward, back, skip)
- Rank presets are created via `POST /api/ranks` (one call per rank)
- Classes are created via `POST /api/classes` then `POST /api/instances/generate`
- Branding is saved via `PATCH /api/settings`
- Completion screen sets `onboardingCompleted: true` via `PATCH /api/settings`
- Dark theme matching existing UI (`#0a0a0a` / `#111111` backgrounds, `rgba(255,255,255,0.04)` card surfaces)
- Mobile-first responsive layout
- Progress bar at top of wizard

### Must NOT Have
- No new API routes (reuse existing ones entirely)
- No changes to the member onboarding flow (separate system on Member model)
- No breaking changes to existing dashboard functionality
- No external dependencies added (use existing Tailwind, lucide-react, next-auth)

---

## Task Flow

```
[Schema] --> [API update] --> [Dashboard redirect] --> [Onboarding route] --> [Wizard component] --> [Manual QA]
   1              2                   3                       4                      5                   6
```

Steps 1-2 are backend prerequisites. Steps 3-4 are routing plumbing. Step 5 is the bulk of the work. Step 6 is verification.

---

## Detailed TODOs

### Step 1: Schema Migration — Add `onboardingCompleted` to Tenant

**File:** `prisma/schema.prisma`

**Changes:**
- Add `onboardingCompleted Boolean @default(false)` to the `Tenant` model, after the `fontFamily` field (line 20 area)

**Then run:**
```bash
npx prisma db push
```

**Acceptance Criteria:**
- `npx prisma studio` shows the new column on the Tenant table
- Existing tenants default to `false`
- No other models are affected (note: `Member` already has its own separate `onboardingCompleted` field on line 68 of schema — these are independent)

---

### Step 2: Update Settings API — Accept `onboardingCompleted` in PATCH

**File:** `app/api/settings/route.ts`

**Changes:**
- Add `onboardingCompleted: z.boolean().optional()` to the `updateSchema` zod object (line 7-14)
- No changes needed to the GET handler, but optionally add `onboardingCompleted` to the `select` clause so the dashboard layout can read it

**Key detail:** The existing PATCH handler already does `data: parsed.data` in the Prisma update call (line 73), so adding the field to the schema is sufficient — no handler logic changes needed.

**Acceptance Criteria:**
- `PATCH /api/settings` with `{ "onboardingCompleted": true }` succeeds and persists the value
- `PATCH /api/settings` without the field still works (field is optional)
- Non-owner roles still get 403

---

### Step 3: Dashboard Layout Redirect — Gate Unfinished Owners

**File:** `app/dashboard/layout.tsx`

**Changes:**
- Expand the existing `prisma.tenant.findUnique` select clause (line 19-20) to also fetch `onboardingCompleted`
- After the auth check, add a redirect condition:
  ```
  if session.user.role === "owner" AND tenant.onboardingCompleted === false
    then redirect("/onboarding")
  ```
- This goes right after the tenant fetch (around line 22), before the JSX return

**Important edge cases:**
- Only redirect `owner` role — coaches, managers, admins should never see onboarding
- If tenant fetch fails (`.catch(() => null)`), do NOT redirect — let them into the dashboard rather than creating a redirect loop
- The redirect must use `next/navigation`'s `redirect()` which is already imported

**Acceptance Criteria:**
- Owner with `onboardingCompleted: false` visiting `/dashboard` is redirected to `/onboarding`
- Owner with `onboardingCompleted: true` sees the normal dashboard
- Non-owner roles (coach, admin, manager) are never redirected regardless of flag
- No redirect loop when tenant fetch fails

---

### Step 4: Onboarding Route — Layout + Page Server Component

**Files to create:**
- `app/onboarding/layout.tsx` — Minimal full-page layout (no sidebar, no topbar)
- `app/onboarding/page.tsx` — Server component with auth gating

**`app/onboarding/layout.tsx`:**
- Simple wrapper: dark background (`#0a0a0a`), centered content area, safe-area padding for mobile
- No sidebar, no topbar, no mobile nav — full-page takeover like the login page
- Accepts `children` only

**`app/onboarding/page.tsx`:**
- Server component that:
  1. Calls `auth()` — redirect to `/login` if no session
  2. Checks `session.user.role === "owner"` — redirect to `/dashboard` if not owner
  3. Fetches tenant to check `onboardingCompleted` — redirect to `/dashboard` if already `true`
  4. Passes `tenantName` and `ownerName` (from session) as props to the client wizard component
- Renders `<OwnerOnboardingWizard tenantName={...} ownerName={...} />`

**Acceptance Criteria:**
- `/onboarding` shows a full-page dark layout (no sidebar)
- Non-authenticated users are redirected to `/login`
- Non-owner users are redirected to `/dashboard`
- Already-onboarded owners are redirected to `/dashboard`
- The wizard component receives the correct tenant and owner names

---

### Step 5: Wizard Client Component — The Main Build

**File to create:** `components/onboarding/OwnerOnboardingWizard.tsx`

This is a single `"use client"` component (~500-700 lines) managing all 5 steps plus the completion screen via internal state. Pattern follows the existing login page's multi-step architecture (state machine with step variable, separate render functions per step).

#### Component Architecture

```
OwnerOnboardingWizard (props: { tenantName: string; ownerName: string })
  state:
    step: 1 | 2 | 3 | 4 | 5 | "done"
    gymName: string (pre-filled from tenantName)
    selectedDisciplines: string[] (from step 2)
    selectedRankPresets: string[] (discipline names to apply)
    classes: ClassDraft[] (from step 4)
    theme: { primaryColor, secondaryColor, textColor, bgColor } (from step 5)
    logoUrl: string | null
    saving: boolean
    summary: { ranksCreated, classesCreated, themeApplied }
```

#### Step 1/5 — Gym Identity
- Input field for gym name, pre-filled with `tenantName`
- Read-only display of owner name (from `ownerName` prop)
- Optional location/city text field (display-only, not persisted)
- "Next" button: saves gymName to state, advances to step 2
- If gym name was edited: fire `PATCH /api/settings { name: gymName }` before advancing
- No Back button (first step)

#### Step 2/5 — Your Discipline
- 3x3 grid of sport cards with emoji icons:
  - BJJ, Boxing, Muay Thai, MMA, Kickboxing, Wrestling, Judo, Karate, Other
- Multi-select with visual toggle (border highlight on selected cards)
- Validation: at least 1 discipline must be selected
- "Next" advances to step 3

**Data structure for discipline cards:**
```typescript
const DISCIPLINES = [
  { id: "BJJ", label: "BJJ", emoji: "🥋" },
  { id: "Boxing", label: "Boxing", emoji: "🥊" },
  { id: "Muay Thai", label: "Muay Thai", emoji: "🦵" },
  { id: "MMA", label: "MMA", emoji: "⚔️" },
  { id: "Kickboxing", label: "Kickboxing", emoji: "👊" },
  { id: "Wrestling", label: "Wrestling", emoji: "🤼" },
  { id: "Judo", label: "Judo", emoji: "🟡" },
  { id: "Karate", label: "Karate", emoji: "🎽" },
  { id: "Other", label: "Other", emoji: "⭐" },
];
```

**Mapping to rank presets:** Only BJJ, Judo, Karate, and Wrestling have presets defined in `RanksManager.tsx`'s `PRESETS` object. The wizard must duplicate/inline these preset arrays (do NOT import from the dashboard component — keep the wizard self-contained).

#### Step 3/5 — Rank System
- For each selected discipline that has a preset (BJJ, Judo, Karate, Wrestling): show a preset card displaying the belt/rank sequence as colored dots or mini belt graphics
- Each preset card has a toggle to apply/unapply (default: applied)
- Disciplines without presets (Boxing, Muay Thai, MMA, Kickboxing, Other): show a note like "No default rank system — you can create custom ranks later in Settings"
- "Skip" button available
- On "Next": for each applied preset, fire sequential `POST /api/ranks` calls:
  ```
  POST /api/ranks { discipline: "BJJ", name: "White", order: 0, color: "#e5e7eb", stripes: 0 }
  POST /api/ranks { discipline: "BJJ", name: "Blue", order: 1, color: "#3b82f6", stripes: 0 }
  ...
  ```
- Track count of ranks created for completion summary
- Show loading state during API calls

**Tricky parts:**
- The `POST /api/ranks` route has a unique constraint `@@unique([tenantId, discipline, order])`. If the user goes Back and re-submits, they will get 409 conflicts. Handle this by catching 409 errors and treating them as success (rank already exists).
- Ranks must be created sequentially per discipline (order matters for the unique constraint).

#### Step 4/5 — Timetable
- Sport-aware class name suggestions based on selected disciplines:
  ```typescript
  const CLASS_SUGGESTIONS: Record<string, string[]> = {
    "BJJ": ["Beginner BJJ", "Advanced BJJ", "No-Gi", "Open Mat", "Kids BJJ", "Competition Training"],
    "Boxing": ["Boxing Fundamentals", "Advanced Boxing", "Sparring", "Pad Work"],
    "Muay Thai": ["Muay Thai Basics", "Muay Thai Advanced", "Clinch Work"],
    "MMA": ["MMA Fundamentals", "MMA Advanced", "Ground & Pound"],
    "Kickboxing": ["Kickboxing Basics", "Kickboxing Cardio", "Sparring"],
    "Wrestling": ["Wrestling Fundamentals", "Wrestling Advanced", "Takedown Drills"],
    "Judo": ["Judo Fundamentals", "Judo Randori", "Judo Kids"],
    "Karate": ["Karate Basics", "Karate Kata", "Karate Kumite"],
    "Other": ["Group Class", "Private Training", "Open Gym"],
  };
  ```
- Display suggestions as clickable pills that pre-fill the class name field
- Quick-add form per class:
  - Name (text input or pick from suggestions)
  - Coach name (text input, optional)
  - Location (text input, optional, e.g. "Mat 1")
  - Day checkboxes (Mon-Sun) — multiple days = one class with multiple schedules
  - Start time + End time (time inputs)
  - Max capacity (number input, optional)
- "Add Class" button adds to a local array; classes are displayed as cards below the form
- Can remove added classes before submitting
- "Skip" button available (0 classes is fine)
- On "Next": for each class draft, fire `POST /api/classes` with schedules array, then one final `POST /api/instances/generate { weeks: 4 }`
- Track count of classes created for completion summary

**API call shape per class:**
```json
{
  "name": "Beginner BJJ",
  "coachName": "Coach Mike",
  "location": "Mat 1",
  "duration": 60,
  "maxCapacity": 20,
  "schedules": [
    { "dayOfWeek": 1, "startTime": "18:00", "endTime": "19:00" },
    { "dayOfWeek": 3, "startTime": "18:00", "endTime": "19:00" }
  ]
}
```

**Note:** Duration is required by the API but not explicitly in the wizard form. Calculate it from `endTime - startTime` automatically. If the calculation yields 0 or negative (e.g. overnight class), default to 60.

#### Step 5/5 — Branding
- Theme picker: show the 12 theme presets from SettingsPage as clickable cards
  - Each card shows: preset name, style label, a swatch of primary + secondary colors
  - Inline the `THEME_PRESETS` array (same data from SettingsPage.tsx, lines 47-62)
  - Default selection: first preset ("Classic BJJ")
- Logo upload: file input using the existing `POST /api/upload` endpoint (FormData with `file` field)
  - Show preview after upload
  - Optional — can skip
- Live preview: a mini mockup showing gym name with the selected theme colors (simplified version of the PhonePreview pattern in SettingsPage)
- "Skip" button available (keeps default theme)
- On "Next": fire `PATCH /api/settings { primaryColor, secondaryColor, textColor, bgColor, fontFamily, logoUrl }` with selected values
- If logo was uploaded, include the returned URL in the settings PATCH

#### Completion Screen
- Heading: "Your gym is ready!"
- Summary cards showing what was configured:
  - "X ranks set up" (or "Skipped" if 0)
  - "X classes added" (or "Skipped" if 0)  
  - "Theme applied" (or "Default theme" if skipped)
- Single CTA button: "Go to Dashboard"
- On click: fire `PATCH /api/settings { onboardingCompleted: true }`, then `router.push("/dashboard")`

#### Progress Bar
- Full-width strip at very top of page, height 3px
- Fill width = `(currentStep / 5) * 100%`
- Uses primary color (default `#3b82f6`, or selected theme color if on step 5+)
- Step indicator text below: "Step X of 5 -- Step Name"

#### Navigation
- "Back" button on steps 2-5 (not on step 1)
- "Skip" button on steps 3, 4, 5
- "Next" / "Continue" button on all steps
- Buttons match login page styling: `rounded-xl py-4 text-sm font-semibold`

#### Design Tokens (match existing codebase patterns)
```
Page background: #0a0a0a
Card surface: rgba(255,255,255,0.04)
Card border: rgba(255,255,255,0.06)  OR  1px solid rgba(255,255,255,0.06)
Card border-radius: rounded-2xl
Input background: #1c1c1c
Input border: 1px solid rgba(255,255,255,0.1)
Input focus: borderColor = primaryColor, boxShadow = 0 0 0 3px ${primary}20
Primary text: #ffffff (text-white)
Muted text: rgba(255,255,255,0.4) to rgba(255,255,255,0.45)
Primary button: bg-primary text-white font-semibold rounded-xl py-4
Ghost/Skip button: text-sm, rgba(255,255,255,0.4) color, no background
```

**Acceptance Criteria:**
- All 5 steps render correctly and look visually consistent with the login page
- Forward/back/skip navigation works without data loss
- Step 1 saves gym name if edited
- Step 2 requires at least 1 discipline selected
- Step 3 creates ranks via API (409 conflicts handled gracefully)
- Step 4 creates classes via API, then generates instances
- Step 5 saves theme + optional logo via API
- Completion screen shows accurate summary counts
- "Go to Dashboard" sets `onboardingCompleted: true` and redirects
- Mobile layout is usable (single column, comfortable touch targets)
- Loading spinners show during API calls
- API errors are shown as inline error messages (not silent failures)

---

### Step 6: Manual QA Verification

**Test scenarios:**
1. Fresh owner login -> redirected to `/onboarding` -> complete all 5 steps -> lands on dashboard
2. Fresh owner login -> skip steps 3, 4, 5 -> completion screen shows "Skipped" -> dashboard works
3. Returning owner (onboarding already done) -> goes directly to dashboard, no redirect
4. Non-owner login (coach, admin) -> never sees onboarding regardless of tenant flag
5. Navigate back through steps -> data is preserved
6. Mobile viewport -> all steps are usable
7. Re-run step 3 after going back -> no duplicate rank errors (409 handled)

**Acceptance Criteria:**
- All 7 test scenarios pass
- No console errors during the flow
- Ranks appear in Dashboard > Ranks after onboarding
- Classes appear in Dashboard > Timetable after onboarding
- Theme colors are applied to dashboard after onboarding

---

## Success Criteria

1. A new owner completing the wizard can set up their gym entirely through the guided flow
2. The wizard is skippable at granular level (individual steps 3-5) without breaking anything
3. After completion, the owner never sees the wizard again
4. No existing functionality is broken (member portal, coach/admin access, existing API behavior)
5. The visual design is indistinguishable in quality from the existing login page

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| 409 conflicts on rank creation if user navigates back | Catch 409 responses and treat as success |
| Duration calculation from time inputs yields 0/negative | Default to 60 minutes as fallback |
| Tenant fetch failure in dashboard layout causes redirect loop | Only redirect when tenant is fetched AND `onboardingCompleted === false`; null tenant = no redirect |
| Wizard state lost on page refresh | Acceptable for MVP — wizard is a one-time flow. Could add localStorage persistence as a follow-up |
| Large wizard component (500-700 lines) | Keep as single file with clearly separated render functions per step (mirrors login page pattern). Extract sub-components only if it exceeds ~800 lines |
