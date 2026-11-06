# Timetable week grid (PR 1 of 3) — evidence (5 Nov 2026)

The staff timetable's desktop week becomes a poster grid: rows are the real start and end times, so classes at the same time sit side by side and line up across the week, as on the printed timetable Total BJJ uses. Split by time only in this PR; mats come in PR 2, the Day view, the phone and the members' day in PR 3. Plan: `.omc/plans/timetable-side-by-side-plan-2026-11-05.md` (v3, approved 5 Nov; "all pushed asap", read as: each PR pushed as a draft once its gates pass, merge on Noe's word).

Synthetic data only, Neon test branch, isolated worktree. No production query, no change to any real club.

## 1. What changed

| Behaviour | Files |
|---|---|
| A pure layout engine: row lines at every start and end minute, tracks sized to their content, empty hours collapsed to "No classes 08:00 to 09:00", lanes from `packLanes`, more than three at once folded into two classes and "+N more" per crowded moment | `lib/timetable-grid.ts` |
| The week as one grid in its own scroll box: day headers and the time gutter pinned, each day a subgrid card (with a `display: contents` fallback), the box opening on today's live or next class once per week shown, a line above it when the week is wider than the box | `components/schedule/PosterGrid.tsx`, `app/globals.css` (`.pg-*`) |
| Chips: time first and never cut, the name in full, the place, then the state, duplicate, kids and category tags; a coach's chips disabled but not faded | `components/schedule/WeekChip.tsx` |
| "+N more" opens the Day view on that day with the group open and focus on its first class | `components/dashboard/TimetableManager.tsx`, `components/schedule/DayGrid.tsx` (`openCluster`, one-shot) |
| The Timetable page may be 1,600 px wide; "Hide menu" (not remembered) gives the week the side menu's 240 px | `app/dashboard/layout.tsx`, `components/layout/Sidebar.tsx`, `app/globals.css`, `docs/UI-RULES.md` §4a.1 and §4a.8 |
| An empty today on the week shows a narrow "Today" pill that fits the 40 px column (found by the journey, see §4) | `components/dashboard/TimetableManager.tsx` |

Not changed: the phone list, the Day view apart from `openCluster`, the members' app, the class form, every route, the schema. No migration.

## 2. Gates

| Gate | Result | Commit |
|---|---|---|
| `npm run lint` (eslint + UI-RULES ratchet) | pass, all ratchets at baseline | content of `6cf2bf6e` |
| `npx tsc --noEmit` | pass | content of `6cf2bf6e` |
| Full unit suite `npm test` | 610 files passed, 114 skipped (database files: no `TEST_DATABASE_URL` in a unit run); 8,508 tests passed, 824 skipped, 3 todo | `6cf2bf6e` |
| Production build (`server.mjs build`, no database variable) | `BUILD EXIT 0`, tree clean | `47f1f012` |
| Independent review (Opus) | APPROVE WITH CHANGES on `8dfce7e2`: six should-fix, all fixed in `027f2578` | `8dfce7e2` |
| Browser journeys, nine, one build | see §3 | `47f1f012` |

The product code is the same from `6cf2bf6e` to `47f1f012`: the two commits after it change only the browser harness under `.claude/`.

## 3. Browser journeys (build of `47f1f012`, Chromium, scrollbars on show where geometry is measured)

| Journey | What it proves | PASS | FAIL | NOTE |
|---|---|---|---|---|
| smoke | the harness itself (Settings contact email, failed saves, retry) | 11 | 0 | 1 |
| timetable-week-grid | the poster club: invariants (51 chips, nothing cut or overlapping, same start same top), side by side, fits at 1440 with scrollbars (14 px spare), scrolls in its box at 1366 and 1280, Hide menu, pinned headers, wide page at 1920, keyboard order and focus return, three accents (ring, Today, Live/Next/Ended contrast), a coach, the subgrid fallback, phone 375 and 390 unchanged, real clock | 16 | 0 | 2 |
| timetable-week-grid-stress | the staggered trio, three at once, five at once as two and "+3 more" opening the Day view with the group open, the "+N more" ring under three accents, an empty today | 11 | 0 | 1 |
| timetable-overload | a 14-session Monday in lanes, the duplicate flag, keyboard order, the form refusing an identical slot | 8 | 0 | 0 |
| timetable-sessions | one chip per session, edits per session, failed saves and retry | 7 | 0 | 0 |
| timetable-multiday | one class on several days, other-tab and Back refreshes, archive and restore | 11 | 0 | 1 |
| timetable-lost-update | a stale tab's save is refused, not applied | 6 | 0 | 0 |
| timetable-day-view | the Day view and its folded group | 9 | 0 | 0 |
| classes-lifecycle | create, edit, eligibility at every door, pause, archive, restore | 56 | 0 | 4 |
| **Total** | | **135** | **0** | **9** |

Run `rmw3wfrmr56e74f`, 18:48 to 19:30 UK, on a quiet machine. Every fixture club was torn down to zero rows. A NOTE is a measurement, not a pass.

Screenshots (opened and checked): 1440 — the six-day poster week fits with 14 px to spare, times first, names whole, places on every chip, Sunday collapsed; 1366 and 1280 — the box scrolls sideways with its scrollbar on screen and the line "Wider than this window. Scroll sideways, or hide the menu."; the page does not scroll; 1366 with the menu hidden — fits; 1920 — lanes stop at 220 px, the class cards keep their 1,152 px measure, the "Ended" pill reads on Thursday.

## 4. Found on the way

| Finding | Kind | What was done |
|---|---|---|
| An empty today's "Today" pill was wider than the 40 px empty-day column | product | narrow pill (`6cf2bf6e`) |
| `timetable-multiday` created every class at Monday 18:00; a fourth at once now folds behind "+N more", so the class it looked for was not a chip | harness | its two "Open mat" classes are created at 20:00 |
| Contrast and focus-ring checks read colours through a canvas, which mis-read `color-mix()`; then the browser's `oklab()` serialisation was refused | harness | a parser for `rgb()`, `color(srgb)`, OKLab and OKLCH |
| The focus ring was measured mid-fade: the Button primitive's `transition-colors` covers `outline-color` | harness | `focusRing` waits for the transition to end (`47f1f012`) |
| With the clock frozen, the server render (real clock) is replaced by the browser's; a press before that lands on a node about to be swapped | harness | the week journeys wait for the browser's own render |
| Playwright cannot intercept what the production build's service worker fetches | harness | journeys block service workers (`9767c85e`) |
| Smoke's forced failed saves (F1, F2) and the lifecycle journey's archive wait (J45) failed in runs made while other test-branch work loaded the machine (database suites, a migration, a unit run) | environment | both pass on the quiet run in §3; Settings and the class lifecycle are untouched by this PR |
| A React hydration mismatch (#418) on two of four real-clock loads at about 17:25 on `6cf2bf6e` | open | not reproduced since; the week journey now keeps the server HTML on its real-clock load and records the first differing text if it happens again |

## 5. Deviations from the plan, recorded

- The engine's by-mat path and its tests are in this PR, ahead of PR 2 (no screen uses it yet).
- Folding is per crowded moment, not per overlap cluster (review finding): one long class makes a whole day one cluster, and a pair at 07:00 must not fold because five clash at 18:00. This departs from the letter of §5.1.
- The box's scroll padding is 50 / 40 px (the header band and gutter plus the focus ring's reach), not 46 / 36.
- The "Hide menu" button sits with the toolbar in the has-classes branch.
- `PosterGrid` is the week variant only; the one-day variant and the "+N more" panel arrive in PR 3.

## 6. Not verified

- E2E specs edited (`tests/e2e/campaign/demo-path.spec.ts` cases 5–6, `tests/e2e/campaign/assess/ld-1-timetable.spec.ts`): EDITED, NOT RUN locally; they do not run on pull requests.
- Browsers other than Chromium; a real touch device.
- Production data, and Sean's own timetable.
- The cause of the intermittent hydration mismatch (§4).
