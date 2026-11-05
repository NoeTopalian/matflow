# P6 lost update — a stale tab can no longer delete a day it never saw — evidence (4 Nov 2026)

PR D of `.omc/plans/timetable-density-plan-2026-11-04.md`, branch `fix/timetable-lost-update`, stacked on `feat/timetable-day-view` (PR #61). Reproduced on 4 Nov as probe P6 on `main` `76cbcb4f` (`TIMETABLE-SNAPSHOT-EVIDENCE-2026-11-04.md`): a tab opened before another tab or device added a day deactivated that day on its next save — any save, a rename included — because PATCH took the submitted schedule list as the whole truth. The likeliest way a day goes missing from the database and stays missing after a reload.

Synthetic data only, Neon test branch, isolated worktree without `.env`. No production query.

## Change (code under test `708fbb4c`)

| Commit | What |
|---|---|
| `42ba2546` | `PATCH /api/classes/[id]` accepts `baseScheduleIds` (the active slot ids the form loaded with). When `schedules` is sent and the class's active slot ids no longer match, 409 `{ error, reason: "stale_schedules" }` — in the pre-flight (so the dry-run preview is refused before any confirmation) and again under the `FOR UPDATE` Class lock inside the write transaction, thrown so nothing of the edit survives. A save without `schedules` (pause, resume) is unaffected. A client that sends no base keeps the old whole-truth behaviour (documented; the app always sends it). The form sends the base on edit. DB suite + journey. |
| `9206aa72` | A refused save is shown in the form, beside the buttons (`role="alert"`), not as a toast — on a phone the toast sat over Cancel / Save and the class status controls (caught by the journey's phone screenshot). Lifecycle actions keep their toasts. |
| `708fbb4c` | Review fixes: the stale refusal offers a Reload button (an installed app has no reload control; reopening the sheet keeps the stale days); the in-lock re-check runs first thing after the lock; `baseScheduleIds` is left out of the audit row's field list (it was showing as a code name in Activity); copy "days or times"; ids capped at 64; a DB case that holds the Class lock while a save's pre-flight passes, adds a day, commits, and proves the save is still refused under the lock; the journey asserts the in-form alert, never a toast. |

Not changed: the schema (no migration), the week grid, agenda and Day view (PRs A–C), member views, lifecycle, eligibility, permissions, the audit log's shape.

## Verification (commit each ran on)

| Check | Result | Commit |
|---|---|---|
| Database, both roles — `class-lost-update-db.test.ts` (4 cases: stale rename refused with Tuesday kept and the dry run refused, then a fresh base saves; a removed day also stales a base; a save without `schedules` ignores the base and a client with no base keeps the old behaviour; **a change that lands between the pre-flight and the Class lock is still refused under the lock**) + 3 class suites | 4 files, 20 / 20 in each role (owner and restricted `matflow_app`) | `708fbb4c` |
| Database red — the new suite against the previous route | 2 of 3 fail (stale save returned 200 and deactivated Tuesday) | route at `f9edfbd3` |
| Unit — 26 files importing the class routes + `timetable-save-refused.test.tsx` (3: base sent on edit, 409 shown beside the buttons with Reload, values kept, no toast; clears on reopen; create sends no base) + 10 timetable files | 32 files, 431 / 431 | `9206aa72`+ source; 26 + 1 files 378 / 378 on `708fbb4c` |
| Type check · `npm run lint` (eslint + UI-RULES ratchet) | 0 · passed, at baseline | `708fbb4c` |
| Production build (`server.mjs build`, no database URL) | exit 0, tree clean | `708fbb4c` |
| Browser — `run-journeys.mjs timetable-lost-update` (fresh `mfv-` fixture torn down to 0 rows) | 6 PASS / 0 FAIL: tab A renames after tab B added Tuesday → 409, in-form alert with Reload, typed values kept, Tuesday and the old name survive; reload then the same rename saves with both days; a squad change from a stale tab is refused at the preview before any confirmation, no roster row written; a phone's stale save is refused with the alert above Save and no sideways scroll; a pause from a stale tab sends no days and still works; no page errors | `708fbb4c` (also 6 / 6 on `9206aa72`; on `42ba2546` the phone section failed on the toast-over-Save defect fixed in `9206aa72`) |
| Independent review (Opus) | REJECT on `42ba2546`: server half "correct and race-safe"; 1 blocker (the toast), 3 should-fix, 4 nits — all addressed in `9206aa72` / `708fbb4c` | `42ba2546` |
| CI | see the PR | head |

## Carried, recorded for a later PR (from the review)

- The same lost update still applies to the **squad list and the scalar fields**: a stale form with unchanged days resends the roster whole-truth and overwrites coach, capacity and description from its old copy. P6 is scoped to days. Base ids for the roster (as here) or a revision column (migration) would close it.
- Two e2e campaign specs PATCH `schedules` without a base; once they send one, `baseScheduleIds` can be required whenever `schedules` is sent (a release after this ships, so an old bundle in an open tab is not met with a 400).

## Not verified

Production; browsers other than Chromium; real devices.
