# NOTES-L6 — `tests/e2e/campaign/authorisation.spec.ts`

Browser-level proof for the nine role gates changed in `04aebe3`, `45bb92b`,
`158b846`. 33 tests. **Not run** — written for you to run.

```
npx playwright test tests/e2e/campaign/authorisation.spec.ts
```

It is collected by the existing **`chromium`** project (owner `storageState`,
`dependencies: ["setup"]`). No config change was needed: `testDir` is
`./tests/e2e` and nothing in `testIgnore` matches `campaign/**`. Verified with
`--list` (34 collected = 1 setup + 33).

`npx tsc --noEmit` and `npx eslint` are both clean on the file. (`tsc` reports
6 pre-existing errors in the generated `.next/dev/types/routes.d.ts`; none in
this file or anything it imports.)

---

## Preconditions the spec enforces rather than assumes

`test.beforeAll` throws with an actionable message if any of these is false,
rather than failing later as something that reads like a product bug:

- `owner@totalbjj.com`, `coach@totalbjj.com`, `admin@totalbjj.com` exist in the
  `totalbjj` tenant.
- **None of the three has `totpEnabled`.** The spec logs in with a password
  only; a TOTP step would hang `waitForURL`. It refuses rather than silently
  clearing someone's second factor on a shared branch.
- At least one `RankSystem` discipline has two undeleted grades (needed for
  promote-then-demote).

Login is `/login?club=totalbjj` → `input[type='email']` → `input[type='password']`
→ `button[type='submit']` → `waitForURL(/dashboard|member/)`, copied from
`tests/e2e/auth.setup.ts`. Password chain is the same one that file uses:
`E2E_BYPASS_TOKEN ?? TEST_PASSWORD ?? "password123"`.

`auth.ts:180` skips login rate-limiting only when `isTestingMode() && isLocalhost`.
Off a local/testing setup, ~3 logins per worker will start counting against
`login:ip:` (30 / 30 min).

---

## Every selector, and where it came from

| Selector | Source |
| --- | --- |
| `input[type='email']`, `input[type='password']`, `button[type='submit']` | `tests/e2e/auth.setup.ts:17-21` |
| `getByRole("heading", { level: 1, name: <member name> })` | `components/dashboard/MemberProfile.tsx:933` — `<h1 …>{member.name}</h1>` |
| `getByText("Two-factor authentication", { exact: true })` | `app/dashboard/members/[id]/page.tsx:357` — the card's `<p>` label |
| `getByRole("button", { name: "Reset 2FA" })` | `components/dashboard/MemberTotpResetButton.tsx:64-77` — plain `<button>`, text `{busy ? "Resetting…" : "Reset 2FA"}` |
| `getByRole("heading", { name: "Payment history" })` | `components/dashboard/PaymentsPageClient.tsx:274` `title="Payment history"` → `components/ui/page-header.tsx:37` `<h1>{title}</h1>` |
| `getByText("Couldn't load payments — tap to retry")` | `components/dashboard/PaymentsPageClient.tsx:228` — the literal string in the fetch `catch` |
| `getByRole("heading", { name: "Mark attendance" })` | `components/dashboard/AdminCheckin.tsx:327` — `<PageHeader title="Mark attendance" …>` |
| class-picker `getByRole("button", { name: /<class name>/ })` | `components/dashboard/AdminCheckin.tsx:404-420` — the `<button>` renders `{inst.name}`, which `app/dashboard/checkin/page.tsx:46` maps from `inst.class.name` |
| `getByLabel("Search members")` | `components/dashboard/AdminCheckin.tsx:457` — `aria-label="Search members"` |
| member-row `getByRole("button", { name: /<member name>/ })` | `components/dashboard/AdminCheckin.tsx:72-97` — `MemberRow` is a `<button>` containing `{member.name}` |
| `getByText("0 checked in" / "1 checked in", { exact: true })` | `components/dashboard/AdminCheckin.tsx:436` — `{checkedInCount} checked in`. `exact` because `"0 checked in"` is a substring of `"10 checked in"` |
| `getByText("Check-in failed")` | `components/dashboard/AdminCheckin.tsx:318` — `showToast("Check-in failed", "error")`; `components/ui/toast.tsx:54` renders `role="alert"` |

**Exact response bodies asserted** (not just status codes):

| String | Source |
| --- | --- |
| `"You do not have permission to do this."` | `lib/api-authz.ts:72` via `apiError`; body shape `{ ok:false, error }` per `lib/api-error.ts:150` |
| `"Forbidden: cross-origin request rejected"` | `lib/csrf.ts:90` |
| `"Class not found"` | `app/api/checkin/route.ts:101` — 404 on purpose, so a coach cannot probe which classes exist |

### Why `exact: true` on "Two-factor authentication"

`app/dashboard/layout.tsx:55` renders `Recommend2FABanner`, whose copy is
`"Two-factor authentication is recommended."` (`components/layout/Recommend2FABanner.tsx:38`).
A loose substring match would find that banner for **every** role and the
absence assertion would silently prove nothing. The card's `<p>` is exactly
`"Two-factor authentication"`, so `exact` separates them. The
`getByRole("button", { name: "Reset 2FA" })` assertion is the unambiguous one
and both are asserted.

Absence is asserted with `toHaveCount(0)`, not `toBeHidden()` — the server must
not render the card at all, not render it hidden.

---

## Two things that would have made every POST pass for the wrong reason

1. **Origin.** `lib/csrf.ts#assertSameOrigin` 403s any non-GET with neither
   `Origin` nor `Referer`. Playwright's `APIRequestContext` is not a browser and
   sends neither, so *every* POST here sets `Origin: <baseURL>` explicitly. Without
   it the role tests would all "pass" with a CSRF 403 and prove nothing about roles.
2. **Inherited owner cookies.** Whether `browser.newContext()` picks up the
   project's `use.storageState` has changed across Playwright versions. If it did,
   every "the coach is refused" test would run as the **owner**, log in fine, and
   fail on the assertion for an unrelated reason. `sessionFor()` calls
   `context.clearCookies()` immediately after creating the context, and passes
   `storageState: undefined`, so it cannot happen either way.

---

## Arranged state, and why it is arranged in SQL

- **Two classes differing in exactly one field** — `instructorId` is the coach
  vs the owner (`app/api/checkin/route.ts:92` narrows on `instructorId`, *not*
  `coachUserId`; both columns exist and only the former is consulted). A third,
  `register-taught-by-coach`, is reserved for the register-screen test so its
  `N checked in` counter is deterministic (0 → 1) however the file's tests are
  distributed across workers.
- **`ClassInstance.date`** is inserted as `($2::timestamptz AT TIME ZONE 'UTC')`
  from local noon today, *not* as a bare JS `Date`. The column is `timestamp(3)`
  without a zone; Prisma reads and writes it as a UTC wall clock, node-pg writes
  the **local** wall clock. On a UTC+8 machine the 8-hour difference is enough to
  put the row outside the app's own "today" window
  (`app/dashboard/checkin/page.tsx:27-29` builds that window from local midnight
  and lets Prisma convert), and the register test would fail with
  "No class instances are scheduled for today."
- **A member with `totpEnabled = true`** — the card is
  `totpRow?.totpEnabled && canResetTotp` (`app/dashboard/members/[id]/page.tsx:354`).
  Against a member without 2FA the card is absent for *every* role, so the
  coach assertion would pass while proving nothing.
- **A `manager` staff user** — see the gap below.

Per-worker isolation: `RUN_STAMP` is computed per module load, so each worker
already has its own; `SCOPE` appends `TEST_PARALLEL_INDEX` so two workers
booting in the same millisecond cannot collide on `User.@@unique([tenantId, email])`.

---

## Gaps — things this file does NOT prove

1. **There is no seeded `manager`, so the spec creates one.** A `User` row with
   `role='manager'` is inserted in `beforeAll`, reusing the **owner's
   `passwordHash`** so it signs in with exactly the credential the rest of the
   suite uses, and is deleted in `afterAll`. This bypasses whatever the real
   staff-invite flow does (seat limits, welcome email, audit row). The manager's
   *authorisation* is therefore proved; the manager's *provisioning* is not.
   Fixing the seed to include a manager would remove this caveat entirely and is
   the single highest-value change to `prisma/seed.ts` for this area.
2. **Change #8 (five CSRF guards): only `waiver/sign` has a positive control.**
   For `admin/dsar/erase`, `admin/import/[id]/commit`, `admin/import/[id]/preview`
   and `products` the spec proves the hostile-Origin 403 with the exact CSRF body,
   as the **owner** (who is authorised on all four) and with deliberately nonsense
   import ids — so it proves the guard runs before the role check and before the
   id is used. It does **not** prove those four still work with a good Origin.
   Adding that needs a valid import job and a real product payload; it was out of
   scope for a gate test and the route bodies would be doing the asserting.
3. **Change #7 is proved for `coach` only.** `STAFF_ROLES` also includes `admin`,
   and `admin` promote/demote is untested here. See finding (b) below — the UI
   and the API disagree for that role, so a test would have had to encode which
   of the two is correct, and that is a product decision, not a correctness one.
4. **Change #9 (`waiver-link` widened) is proved for `coach` and `admin`.**
   `manager` is untested; it was never in doubt (it was in the shadowed
   two-element list) but it is not proved.
5. **GET routes have no cross-origin dimension** — `assertSameOrigin` returns
   `null` for GET/HEAD/OPTIONS by design (`lib/csrf.ts:62`), so changes #2 and #3
   are proved on role alone.
6. **Only the staff-admin check-in path is covered.** `/api/checkin`'s member
   self-serve branch, the parent-checks-in-kid branch, the kiosk route and the
   `DELETE` verb are untouched by these nine changes and untouched here.
7. **The register test assumes the club has fewer than ~200 active members.**
   `app/api/checkin/members/route.ts:24` defaults to `take: 200` ordered by name;
   the test's member is named `Campaign Register…`. On a branch seeded with
   hundreds of members it would need the cursor or a name that sorts earlier.
8. **Timing on the payments page test.** It asserts the *browser's own*
   `GET /api/payments` response status via `page.waitForResponse`, so the
   "no error banner" assertion cannot race the fetch. If the page is ever changed
   to fetch a different path first, that matcher needs updating.

---

## Findings turned up while writing this (not part of the nine)

**(a) The check-in register still offers a coach classes they cannot check into.**
`app/dashboard/checkin/page.tsx:27-41` (`getTodayInstances`) filters on tenant and
date only — no instructor narrowing — and `app/api/checkin/members/route.ts:17`
admits all four staff roles for *any* instance in the tenant. So after `04aebe3`
a coach sees every class on today's timetable, can open the full roster of any of
them, clicks a member, and gets a `"Check-in failed"` toast. That is exactly the
"a control you can see and cannot use" defect the branch's own comments say it
set out to remove (`app/dashboard/members/[id]/page.tsx:348-353`), left standing
one screen over. **The spec asserts this current behaviour** (test: *"the register
screen shows the coach the refusal, and writes nothing"*), so if the picker is
later narrowed, that test will fail loudly and should be updated rather than
deleted — it is the marker for the follow-up.

**(b) `MemberProfile` hides promote from `admin`, but the API now allows it.**
`components/dashboard/MemberProfile.tsx:652` — `canPromote = ["owner","manager","coach"]`
— gates the "Assign / Promote" button, while `app/api/members/[id]/rank/route.ts:63`
is now `STAFF_ROLES` (all four). The inverse of (a): a permitted action with no
control. Change #7 made promote and demote symmetric with each other but left the
screen out of step with both.

**(c) `cleanupRun()` cannot delete a member who has ever been promoted.**
`RankHistory.memberRankId → MemberRank` is `ON DELETE RESTRICT` and
`tests/e2e/campaign/helpers/db.ts:174` deletes `MemberRank` without first deleting
`RankHistory`, so the whole cleanup throws a foreign-key error and leaves that
run's members behind — the exact accretion the helper's own header comment
(lines 152-160) says it exists to prevent. This spec works around it by deleting
`RankHistory` itself before calling `cleanupRun()`. **The bug is still in the
helper** and will bite the next spec that exercises grading. Worth a one-line fix
in `db.ts`.

**(d) This file cleans up more than `cleanupRun()` knows about.** `cleanupRun()`
only matches `Member` rows by email stamp. The classes, class instances,
attendance rows and the `manager` `User` this spec creates are removed by explicit
SQL in the same `afterAll`, each call `.catch(() => {})` so one failure cannot skip
`cleanupRun()` itself.
