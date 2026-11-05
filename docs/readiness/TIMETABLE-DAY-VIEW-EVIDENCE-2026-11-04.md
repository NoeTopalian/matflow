# Staff Day view, shared lane engine, member mat labels — evidence (4 Nov 2026)

PR C of `.omc/plans/timetable-density-plan-2026-11-04.md`, branch `feat/timetable-day-view`, stacked on `feat/timetable-overload` (PR #60). Synthetic data only, Neon test branch, isolated worktree without `.env`. No production query.

## Change (code under test `ddea0498`)

| Commit | What |
|---|---|
| `8c4ba4ae` | `lib/schedule-state.ts` owns `hourWindow` (moved from the member page, identical results for every well-formed input), `clusterSessions` / `clusterLabel` (the week list's grouping, moved from the component) and `minToTime`. New `components/schedule/DayGrid.tsx`: one day on a time axis, overlapping sessions in lanes (`packLanes`, up to three; a wider clash folds into one group that opens to rows), hour lines, now line, blocks with name, start–end, mat, state pill and Duplicate? tag, built only from the `Button` primitive. Staff timetable gets a desktop Week ⇄ Day toggle, a day picker and the Day view, with the club's hour window over the whole week; each block opens its own class. The member day view shows the mat beside sessions that run side by side. |
| `9a9b3d57` | Journey: expanded group rows are in the day's order; mats asserted as a set. |
| `ddea0498` | Review fixes: blocks are disabled and verb-less for a coach or admin (the enabled "Edit …" button that did nothing was the blocker); the selected segment and selected day are white on the grey track; 56 px/h; a block never paints over the next thing beneath it in its horizontal range nor past the grid's end; focus follows a group as it opens and closes; groups keyed by start minute and the grid remounts per day; DOM and Tab order follow the clock; dimmed sessions keep their ink; `hex()` from `lib/color`; "Today" resets the day; the today-column scroll re-runs on returning to Week; day buttons named "Monday 2, 3 sessions"; the member block puts the mat in the coach's place when it is the differentiator, inline on short blocks. |

Not changed: the API, the schema, the week grid and agenda (PR A/B), lifecycle, eligibility, filters, permissions. The member page's rendering is otherwise untouched.

## Decisions recorded for Noe (plan §2 decision 1, revised)

- **Shared engine, renderer per surface.** The plan said "extract the member DayGrid". What shipped: the maths that decides what clashes and which hours a club runs (`packLanes`, `hourWindow`, `clusterSessions`) is single-sourced in `lib/schedule-state.ts`; the staff view has its own light-shell renderer; the member JSX is untouched. Known renderer differences are listed in the plan.
- **28 px block minimum, below the 44 px touch floor**, on a time axis where height is duration; the expanded group rows are 44 px. A justified hand-roll under UI-RULES §0.4, written down rather than silent.
- **56 px/h, not 36**: at 36 a 45-minute class is 27 px and the time line never fits.

## Verification (commit each ran on)

| Check | Result | Commit |
|---|---|---|
| Unit — `timetable-day-view.test.tsx` (12: lanes by measured offset, 28 px minimum and the cap against the next block and the grid's end, four-way fold/open/collapse with focus, names with state and duplicate, hour labels and empty state, `hourWindow` and `clusterSessions` incl. overnight, Week/Day toggle, Monday lanes, a block opens its class, open groups do not leak across days, coach sees disabled verb-less blocks, "Today" resets the day, the week-wide hour window) + `member-schedule-place-label.test.tsx` (1) + 15 timetable/member-schedule files | 17 files, 137 / 137 | `ddea0498` source |
| Reviewer's full unit run | 596 files, 8354 pass, 1 skipped | `8c4ba4ae` |
| Type check · `npm run lint` (eslint + UI-RULES ratchet; raw buttons unchanged at 336) | 0 · passed | `ddea0498` |
| Database, both roles — 3 class suites (no server code in this PR; for the record) | 16 / 16 in each role | `ddea0498` |
| Production build (`server.mjs build`, no database URL) | exit 0, tree clean | `ddea0498` |
| Browser — `run-journeys.mjs timetable-day-view` (busy week seeded via the create API; fresh `mfv-` fixture torn down to 0 rows) | 9 PASS / 0 FAIL: toggle with the week navigation kept and the club's 06:00–22:00 window; ten Monday blocks in time order, the staggered trio side by side then back in lane 1 by measured geometry, the 18:40 trio three abreast with two flagged; a block opens its own class and Escape saves nothing; Saturday's four-way clash as one group, opened from the keyboard with focus on its first row, four rows in name order with their mats, collapse returns focus to the group; Tab walks Monday's blocks in time order and Enter opens; phone 375 px has no toggle and the agenda is unchanged; exactly the seeded rows in the database; no page errors | `ddea0498` (earlier 9 / 9 on `9a9b3d57`; one 8 / 1 on `8c4ba4ae` was the journey's own wrong mat-order assertion) |
| Independent review (Opus) | REJECT on `8c4ba4ae`: 1 blocker (coach/admin fake-clickable blocks), 6 should-fix, 12 nits — all addressed in `ddea0498` except those recorded below | `8c4ba4ae` |
| CI | see the PR | head |

## Carried, not fixed here

- **Member mat label has no browser journey**: the harness has no member sign-in. Unit-tested on the real page component (two 18:40 sessions on Mat 1 and Mat 2; the lone Open Mat keeps its coach). Browser-level: UNVERIFIED.
- Day-picker `role="tab"` semantics replaced by `aria-pressed` buttons in a group (the reviewer's simpler option); the phone agenda's existing tablist is unchanged.
- The now line and Live/Next pills update on re-render only, as the week chips do.
- Member Sign-in sheet (`member/home`) still shows two same-time sessions identically; outside this PR.

## Not verified

Production; browsers other than Chromium; real devices and coarse pointers (the 28 px blocks on an iPad are reasoned, not measured); the member label in a browser.
