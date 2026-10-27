# Headcount and movement (Sean's notes 3 and 4; rows 7, 8 of the task record): verification evidence, 23 Oct 2026

Branch `sean/batch-c-headcount`, PR #39. Candidate `778428bd` = the branch merged with `main` `41b608aa` (`cda844eb`), test timeouts and lint (`c4bc2846`, `acf13a5a`), then the reporting branch integrated at `8f191b70` (`a5eb13cd` merge + test fixes `b8976d65`, `58cf288a`, boundary test `126af5ae`) and again at `c5c2171f` (`778428bd`), so both branches carry one version of every reporting rule (shared populations, server-side Members totals, club-zone month in `lib/club-month.ts`, one payer rule, `lib/percent.ts`, tenants CSV "Members" + "Active members"); batch-c's own month helpers were deleted in favour of batch-a's; reports cache key v6.

## Gates on `778428bd` (Node 24, worktree without `.env`)
- `tsc --noEmit` exit 0; `npm run lint` 0 errors / 78 warnings (= `main`; the three warnings this branch had introduced in `tests/unit/member-status-event.test.ts` removed).
- Full `npm test`: 522 files, 7373 tests passed (88 database files skipped without a URL — not passed).
- Neon test branch: migration `20261017022302_status_event_source_provenance` applied (`migrate-test.mjs deploy`); it is the newest migration on the branch.
- Database suites as owner and as `matflow_app`: **34/34** — `member-population-parity` (incl. the 1,600-member tenant), `t8a-status-history-db`, `t8b-status-backfill-db`, `t8c-membership-db`, `t8d-status-provenance-db`, `member-children-lifecycle`. Five long cases (two erase-route calls; commit then rollback with probe dates; the whole detect→preview→apply→re-apply→rollback cycle across two clubs; the ledger/back-fill/replay report) needed explicit per-test timeouts of 120–180 s and 60 s transaction budgets from this machine (Neon ≈ 205 ms round trip); with the defaults they timed out at 30 s with no assertion failing, as both roles.
- `server.mjs build`: `BUILD EXIT 0 commit 778428bd tree clean`.
- Browser on that build, synthetic clubs torn down to 0 rows each time:
  - `headcount-movement` **35 PASS / 0 FAIL / 4 NOTE**: Ana (new) and Ben (taster) created through `POST /api/members`, Cara reactivated and Eve cancelled through `PATCH /api/members/[id]` so the status events are written as production writes them (back-dated history and the prepaid-course completion seeded by SQL, recorded in a note); the tally "Feb 26 – Oct 26: 6 new · 1 rejoined · 3 lost (2 cancelled, 1 completed course) · net +4 · 4 active members today"; the definition line; the Members view switch with its subtitle and "Active members" axis; the chart's axis starting at 0; one dot per month at its month-end headcount (3,3,3,3,2,2,2,2,4) read from the SVG; the last point equal to today's Active members by position and by tooltip ("Active members today: 4"); the Bars tooltip for this month (Joined with new/rejoined, Lost with cancelled/completed course, Net) equal to the tile's Net; the CSV "Membership movement", "Membership movement by month" and "Active members at month end" rows equal to the screen (the last headcount row "Today, equals Active members"); the Joined and churn drill-throughs; the same at 390 px with the tooltip reached by a real tap. (A first run read 27/35: recharts 3 renders tick labels and tooltips in portalled layers, so the harness selectors were corrected; the screenshot of that run already showed the chart as asserted.)
  - `reporting-truth` **47 PASS / 2 FAIL**: the two failures are the Joined tile's Net text, which this branch changes from `joined − cancelled` to the movement net — the D11 divergence below, not a regression of the reporting branch's other 47 checks.

## Decision D11 (Noe) — Joined tile versus movement
The Joined tile counts `joinedAt` in the club month (any status) and Cancelled counts `cancelledAt`; the movement series counts status events into and out of active. Measured on the journey's club: tile rule joined 4 / cancelled 1 (net +3) against movement net +2, so the tile reads "Joined 4 · Net +2". Recommendation: take Joined (= new + rejoined), Left (= lost) and Net from movement, and show tasters added on their own line, so the number beside churn and the chart agree. Worked example (London, October): Ana added 5 Oct active → new; Ben added 10 Oct as a taster → tasters added, not Joined; Cara cancelled in June, reactivated 12 Oct → rejoined; Dan's prepaid course ended 20 Oct → lost; Eve cancelled 15 Oct → lost. Joined 2, Left 2, Net 0, tasters added 1. Until decided the tile keeps the current mix and both journeys record it as a note.

## Back-fill rehearsal
`scripts/backfill-status-events.ts` refuses production outright (`scripts/backfill-status-events-guard.mjs`: the shared target guard with `allowProduction` false, the production short name and a `--production` flag rejected before the URL is parsed). A preview on a production-derived branch needs Noe's authorisation to create that branch (`docs/runbooks/RESTORE-REHEARSAL-ISOLATED.md` §1 and §3: one Neon branch from the production root, 24-hour deletion deadline, branch URL carries the production password). A rehearsal on the synthetic test branch is recorded below when run.

## Independent review
See the PR #39 comment for the verdict on `778428bd`.

## Review
Verdict on `778428bd`: APPROVED, on the condition that the F1 count was read before merge. Critical 0, High 0, Medium 1, Low 6.

**F1 (Medium): closed by the production count. No code change.** The concern was that refresh and refresh-rollback events written before provenance existed (`sourceAction` null) would be misread: a completed course as "other changes", and a rollback as a loss plus a rejoin. Such an event would show as `reason = 'import'` with a non-null `fromStatus`, because an import create is always `none → status`. Noe read the count on production, read-only, at 23 Oct 2026 03:29Z with `scripts/readiness/status-event-provenance-count.mjs` (one `READ ONLY` transaction, aggregates only):

Result (sanitised; club-level counts are kept privately by the owner): **0 import events carrying a `fromStatus` at every club.** At the customer club every import event is a create; the demo club has no import events.

The count is 0, so production holds no refresh or rollback event without provenance, and F1 is closed. This holds as of 03:29Z on 23 Oct. A TeamUp refresh or rollback run on production by the deployed build before this branch ships would write such events. Re-run the count just before merge. If it is not 0, extend `scripts/backfill-status-event-provenance.ts` as the review describes, before merge.

**F2–F6: fixed on this branch, each in its own commit with a test that failed before the fix and passes after it.**

| Finding | Commit | Change |
|---|---|---|
| F2 | `a11f8710` | A refresh cancellation is dated at midnight in the club's timezone (`clubMidnight`, the back-fill's rule), not at UTC midnight. A New York club's 1 Oct cancellation now lands in October. The commit route passes `Tenant.timezone`. For London clubs during BST, the event moves from 00:00Z to 23:00Z the day before, which is the same London day. |
| F3 | `4bbee7b5` | A refresh course completion (into `inactive`) is dated by the day the course ended, at club midnight, not by the export time. The parser carries the end on the draft as `courseEndedAt`: Completed At, or the Cancelled Date if there is none, in the back-fill's order. The refresh plan keeps it on the change. The writer's clamp still applies. **Superseded (26 Oct 2026):** under the 25 Oct later-upload rule a refresh writes no status event, so this dating had no caller and was removed in `5bdf1347`; the back-fill keeps its own end-of-course rule. |
| F4 | `a1c9a6c4` | `lib/status-backfill.ts` no longer has its own `clubMonthKey`. It imports and re-exports the one in `lib/club-month.ts`. The existing back-fill tests were not changed. |
| F5 | `abcefde5` | The lock comment is corrected in `prisma/migrations/20261017022302_status_event_source_provenance/README.md`. `migration.sql` is unchanged: a test pins its hash, because the migration has been applied to the test branch. |
| F6 | `23319f43` | `--rollback` alone now only previews. Per club, it prints the back-filled events it would delete, by month and kind, and a rollback digest over the exact event ids. `--rollback --confirm-digest <digest>` deletes only the previewed ids. If they have changed, it refuses and leaves the club untouched. The apply digest now covers every planned (member, occurredAt, toStatus), the months by kind and the exceptions by ledger row id. The in-transaction re-plan is checked against the same digest. |

**Gates on `23319f43`** (Node 24, worktree without `.env`):

- `tsc --noEmit`: exit 0.
- `npm run lint`: 0 errors, 78 warnings, the same as `main`.
- Touched unit files: all pass.
- Full unit suite: 522 files passed, 88 skipped (database files without a URL, which counts as not passed). 7,390 tests passed, 636 skipped, 3 todo.
- Two files failed in the full suite. Neither is touched by these commits, and both passed 3 of 3 runs in isolation:
  - `csv-export-fidelity` timed out at 30 s on its dynamic import under full-suite load;
  - `sec-f3-secret-scan-residuals` is the known random-draw flake.
- Not run on these commits:
  - the database suites (`t8a-status-history-db` now expects a refresh cancellation at London midnight, 23:00Z);
  - the production build;
  - the browser journeys.

**F7 (Low):** the PR body is out of date (it says cache v4, and its counts predate the merge). Updated text was handed to the coordinator. This evidence doc and the read-only count script are now committed.

## F1 count re-read 23 Oct 2026 13:32Z
Same script, same `READ ONLY` guard: still 0 import events carrying a `fromStatus` at every club (sanitised; counts kept privately). `sourceAction` does not exist yet (migration `20261017022302` pending). F1 stays closed as of 13:32Z. Repeat the count just before merge if a TeamUp refresh or rollback could have run on production since.
