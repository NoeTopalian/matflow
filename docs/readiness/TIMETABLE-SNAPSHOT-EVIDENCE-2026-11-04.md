# Timetable stale snapshot, and Sean's missing Gi day — evidence (4 Nov 2026)

Sean (Total BJJ) set Gi on Monday and Tuesday and sees one of them on the timetable. This record keeps two things apart, because they are not the same:

| # | Item | Status |
|---|------|--------|
| 1 | **Stale timetable snapshot defect** — the timetable ignored fresh server data while it stayed open | **Reproduced, fixed, tested** on branch `fix/timetable-stale-snapshot`. Release state: see the PR. Not deployed. |
| 2 | **Sean's Monday/Tuesday report** | **Not reproduced as his case.** Three ways current `main` produces "one day shown" were reproduced with synthetic data (below); which one, if any, Sean hit is unknown until he answers. Not resolved. |
| 3 | **Timetable UI/UX defects found on the way** (§3) | **Fixed, tested** on the same branch. Not deployed. |

Synthetic data only, Neon test branch, isolated worktree. No production query, no change to Sean's records.

## 1. The stale snapshot defect

**Cause.** `components/dashboard/TimetableManager.tsx` copied `initialClasses` and `initialInactiveClasses` into state on its first render and never read them again. A route refresh re-renders the server page and passes new props while the component stays mounted, so:

- a day saved in another tab stayed hidden after a refresh (probe P4);
- a class paused elsewhere stayed on the grid (P7);
- and after saving, a Dashboard link then browser Back re-mounted the timetable from the page copy Next had cached *before* the save, so the class was not shown at all (P5). Next 16 reuses cached page data on Back/Forward (`node_modules/next/dist/docs/01-app/02-guides/upgrading/version-15.md`).

**Change** (`80781e55`: 34 lines, one file, no API, schema or migration change; the §3 fixes later add a `roster` field to two API replies):

1. Adopt each new server snapshot during render, both lists together, so a class moving between active and paused is never shown twice or lost. Local changes stay until the next snapshot.
2. Default `initialInactiveClasses` to one module-level empty array. A `= []` default is a new array every render and would read as a new snapshot every render ("Too many re-renders"; the reviewer confirmed this by restoring it).
3. After a confirmed save, pause, archive or restore, `router.refresh()`. This is what fixes P5: the cached copy Back uses is then the one after the save.

**What it does not overwrite.** The open class form keeps its typed values when a snapshot arrives (it owns its state; `editTarget` is untouched). A re-render with the same snapshot keeps local changes. A failed save, pause, archive or resume requests no refresh and leaves the class where it was. Each is a unit test.

## 2. Sean's report — what was and was not established

Reproduced on `main` `76cbcb4f` with synthetic clubs:

| Probe | `main` 76cbcb4f | branch 355ff655 |
|---|---|---|
| P1 one form, Monday + Tuesday, fresh load | PASS | PASS |
| P2 two separate same-name classes | PASS | PASS |
| P3 edit Tuesday, then refresh — Monday kept | PASS | PASS |
| P4 Tuesday added in another tab, then refresh here | **FAIL** (Tuesday hidden; DB has both) | PASS |
| P5 Tuesday saved, Dashboard link, browser Back | **FAIL** (class not shown at all; DB has both) | PASS |
| P6 a tab that never saw a day saves an unrelated edit | **FAIL** (the day is **deactivated in the database**) | **FAIL — not fixed here** |
| P7 paused / resumed elsewhere, then refresh | **FAIL** (stays on the grid) | PASS |

What this narrows: on a **fresh page load** the timetable shows every day the database holds (P1, P2). So:

- if a full reload shows Sean both days, what he saw was a stale view (P4/P5) — fixed by this change;
- if a full reload still shows one day, the database holds one active day. This change does not alter that. The reproduced way to get there is P6; the other is that the day was never saved.

Also checked: the staff timetable renders the weekly template by weekday, so the selected week and schedule start dates cannot hide a day there; every filter (venue, category, My classes) hides whole classes, never one day of a class — but it can hide one of two same-name classes; sessions land on Monday and Tuesday in a London club and in a UTC+13 club (integration test).

**Questions for Sean** (to be forwarded; he has not been contacted): which day is missing; whether a reload brings it back; one Gi class with two days or two Gi classes; whether MatFlow is open in more than one tab or device when classes are edited; screenshots of the timetable (week and filters) and the Gi class settings.

## 3. UI/UX defects found on the way — fixed on the same branch

| Defect | Fix | Commit |
|---|---|---|
| "Switch back to rank gate" saved with no rank chosen kept the squad: the form said anyone could attend, the door still admitted only the squad | The form sends an empty roster in that case; with a rank chosen it still omits it (the rank gate clears the squad, and any roster array would null the rank) | `d0e56f92` |
| A just-saved squad class reopened as open to everyone until the next page load (~6 s here) — the save replies carried no roster | Create and update replies carry the roster in the timetable page's shape | `c6719853` |
| Archive sat idle for ~5 s while it read the class's history, inviting a second click and a second confirmation | Busy from the click (spinner, `aria-busy`, disabled) until confirmed, cancelled or failed | `d0e56f92` |
| (review) one class's action could clear another's busy state; the Paused list spun Resume while archiving | One lifecycle action at a time across all classes; each clears only its own state; the acting button spins | `355ff655` |

Each fix has a test that fails on the commit before it: the unit cases on the previous component (3 of 7, then 2 of 10), the integration test against the previous routes (4 of 4, both roles).

## Open defects found, not fixed here

| Finding | Effect | Where |
|---|---|---|
| **P6 lost update** — PATCH treats the submitted schedule list as the whole truth and deactivates any active day missing from it | A stale tab or second device can permanently remove a day another person added | `app/api/classes/[id]/route.ts` schedule reconcile (`slotKey`, deactivate) |
| No refresh after a 404/409 (independent review) | After "This class changed… refresh", the view stays stale | class action handlers |
| Active and inactive lists read in two transactions (review) | A concurrent change can briefly show a class in both or neither | `app/dashboard/timetable/page.tsx` |
| A long-open edit form sends its old copy of most fields (review; same family as P6) | Can overwrite another person's change | ClassForm save |

## Verification (commit each ran on)

Code under test is **`355ff655`**; the commit after it adds this record only.

| Check | Result | Commit |
|---|---|---|
| Browser — `run-journeys.mjs timetable-multiday` (production build, fresh synthetic fixture, torn down to 0 rows) | 11 PASS / 0 FAIL / 1 NOTE (agenda chip 358 × 58 px) | `355ff655` |
| Browser — `tt-probe` | 7 PASS / 1 FAIL — the FAIL is P6, the open defect above | `355ff655` |
| Browser — `tt-probe` baseline | 4 PASS / 4 FAIL (P4–P7) | `76cbcb4f` (`main`) |
| Unit — timetable, lifecycle, dialog, lane-3 files | 101 / 101 | `355ff655` source |
| Unit — every file importing the class routes (15) | 212 / 212 | `d0e56f92` source (routes unchanged in `355ff655`) |
| Unit — red on the commit before each fix | snapshot 4 (+2 refresh) of 13 · squad/busy 3 of 7, then 2 of 10 | `76cbcb4f`, `1c9964e5`, `d0e56f92` components |
| Database, both roles (owner and restricted `matflow_app`) — 8 class suites incl. the two new ones | 8 files, 43 / 43 in each role | `355ff655` |
| Integration red — roster reply against the previous routes | 4 / 4 failing, both roles | `1c9964e5` routes |
| Type check · lint (changed files) | 0 errors · 0 | `355ff655` |
| CI — full Vitest, lint, typecheck, policy, advisories, GitGuardian | see the PR | final head |
| Independent review | approve with nits, twice; every nit fixed or recorded above | `18b7277c`, `d0e56f92` |

## Not verified

Production behaviour and Sean's own data (not queried, by instruction); other browsers than Chromium; real devices; refresh latency on Vercel (here ~6 s per refresh because every query crosses to the Neon test branch — production is expected to be faster, but that is not measured).
