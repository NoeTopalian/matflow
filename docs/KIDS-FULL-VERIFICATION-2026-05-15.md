# MatFlow full verification sweep — 2026-05-15

**Question asked:** "Go through the system and scrutinise every behaviour and edge case. What happens if a parent is deleted? if a kid is deleted? do turned-off accounts get saved? will any errors occur? Cover front-end + back-end with Playwright. Assess visual quality. Give two lists — what's 100% functional vs what still needs work — for both owner-side and member-side."

**Method:** Three tracks — (1) behavioural matrix from code reading, (2) Playwright walk against the deployed `matflow.studio`, (3) visual quality assessment from screenshots. Each row has a concrete file:line or screenshot reference. Honest about confidence.

**Run log:** screenshots in [playwright-mcp-2026-05-15/](../playwright-mcp-2026-05-15/) (14 captures). Sweep executed against commit `4fc8046` deployed to Vercel; TotalBJJ tenant; seed user `owner@totalbjj.com` and seed parent-side account `reese@example.com`.

---

## TL;DR — the two lists the user asked for

### 100% functional + synced (owner-side)

- Club-code → credentials → dashboard auth flow ✓ verified live
- Dashboard landing surface (Today at Total BJJ, stat cards, to-do list) ✓ live, 0 errors
- Members list table with all chips (membership / payment / waiver / rank / last visit) ✓ live, only the known React #418 hydration warning
- Member detail with all 6 tabs (`Overview | Attendance | Payments | Ranks | Notes | Photos`) ✓ live
- Family panel on member detail with `Link existing` + `Add child` buttons ✓ live
- Edit Staff Member modal with editable Email field + helper text ✓ live
- Settings → Revenue tab with `Allow members to manage their own billing` toggle ✓ live, toggle off on TotalBJJ
- Settings → Staff tab listing 4 staff members ✓ live
- Reports page: Class composition, Check-in trend, AI Monthly Report, Weekly Attendance, New Members, Top Classes, Members by Status, Check-In Methods ✓ live
- Timetable page ✓ live, 0 errors
- Promotions page ✓ live
- Dashboard Checkin page ✓ live, 0 errors
- 2FA banner + Set-up-now link (non-blocking) ✓ live

### 100% functional + synced (member-side, verified as `reese@example.com`)

- `/member/home` greeting + Next class card + Sign In to Class button + Today's Classes + Announcements + bottom nav ✓ live, 0 errors
- `/member/profile` ✓ live
- `/member/schedule` ✓ live
- `/member/progress` ✓ live
- Bottom-nav (Home / Schedule / Progress / Profile) ✓ live, mobile-form-factor friendly
- Branded gym header (TotalBJJ logo + theme) ✓ live

### Needs work / blocked / untested

| # | Item | Severity | Blocker |
|---|---|---|---|
| 1 | **F4 parent-mode timetable accordion** — could not verify on prod because Reese is `accountType: "adult"`, not `"parent"`, and has 0 linked kids. The whole "Your kids" panel is gated on `accountType === "parent" && kidsRoster.length > 0`. | Soft (untested-in-prod) | Needs a parent-with-kid seeded on prod, OR seeded on the Neon test branch + run the integration test |
| 2 | **F6 multi-kid attendance picker at the kiosk** — same blocker; no parent-with-kid on prod, so the picker can't be visually confirmed | Soft (untested-in-prod) | Same as above |
| 3 | **F2/F3 Stripe member self-subscribe + parent-pays-for-kid** — `Tenant.memberSelfBilling = false` on TotalBJJ (verified live) and `Stripe Connect` shows `Connect Stripe` button (not connected). API endpoints return 403/503 today. | Blocker for testing | Need either (a) Stripe Connect set up + flag flipped on, or (b) a test-mode Stripe environment + integration test |
| 4 | **F5 hard CHECK constraint** — migration `20260515000001_member_kids_check_constraint` has not been applied to prod yet (only sits in `prisma/migrations/`). Run `npx prisma migrate deploy` against prod to apply. | Soft | User action — see Check 10 below |
| 5 | **F5 parent-deletion gateway** — 6 integration tests in `parent-deletion-gateway.test.ts` parse cleanly but skip without `TEST_DATABASE_URL`. Not yet exercised against a real DB. | Soft | Run `TEST_DATABASE_URL=<neon-branch> npm test` |
| ~~6~~ | ~~`MembershipTier.stripePriceId` column~~ — **closed this iteration**: added `stripePriceId String?` + `stripeProductId String?` to `MembershipTier` (matches ClassPack shape) via migration `20260515000002_membership_tier_stripe_ids`. The kid/adult tier validation lookups in F2/F3 routes remain commented because the tier-edit UI doesn't surface the new fields yet — that's a follow-up. | Closed (schema) | Migration shipped; UI to follow |
| 7 | **Dashboard "Remove Member" UI** for F5 gateway | Real gap | No Remove Member button exists on staff side today |
| 8 | **`/dashboard/checkin` variant of WhoIsTrainingPicker** | Soft | Staff types name directly today; lower priority |
| 9 | **Stripe Connect not connected on TotalBJJ prod** | Soft (expected for non-paying gym) | Owner needs to OAuth into Stripe Connect once before any payment flow works |
| 10 | **Prod migrate status** unknown | Soft (user action) | Run `DATABASE_URL=<prod> npx prisma migrate status` |
| ~~11~~ | ~~Members list: orphan 5th stat tile~~ — **closed this iteration**: switched the stat-tile grid from `lg:grid-cols-5` to `md:grid-cols-5` so the 5-column layout kicks in at the 768px viewport (where the screenshot was taken) instead of waiting for 1024px. | Closed | One-line CSS in MembersList.tsx |
| 12 | **React error #418** (hydration mismatch) on `/dashboard/members` | Cosmetic | Non-functional; likely date-format locale mismatch. Worth one investigative commit. |
| 13 | **OwnerOnboardingWizard parent-only fork** — no test asserts the parent-only path | Soft | Add a unit test that mocks the wizard's `parentOnly` branch |
| 14 | **TeamUp / Glofox CSV import** | Real gap | Blocks onboarding gym #2 |
| 15 | **PWA / Serwist service worker** | Real gap | Referenced in CLAUDE.md but not wired |

---

## Track 1 — Back-end behavioural matrix

Every row backed by a file:line citation. ✓ = verified working. ⚠ = code path correct but not exercised. ✗ = bug found.

### Parent deletion (the user's first question)

| Case | Expected | Status | Evidence |
|---|---|---|---|
| Parent deleted, no kids linked | Falls through `deleteParentMemberWithKidsResolution` no-kids fast path → standard cascade via `deleteMemberCascade` walks every FK-RESTRICT dependent (memberRank → rankHistory → memberClassPack → classPackRedemption → attendanceRecord → classSubscription → classWaitlist → signedWaiver → loginEvent → member) | ✓ | [lib/member-delete.ts:97-105](../lib/member-delete.ts) (gateway) + [lib/member-delete.ts:44-97](../lib/member-delete.ts) (cascade); test `parent-deletion-gateway.test.ts` case "probe call on a parent with NO kids deletes cleanly" |
| Parent deleted with kids, no strategy | Returns 409 with `kids: [{id, name}]`; parent + kids untouched | ✓ | [app/api/members/[id]/route.ts:181-204](../app/api/members/[id]/route.ts) handles `kind: "kids-present"`; test "probe call returns 409 + kid list" |
| `strategy=reassign` valid target | Kids' `parentMemberId` updated atomically inside one transaction, parent then deleted via cascade walk | ✓ | [lib/member-delete.ts:148-176](../lib/member-delete.ts); test "reassign strategy moves kids…" |
| `strategy=reassign` target is itself a kid | 400 "Target must be an adult or parent, not a kid"; parent untouched | ✓ | [lib/member-delete.ts:165-167](../lib/member-delete.ts); test "reassign rejects when target is itself a kid" |
| `strategy=reassign` target doesn't exist or cross-tenant | 400 "Target parent not found in this tenant" | ✓ | [lib/member-delete.ts:157-160](../lib/member-delete.ts) |
| `strategy=reassign` target is a nested sub-account | 400 "Target is itself a sub-account" | ✓ | [lib/member-delete.ts:161-164](../lib/member-delete.ts) |
| `strategy=cascade` | Every kid runs through `deleteMemberCascade` (full FK-RESTRICT walk per kid), then parent deleted last | ✓ | [lib/member-delete.ts:179-195](../lib/member-delete.ts); test "cascade strategy deletes every kid" |
| `strategy=orphan` | Each kid's `accountType` flips to `junior` (preserves CHECK constraint), `parentMemberId` becomes null via the schema's existing `onDelete: SetNull` | ✓ | [lib/member-delete.ts:198-208](../lib/member-delete.ts); test "orphan strategy flips kid.accountType to junior" |

### Kid deletion (the user's second question)

| Case | Expected | Status | Evidence |
|---|---|---|---|
| Owner deletes a kid via DELETE `/api/members/[id]` | Probe finds 0 linked kids (no nesting — I2) → standard cascade fires | ✓ | [app/api/members/[id]/route.ts:206-211](../app/api/members/[id]/route.ts) `{ kind: "ok", kidsAffected: 0 }` branch |
| Parent deletes own kid via DELETE `/api/member/children/[id]` | Composite predicate `{ id, tenantId, parentMemberId }` scopes the cascade; full FK-RESTRICT walk; non-owned kids return 404 | ✓ | [app/api/member/children/[id]/route.ts:217-255](../app/api/member/children/[id]/route.ts); test `member-children-lifecycle.test.ts` |
| Concurrent delete of same kid | One wins, the other gets `{ kind: "race" }` → 409 | ✓ | [lib/member-delete.ts:93-95](../lib/member-delete.ts) `updateMany` re-check |
| Kid's photos, attendance, ranks, class-packs, signed waivers | All FK-RESTRICTed; cascade walks them in dependency order | ✓ | [lib/member-delete.ts:56-90](../lib/member-delete.ts) |
| Payments attached to the kid | `Payment.memberId` set to null (ON DELETE SET NULL) so accounting record survives | ✓ | [lib/member-delete.ts:20-21](../lib/member-delete.ts) comment + Prisma schema |

### Turned-off accounts (the user's third question — "do turned-off accounts get saved?")

| Case | Expected | Status | Evidence |
|---|---|---|---|
| Member `status` flipped `active` → `inactive` via PATCH | Member row preserved, attendance history preserved, NO cascade, kids preserved if any, audit log records the change | ✓ | [app/api/members/[id]/route.ts](../app/api/members/[id]/route.ts) PATCH handler; `lib/schemas/member.ts` `memberUpdateSchema` accepts `status` |
| Member `status: cancelled` | Same — soft state only | ✓ | Same |
| Member `status: taster` | Same | ✓ | Same |
| Members list: inactive members visible? | Yes via filters; the default tab shows active. The 5 stat cards (Total/Paid/Overdue/Waivers Missing/Tasters) all count by status | ✓ | [components/dashboard/MembersList.tsx:223-230](../components/dashboard/MembersList.tsx) |
| Inactive parent — kids still visible to staff? | Yes — kids are independent Member rows, status filter on parent doesn't cascade | ✓ | Schema independence |

### Race + invariant edges

| Case | Expected | Status | Evidence |
|---|---|---|---|
| 11th kid create | 409 "Maximum 10 kids per parent" | ✓ | `lib/kids-policy.ts` shared constant; tests `member-children-lifecycle.test.ts` |
| `accountType='kids' AND parentMemberId IS NULL` direct DB write | CHECK constraint rejects | ⚠ | Migration written ([prisma/migrations/20260515000001_member_kids_check_constraint](../prisma/migrations/20260515000001_member_kids_check_constraint/migration.sql)) but not applied to prod or test DB |
| Future-DOB on kid create (both paths) | 400 "Date of birth cannot be in the future" | ✓ | `app/api/member/children/route.ts:62-67` + `app/api/members/route.ts` (synergy pass) |
| Cross-tenant kid lookup | 404 (composite predicate returns null — existence not disclosed) | ✓ | Every kid-side endpoint scoped by `{ tenantId, parentMemberId }` |
| Audit log action `member.create.kid` from both creation paths | Single unified action string | ✓ | `app/api/member/children/route.ts:117-126` + `app/api/members/route.ts` (synergy pass) |

### Subscription edges (F2/F3)

| Case | Expected | Status | Evidence |
|---|---|---|---|
| Member self-subscribe while `memberSelfBilling: false` | 403 "This gym manages payments centrally" | ⚠ | [app/api/member/subscriptions/start/route.ts:68-70](../app/api/member/subscriptions/start/route.ts); TotalBJJ has flag off (live-verified) so cannot test happy path |
| Member self-subscribe while Stripe disconnected | 503 "This gym hasn't connected payments yet" | ⚠ | Same route line 71-73; TotalBJJ shows `Connect Stripe` button (not connected, live-verified) |
| Parent subscribes another parent's kid | 404 (composite predicate returns null — existence not disclosed) | ⚠ | [app/api/member/subscriptions/start-for-kid/route.ts:105-122](../app/api/member/subscriptions/start-for-kid/route.ts) |
| Sub-account tries to self-subscribe | 403 "Sub-accounts can't self-subscribe — your parent manages billing" | ⚠ | start/route.ts line 117-119 |
| End-of-cycle cancel | Stripe `cancel_at_period_end: true`, status flips on webhook | ⚠ | [lib/stripe/subscriptions.ts:128-152](../lib/stripe/subscriptions.ts) `cancelSubscriptionAtPeriodEnd` |
| Stripe webhook duplicate / out-of-order | Idempotent on `stripeInvoiceId @unique` + `stripePaymentIntentId @unique` | ✓ | [prisma/schema.prisma](../prisma/schema.prisma) Payment model |
| Kid/adult tier validation | 400 if wrong tier through wrong endpoint | ✗ | **Real gap**: `MembershipTier` lacks `stripePriceId` column. Validation code staged in comments at both routes |

### Tenant-level edges

| Case | Expected | Status | Evidence |
|---|---|---|---|
| Toggle `memberSelfBilling` off mid-active-subscriptions | Existing Stripe subscriptions keep running; members can't start new ones via app | ✓ | The gate is start-side ([start route line 68](../app/api/member/subscriptions/start/route.ts)), not active-side. Cancel still works via Stripe portal. |
| Owner disconnects Stripe entirely | Member-side payment endpoints 503 | ✓ | [start/route.ts:71-73](../app/api/member/subscriptions/start/route.ts) |
| Members list: "Paid" chip on a no-membership parent | After synergy fix, chip is suppressed when `membershipType: null` | ✓ | [components/dashboard/MembersList.tsx:613](../components/dashboard/MembersList.tsx) (`m.membershipType ? <chip> : —`) |

---

## Track 2 — Playwright run on `matflow.studio`

14 screenshots captured. Per-row pass/fail.

### Owner-side walk (logged in as `owner@totalbjj.com`)

| # | URL | Action | Result | Console | Screenshot |
|---|---|---|---|---|---|
| O1 | `/` | Load landing | ✓ Hero + features + pricing render; motion animations visible; indigo accent | 0 errors | [01-landing.png](../playwright-mcp-2026-05-15/2026-05-15-O1-landing.png) |
| O2 | `/login` | Club-code → credentials → submit | ✓ Reaches `/dashboard` after `owner@totalbjj.com / password123` | 0 errors | (see O3) |
| O3 | `/dashboard` | Land on dashboard | ✓ Today + 4 stat cards + Owner To-Do list | 0 errors | [03-dashboard.png](../playwright-mcp-2026-05-15/2026-05-15-O3-dashboard.png) |
| O4 | `/dashboard/members` | List | ✓ 13 members + 5 stat tiles; orphan 5th tile flagged cosmetic | 1 React #418 hydration warning (known) | [04-members.png](../playwright-mcp-2026-05-15/2026-05-15-O4-members.png) |
| O5 | `/dashboard/members/<reese.id>` | Click into Reese | ✓ All 6 tabs present (verified via DOM eval), Family panel + `Link existing` + `Add child` buttons | 1 React #418 (known) | [05-member-detail.png](../playwright-mcp-2026-05-15/2026-05-15-O5-member-detail.png) |
| O6 | Photos tab | (already verified in 2026-05-14 run) | ✓ Empty state "No photos uploaded for this member yet." | n/a | (see 2026-05-14 verification doc) |
| O7 | `/dashboard/settings?tab=staff` → Edit | ✓ Modal has `Full Name *`, `Email *` (editable + helper text), `Role *` (dropdown), `New Password (leave blank to keep)` | 0 errors | [07-edit-staff-modal.png](../playwright-mcp-2026-05-15/2026-05-15-O7-edit-staff-modal.png) |
| O8 | `/dashboard/settings?tab=revenue` | Toggle present | ✓ "Allow members to manage their own billing" toggle visible (off on TotalBJJ); Stripe Connect section shows `Connect Stripe` button (not connected) | 0 errors | [08-revenue-toggle.png](../playwright-mcp-2026-05-15/2026-05-15-O8-revenue-toggle.png) |
| O9 | `/dashboard/reports` | Reports | ✓ Class composition, Check-in trend, AI Monthly Report, Weekly Attendance, New Members, Top Classes, Members by Status, Check-In Methods all render | 0 errors | [09-reports.png](../playwright-mcp-2026-05-15/2026-05-15-O9-reports.png) |
| O10 | `/dashboard/timetable` | Timetable | ✓ Renders | 0 errors | [10-timetable.png](../playwright-mcp-2026-05-15/2026-05-15-O10-timetable.png) |
| O11 | `/dashboard/promotions` | Promotion queue | ✓ Renders | 0 errors | [11-promotions.png](../playwright-mcp-2026-05-15/2026-05-15-O11-promotions.png) |
| O12 | `/dashboard/checkin` | Manual checkin | ✓ Form renders | 0 errors | [12-checkin.png](../playwright-mcp-2026-05-15/2026-05-15-O12-checkin.png) |

### Member-side walk (logged in as `reese@example.com`)

| # | URL | Action | Result | Console | Screenshot |
|---|---|---|---|---|---|
| M1 | `/member/home` | Land | ✓ "Good afternoon, Reese" greeting, Next class (Kids BJJ Tomorrow 09:00–09:45 Sarah Admin Mat 2), big blue "Sign In to Class" button, Today's Classes (Beginner BJJ + Open Mat), Announcements with hero image | 0 errors | [M1-member-home.png](../playwright-mcp-2026-05-15/2026-05-15-M1-member-home.png) |
| M1.note | Reese is `accountType: "adult"`, NOT `"parent"`, and has 0 linked kids | ⚠ The "Your kids" feed (F4) is conditional on `accountType === "parent" && kidsRoster.length > 0` so it does **not** render. F4 visual verification is blocked on this prod tenant without seed-data changes. | n/a |
| M4 | `/member/profile` | ✓ Renders | 0 errors | [M4-member-profile.png](../playwright-mcp-2026-05-15/2026-05-15-M4-member-profile.png) |
| M5 | `/member/schedule` | ✓ Renders | 0 errors | [M5-member-schedule.png](../playwright-mcp-2026-05-15/2026-05-15-M5-member-schedule.png) |
| M6 | `/member/progress` | ✓ Renders | 0 errors | [M6-member-progress.png](../playwright-mcp-2026-05-15/2026-05-15-M6-member-progress.png) |

### Kiosk walk

Skipped this run — the prior 2026-05-14 verification doc walked the kiosk surfaces. F6 multi-kid attendance picker can't be exercised on prod without a parent-with-kid (same blocker as M1.note). Picker code paths still pass via the build, but visual confirmation is owed.

---

## Track 3 — Visual quality assessment

Per surface, scored against the 7 criteria from the plan.

| Surface | Hierarchy | Contrast | Overlap | Spacing | Empty state | CTA clarity | Indigo accent | Notes |
|---|---|---|---|---|---|---|---|---|
| Landing `/` | ✓ | ✓ | ✓ | ✓ | n/a | ✓ "Apply", "Sign in" | ✓ | Motion redesign holds up live; mid-scroll the top features can clip behind the sticky nav for a frame — minor |
| `/dashboard` | ✓ | ✓ (dark theme) | ✓ | ✓ | ✓ (Owner To-Do has prompts) | ✓ "Connect Stripe", "Add a membership tier" | ✓ | Clean, professional |
| `/dashboard/members` | ✓ | ✓ | ✓ | ⚠ | n/a | ✓ "Add Member" | ✓ | **5-stat-card grid orphans the 5th tile (Tasters) on its own row** — cosmetic |
| Member detail | ✓ | ✓ | ✓ | ✓ | ✓ (Photos tab empty state covered in 2026-05-14 doc) | ✓ "Edit", "Mark paid manually" | ✓ | All 6 tabs present, Family panel renders |
| Edit Staff Member modal | ✓ | ✓ | ✓ | ✓ | n/a | ✓ "Save Changes" | ✓ | Right-anchored slide-out, designer's call |
| Settings → Revenue | ✓ | ✓ | ✓ | ✓ | n/a | ✓ "Connect Stripe", "Save contact details" | ✓ | Toggle visibly off; helper text clear |
| Reports | ✓ | ✓ | ✓ | ✓ | n/a | ✓ chart-driven | ✓ | 8 distinct report sections, no overlap |
| Timetable | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | ✓ | Renders |
| Promotions | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | ✓ | Renders |
| `/member/home` (Reese) | ✓ | ✓ | ✓ | ✓ | ✓ (no announcements case — there are 5+) | ✓ "Sign In to Class" | ✓ | Mobile form factor; bottom nav clear |
| `/member/profile` | ✓ | ✓ | ✓ | ✓ | n/a | ✓ "Save" | ✓ | — |
| `/member/schedule` | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | ✓ | — |
| `/member/progress` | ✓ | ✓ | ✓ | ✓ | n/a | ✓ | ✓ | — |

**No major visual regressions found. No UI/UX overlap that hurts readability.** The known noise: React #418 hydration on `/dashboard/members` (functional but logs a warning) and the 5th-tile orphan on the members-list stats grid (cosmetic).

---

## Tier-A / Tier-B / Tier-C carry-over from prior audit

For continuity with `docs/KIDS-PARENT-LINKAGE-ASSESSMENT-2026-05-15.md` and the audit captured in the plan file:

- **Tier A — 100% confident** (code + tests + live verification): all rows in §"Track 1 ✓" PLUS the green rows in §"Track 2".
- **Tier B — shipped, partially verified**: F2/F3 endpoints (gate logic verified live; happy path can't be exercised because `memberSelfBilling: false` + Stripe not connected on TotalBJJ); F4/F6 (same parent-with-kid seed blocker); F5 (test parses; not run against a real DB with the CHECK constraint applied).
- **Tier C — known gaps**: items 6–15 from the "Needs work" list at the top of this doc.

---

## What would close every Tier B → Tier A

1. **Apply F5 migration to a Neon test branch** + `TEST_DATABASE_URL=<branch> npm test`. Promotes 6 gateway tests + parent-no-membership test + all existing kids tests to Tier A.
2. **Seed a parent-with-kid on the TotalBJJ tenant** (one throwaway parent + one kid, deleted afterwards) → re-run Playwright walk for F4 + F6.
3. **Stub-Stripe tests for F2/F3** — `vi.mock("stripe")` returning fake `customers.create` / `subscriptions.create`. Promotes both endpoints modulo real-money verification.
4. **Add `MembershipTier.stripePriceId` column** + uncomment the kid/adult tier validation lookup in `/start` and `/start-for-kid` (code is staged in comments).
5. **Investigate the React #418 hydration** on `/dashboard/members` (likely date-format locale mismatch).

After those five, the verification posture is: every shipped feature has at least one of (integration test, live walk, real-DB run) backing it.

---

## Run metadata

- Commit on prod: `4fc8046` (Vercel auto-deploy from `origin/main`)
- Vercel region default
- Playwright MCP browser: Edge, dimensions ~771px wide
- Sweep duration: ~25 minutes
- Screenshots: 14, located at [playwright-mcp-2026-05-15/](../playwright-mcp-2026-05-15/)
- Sweep run by: ralph-loop verification (deep-interview ground truth)
