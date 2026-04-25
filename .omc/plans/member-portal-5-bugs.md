# Member Portal — 5 Bug Fixes (C1, C2, C5, H3, H13)

**Scope:** Replace hardcoded demo data with real API calls on Schedule + Progress, wire up Profile save, accept `?class=` deeplink on Check-in, and normalize session role.
**Mode:** SHORT consensus (ralplan-DR lite).
**Complexity:** MEDIUM. 5 targeted edits + 1 new API route. No schema changes. No redesign.

---

## RALPLAN-DR Summary

### Principles (4)
1. **Minimum surface area.** Edit existing files; create only one new route (`/api/member/classes`). No new components, no redesigns.
2. **Preserve demo fallback behavior.** Every new API call must degrade gracefully when `tenantId === "demo-tenant"` or the DB is unreachable, matching the pattern used in `/api/member/me` and `/api/member/schedule`.
3. **Match existing shape conventions.** The schedule API already uses `dayOfWeek` with JS `getDay()` convention (0=Sun…6=Sat). The schedule page internally uses `dow` with 1=Mon…7=Sun. Do not break this contract — map at the boundary.
4. **Typed session role without runtime surprises.** Normalize role in the session callback (lowercase+trim), then narrow the TS union — never the other way around.

### Decision Drivers (top 3)
1. **Correctness over novelty.** `/api/member/schedule` and `PATCH /api/member/me` already exist with the right shape — consuming them is strictly safer than inventing new contracts.
2. **App Router v16 compatibility.** `app/dashboard/checkin/page.tsx` is a Server Component; `searchParams` must be typed as `Promise<...>` and awaited (Next 15+/16 async searchParams rule).
3. **Role narrowing must not break existing string callers.** Everywhere currently reading `session.user.role` as `string` must still compile under the union type.

### Options Considered

**Option A — Consume existing `/api/member/schedule` for C1, add new `/api/member/classes` for C5, reuse existing `PATCH /api/member/me` for C2.** *(Selected.)*
- Pros: zero schema churn; leverages existing demo-fallback pattern; `/api/member/me` PATCH already accepts `{name, phone}` — verified in `app/api/member/me/route.ts:137-186`.
- Cons: adds one new route file. Acceptable because `/api/member/me` does not currently expose per-attendance class details, and shoehorning them in bloats the hot-path "me" payload.

**Option B — Extend `/api/member/me` to include an `attendedClasses` array instead of a new route.**
- Pros: no new file.
- Cons: `/api/member/me` is called on every page load for header/profile data; padding it with a `findMany`+`include: { classInstance: { include: { class: true } } }` adds latency to every screen. Violates principle #1 (minimum surface area of *hot* code) even though it literally touches fewer files.
- **Invalidated** because the spec explicitly says "Create `app/api/member/classes/route.ts`".

### Mode: SHORT
No pre-mortem / expanded test matrix required. Each fix has a direct acceptance check; blast radius is contained to the 6 listed files.

---

## Ordered Implementation Plan

### Task 1 — H13: Role normalization
**Files:**
- `auth.ts` (jwt callback line 112, session callback line 149)
- `types/next-auth.d.ts` (lines 4, 17, 34)

**Changes:**
1. Add a shared helper at the top of `auth.ts` (before the NextAuth config):
   ```ts
   function normalizeRole(r: unknown): string {
     return (typeof r === "string" ? r : "").toLowerCase().trim();
   }
   ```
2. In `auth.ts` `jwt()` callback, after `if (user) { ... }` block (line 112), change:
   ```ts
   token.role = (user as any).role;
   ```
   to:
   ```ts
   token.role = normalizeRole((user as any).role);
   ```
   This closes the write-side gap — roles are normalized at the moment they enter the JWT, not just when they're read.
3. In `auth.ts` `session()` callback, replace:
   ```ts
   session.user.role = token.role as string;
   ```
   with:
   ```ts
   session.user.role = (normalizeRole(token.role) as "owner" | "manager" | "coach" | "admin" | "member");
   ```
4. In `types/next-auth.d.ts`:
   - Line 4 (`interface User`): **keep as `role: string`** — `authorize()` returns raw DB/demo strings; narrowing here would break compilation.
   - Line 17 (`interface Session.user`): change `role: string;` → `role: "owner" | "manager" | "coach" | "admin" | "member";`
   - Line 34 (`interface JWT`): keep as `role: string` — the raw pre-normalized token value.

**Acceptance:**
- `npm run typecheck` passes.
- `grep -rn "session.user.role" app components` — every reader still compiles (all current readers use `===` string comparisons, which remain valid against a union subtype of `string`).
- Manual: log in as `OWNER@totalbjj.com` (if such a user exists) or similar; session role comes back lowercased.

**Risk:** If any code assigns `session.user.role = someString`, it would fail to compile after narrowing `Session`. Grep to confirm nothing writes to `session.user.role` outside `auth.ts`.

---

### Task 2 — C2: Profile save (name/phone PATCH)
**File:** `app/member/profile/page.tsx`

**Changes:**
1. The page already has `memberName`, `memberEmail`, `memberPhone` state (lines 300-302) and already fetches `/api/member/me` to hydrate them (lines 318-328). Good.
2. Replace the three hardcoded-`defaultValue` rows (lines 440-456) with controlled inputs bound to state, and keep email read-only.
   - Name input: `value={memberName}` + `onChange={(e) => setMemberName(e.target.value)}`.
   - Email input: add `readOnly` and `disabled`, keep `value={memberEmail}`.
   - Phone input: `value={memberPhone ?? ""}` + `onChange={(e) => setMemberPhone(e.target.value || null)}`.
   - Because the array-of-objects `.map()` at line 440 mixes the three fields, switch to three explicit JSX rows (simpler + avoids a per-field `onChange` lookup table).
3. Add new state above the return:
   ```ts
   const [saving, setSaving] = useState(false);
   const [saveMsg, setSaveMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
   ```
4. Add a Save button directly beneath the Personal Details card. On click:
   - `setSaving(true); setSaveMsg(null);`
   - `fetch("/api/member/me", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: memberName, phone: memberPhone }) })`.
   - On `res.ok`: `setSaveMsg({ type: "ok", text: "Profile saved" })`.
   - On failure: `setSaveMsg({ type: "err", text: "Could not save. Try again." })`.
   - Finally: `setSaving(false)`; auto-clear message after 3s via `setTimeout`.
5. Render `saveMsg?.text` as a small line under the button, colored by `type`.

**Acceptance:**
- Typing in Name or Phone updates the controlled input (previously stuck on first render value).
- Email input is visibly non-editable.
- Clicking Save fires a single `PATCH /api/member/me` with `{name, phone}`. DevTools Network tab shows 200.
- On success, "Profile saved" appears for ~3s.
- Refreshing the page shows the new values (backed by real DB write — verified via existing PATCH handler at `app/api/member/me/route.ts:158-159`).
- Demo-tenant session still "succeeds" (no-op PATCH returns `{ok: true}` — line 143 of the route).

**Risk:** None — PATCH handler already accepts `{name, phone}` (confirmed).

---

### Task 3 — C1: Schedule page — replace ALL_CLASSES with API fetch
**File:** `app/member/schedule/page.tsx`

**Background:** The API returns `dayOfWeek` using JS `getDay()` convention (0=Sun…6=Sat). The page currently uses `dow` with 1=Mon…7=Sun (see line 11 `dow: 1` for Monday, line 22 `dow: 6` for Saturday, and the `todayDow` calc at line 170 that maps Sunday→7). **Map at the boundary.**

**Changes:**
1. Remove the module-level `const ALL_CLASSES = [...]` (lines 10-24).
2. Define the fetched-item type at module scope:
   ```ts
   type ScheduleClass = {
     id: string; name: string; time: string; endTime: string;
     coach: string; location: string; capacity: number | null;
     dow: number; // 1=Mon…7=Sun (internal convention)
     classInstanceId?: string | null;
   };
   ```
3. Update the `EventSheet` prop type `cls: typeof ALL_CLASSES[0]` (line 76) → `cls: ScheduleClass`.
4. Inside `MemberSchedulePage`, add state and fetch. Use a `loading` flag to suppress the "No classes today" empty state during the initial fetch (avoids a flash):
   ```ts
   const [allClasses, setAllClasses] = useState<ScheduleClass[]>([]);
   const [scheduleLoading, setScheduleLoading] = useState(true);
   useEffect(() => {
     fetch("/api/member/schedule")
       .then((r) => r.ok ? r.json() : [])
       .then((data: Array<{
         id: string; name: string; startTime: string; endTime: string;
         coach: string; location: string; capacity: number | null;
         dayOfWeek: number; classInstanceId?: string | null;
       }>) => {
         const mapped: ScheduleClass[] = (Array.isArray(data) ? data : []).map((c) => ({
           id: c.id,
           name: c.name,
           time: c.startTime,
           endTime: c.endTime,
           coach: c.coach,
           location: c.location,
           capacity: c.capacity,
           // API: 0=Sun…6=Sat. Internal: 1=Mon…7=Sun.
           dow: c.dayOfWeek === 0 ? 7 : c.dayOfWeek,
           classInstanceId: c.classInstanceId ?? null,
         }));
         setAllClasses(mapped);
       })
       .catch(() => setAllClasses([]))
       .finally(() => setScheduleLoading(false));
   }, []);
   ```
5. Replace every remaining `ALL_CLASSES` reference inside the component:
   - `DayGrid` line 174: `const dayClasses = ALL_CLASSES.filter(...)` → pass `allClasses` and `loading` props. Add `classes: ScheduleClass[]; loading: boolean` props to `DayGrid`, forward from parent (three `<DayGrid classes={allClasses} loading={scheduleLoading} ... />` sites at lines 481, 492, 504).
   - Inside `DayGrid`, change the empty-state guard at line 217: `{dayClasses.length === 0 && ...}` → `{!loading && dayClasses.length === 0 && ...}` so "No classes today" is suppressed during fetch.
   - Day-pill count at line 434: `ALL_CLASSES.filter(...)` → `allClasses.filter(...)`.
   - `selectedCls` at line 397: `ALL_CLASSES.find(...)` → `allClasses.find(...)`.
6. Update `INITIAL_SUBS` behavior: leave the `Set<string>` as-is (demo subscription state is local UI only; out of scope — spec does not ask us to persist subscriptions).

**Acceptance:**
- Page loads; `/api/member/schedule` is called exactly once per mount (Network tab).
- Classes appear in the correct day columns for a real tenant (Mon→Mon, Sun→Sun).
- Empty state "No classes today" shows when no classes exist for that day (existing logic at line 217 still works).
- Demo tenant still shows the 13 demo classes (because the API returns them for `demo-tenant`).
- All three swipeable panels (prev/curr/next) render with the correct filtered classes.

**Risk (medium):** The mapping `0→7` must be applied consistently. If omitted, Sunday classes would show as `dow=0`, which no filter matches (internal uses 1-7). Test with a Sunday class if available.

---

### Task 4 — C5: Create `/api/member/classes` + wire Progress page
**Files:**
- `app/api/member/classes/route.ts` (NEW)
- `app/member/progress/page.tsx`

#### 4a — New route
Create `app/api/member/classes/route.ts`:
```ts
/**
 * GET /api/member/classes
 * Returns distinct classes the logged-in member has attended, most-recent first.
 * Used by the member Progress page ("Your Classes").
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

const DEMO_CLASSES = [
  { id: "demo-1", name: "No-Gi",            day: "Monday",   time: "18:00", coach: "Coach Mike" },
  { id: "demo-2", name: "Fundamentals BJJ", day: "Tuesday",  time: "09:30", coach: "Coach Mike" },
  { id: "demo-3", name: "Open Mat",         day: "Friday",   time: "18:00", coach: "Open" },
  { id: "demo-4", name: "Saturday Session", day: "Saturday", time: "10:00", coach: "Coach Mike" },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.tenantId === "demo-tenant") return NextResponse.json(DEMO_CLASSES);

  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json([]);

  try {
    const records = await prisma.attendanceRecord.findMany({
      where: { memberId },
      include: { classInstance: { include: { class: true } } },
      orderBy: { checkInTime: "desc" },
    });

    // Deduplicate by classId — keep the most recent attendance per class.
    const seen = new Set<string>();
    const result: Array<{ id: string; name: string; day: string; time: string; coach: string }> = [];
    for (const r of records) {
      const classId = r.classInstance.class.id;
      if (seen.has(classId)) continue;
      seen.add(classId);
      result.push({
        id: classId,
        name: r.classInstance.class.name,
        day: DAY_NAMES[r.classInstance.date.getDay()] ?? "",
        time: r.classInstance.startTime,
        coach: r.classInstance.class.coachName ?? "Coach",
      });
    }

    return NextResponse.json(result);
  } catch {
    return NextResponse.json([]);
  }
}
```

#### 4b — Progress page
`app/member/progress/page.tsx`:
1. Remove `DEMO_SUBSCRIBED_CLASSES` seed and initialize `subscribedClasses` to `[]` (not demo data). Add a `classesLoading` flag (initially true, set false in `.finally()`) and suppress the "No subscribed classes yet" empty state while loading — consistent with Task 3 pattern.
2. Replace the second `useEffect` block that fetches `/api/member/schedule` (lines 109-123) with:
   ```ts
   fetch("/api/member/classes")
     .then((r) => r.ok ? r.json() : null)
     .then((data: Array<{ id: string; name: string; day: string; time: string; coach: string }> | null) => {
       if (!Array.isArray(data)) return;
       setSubscribedClasses(data);
     })
     .catch(() => {});
   ```
   (No slicing, no day-index remapping — the API already returns the final display shape.)

**Acceptance:**
- Navigate to `/member/progress` as a member with 2+ attendance records → "Your Classes" shows their *attended* classes, deduplicated by class.
- A member with zero attendance records sees the empty state "No subscribed classes yet" (existing check at line 168).
- Demo-tenant users see the 4 demo classes.
- Network tab: `/api/member/classes` replaces the previous `/api/member/schedule` call.

**Risk:** Low. The new endpoint is read-only and demo-safe.

---

### Task 5 — H3: Check-in deeplink via `?class=`
**File:** `app/dashboard/checkin/page.tsx`

**Changes:**
1. Change the page signature (line 83):
   ```ts
   export default async function CheckinPage({
     searchParams,
   }: {
     searchParams: Promise<{ class?: string }>;
   }) {
     const { class: classIdParam } = await searchParams;
     const session = await auth();
     // ...
   }
   ```
2. After `instances = await getTodayInstances(...)` (line 91), branch:
   ```ts
   if (instances.length > 0) {
     let chosen: CheckinClassInstance | null = null;

     if (classIdParam) {
       const now = new Date();
       const start = new Date(now); start.setHours(0, 0, 0, 0);
       const end   = new Date(now); end.setHours(23, 59, 59, 999);
       try {
         const matched = await prisma.classInstance.findFirst({
           where: {
             classId: classIdParam,
             class: { tenantId: session!.user.tenantId }, // tenant safety
             date: { gte: start, lte: end },
             isCancelled: false,
           },
         });
         if (matched) {
           chosen = instances.find((i) => i.id === matched.id) ?? null;
         }
       } catch { /* ignore, fall back below */ }
     }

     // If a ?class= param was given but no matching instance found today,
     // do NOT silently fall back to instances[0] — show an explicit empty state.
     // This prevents the staff seeing the wrong class check-in UI with no warning.
     if (!chosen && !classIdParam) chosen = instances[0];

     if (chosen) {
       initialInstanceId = chosen.id;
       initialMembers = await getMembersForInstance(chosen.id, session!.user.tenantId);
     }
     // chosen === null means ?class= was given but no today's instance found → renders empty state
   }
   ```
3. Keep the outer `try/catch` unchanged — DB unavailable path still works.

**Acceptance:**
- Visit `/dashboard/checkin` with no query → first today's instance loads (existing behavior preserved).
- Visit `/dashboard/checkin?class=<classId>` where `<classId>` has a today's instance → that instance is selected initially.
- Visit `/dashboard/checkin?class=not-a-real-id` → falls back to `instances[0]`, no crash.
- Visit with a classId from a *different* tenant → tenant-scoped query returns null → falls back (prevents cross-tenant leak).

**Risk:** Medium — we are widening the surface of the server component. The tenant scoping in the `findFirst` call is the critical security check; do not omit.

---

## Global Acceptance Verification

Run in order:
```bash
npm run typecheck       # Task 1 narrowing + all new types
npm run lint
npm test                # existing tests must pass
npm run dev
```

Manual smoke:
1. Log in as a real DB member → visit `/member/schedule` → classes load from API (Network tab), correct day columns.
2. `/member/profile` → edit name, click Save → "Profile saved" appears → reload → new name persists.
3. `/member/progress` → "Your Classes" lists attended classes only.
4. `/dashboard/checkin?class=<realClassId>` → that class is preselected.
5. Log in as demo user (owner@totalbjj.com / password123, tenant `totalbjj`) → every screen still renders with demo data.
6. Open any authed page → `console.log(session.user.role)` in React devtools shows a lowercased string.

---

## Risk Notes

- **JWT token reuse.** After deploying Task 1, existing sessions keep their old (un-normalized) `token.role` until the next JWT refresh. Session callback re-normalizes on every read, so effect is immediate. No user-visible migration.
- **Demo-tenant purity.** Every new fetch path degrades to `[]` or `{ok:true}` when `tenantId === "demo-tenant"` or `memberId` is missing. Matches existing conventions. Do not add hard errors for missing data.
- **H4 (promotedBy).** Out of scope by spec. `/api/member/me` still returns `promotedBy: null` (line 121 of route). Do not touch.
- **Subscription persistence (schedule page).** `INITIAL_SUBS` and the `Set<string> subscribed` state remain local. Spec does not require persistence. Any "subscribe" button click today is in-memory only — this is pre-existing behavior.
- **C1 day-of-week mapping.** API uses 0=Sun, page uses 1=Mon…7=Sun. The mapping `c.dayOfWeek === 0 ? 7 : c.dayOfWeek` MUST be applied. Add an inline comment.

---

## ADR

- **Decision:** Fix all 5 bugs via targeted edits in the 6 listed files plus one new API route (`app/api/member/classes/route.ts`).
- **Drivers:** Existing infrastructure (`PATCH /api/member/me`, `/api/member/schedule`) already supports most requirements; minimizing new code minimizes regression risk; spec explicitly names the new route file.
- **Alternatives considered:**
  - Extend `/api/member/me` instead of adding `/api/member/classes` — rejected: bloats hot path.
  - Narrow JWT `role` type too — rejected: requires `authorize()` rewrite, out of scope.
  - Add optimistic UI / toast library for profile save — rejected: inline message is simpler and matches current design language (no toast system exists in the codebase).
- **Why chosen:** Smallest blast radius; aligns exactly with spec; preserves demo fallback path end-to-end.
- **Consequences:**
  - `+` Progress page becomes accurate.
  - `+` Deeplinks from member Schedule (or elsewhere) can now target a specific class on the coach check-in screen.
  - `+` Type narrowing on `role` catches future typos at compile time.
  - `-` One additional route to maintain.
  - `-` Any future writer of `session.user.role` must use the narrowed union.
- **Follow-ups (not in scope):**
  - Persist class subscriptions (`INITIAL_SUBS` is still in-memory).
  - Populate `promotedBy` (H4).
  - Validate the role union at runtime in the session callback (currently pass-through lowercase).
