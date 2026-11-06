# Activity timeline — the page, and a member's History — evidence (5 Nov 2026)

PR B2 of `.omc/plans/activity-timeline-plan-2026-11-05.md`, branch `feat/activity-timeline`, stacked on `feat/activity-feed-api` (PR #64, the server half) which is stacked on `feat/activity-deeplinks` (PR #63). With this PR the Activity page is the new timeline, managers can open it, and a member's page shows that member's History.

Synthetic data only, Neon test branch, isolated worktree without `.env`. No production query.

## Change (code under test `e23700c9`; the head adds this document)

| Commit | What |
|---|---|
| `9ef60720` | Shared primitives: `Input` (new); `Checkbox` accepts `"mixed"`; `DataTable` takes `sectionOf` (a heading before each run of rows); a text field and a field-like button grow to 44px on a touch screen (UI-RULES §5a line added in the same commit). |
| `03cbeebf` | `components/activity/`: the timeline (page and embedded variants), the sentence, the Activity types sheet, the member search, Jump to date, Undo, and the hook that loads pages; `lib/activity-url.ts` (the filters as they live in the address bar). |
| `ff2b114f` | `/dashboard/activity` renders the timeline for the owner and managers; the member page's "Details history" becomes "History" (owner and manager); Activity appears in a manager's menu; `GET /api/members` authorises through `requireApiStaff()`; the old `ActivityLog.tsx` is deleted. |
| `1e437f6a` | Pressed chips, the pressed day and a ticked box keep a dark edge, so they survive a white club accent. |
| `9fe7a437` | `docs/RULES.md` §5c (§5b before the mats rules took that number on merging main): the Activity rules as Noe decided them. |
| `3bb1b2e6` | Design-review fixes in shared primitives: Tab belongs to the top overlay when two are open; the staff shell's focus ring is the accent moved far enough to be seen (`--focus-ring`); the 44px rule applies to the `Input` primitive only; each `DataTable` section is its own row group. |
| `b08528cc` | Review fixes in the timeline (list under "Review findings"). |
| `fa246f40` | The line after a sentence does not repeat what the sentence said; stored words ("past_due") are shown as words ("Past due"). |
| `232507b5` | Re-check fixes: a day's rows keep their place (and the focus inside them) when a row arrives above; the member search cannot stick on "Searching…"; the focus ring is measured against the navigation's surface; the "Since here" dialog's title carries the date; a failed "Show older" has not paged. |
| `e23700c9` | After "Show older" the focus moves when the new rows are on the page, not a frame later (found by the phone journey). |
| `d0a1d003` · `2e9d84bf` · `5c793d7b` · `a8846d56` | The two browser journeys, and the harness helpers `seedStaff` / `staffSignIn`. |

Not changed: the schema (no migration), `GET /api/activity`'s contract, `GET /api/audit-log` and both undo routes (`git diff 7d05ee95 HEAD -- app/api/audit-log` is empty), what the audit log records, any permission other than those named above.

## The five questions (plan §2) — answered on a phone

`activity-five-questions.mjs`, 390 × 844, as the club's owner, on a fresh synthetic club: 9 PASS / 0 FAIL on `e23700c9`.

| Question | How it is answered | Taps |
|---|---|---|
| What happened in my club today? | Activity opens under a "Today" heading, newest first | 0 |
| What has this member done? | The member's page → History (check-ins, payment, edit); "See all activity" opens the timeline for them | 1 |
| Who changed this class, price or setting? | "Staff changes": the plan move, the class and the settings change, each naming the staff member | 1 |
| Who paid, failed to pay or cancelled? | "Money": the payment, the failed payment and the cancellation, with names and amounts | 1 |
| Tap any name and land on that exact record | A member → their page; a session → Attendance for that session; an amount → that member's Payments with the payment marked; a class → the timetable at that class | 1 each |

## Verification (commit each ran on)

| Check | Result | Commit |
|---|---|---|
| Browser — `run-journeys.mjs smoke activity-five-questions activity-timeline` (a fresh `mfv-` club per journey, each torn down to 0 rows) | smoke 11 PASS / 0 FAIL / 1 NOTE (the reference run's own measurement; it checks the harness); `activity-five-questions` 9 PASS / 0 FAIL; `activity-timeline` 20 PASS / 0 FAIL; no uncaught browser error; no wire fault in this run. Build stamped `e23700c9`, tree clean; three synthetic clubs created and torn down | `e23700c9` |
| Unit — the timeline's files (`activity-timeline-view`, `activity-feed-hook`, `activity-url`, `member-search-picker`, `ui-primitives-activity`, `overlay-stacked-focus`, `staff-focus-ring`) and the feed's (`activity-feed-entry`, `activity-api`, `activity-feed-lookups`, `activity-feed-where`, `activity-types`) | 273 / 273 in twelve files (all also inside the full suite) | `e23700c9` |
| Full unit suite (`npm test`) | 625 files passed, 0 failed, 115 skipped · 8,754 tests passed, 0 failed, 836 skipped, 3 todo. The skipped files are the database suites, which need a test-branch URL this run does not have; skipped is not passed (six of them were run separately, next row) | `e23700c9` |
| Database, both roles — `sec-b-role-matrix-db`, `member-population-parity`, `activity-feed-db`, `sec-a-revocation-fail-closed-db`, `sec-a2-outage-handlers-db`, `attribution-tenant-scope-db` (the files that call `GET /api/members`, whose gate changed, plus the feed's own) | All six pass as the owner role and as `matflow_app`: `activity-feed-db` 12 / 12, `member-population-parity` 10 / 10, `sec-b-role-matrix-db` 59 / 59, the other three 17 / 17 together. A first attempt at three files in one batch ran past the harness's ten-minute limit in both roles (the test branch was slow: about five minutes a role for the feed's file alone), which is a failed gate, not a pass; the three were then run one at a time, each inside the limit | `e23700c9` |
| Type check · `npm run lint` (eslint + UI-RULES ratchet) | 0 · passed, every ratchet at baseline | `e23700c9` |
| Production build (`server.mjs build`, no database URL) | exit 0, tree clean | `e23700c9` |
| Independent reviews (Opus, read-only) | Two on `d0a1d003` — design rules and accessibility: REJECT, 3 blockers; behaviour and access: REJECT, 2 blockers. All five fixed. A third reviewer re-checked the fixes: APPROVE WITH NITS, no blocker, every earlier blocker closed; four small should-fix items, all fixed in `232507b5`. That commit and `e23700c9` (the focus fix the phone journey led to) have not themselves been re-reviewed | `d0a1d003`, then `5c793d7b` |
| Secret scan (GitGuardian, on the PR) | Flagged one "generic password" in `d0a1d003`: the line in the journey harness that makes a random password, at run time, for a synthetic fixture user (`.claude/skills/matflow-verify-browser/scripts/lib.mjs`). No credential is or was in the repository. The line now uses the form the fixture owner's already used (fixed the same way on `main` in `3bd8da37`); a manager and a coach made by it were signed in through the real form afterwards. The finding stays against the old commit until it is marked a false positive in GitGuardian, which is Noe's to do | fix after `e23700c9` |
| CI | see the PR | head |

### What the timeline journey holds (`activity-timeline.mjs`, 1440 px unless said)

- **Default view**: a Today heading; sentences whose names link to the member and the session; club settings and staff accounts left out; exactly 50 rows; no raw id or code word in the table; the table in a white card; each day the header of its own rows.
- **Activity types**, by keyboard: Escape and Cancel discard the ticks; nothing can be applied with nothing ticked; Space ticks a whole group; one request for the whole visit to the sheet.
- **Member**: found by part of an email address with the arrow keys and Enter; named at once; only the id reaches the address; focus moves to the clear button, and back to the field on clear; the filter card keeps its height; Back from the profile returns to the same rows.
- **Plan** and **Done by**; **Reset filters**.
- **Jump to date**: Yesterday, Previous day, a typed date, Next day; "Show older" loads the rest and moves focus to the first new row.
- **Views**: Money is payments, failures and cancellations; "Show all activity types" widens the types only.
- **A staff name** in a row filters to that person without leaving the page.
- **Undo** (owner): "Since here" is offered only on Everything with no filter, and lists what it would put back; a row that cannot be undone says why from the keyboard; undoing a phone edit restores the number in the database, strikes the row through in place, and the undo appears as its own row.
- **Failures**: a failed first load is an error with a retry that sends one request, never an empty list; an answer to an old filter that arrives six seconds late does not replace the new filter's rows; a failed "Show older" keeps the 50 rows and can be retried; when names cannot be loaded the plain log is shown with a notice.
- **Links**: a filter that matches nothing says so and offers two ways out; a type that no longer exists is left out, said, and never sent; an id that is not a member is "Removed member"; `?day=abc&memberId=a%20b` is the unfiltered page.
- **Copy link** writes the view out; **Make this my default** is read before the first request (one request on reload), is not inherited by a manager signing in on the same browser, and can be dropped.
- **A manager**: the page opens; no Undo anywhere; the owner's "Everything" link shows no settings, staff-account or undo rows; asking for owner-only types by name sends only the permitted ones and says so; the sheet lists none of them; an edit shows "Fields: Phone", never the numbers; a plan's name is not a link; the API's answer has no `undo`, no owner-only type and none of the old values; both undo routes answer 403 to a same-origin request with the permission message; every link in the table opens for a manager (each followed in the browser until the page that finally renders), and the same check is shown to see a refusal on a page managers may not open.
- **A coach**: no Activity in the menu; the page sends them to `/dashboard?denied=1`; the API answers 403; a member's page has no History.
- **Widths**: no sideways scroll at 1440, 1280 and 1024; the four filters are one height; Undo sits inside the table's card.
- **Accents** `#ffffff`, `#ffe14d`, `#111111` (applied as the owner's browser applies a branding change): the pressed view is told from the others at 3:1 or better against the card; its label is 4.5:1 on its fill; the keyboard focus ring is 3:1 or better (measured once the ring has settled: 3.95:1 on white, 3.58:1 on the yellow, 18.9:1 on the near-black, against the card); a ticked box keeps its hairline.
- **Club time**: a browser set to Asia/Makassar shows the club's times and the club's "Today", with the line "Times are shown in club time (Europe/London)."
- **A member's History**: 20 cards, the payment and the check-ins among them, no button and no table; "See all activity" opens the page for them.
- **Phone** (390 × 844): cards under a Today heading; a 77-character class name wraps; every link in the first ten cards can be tapped; the Filters sheet applies "Done by" and holds Copy link; the Activity types sheet opens on top of it and Tab reaches the tick boxes; "Show older" moves focus into the first new card; no sideways scroll.

## Review findings and what was done

**Design rules and accessibility** — blockers: the touch-screen height rule also grew the member profile's fields (scoped to the `Input` primitive); with the Activity types sheet open on top of the Filters sheet, Tab never left its first control (the focus trap now belongs to the top overlay; this also fixes any confirm opened from a sheet); the focus ring was invisible on a white or yellow accent (see "For Noe to veto" 1). Should-fix, done: the table sits in a card; on a phone the filter card is Jump to date and Filters, with Copy link and the default view inside the sheet; focus after "Show older" reaches the row that is on screen; the member search keeps the picked name, hands focus across the pick and the clear, has only options in its listbox and one spoken status, and Enter retries a failed search; button names start with the words on them; day headings are headers of their own row groups, white with a rule, and an `h2` on a phone; 36px tick rows only with a mouse; "Show all activity types" is no longer also called "Show everything"; the undo dialog's title says since when, with its date. Not done, recorded: the "by MatFlow support" explanation is a tooltip only; the default-view button changes width between its two labels; view chips' touch areas overlap by 4px when the row wraps; the "What happened" column is narrow in the owner's table between 640 and 767 px; an unticked box's border is 1.6:1 (the existing primitive).

**Behaviour and access** — blockers: the two notes about a link's types could never appear, because the page drops such keys before asking (the page now says it from its own reading of the link); a journey asserted the wrong first card. Should-fix, done: a late "Since here" answer cannot reopen a closed dialog or replace another row's; "Show older" waits for any request and is not cancelled by a refresh or a return to the tab; a background refresh that fails leaves the rows; a malformed day or id is not a filter; a refused undo (409) stops being offered and says why; the two journey checks that could not fail for the reason they claimed (the undo 403s, the manager's links) now can; the missing member-search tests and a strike-through test that does not depend on the reload. Not done, recorded: the embedded history's error state has no "See all activity" link; `?day=<today>` counts as a filter; "n more loaded" stays in the spoken status after a later refresh; a default saved in another tab is picked up on the next render, not live.

## For Noe to veto (each is one line to change)

1. **The focus ring follows the accent only as far as it can be seen.** The ring was the club's raw accent, so a white or pale accent drew none. It is now the accent darkened until it reaches 3:1 on the dashboard's darkest surface, the navigation (white becomes mid-grey, the yellow becomes olive); an accent that already shows — the default blue, any dark colour — is unchanged. This applies to the whole staff dashboard, not only Activity. Until the next page load after a branding change in Settings, the ring is still the previous accent's.
2. **"Activity for {name}" and an "Open profile" button** appear when the page is filtered to one member. The plan's title is "Activity" throughout.
3. **"Show all activity types"** is the plan's "Show everything" in the summary line, renamed because the empty state's "Show everything" also clears the member, class, plan and staff.
4. **On a phone, Copy link and "Make this my default" are inside the Filters sheet**, so the card is two controls as the plan asks.
5. **The line after a sentence leaves out what the sentence said** (no "· Status: Active → Cancelled" after "cancelled Melody's membership"). The full list of changed fields is still in the response for the row-details sheet (PR D).
6. **Day headings in the table are a white band**, not the grey the plan gave (grey read as one more striped row), and `scope="rowgroup"` not `colgroup`.

## What the browser runs found that the unit tests had not

The journeys were run four times while they and the fixes settled. They found: assertions of mine made against the loading skeleton and against controls that had not hydrated (journey faults); the two "types left out" notes that could never show (also found by review); the accent check passing without the accent having changed, because the club colour travels in the session; detail lines repeating their sentences; and focus not moving after "Show older" on a phone. Twice a request failed on the wire between the test browser and the local TLS proxy (once a timeline request, once a navigation, `net::ERR_TOO_MANY_RETRIES`, the second while other tests were running on the same machine). The page showed "Couldn't reach MatFlow. Check your connection and try again." with its retry, which is the right behaviour; the cause on the test rig was not established. The journeys now retry such a fault once and report it as a NOTE rather than fail on it or hide it. The final run on `e23700c9` had none.

## Carried to later PRs

- "Created a class" (and other rows with nothing to restore) say "Recorded before snapshots were kept, so the previous values aren't known" as their reason for no Undo. That is the undo registry's general reason and is wrong for a creation; PR C adds reasons to that registry and should give creations their own.
- The row-details sheet, the class sheet's History and a payment's History are PR D.
- `components/dashboard/SettingsPage.tsx` applies a new accent at once but not the new focus ring (item 1 above).
- Screenshots were taken of the default view at 1440, 1280, 1024 and 390, and of the picker, the empty, error and degraded states, the undone row, the manager's view and the member History at 1440, the Filters and Activity types sheets at 390, and the three accents at 1440. The plan asked for every state at every width; the layout assertions (no sideways scroll, one height, Undo inside the card) ran at all four widths, the state screenshots did not.

## Not verified

Production; real club data and volumes; Safari and Firefox (the journeys run in Chromium); a real screen reader (roles, names and focus were asserted, speech was not heard); the first 25 minutes after the club's midnight (the seeded "today" rows would fall under Yesterday; the journeys are not run then).
