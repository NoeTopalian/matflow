# Staff timetable overload — evidence (4 Nov 2026)

A club that runs 14 sessions on a Monday, several at once and the same class on two mats, got a 130 px column of truncated names with no sign of what clashed. This record covers PR B of the plan in `.omc/plans/timetable-density-plan-2026-11-04.md` (decisions 2–5), on branch `feat/timetable-overload`, stacked on `fix/timetable-one-chip-per-session` (PR #59, one chip per session).

Synthetic data only, Neon test branch, isolated worktree without `.env`. No production query.

## Change (code under test `32626268`)

| Commit | What |
|---|---|
| `82e524b1` | Once any day has `DENSE_DAY` (7) sessions the week grid's minimum width goes from 980 to 1260 px (180 px columns) and that day's chips are the compact two-line chip: time range and mat, then the full name with its Kids/category tags. Overlapping sessions sit in a `role="group"` with a rail and "Up to N at once" — N is the lane count `packLanes` already computes for the member day view, so a staggered 16:30 / 17:00 / 17:30 reads "up to 2", never 3; chips inside a group show start–end and their mat. Same name, day, start and mat twice is flagged "Duplicate?" (`lib/schedule-state.ts#duplicateSessionKeys`) and left exactly as stored. The class form refuses a repeated slot. |
| `f86912d7` | Review fixes: the content column is capped at 1152 px, so the dense grid always scrolls sideways **inside its own box** (`overflow-x: auto` kept at every desktop width when dense; the unreachable `2xl` step removed); the form refuses the same **day and start** twice (a session's identity downstream — one `ClassInstance` per start, cancel keys) and names the slot once; same-name same-start sessions order by place then id; compact chips always show start–end and place; names wrap to two lines; place text and the flag in text-colour ink (amber ink fails 4.5:1 on the tint); the duplicate rule includes the venue; the group's visible label is `aria-hidden` since the group's name already says it. |
| `32626268` | The flag is a tag beside the name (the journey caught "Duplic…" clipped in the place's slot at 180 px); the mat shows on duplicates too. |

Not changed: member views (`app/member/**`), the API, the schema, lifecycle, eligibility, filters, permissions.

## Verification (commit each ran on)

| Check | Result | Commit |
|---|---|---|
| Unit — `timetable-overload.test.tsx` (10 cases: dense switch, quiet week unchanged, five groups in order, staggered trio, `groupSessions` lanes incl. an overnight pair, agenda groups, duplicate flag and rule incl. venue, form refusal incl. same start / different end and three identical rows) + 9 timetable and schedule-state files | 10 files, 103 / 103 | `f86912d7` source; 3 affected files 25 / 25 on `32626268` |
| Type check · lint on changed files | 0 errors · 0 | `32626268` |
| Database, both roles — 3 class suites (no server code changed in this PR; run for the record) | 16 / 16 in each role | `82e524b1` |
| Production build (`server.mjs build`, no database URL) | exit 0, tree clean | `32626268` |
| Browser — `run-journeys.mjs timetable-overload` (busy-gym week seeded through the app's create API from the signed-in page; fresh `mfv-` fixture torn down to 0 rows) | 8 PASS / 0 FAIL: dense grid with 14 compact Monday chips and "14 sessions", Tuesday normal; the week box is `overflow-x: auto` and neither `<main>` nor the document scrolls sideways at 1280, 1440 and 1600 px; no clipped text in any compact chip; five groups with the expected labels; the duplicate pair flagged, the Mat 2 session not, each chip opens its own class; Tab walks all 14 chips in time order into and out of groups; form refuses the same day+start with typed values kept and saves nothing on Escape; phone 375 px agenda 14 rows in 5 groups, picker 14, rows ≥ 44 px, no sideways scroll; no page errors | `32626268` |
| Browser — the run before the tag fix | 7 PASS / 1 FAIL ("Duplic…" clipped) — the fix above | `f86912d7` |
| Independent review (Opus) | REJECT on `82e524b1`: 1 blocker (page scrolled sideways at 1280–1535 px), 7 should-fix, 8 nits — all fixed in `f86912d7`/`32626268` except the two below | `82e524b1` |
| CI | see the PR | head |

## Review items carried, not fixed here

- `groupSessions` lives in the component; the plan puts it in `lib/schedule-state.ts` for PR C to share with the member day view. Move it in PR C.
- No unit assertion on equal column heights (CSS grid rows; visible in the desktop screenshot).

## Not verified

Production; browsers other than Chromium; real devices; a club with more than one venue in the duplicate rule (unit-tested, not exercised in the browser).
