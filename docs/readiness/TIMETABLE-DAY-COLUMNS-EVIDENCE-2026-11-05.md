# Timetable Day view, phone and members' day (PR 3 of 3) — evidence (5–6 Nov 2026)

The split chosen in PR 2 now applies to every screen: the staff Day view draws one column per mat on its clock scale, the staff phone's day and the members' day become one day of the poster grid (mat columns while the day needs three side-by-side columns or fewer, otherwise by time with a sentence saying so), and "+N more" opens every class of a clash over the grid. Stacked on PR 2. Plan: `.omc/plans/timetable-side-by-side-plan-2026-11-05.md` §4.11–§4.13.

Synthetic data only, Neon test branch, isolated worktree. No production query, no change to any real club.

## 1. What changed

| Behaviour | Files |
|---|---|
| `GET /api/member/timetable`: the split in effect and the club's mats (ids and names only), no-store, the caller's own club only; the demo club is by time; member schedule and member home carry each class's `matId` | `app/api/member/timetable/route.ts`, `app/api/member/schedule/route.ts`, `lib/member-home.ts` |
| The staff Day view by mat: one column per mat (the week's column rule, `matColumns`), mat names and hours pinned in its own scroll box, several classes on one mat split that column and fold beyond three in it, lanes at least 120 px, each block's name ends with its mat | `components/schedule/DayGrid.tsx`, `lib/timetable-grid.ts` |
| The staff phone's day: one card holding the one-day poster grid; every chip says its place; one or two lanes use the larger phone chip; "+N more" opens a panel over the grid (Escape and Show fewer give focus back; it closes on another day); the day tabs mark selected and today without the club colour | `components/dashboard/TimetableManager.tsx`, `components/schedule/PosterGrid.tsx` (`PosterDay`), `components/schedule/MorePanel.tsx`, `components/schedule/WeekChip.tsx` |
| The split control on the Week view, the Day view and the phone, worded for the whole club | `components/dashboard/TimetableManager.tsx`, `components/dashboard/MatsSheet.tsx` |
| The members' day on the poster grid: time first, the name in full, pills, then the place where it tells classes apart and the coach under a mat name; mat names pinned on the shell's opaque colour; drawn once both the classes and the layout are in; by time if the layout cannot be read; scrolls to the live or next class (also when it is folded into "+N more") without moving focus; side panes inert; an ended class paler, a booked ended class greyed; the red now-line gone | `app/member/schedule/page.tsx`, `app/member/layout.tsx` (`--member-bg`), `app/globals.css` |
| The members' schedule takes the height of the layout's content area, so the end of the day stays above the tab bar while the two-factor banner shows (it ran under the tab bar before; the unused `--member-header-clearance` is removed) | `app/member/schedule/page.tsx`, `app/globals.css`, `app/member/layout.tsx` |
| The old phone list (`ClassChip`, `DaySessions`, `groupSessions`, `groupLabel`) deleted; the raw-button ratchet 336 → 332 | `components/dashboard/TimetableManager.tsx`, `scripts/check-ui-rules.mjs` |
| Rules | `docs/RULES.md` §5b, `docs/UI-RULES.md` §4a.8 |
| Harness: `gridInvariants` for one-day grids, `memberLogin`, `memberSignIn`, `structureDiff`; week lookups in two journeys scoped to the week grid (the phone's hidden day grid comes first in the page) | `.claude/skills/matflow-verify-browser/scripts/` |

No schema change, no migration.

## 2. The six acceptance checks (plan §2), from one build

| # | Check | Result | Proved in |
|---|---|---|---|
| 1 | By mat: every class in its own mat's column, rows lined up by time across the week | PASS | `timetable-mats` (by-mat), `timetable-day-columns` (day-view, phone, member) |
| 2 | By time: overlapping classes side by side, a class on its own full width | PASS | `timetable-week-grid` (invariants), `timetable-overload` |
| 3 | Nothing hidden: more than three at once shows two plus "+N more", which shows every one | PASS | `timetable-week-grid-stress` (desktop), `timetable-day-columns` "more" (staff phone and members, all five listed) |
| 4 | PC: at 1440 px six days of two mats fit with no sideways scrolling | PASS | `timetable-week-grid` and `timetable-mats` (14 px to spare with scrollbars on show) |
| 5 | Phone: one day shows its mat columns with no sideways scrolling | PASS | `timetable-day-columns` phone-staff-375/390 and member-dark/light-375/390 |
| 6 | The choice: one tap for an owner or manager, and everyone, members included, sees it | PASS | `timetable-mats` choice, `timetable-day-columns` everyone-sees-it |

## 3. Gates

| Gate | Result | Commit |
|---|---|---|
| `npm run lint` (eslint and the UI-rules ratchet: raw buttons 332, hex literals 707, both at baseline) | pass | b60afb3e |
| `tsc --noEmit` | pass | b60afb3e |
| Full unit suite | 622 files passed, 116 skipped (database files without a test URL), 0 failed; 8,754 tests passed | 81a2a250 |
| Every unit file that renders the members' schedule (6 files) | 50 passed | b60afb3e |
| `member-timetable-db` as owner and as `matflow_app` | 2 of 2 each | debd6873 |
| Production build | exit 0, tree clean | 412146b5 |

Commits after b60afb3e change only the browser harness (`.claude/skills/matflow-verify-browser/scripts/`), which no unit test reads.

## 4. Browser journeys

Build of 412146b5, Chromium, test branch. Run `rmw48rmy1034553` (6 Nov, 00:31 to 01:30) ran the first ten; the test database then stalled (three class creates refused with 503, a teardown transaction took 157 s against a 60 s limit) and the run stopped before the last three. The leftover fixture was torn down by hand to 0 rows. Run `rmw4br3ky2a51a6` (01:57 to 02:24, a rebuild of the same commit) ran the last three. Every fixture was torn down to 0 rows.

| Journey | PASS | FAIL | NOTE |
|---|---|---|---|
| timetable-day-columns | 13 | 0 | 2 |
| timetable-day-columns-three-mats | 10 | 0 | 0 |
| smoke | 11 | 0 | 1 |
| timetable-week-grid | 16 | 0 | 2 |
| timetable-week-grid-stress | 11 | 0 | 1 |
| timetable-overload | 8 | 0 | 0 |
| timetable-sessions | 7 | 0 | 0 |
| timetable-multiday | 11 | 0 | 1 |
| timetable-lost-update | 6 | 0 | 0 |
| timetable-day-view | 9 | 0 | 0 |
| timetable-mats | 13 | 0 | 3 |
| member-booking-notice | 8 | 0 | 1 |
| classes-lifecycle | 56 | 0 | 4 |
| **Total** | **179** | **0** | **15** |

Measured on the members' day: the last class ends 41 px above the tab bar (731 against 772) at 375 and 390 px on both shells; the mat names stay on top on an opaque band; contrast of mat names, time labels, break rows, unbooked block text, "+N more" and panel rows at least 6.5:1 on the dark and light shells under accents #ffffff, #ffe14d and #111111.

Earlier runs on this branch (rehearsals on debd6873 and b60afb3e, and a subset on d969efd2) found the defects in section 6; their failures are not counted above.

## 5. Independent review (Opus, of debd6873): approve with changes

| # | Finding | Outcome |
|---|---|---|
| 1 | BLOCKER: the hex-literal ratchet read 709 against 707 (a comment quoting two colours) | Fixed in e587c457 |
| 2 | On Safari a tap on a "+N more" row closed the panel before the tap landed | Fixed in e587c457 (closes on a press outside, or when focus moves to something outside); unit test that fails before the fix |
| 3 | No unit test opened the sheet from a panel row | Added in e587c457 |
| 4 | A booked block's secondary text was see-through ink, about 2.7:1 on a blue class | Fixed in b60afb3e (the block's own ink) |
| 5 | A booked class that had ended looked current apart from its pill | Fixed in b60afb3e (greyed with a desaturate filter, which keeps brightness so the ink still reads) |
| 6 | Scroll-to-live missed a live class folded into "+N more" | Fixed in b60afb3e ("+N more" carries the folded state; the scroll lands on it). The band height is still measured once per day change |
| 10 | An opened "+N more" came back, and took focus, after a swipe away and back | Fixed in b60afb3e (closes on any day change) |
| 7, 8, 9, 11–14 | Nits: the Day view by mat tabs column by column; mat header pill and column gap differ from Appendix B 21; the selected phone tab has no 2 px edge; unused `clusterSessions`/`clusterLabel`, a stale DayGrid comment, a duplicated measuring hook; static inline styles; the e2e helper can race the first paint; eight plan-listed test rewrites untouched (each still passes) | Accepted, not changed |

## 6. Found on the way

| What | Outcome |
|---|---|
| The members' last classes sat under the tab bar whenever the two-factor banner showed: the schedule sized itself from fixed header and tab-bar heights | Fixed in ba5a6afd; the journey now measures the last block 41 px above the tab bar at 375 and 390 px, dark and light shells |
| Writing a ref during render (the panel's close handler) failed the react-hooks lint rule | Fixed in 81a2a250 |
| The week and mats journeys read the hidden phone grid, which now carries the same day and time-label markers and comes first in the page | Journeys scoped to the week grid (d969efd2) |
| The mats choice step read the database before the last save landed, passing on a message left by the save before | Journey waits for each save's own response (d969efd2) |
| The contrast step booked Thursday's "Advanced Gi + Sparring" instead of Monday's (two classes share the name) | Journey books by Monday's schedule (412146b5) |

## 7. Not verified

- Safari and iOS: Chromium only. The Safari "+N more" tap fix is proved by a unit test, not a WebKit run.
- Booked-block contrast in the browser: the harness measures text against the shell behind a gradient fill, not the fill, so its readings for booked blocks (18.9:1, and 1.1:1 for white ink on a #111111 club) are not usable. White ink on mid-tone class colours from the shared `readableText` (about 3.7:1, older than this PR) is unchanged.
- React hydration mismatch (#418) on real-clock loads of the staff timetable: seen intermittently in earlier runs on this branch, and before PR 3; not seen in the final run. `structureDiff` now names the element when it recurs. Cause unknown.
- `tenant-restore-purge-race` (times out, as on PR 1 and PR 2) and the other database suites were not re-run on this PR; it adds one database file (`member-timetable-db`, green in both roles).
- E2E specs (`tests/e2e`) were not run; they run nightly, not on pull requests.
- Production: nothing here ran against production or a real club.
