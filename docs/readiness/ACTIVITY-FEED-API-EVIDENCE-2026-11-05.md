# Activity timeline, server half — `GET /api/activity` — evidence (5 Nov 2026)

PR B1 of `.omc/plans/activity-timeline-plan-2026-11-05.md`, branch `feat/activity-feed-api`, stacked on `feat/activity-deeplinks` (PR #63). Nothing in the app calls the new route yet; the page arrives in PR B2. `GET /api/audit-log` and both undo routes are untouched.

Synthetic data only, Neon test branch, isolated worktree without `.env`. No production query.

## Change (code under test `cc0f59dc`; head `6a9802c1` adds test registrations only)

| Commit | What |
|---|---|
| `1f5e46eb` | Club days: `clubDayKey`, `clubDayWindow` (next calendar date, never start + 24 h), `shiftDayKey`, `parseDayKey`; the `lib/date.ts` formatters take an optional time zone. |
| `45aadf61` | `lib/activity-types.ts` (client-safe): the activity types — label, group, icon, the audit actions each owns, who may see it, whether it is in the default view — the five views, the `types` URL parameter, a person's stored default, field names in words. Labels `waiver.sign-for-child`, written since it shipped without one. |
| `398e391e` | `lib/activity-feed.ts` (server-only): row rules, the query compiler, the manager restriction, the member / class / payment / plan filters, club-scoped name lookups, sentence templates, the detail line, changed fields, source, the undo decision. |
| `eb6ac0d1` | `GET /api/activity`: owner and manager; closed response; two transactions (rows, then names with a five-second budget); a rate limit; timeouts answered with a sentence that says what to do. |
| `de5c529c` | The database test, and names shown exactly as written. |
| `cc0f59dc` | Fixes from two independent reviews (below). |
| `ccba5094` | `scripts/perf/activity-feed-explain.mjs`. |
| `6a9802c1` | The route is claimed by journey J85; the perf script's synthetic users are pinned in the login-writer inventory; vitest resolves the `server-only` marker to an empty stub. No file under `app/` or `lib/` changes. |

Not changed: the schema (no migration, no index), any existing route, any page, permissions elsewhere, the audit log's contents or retention.

## What it guarantees, and the test that holds each

| Guarantee | Held by |
|---|---|
| A manager is never sent staff changes, sign-in and security events, settings, data requests, imports, plan set-up, MatFlow support activity, undo rows, an unmapped action, or any row made during a support session — by any parameter | unit: 16 parameter combinations incl. cursor, payment, class, embed, day; database: 13 combinations, as both roles |
| The response is a closed shape: no audit row, metadata, address, operator id, request id or tenant id | unit: allow-list of every key incl. nested parts, changes and source; banned-string check for both roles |
| Every row is found by the filter of the type it shows — including rows with no metadata, no `status`, no `acknowledged`, and shapes no writer produces | unit: every labelled action × 32 metadata shapes; database: the same claim against Postgres |
| The in-memory model of the SQL that the unit tests rely on answers as Postgres does | database: model vs query result for every fixture row × every type |
| Another club's id (member, class, plan, payment, staff, cursor) gets the same answer as an id that never existed, and its names appear nowhere | unit + database |
| An erased member is "Deleted member", never a link; their old values are in nobody's response | unit + database (erasure applied to the fixture) |
| 120 rows written in the same instant page at 50 to exactly 120 different rows | unit + database |
| Names that cannot be loaded do not fail the page (200, plain labels, `enriched: false`); one row that cannot be described does not either | unit |
| A day is 23 or 25 hours long when the clocks change; a session label never moves with the server's or the reader's zone | unit (London, Auckland, Los Angeles, Cairo) |

## One thing the database test changed

Prisma renders `NOT (array contains x)` as "is an array that does not contain x". So "every check-in without a warning" could not include a row whose `acknowledged` value is not a list, and such a row was found by **no** type filter — invisible to a manager and in every view but Everything. No writer produces that shape today (all three validate a list), and the unit tests could not see it because the model negated naively; the database test caught it once a reviewer asked for odd shapes in the fixtures. The fix does not depend on the negation at all: **Check-in** finds every staff check-in and **Check-in with a warning** finds the warned ones, so the two overlap (declared in `typesFinding()`). A warned check-in shows as "Check-in with a warning" and is still found by "Check-in". The model now renders `array_contains` under `NOT` as Postgres does.

## Verification (commit each ran on)

| Check | Result | Commit |
|---|---|---|
| Unit — the seven activity files (`club-day`, `activity-types`, `audit-labels`, `activity-feed-where`, `activity-feed-entry`, `activity-feed-lookups`, `activity-api`) | 192 / 192 | `cc0f59dc` |
| Database, both roles — `activity-feed-db.test.ts` | 12 / 12 as the owner role, 12 / 12 as `matflow_app` | `ccba5094` |
| Full unit suite (`npm test`) | 618 files passed, 0 failed, 115 skipped · 8,657 tests passed, 0 failed, 836 skipped, 3 todo. The skipped files are the database suites, which need a test-branch URL this run does not have; skipped is not passed. This PR's own database test ran separately (row above) | `6a9802c1` |
| Type check · `npm run lint` (eslint + UI-RULES ratchet) | 0 · passed, every ratchet at baseline | `6a9802c1` |
| Production build (`server.mjs build`, no database URL) | exit 0; the only uncommitted file was this document | `6a9802c1` |
| Query cost — `scripts/perf/activity-feed-explain.mjs`, as `matflow_app` with row-level security | 19 scenarios, all at or under 300 ms (table below); both clubs torn down to 0 rows | `ccba5094` |
| Independent reviews (two, Opus, read-only) | both REJECT on `de5c529c`, two blockers each; neither found a way for a manager to be sent an owner-only row. All four blockers and the should-fix items listed below are in `cc0f59dc` | `de5c529c` |
| Browser | not applicable: no page calls the route until PR B2 | — |
| CI | see the PR | head |

The full suite first ran on `ccba5094` and failed three inventories (4 tests): the journey manifest (a route no journey claims), the login-writer list (the perf script creates synthetic users) and the CSRF sweep (it imports every route and could not resolve `server-only`). `6a9802c1` registers all three. Its first run on `6a9802c1` then had one failure, `e2e-bypass-no-owner-escalation.test.ts` "still signs in a seeded account presented with the bypass token", which timed out at 33.5 s while a second worktree was being linted and tested on the same machine; the file passes 3 / 3 alone, this PR does not touch it, and the re-run recorded above (nothing else running) passed in full.

### Query cost on a year of rows

Two synthetic clubs of 200,000 audit rows each, spread evenly over 365 days, statistics refreshed. Execution time is Postgres's own (`EXPLAIN (ANALYZE, BUFFERS)` of the SQL Prisma sent). Pass line 300 ms.

| Scenario | Execution |
|---|---|
| Default first page (Club activity) | 0.5 ms |
| Everything, first page | 0.1 ms |
| One member, active all year | 13.5 ms |
| One member whose rows are all in the oldest month | 225.3 ms |
| Member page History, 20 rows | 6.2 ms |
| Member page History, oldest-month member | 218.7 ms |
| One class | 1.4 ms |
| One plan | 5.8 ms |
| One rare type (refunds, 1 row in 1,000) | 69.9 ms |
| One payment's trail | 30.7 ms |
| Done by one staff member | 0.2 ms |
| Deep paging (page 40) | 0.6 ms |
| Jump to a date 300 days back | 0.1 ms |
| Manager, default first page | 0.2 ms |
| Manager, one member | 298.4 ms |
| Name lookup for a member who is gone | 60.6 ms |
| Already-undone lookup, page 30 / 180 / 364 days back | 10.9 / 99.9 / 132.3 ms |

**Read this with care.** Three scenarios sit near the line, and they are the same case: a member filter that has to read the club's whole year because the member appears on few rows (the filter is seven conditions on JSON metadata, joined by OR, so no index narrows it). An earlier run of the same scenario, before the review fixes, measured 326.5 ms; the numbers move by tens of milliseconds between runs. At the size of a real club today (well under 100,000 rows a year) the same query is about half this. The plan's pre-agreed fallback — one expression index on `metadata->>'memberId'` — would not help: it covers one of the seven conditions. If a club approaches 200,000 rows a year, the right fix is a small link table (audit row → member) written alongside the row, which is a schema decision for Noe. Wall-clock times on this machine were 3–4 s a request and are not the product's: each round trip to the test branch from here is about 200 ms, and a request makes about sixteen of them.

## Review findings and what was done

Security and queries — blockers: the paging cursor was resolved without a club filter (fixed: looked up in this club, explicit comparison); one unknown currency code failed the whole page (fixed: a formatter that cannot throw, entries built fail-soft). Should-fix, done: a lower time bound on every query; a cap on the already-undone lookup; odd JSON shapes in the fixtures (which found the check-in gap above); the missing boundary tests; a joined user of another club is never named; the 500 path is not cached. Not done, recorded: the five-second name-lookup budget stops the request waiting but a statement already running is cancelled by the database's own 15 s bound; when the rate limiter's store is down the route answers "Too many requests" (it fails closed; the wording misleads); a pool timeout is reported with the "too much to load" sentence.

Sentences and taxonomy — blockers: a member far down a card-scan batch was called "a deleted member" on their own timeline (fixed: the filtered member is always looked up); a whole-form member save listed every field the form sent as changed (fixed: the diff, plus Email when the two digests differ, plus Notes / Medical details; a no-op save lists nothing). Should-fix, done: support edits are told as MatFlow support's; a removed staff member's rows are "Staff (account removed)", not "Automatic"; a reason typed about a member is owner-only and gone once the member is erased or deleted; the club's currency where the row has none; stripes gained, lost or unchanged; a re-tick is a confirmation; a requested cancellation is not "cancelled"; a removed child is named; templates for disputes, guardian decisions and staff tasks; "who opened a signed waiver" moved to Member sign-in and access. Not done, recorded: enum values print as stored ("active → cancelled"); the day window in zones whose clocks change at local midnight west of Greenwich holds an hour of the previous day (no club is in one).

## Carried to later PRs

- `member.attribution.update` is written on every profile save whether or not the values changed (the form sends them every time). Until the writer records only real changes (PR C), it is its own type, "Conversion credit", **off by default**.
- A deleted member's name appears only from PR C, when the deletion row starts recording it. Until then such a member reads "a deleted member".
- `payments/manual` and `class-packs` accept any three characters as a currency; the feed no longer fails on one, but the validation should be tightened where it is written.
- The check-in route logs a removed check-in even when nothing was removed.

## Not verified

Production; real club data and volumes; behaviour under concurrent load; anything in a browser (PR B2).
