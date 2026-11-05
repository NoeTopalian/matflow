# Staff timetable: one chip per session — evidence (4 Nov 2026)

Sean (Total BJJ) runs Beginners Course Gi three times on Monday (06:30, 12:00, 18:40) and the staff timetable showed one Monday chip. This record covers the fix on branch `fix/timetable-one-chip-per-session` (base `main` `76cbcb4f`).

Synthetic data only, Neon test branch, isolated worktree without `.env`. No production query, no change to Sean's records.

## Cause

`components/dashboard/TimetableManager.tsx` built the week grid and the phone agenda from **classes per day**: `byDay[i]` was the classes with any slot on day `i`, and each chip's time came from `schedules.find(...)`, the first slot for that day. A class with three Monday slots was one entry, so one chip, showing whichever slot came first in the array. The page ordered slots by day only, so "first" was insertion order and could change after an edit. The same first-slot lookup fed `chipStatesFor`, so Live / Next and a cancellation were judged against the wrong session for a second or third same-day slot.

## Change

| Commit | What |
|---|---|
| `b27213c2` | `byDay` is `DaySession[][]`: one `{ cls, slot }` per (class, slot) on the day, sorted by start time. `chipStatesFor(sessions, …)` reads each session's own slot. Grid, agenda and the agenda day counts use sessions. `app/dashboard/timetable/page.tsx` orders slots `[dayOfWeek, startTime]`, so the class card's pill row is chronological. Unit test `tests/unit/timetable-same-day-sessions.test.tsx` (fails 5 of 6 on `76cbcb4f`). |
| `d04952ce` | Browser journey `journeys/timetable-sessions.mjs`. |
| `2448f3ef` | Review fixes: chip key is the slot id (two slots of one class can share a day and start time; the reconcile keys on day\|start\|end); same-minute sessions of different classes tie-break by name; create and update replies order slots the same way so the card is chronological straight after a save; the unit test freezes the clock on a Thursday and the journey matches chip names with or without their state suffix, so neither depends on the weekday it runs. |

Not changed: the database, the API's shape (an `orderBy` on two existing includes only), the member schedule and home views (they already render per session), the coach Today list, filters, eligibility, lifecycle.

## Verification (commit each ran on)

| Check | Result | Commit |
|---|---|---|
| Unit — new file on the old component | 5 of 6 fail (one Monday chip, wrong time, picker counts classes, old `chipStatesFor` signature) | `76cbcb4f` |
| Unit — 8 timetable files + the 25 files importing the class routes | 31 files, 414 / 414 | `2448f3ef` source |
| Type check · lint on changed files | 0 errors · 0 | `2448f3ef` |
| Database, both roles (owner and restricted `matflow_app`) — 6 class suites | 48 / 48 in each role | `2448f3ef` |
| Production build (`server.mjs build`, no database URL) | exit 0, tree clean | `2448f3ef` |
| Browser — `run-journeys.mjs timetable-sessions` (fresh `mfv-` fixture, torn down to 0 rows) | 7 PASS / 0 FAIL / 0 NOTE: three Monday chips in time order after create and reload, card pills chronological, second class interleaved and each chip opens its own class, Tab order and visible focus, aborted and 500 saves keep the form and save nothing, one retry saves, phone 375 px agenda lists 4 in order with picker count 4 and rows ≥ 44 px, no sideways scroll, exact rows in the database, no page errors | `2448f3ef` |
| Independent review (Opus) | REJECT on the first head (`d04952ce`): both blockers in the tests (weekday dependence), one should-fix (key collision), six nits; all fixed in `2448f3ef` except the two noted below | `d04952ce` |
| CI — full Vitest, lint, typecheck, policy, advisories, GitGuardian | see the PR | head |

## Found, not fixed here

- Chips share one accessible name per class (`Edit Beginners Gi` three times); the start time is in the visible text but not the name. Changing the name needs a sweep of the journeys that match it exactly. Separate PR.
- The server accepts two identical slots in one class and the reconcile never de-duplicates them. The form should refuse an identical slot; part of the planned overload work (PR B).
- P6 lost update (PATCH treats the submitted slot list as the whole truth) is unchanged; separate PR as recorded in `TIMETABLE-SNAPSHOT-EVIDENCE-2026-11-04.md`.

## Not verified

Production and Sean's own data (not queried, by instruction); browsers other than Chromium; real devices.
