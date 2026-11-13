# Round 6 — timetable, bookings and check-in (13 Nov 2026)

Branch `programme/rounds`, baseline `ddf9a53f` (main `fa28bb41` merged in). Local only: not pushed, not merged, not
deployed. Brief: the programme brief's Round 6 ("Sean's missing class"; "Preserve invariants"). Synthetic data only.

## Release state

| | State |
|---|---|
| Implemented | yes, local commits on `programme/rounds` (below) |
| Independently reviewed | merge resolutions: APPROVE WITH NITS; Round 6 commits: APPROVE WITH NITS, re-review of the follow-up: APPROVE WITH NITS. Findings fixed or accepted (Review follow-up, below) |
| Tested locally | see Verification |
| Pushed / merged / deployed | no |
| Activated / configured for Sean | not applicable; nothing here touches category activation or Sean's records |

## Findings

### R6-1 — the staff timetable's "today" followed the browser's clock (FIXED)
- **Screen:** staff timetable (`/dashboard/timetable`), week grid, Day view and phone day picker.
- **Expected, and its authority:** "today" is the club's day. `/api/coach/today` and check-in already use it
  (`todayWindow`, `Tenant.timezone`); Round 3 moved reports and the dashboard to the club's zone and logged this screen
  as the remaining browser-clock item (`docs/METRICS.md`).
- **Reproduction:** `tests/unit/timetable-club-zone.test.tsx`, browser in Bali (`TZ=Asia/Makassar`), London club,
  frozen instants. On the unfixed code 4 of 5 cases failed: the Today marker on the browser's Saturday 14 / Monday 16
  instead of the club's Friday 13 / Sunday 15; the club's cancellation of Friday's 19:00 drawn on Saturday's 19:00; a
  01:00 session during London's clock change read "ended" instead of live.
- **Root cause:** `getWeekDates`, `todayMidnight`, the Today button, the initial Day-view day and `chipStatesFor`'s
  minutes read the device clock, while `cancelledToday` comes from the server's club-day read. Mixed clocks.
- **Fix:** `54d93b1b`. `clubWallClock(now, timeZone)` (`lib/class-time.ts`, same arithmetic as `todayWindow`); every
  "today" in `TimetableManager` goes through it; the page passes the club's zone. Without the prop the device zone is
  used, as before (tests only; the page always passes it). Server and browser now render the same day.
- **Verification:** the unit file (club midnight, both London clock changes, agreement with `todayWindow` over six
  zones from UTC-11 to UTC+14 hourly for two weeks); journey `timetable-club-zone` (real Bali browser, club zone chosen
  so the dates differ, real cancel route, desktop, phone, keyboard).
- **Limitation:** the member schedule still uses the member's device date (`app/member/schedule/page.tsx`). A member
  whose phone is in another zone sees their own today. Deliberate for this round: members are normally at the club.
  Also unchanged: an overnight session is not shown as live after the club's midnight (its column is no longer today).

### R6-2 — a booking whose reply was lost was reported as failed (FIXED)
- **Screen:** member schedule (`/member/schedule`), the class sheet's booking button.
- **Expected, and its authority:** the brief's "retry wording does not promise success" and Round 4's lost-reply
  rules: the page must not state the opposite of what the server holds.
- **Reproduction:** `tests/unit/member-schedule-lost-reply.test.tsx`. On the unfixed page, a booking that committed but
  whose reply was lost was rolled back to "not booked" with "Couldn't book this class — please try again"; the same for
  an un-booking.
- **Root cause:** a thrown fetch or 5xx was treated as a refusal.
- **Fix:** `4c43459d`, then review follow-up (below). An unknown outcome re-reads `/api/member/me/subscriptions` and
  shows this class as the server holds it. It says the change did not happen only after a server error (which rolled
  back); with no reply the request may still land, so it says "Couldn't confirm the booking. Reload to see whether it
  went through." With no re-read either, the button shows the last known state and the same "couldn't confirm".
- **Verification:** the unit file (6 cases, incl. another class's booking in flight); journey
  `member-booking-lost-reply` (real request reaches the server, reply dropped by the browser; database checked).
- **Limitation:** a booking recovered by the re-read does not show the allowance notice ("period already used"); the
  door still applies the allowance.

### R6-3 — the class edit audit row listed `baseRosterIds` as a changed field (FIXED)
- **Screen:** Activity (class edits). **Fix:** `0bb9fd83`. **Verification:** `round4-class-edits-db` new case fails
  without it (`['baseRosterIds', 'maxCapacity']`). Found by the merge review; pre-existing from Round 4.

### Sean's missing Monday/Tuesday class — NOT CONFIRMED
No condition in the brief's list reproduces a class disappearing from the staff grid on the current code. A browser's
zone cannot move a slot (placement is by `dayOfWeek`); R6-1 changed which day is marked today, not where classes sit.
The earlier causes (stale view #58, one-chip collapse #59, stale tab deleting a day #62) were each reproduced and fixed,
but none was reproduced as Sean's case. Minimum missing evidence: which class and day Sean expected, when he looked,
that class's active timetable slots and lifecycle, and whether "My classes" was on. Reading his club is an owner action.

## Conditions checked (brief list)

| Condition | Result |
|---|---|
| Fresh load; mounted page receiving new data; active/inactive snapshots | covered by #58 and journeys, re-run on `ddf9a53f` |
| Selected week | R6-1 |
| Filters | "My classes" persists per browser and is shown on screen; not a defect |
| Multi-day vs separate classes | covered by #59 and journeys |
| Effective dates | neither view hides a slot by its dates; no screen sends an end date (the class APIs accept `schedules[].endDate`) |
| Cancellations | never hide a class; today's now lands on the club's day (R6-1) |
| Paused / archived | covered by `classes-lifecycle` |
| Overnight | one rule shared with the door; on its start day |
| Timezone boundaries | R6-1 (staff); member schedule limitation above |
| Squad classes (members) | hidden from a member not on the list and not booked, by design |

## Bookings and check-in

New real-concurrency database cases (`tests/integration/round6-bookings-checkin-db.test.ts`, both roles): two members
booking the last place (3 rounds: one booked, one "full", one row; removing the booking route's `FOR UPDATE` makes it
fail with both booked); one member's double submit (one row); a retry after a lost reply on a class it filled (still
booked, no second place); a booking kept after its member lost eligibility still holds its place under the interim
capacity rule, is explained to the member with the door's sentence and has its durable `class.bookings.kept_ineligible`
row; two check-ins for the last place of a session (3 rounds, one attendance row); a booking racing a pause (5 rounds).

Existing evidence relied on, unchanged code: booking preservation (`booking-preservation-db`), the five check-in doors
across clubs, allowance, packs, hold, kids and revoked cards (`sec-pre-resend-checkin-doors-db`), card scans
(`card-scan-concurrency-db`, `card-scan-retry-db`), allowance races (`checkin-allowance-race-db`), parent check-in.

Recorded, not changed: a check-in whose statement ran just before a session's cancellation commits is admitted (the
cancel route does not take the Class lock, `lib/checkin.ts`). That outcome equals the order "check-in, then cancel",
which the product allows. Booking creation writes no audit row (a member's own action; existing design).

## Merge review of `ddf9a53f` (two hand-resolved saves)

Independent review: APPROVE WITH NITS, no merge-introduced defect; tenant scope, support restrictions, category
safeguards, `expected` checks, changed-field saves, logo ownership, lock order and booking rules preserved. Findings 1
and 2 fixed in `0bb9fd83`. Deferred: no Reload button on a category 409 (its text says to reload); the settings logo
ownership check runs before the write lock (not reachable from the app's form, which sends `expected` for every changed
field); the class field list is written in two places.

## Test database

The first run of `class-categories-b-stale-editors-db` on `ddf9a53f` failed under both roles: the shared test branch
had never had Release B's stale-writer migration applied. The same failure on main's code; applied with the guarded
tool; the rerun passed. Before the Round 6 database runs the migration's recorded checksum and the live function body
were checked against the repository, and each run's role recorded (`neondb_owner`, `matflow_app`).

## Performance

The timetable page adds one small tenant read inside its existing parallel reads; the member schedule adds one request
only when a booking's outcome is unknown. Existing class-save round trips are recorded in the programme's Round 8
backlog. Timings on the test branch are not production timings.

## Review follow-up

The independent review of the Round 6 commits found one MEDIUM: after a lost reply the re-read replaced the whole set
of booked classes, so another class's booking still in flight was shown as not booked. Fixed in `1ba90574` (this class
only), with a unit case that fails on `4c43459d`; so is the case where a reply never came and the re-read showed
nothing (now "couldn't confirm", since the request may still land). Accepted and not changed:
- with no reply and no re-read either, the button returns to its last known state (UI-RULES §7) under a "couldn't
  confirm … reload" message;
- a booking recovered by the re-read shows no allowance notice (R6-2 limitation);
- the timetable page's zone read is one more small read beside the seven it already runs in parallel against a pool
  of five per instance (recorded in the Round 8 backlog);
- an overnight session is not shown live after the club's midnight (R6-1 limitation);
- two quick taps on the same class while its first request hangs can leave the button showing the opposite of the
  server until reload (no in-flight guard on the button; existed before Round 6). Recorded for the UI round.

## Close-out (13 Nov 2026, after the owner's review instruction)

### Deferrals resolved

| Item | Severity | User impact | Disposition | Destination |
|---|---|---|---|---|
| Member home check-in on the phone's date | **High (behavioural)** | The member home (where members check themselves in) asked for sessions on the UTC date and listed the device's weekday. Where those differ from the club's day (a club east of UTC every morning before UTC midnight; London 00:00–01:00 in summer) a self check-in went to another date's session and the door refused it, or the app wrongly said the session "may have been cancelled". No wrong attendance could be written: the door judges its own window. | **Fixed** `679dd9a5`: the home read pairs sessions with the club's today and returns it; the page lists that weekday. Reproduced first (real route, both roles; page test) | done |
| Member schedule page on the phone's date | Low (presentation) | The schedule page's Today marker, Live/Next and the day's Cancelled flag follow the phone. Bookings there are standing per class, and its session id is not used for any action, so no one can book or check in to the wrong session from it. | Deferred | Round 11 (visual quality) |
| Overnight session after the club's midnight | Medium (behavioural, narrow) | The door admits a session past midnight (its window runs to the end plus the grace), but after the club's midnight the member home lists only the new day, so a member arriving late to a running overnight session cannot check in from the app; the desk, coach register and scanner can. The staff grid also stops showing it live (presentation). | **Explicit blocker, not fixed**: listing the previous day's still-open sessions on the member home is a change to what "today's classes" means to a member, so it needs the owner's choice of wording and placement. No eligibility or window rule changes either way. | Owner choice, then Round 11 |
| Two quick taps on one booking button | Medium (behavioural) | A second tap while the first request or its re-read was out could, with the lost-reply recovery, leave the button showing the opposite of the server once both settled. | **Fixed** `bf1cdd78`: one request per class at a time (button disabled and busy until it settles). Fails on the previous page | done |
| Recovered booking without its allowance notice | Low (information) | After a lost reply, a booking found by the re-read showed no "period already used" notice. | **Fixed** `bf1cdd78`: a read-only `GET` on the booking route returns the same notice through the same code (`bookingAllowance`, `allowanceBookingNotice`); no rule changed. Both database roles | done |
| No Reload button on a category refusal | Low (usability) | The refusal says "Reload the page"; an installed app has no reload control, so recovery meant closing the app. | **Fixed** `4d0902f0` (one condition). | done |

### Merge-review findings, by name

1. **Audit fields listed `baseRosterIds`** (Round 4 origin): fixed `0bb9fd83`.
2. **No test for one save with `expected` and `categoryBaseId`**: test added `0bb9fd83`.
3. **No Reload button on a category 409**: fixed `4d0902f0` (above).
4. **Settings logo ownership checked before the write lock** (`app/api/settings/route.ts`): non-blocking. The race needs a
   save that re-sends the stored logo without `expected.logoUrl` while another save changes it; the app's settings form
   sends only changed fields, each with its `expected` value, so only a hand-made owner request can do it, and then it
   can only re-write a logo the club already owns. Recorded for Round 9 hardening.
5. **Class field list written in two places** (`CLASS_PRECONDITION_FIELDS` in the route, `CLASS_EDIT_FIELDS` in the
   form): non-blocking. Both lists are equal today and the server refuses an `expected` for any field outside its own
   list (400), so drift fails loudly rather than silently. Recorded as maintenance.

### Journeys (all fixtures torn down: nothing left behind in any run)

| Journey | Tested commit | Result |
|---|---|---|
| timetable-sessions, timetable-multiday, timetable-lost-update, classes-lifecycle, class-colours, class-categories-b, member-booking-notice | `824b93ba` | 7/0, 11/0, 6/0, 56/0, 13/0, 16/0, 8/0 |
| member-booking-lost-reply | `824b93ba` (failed 5/2, journey waits), `0665ab5d` | 7/0 |
| timetable-club-zone | `824b93ba`, `0665ab5d`, `67934ed7` (journey faults), `a9cd5b9c` | 6/0 |

Equivalence: application code is identical at `1ba90574`, `824b93ba`, `0665ab5d`, `67934ed7` and `a9cd5b9c` (the
commits between them change tests, journeys and documentation only). The close-out commits change application code,
so the affected journeys and gates are re-run on the close-out head (below).

## Verification

All on `programme/rounds`. Application code is final at `1ba90574`; later commits change tests, journeys and
documentation only (`64e1269c`'s DB test file, `824b93ba` two unit mocks, `0665ab5d`/`67934ed7`/`a9cd5b9c` journeys).

| Check | Commit | Result |
|---|---|---|
| Type check | `f18df70e` | 0 errors |
| Lint (eslint + UI-RULES ratchet) | `f18df70e` | passed, ratchet at or below baseline |
| Full unit suite | `f18df70e` | **3 failed** in 2 files: page mocks without `tenant` (cause: R6-1 adds the tenant read). Fixed in `824b93ba` |
| Full unit suite | `824b93ba` | 9,673 passed, 0 failed, 1,053 skipped (database files without a URL), 3 todo |
| Production build | `824b93ba`, `0665ab5d`, `67934ed7`, `a9cd5b9c` | clean, each a build of that commit |
| Database suites, `neondb_owner` and `matflow_app` | `f18df70e` (integration files identical at the final head) | round6-bookings-checkin 6/6, round4-class-edits 13/13, class-categories-b-stale-editors 13/13, booking-preservation 8/8, sec-pre-resend-checkin-doors 27/27, each under both roles |
| Journeys (`CLASS_CATEGORY_MANAGEMENT=on`) | `824b93ba` | timetable-sessions 7/0, timetable-multiday 11/0, timetable-lost-update 6/0, classes-lifecycle 56/0, class-colours 13/0, class-categories-b 16/0, member-booking-notice 8/0 |
| Journey member-booking-lost-reply | `824b93ba` | **5/2 failed**: fixed 3 s waits read the screen before the page's re-read had returned. Journey fixed in `0665ab5d` |
| Journey member-booking-lost-reply | `0665ab5d` | 7/0; every re-read answered 200 |
| Journey timetable-club-zone | `824b93ba`, `0665ab5d`, `67934ed7` | **failed**: a fixture field name, then waiting for week navigation before any class existed, then checking the Cancelled chip before the page's today read had returned. Journey fixed each time |
| Journey timetable-club-zone | `a9cd5b9c` | 6/0, Bali browser, club in Pago Pago (club Thursday 12, browser Friday 13): Today marker, week, cancellation on the club's day, Monday/Tuesday and overnight placement, keyboard week navigation, phone, no hydration error. The page's `/api/coach/today` took 16 s on the test branch from Bali (not a production timing) |

A first journey run on `824b93ba` was refused by the harness because the unit suite's processes were running; it was
re-run afterwards, not overridden.

Behavioural checks against the defect restored:
- unfixed timetable: 4 of 5 component cases fail;
- unfixed member schedule: 3 of 4 lost-reply cases fail; `4c43459d`'s page: 2 of the 6 later cases fail (also
  reproduced by the reviewer);
- route audit filter reverted: `round4-class-edits-db`'s new case fails with `['baseRosterIds', 'maxCapacity']`
  (owner role, 13 Nov);
- booking route without `FOR UPDATE`: the last-place case fails with both members booked (`[201, 201]`, owner role,
  13 Nov; the route was restored from git).
