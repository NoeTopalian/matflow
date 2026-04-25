# Deep Dive Trace: fix-three-broken-member-portal

## Observed Result
Six bugs in the MatFlow member portal / dashboard:
- **C1** — Schedule page shows empty (hardcoded demo data, never calls API)
- **C2** — Profile page name/phone has no save handler (inputs uncontrolled, no PATCH)
- **C5** — Progress "Your Classes" shows wrong classes (first 4 tenant classes, not member's)
- **H3** — AdminCheckin ignores `?class=` deeplink from WeeklyCalendar
- **H4** — `promotedBy` always null despite `promotedById` stored in DB
- **H13** — Sidebar silently empty on role typo (no normalization anywhere in auth pipeline)

## Ranked Hypotheses
| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|------------|------------|-------------------|--------------|
| 1 | UI-to-API wiring gap: components built with demo/static data, never wired to real endpoints | High | Strong | ALL_CLASSES hardcoded in schedule page; profile has no PATCH call despite full API existing |
| 2 | API returns incomplete/wrong data: endpoints called but return null or wrong records | High | Strong | promotedBy hardcoded null line 121; schedule API has no ClassSubscription filter |
| 3 | Missing request coordination: params/role signals produced but never consumed | High | Strong | checkin page has zero searchParams read; role never normalized before sidebar filter |

## Evidence Summary by Hypothesis

**Lane 1 (C1, C2):**
- `app/member/schedule/page.tsx`: `ALL_CLASSES` is a 13-element module-level const. Zero `fetch`/`useEffect`-for-data in 527 lines. API endpoint `/api/member/schedule` is fully implemented and explicitly documented as "used by member Schedule and Home pages."
- `app/member/profile/page.tsx`: inputs use `defaultValue` (uncontrolled). No `onSubmit`, no save button, no `fetch` with PATCH anywhere. `PATCH /api/member/me` is fully implemented at `me/route.ts:137–186` and works correctly (proven by home page onboarding using it at line 208–212).

**Lane 2 (C5, H4):**
- `app/api/member/me/route.ts:121`: `promotedBy: null` — literal hardcoded. `promotedById` is not in the select query (lines 65–69). Schema: `MemberRank.promotedById` is a bare `String?` scalar with no Prisma relation declared — resolving to a name requires a secondary User lookup.
- `app/api/member/schedule/route.ts:40–53`: `prisma.class.findMany` filtered only by `tenantId` — no `ClassSubscription` join. `app/member/progress/page.tsx:114`: `data.slice(0, 4)` — client truncates the unfiltered list. `ClassSubscription` model exists in schema (`schema.prisma:192–202`) but is never queried.

**Lane 3 (H3, H13):**
- `components/dashboard/WeeklyCalendar.tsx:413`: emits `href={'/dashboard/checkin?class=${cls.id}'}`. `app/dashboard/checkin/page.tsx:83`: function signature `async function CheckinPage()` — zero params, no searchParams. Line 93: `initialInstanceId = instances[0].id` hardcoded. Zero `useSearchParams` hits in either checkin page or AdminCheckin.
- `components/layout/Sidebar.tsx:45–46`: `.includes(role)` against hardcoded lowercase array. `auth.ts:49,149`: role copied verbatim from DB → JWT → session. `prisma/schema.prisma:45`: `role String` (not enum). `types/next-auth.d.ts:6`: `role: string` (not union type). No normalization at any layer.

## Evidence Against / Missing Evidence
- **Lane 1**: Profile does fetch on mount (GET wired correctly); the gap is write-only. Email is intentionally read-only per PATCH route (only name/phone are mutable). Schedule `dow` vs API `dayOfWeek` convention needs verification.
- **Lane 2**: `promotedById` may never be written by any code path — if so, H4 fix requires both schema relation + write-side change, not just GET handler. ClassSubscription has no existing API query anywhere.
- **Lane 3**: `cls.id` in calendar deeplink may be a `Class` template ID, not `ClassInstance` ID — if so, H3 fix needs a DB lookup step in addition to reading the param. H13 may be latent-only (demo users always lowercase).

## Per-Lane Critical Unknowns
- **Lane 1 (UI wiring)**: Whether schedule API `dayOfWeek` (JS 0=Sun convention per route comment) aligns with `ALL_CLASSES.dow` (1=Mon convention used in page). Determines if replacement is a straight swap or needs index remapping.
- **Lane 2 (API data)**: Whether `promotedById` is ever written to `MemberRank` by any existing code path — if never written, H4 fix scope expands to write path + schema relation + GET handler.
- **Lane 3 (coordination)**: Whether `cls.id` in `WeeklyCalendar.tsx:413` is a `Class` ID or `ClassInstance` ID — determines H3 fix complexity (simple searchParams read vs. additional instance lookup).

## Rebuttal Round
- Best rebuttal to leader: "C5 might be intentional — show all classes as a preview, not member subscriptions"
- Why leader held: Section heading is explicitly "Your Classes"; variable named `subscribedClasses`; DEMO_SUBSCRIBED_CLASSES exists confirming per-member intent. Rebuttal fails on naming evidence alone.

## Convergence / Separation Notes
- All 6 bugs are implementation omissions, confirming all 3 lanes are really one meta-pattern: **features were scaffolded but not fully connected**. However, each bug has a distinct fix — they do not collapse to a single change.
- H4 has layered complexity: (1) hardcoded null, (2) field not selected, (3) no schema relation. May simplify to "display promotedById as-is" if name resolution is deferred.
- H3 has ID-type uncertainty: calendar may link with `Class.id` not `ClassInstance.id`, requiring a lookup to resolve today's instance.

## Most Likely Explanation
All 6 bugs are confirmed implementation gaps: APIs exist and work correctly, but components were never wired to them (C1, C2, H3), APIs return incomplete data because field selection or query filters were omitted (C5, H4), and session data flows through without validation guards (H13). Confidence is HIGH for all six — evidence is from direct source code reads, not inference.

## Critical Unknown
Whether `WeeklyCalendar.tsx:413` links with a `Class.id` or `ClassInstance.id` — this is the single fact with the highest impact on fix scope. All other unknowns are confirmable during implementation.

## Recommended Discriminating Probe
Read `components/dashboard/WeeklyCalendar.tsx` near line 413 to check the type/shape of `cls` — specifically whether it's a `Class` row (template) or `ClassInstance` row. This collapses H3 fix complexity from "searchParams + DB lookup" to "searchParams only."
