# Deep links — a class, session or payment link opens that exact record — evidence (5 Nov 2026)

PR A of `.omc/plans/activity-timeline-plan-2026-11-05.md` (the Activity timeline), branch `feat/activity-deeplinks`, from `main` `e77b568c`. It lands first so that no link in the Activity timeline (PR B) ships before the page it points at can show the record.

Synthetic data only, Neon test branch, isolated worktree without `.env`. No production query.

## Change (code under test `effbd500`)

| Commit | What |
|---|---|
| `104bb281` | `/dashboard/timetable?classId=` opens that class's edit sheet for an owner or manager; a paused or archived class is scrolled to and marked in Paused and archived instead; an id that is not on the timetable says so in a toast; the parameter is removed from the address afterwards. `/dashboard/attendance?instance=` shows that one session's check-ins (up to 1,000) under a "Session: …" label, with a way back to all attendance; a session with nobody checked in says so; an unknown session shows a note above the usual recent list. `/dashboard/members/:id?tab=payments&paymentId=` marks that payment and scrolls to it once; nothing is filtered. `DataTable` gains `isRowCurrent` (row and phone card, `aria-current="true"`). `lib/session-label.ts` names a session the same way everywhere, from the stored day marker and "HH:mm" — never from a `Date` built out of them. |
| `59c710d9` | Browser journey `deeplinks.mjs`. |
| `0955173a` | Merge of `main` (`e77b568c`, #58). One conflict, in the Paused and archived list's props; both sides kept. |
| `effbd500` | Review fixes: the marker is a dark outline (`--tx-2`), not the faint focus grey, and is measured in the journey; ids may contain `-`, `_` and `:` (seeded clubs have readable ids); a second `?classId=` link on the same mounted page is honoured; the "Show all attendance" link lines up with the label; the club-wide stat cards are hidden while one session is shown; the member page says "isn't among this member's latest payments" (the list holds the newest 100); the address keeps its `#hash`; the payment is scrolled to once; a time-zone test that fails if the label is ever built in the reader's zone. |

Not changed: the schema (no migration), any API route, permissions, the check-in register, what the Attendance page shows without `?instance=`, the Activity page itself.

## Verification (commit each ran on)

| Check | Result | Commit |
|---|---|---|
| Unit — the six new files (`data-table-current-row`, `session-label`, `attendance-session-focus`, `attendance-page-session`, `timetable-deeplink-class`, `member-payment-deeplink`) | 31 / 31 | `effbd500` |
| Full unit suite (`npm test`) | 612 files passed, 114 skipped; 8,470 tests passed, 824 skipped, 3 todo. The skipped files are the database suites, which do not run without a test database — skipped is not passed. | `effbd500` |
| Type check · `npm run lint` (eslint + UI-RULES ratchet) | 0 · passed, every ratchet at baseline | `effbd500` |
| Production build (`server.mjs build`, no database URL) | exit 0, tree clean | `effbd500` |
| Browser — `run-journeys.mjs smoke deeplinks` (fresh `mfv-` fixture, torn down) | smoke 11 PASS / 0 FAIL / 1 NOTE; deeplinks 10 PASS / 0 FAIL: an active class opens its sheet and the address is cleaned; a session link shows that session's check-ins with the label and the way back; an empty session says so; an unknown session shows the note and the recent list; a paused class is marked and in view; an unknown class toasts; a payment is marked and in view; an unknown payment shows the note; the same at 390 px; no console errors. The marker's outline colour is read back and equals `--tx-2`. | `effbd500` |
| Independent review (Opus, read-only) | APPROVE WITH NITS on `0955173a`: no blockers; five should-fix and ten nits. All five should-fix and eight nits are in `effbd500`. Not done: moving keyboard focus to the marked record (nit 7). | `0955173a` |
| Database, both roles — `tenant-isolation.test.ts` | 2 / 2 as the owner role and 2 / 2 as `matflow_app` | `effbd500` |
| CI | see the PR | head |

**No database test is specific to this change.** It adds one optional equality filter to an existing tenant-scoped read and one lookup of the same shape as an existing one (`{ id, class: { tenantId } }`). The unit test asserts both `where` clauses and the journey exercises them on the test branch; the general tenant-isolation suite passes as both roles. A second suite started in error as an adjacent check (`sec-d-attendance-misbinding-db`, the attendance-import suite, 23 cases) outran the harness's ten-minute limit and was stopped — a run that did not finish, not a pass, and nothing this change touches. The fixture clubs those interrupted runs left on the test branch were removed (checked: none remain).

## Departures from the plan (for Noe to veto)

1. The record a link names is marked with a **dark outline (`--tx-2`)**, not `--bd-active` as the plan's first draft said: that grey is about 1.6:1 on white and identical to the keyboard-focus outline (review S1).
2. On Attendance, the way back from one session is a **"Show all attendance" link**, not a "×" on a chip, and the club-wide stat cards are hidden while one session is shown — they described the whole club under a one-session heading (review nit 2).
3. Ids are accepted as letters, digits, `_`, `-` and `:` up to 100 characters, not cuid-only (review S2).

## Not verified

Production; browsers other than Chromium; real devices; a screen reader. The links themselves do not exist until PR B: this PR is reachable only by typing or pasting an address.
