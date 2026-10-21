# Class eligibility + plan allowance: verification evidence (21 Oct 2026)

Branch `sean/batch-d-plan-limits`, code head `43bcdadb` (batch-b `0a4a2dcf` merged in at `d43c4fe6`). Local only; nothing pushed. All runs on Node 24 (`node-v24.22.0-win-x64`) from a worktree with no `.env`.

## Gates on `43bcdadb` unless stated
- `npx tsc --noEmit -p .` exit 0; `npm run lint` 0 errors, UI-rules ratchet at baseline.
- Full `npm test` (on `e3559879`; later commits touched only files re-run below): 7287 passed, 2 failed, 663 skipped (database files without a URL — not passed), 3 todo. Both failures reproduce on the base: `tests/unit/member-hold.test.ts` (hard-coded 2026-10-20) and `tests/unit/impersonation-cannot-activate.test.ts` (positive control).
- Focused unit files after the review fixes: 214 passed (doors, window, allowance, editor, migration, atomic, booking, usage, card route, gate).
- Test branch `ep-hidden-salad` migrated with `migrate-test.mjs deploy`: `20261017020102`, `20261017035912`, `20261017052858`, `20261021140000`, `20261021170000` applied (seven `pay_*` migrations present on the branch are not in this worktree).
- DB suites as owner and as `matflow_app`: `tier-class-allowance-db`, `class-membership-tier-db`, `squad-class-tier-db` 34/34 both roles; `checkin-allowance-race-db` 7/7 both roles (120 s on the eight-pair loop); `checkin-allowance-review-db` 6/6 both roles on the second run (first owner run: one "Connection terminated unexpectedly" from Neon on the 36 s pack case, no assertion failure). `pg_stat_activity` during a solo run showed no lock wait over 2 s.
- `server.mjs build`: `BUILD EXIT 0 commit 43bcdadb tree clean`.
- Browser (`matflow-verify-browser`, journey `allowance-eligibility.mjs`, synthetic club `mfv-…`, torn down to 0 rows): 25 PASS / 0 FAIL / 1 NOTE — plan editor summary and period dates, failed saves kept values, retry sent one request, "1 each week" saved and read back, desk ASK with count and reset date, cancel records nothing, admit records the override and the count on the audit row, undo gives the class back, membership-list refusal at the register with the member's sentence, an old client's `tier_not_included` acknowledgement admits no one, phone width no horizontal scroll, Create tier 104×44 px, no page errors.

## Independent review
# Independent review: MatFlow batch-d (class eligibility + plan allowance)

Branch `sean/batch-d-plan-limits`, head `b14f57cb`, range `da405e89..b14f57cb` (80 files). Worktree `C:\Users\NoeTo\AppData\Local\Temp\mf-sean\batch-d`. Read-only review. No `.env` present and none was added. Nothing was run against any database.

## What I ran (on b14f57cb)

- `npx tsc --noEmit -p .`: exit 0.
- `npx eslint` on the 18 changed source files: exit 0.
- `npx vitest run` on 15 focused unit files (class-allowance-window, class-allowance, checkin-allowance-gate, checkin-tier-eligibility, coach-attendance-eligibility, member-booking-allowance, memberships-manager-limit, register-tier-refusal, register-allowance-asks, undo-registry, checkin-tier-doors, checkin-allowance-doors, memberships-allowance-route, migration-tier-class-allowance, coach-attendance-allowance-ask): 15 files, 297 tests passed.
- I did NOT run the database suites (no test-branch URL in the worktree, by design). The full-suite logs in the scratchpad (`full1.txt`, `full2.txt`) show 86 files skipped, so the DB suites were not exercised in that evidence (see H-1 and the open questions).

## Stage 1: spec compliance

| Decision | Verdict |
|---|---|
| 1. Explicit reset periods (week Monday-Sunday / calendar month / every N weeks from a per-plan anchor), never rolling | Implemented (`periodContaining`, `allowanceVerdict`). The rolling-window regression is pinned (`checkin-allowance-gate.test.ts:172`). The reader rule holds: legacy `maxClassesPerWeek` reads as N per calendar week, and a limit with no basis reads as Unlimited. Billing stays separate. The editor shows the summary and the period dates before saving. The migration has one CHECK defect (H-1). |
| 2. Attendance consumes the allowance; booking consumes nothing | Implemented. Statement C counts from rows and excludes imports, cancelled sessions, pack redemptions and the judged session. The fetch range covers an 8-week period plus 2 days of slack. A reversal lands in its own period (count by the class's own slot). A duplicate is caught before the allowance (`alreadyIn`), with P2002 as the backstop. Lock order is Class FOR UPDATE, then eligibility, then Member FOR NO KEY UPDATE, then statement C, then pack/insert. Booking never refuses on the allowance and returns `allowanceNotice`. The notice does not promise admission, but its wording is inaccurate (L-1). |
| 3. Eligibility (roster AND tier) mandatory at every door, no override | Implemented in the engine (`classEligibility` under the Class lock, every method), the coach tick (`lockedClassEligibility`), booking, the register (no tier ask), the card scanner (`refused`) and the kiosk. `acknowledged: ["tier_not_included"]` is stripped at all three staff routes and admits no one (tested). The allowance keeps its staff ask/override with `allowance_reached` recorded. |
| 4. Churn not in diff | Confirmed. |

Stage 1 passes, apart from H-1, which is a defect in the migration that implements decision 1.

## Findings

### Critical
None.

### High

**H-1. The every-N-weeks CHECK accepts `classLimitBasis = 'weeks'` with `classLimitWeeks` NULL, and the DB test that claims otherwise would fail.**
File: `prisma/migrations/20261021140000_tier_class_allowance_basis/migration.sql:40`. Test: `tests/integration/tier-class-allowance-db.test.ts:101`.
Confidence: HIGH (PostgreSQL semantics: a CHECK is satisfied when its expression is NULL).
Scenario: `UPDATE "MembershipTier" SET "classLimit"=4, "classLimitBasis"='weeks', "classLimitWeeks"=NULL, "classLimitAnchor"='2026-10-20'`.
- Branch 1 is `TRUE AND (NULL BETWEEN 2 AND 8) AND TRUE`, which is NULL.
- Branch 2 is `('weeks' IS DISTINCT FROM 'weeks') AND ...`, which is FALSE.
- `NULL OR FALSE` is NULL, so the row is accepted.

`tierAllowance` then reads that row as Unlimited, so the plan silently has no allowance. The API (`refineAllowance`) and the undo guard both prevent this write today, so the exposure is limited to raw or script writes. Two things still make it High:
- The migration is the permanent artefact and has not been deployed, so it is cheap to fix now and costs a new migration later.
- `tier-class-allowance-db.test.ts:101` ("every-N-weeks with no weeks" expecting `MembershipTier_classLimitWeeks_check`) will fail when the DB suite runs. The visible full-suite evidence skipped the DB files, so this has apparently not been run on this head.

The anchor-NULL case is caught correctly, because `IS NOT NULL` is never NULL.

Fix: make branch 1 NULL-safe, for example:
```sql
("classLimitBasis" = 'weeks' AND "classLimitWeeks" IS NOT NULL AND "classLimitWeeks" BETWEEN 2 AND 8 AND "classLimitAnchor" IS NOT NULL)
```
Then update the string assertion in `tests/unit/migration-tier-class-allowance.test.ts:94`. Run `tier-class-allowance-db.test.ts` on the test branch, both roles, before claiming the CHECK set is verified.

### Medium

**M-1. After saving an every-N-weeks plan, the plans table and the editor show it as Unlimited until the page is reloaded.**
File: `lib/class-allowance.ts:72-76` (`isoDateOf`), with `components/dashboard/MembershipsManager.tsx:305-306` (edit) and `:318-320` (create).
Confidence: HIGH.
Scenario:
1. PATCH or POST returns the Prisma row (`app/api/memberships/[id]/route.ts:97`, `app/api/memberships/route.ts:119`). `classLimitAnchor` is a Date, which serialises as `"2026-10-20T00:00:00.000Z"`.
2. The manager merges that response into `tiers`.
3. `tierAllowance(row)` calls `isoDateOf("2026-10-20T00:00:00.000Z")`. That value fails `^\d{4}-\d{2}-\d{2}$`, so the anchor is null and the function returns null (Unlimited).
4. The table (`:442`, `:553`) reads "Unlimited", and reopening the editor (`:227`) shows a blank limit.

No stored data changes: an untouched editor sends nothing. But the owner is told the allowance they just saved is not there, and may re-enter it wrongly.

The unit test passes for the wrong reason. Its mock server returns `rowColumns(...)`, which pre-slices the anchor to `YYYY-MM-DD` (`tests/unit/memberships-manager-limit.test.tsx:61`), so it never sees the real response shape.

Fix:
- Make `isoDateOf` accept a full ISO timestamp, e.g. `if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10)`, or have both routes serialise `classLimitAnchor` as `YYYY-MM-DD` as `app/dashboard/memberships/page.tsx` does. Ideally do both.
- Make the test's mock return what the route really returns (a Date run through `JSON.stringify`).
- Add a test: save "4 every 4 weeks", and the row reads "4 every 4 weeks" without a reload.

**M-2. Card scanner "Admit anyway" no longer settles the asked row in place. It leaves a stale askable row and adds a new one.**
File: `components/dashboard/CardScanner.tsx:376`.
Confidence: HIGH.
Commit `033445f4` (batch-b) changed `const at = confirm?.at ?? Date.now()` to `const at = Date.now()`, and the merge `d43c4fe6` carried that into batch-d. On a confirm resend:
- `r.at === at` (`:384`) never matches, so the asked row is never put back to pending.
- `settle` (`:401`) finds no row and prepends a new one (`:406`).

The coach is left with two rows for the same card:
- the old "Allowance used" row, still with its "Admit anyway" button;
- a new "Checked in" row.

A second tap on the stale button sends again and adds a third row, "Already in". The audit and the record are correct; the screen is wrong. This breaks the documented contract in the doc comment at `:364-368`. Before 20 Oct this path served the tier ask; now it is the only ask the scanner has (the allowance).

Fix: restore `const at = confirm?.at ?? Date.now();`. Add a component test: needs_confirmation, then Admit anyway, then one row that reads success.

### Low

**L-1. The booking notice wording is inaccurate.**
File: `lib/class-allowance.ts:341`.
Confidence: HIGH.
"You'll be refused at check-in unless a place frees up" has two problems:
- "a place" reads as capacity. The only thing that frees an allowance is a reversed attendance or the reset.
- It is untrue for a member with a class pack (the member app and kiosk then pay with the pack) and at staff doors (staff are asked).

It never promises admission, so decision 2's copy rule holds. Suggested: "{count}. Booking doesn't use a class, but checking in before {reset} will need a class-pack credit or staff to admit you." Update `tests/unit/class-allowance-window.test.ts:181` and `member-booking-allowance.test.ts:49`.

**L-2. A failure computing the booking notice refuses the booking.**
File: `app/api/member/class-subscriptions/[classId]/route.ts:142`.
Confidence: MEDIUM.
`bookingAllowance` runs inside the booking transaction. Any throw there rolls back the `classSubscription.create` and returns 500 "Failed to subscribe". Examples: the tenant lookup failing, the raw statement failing, or a malformed `visits` making `JSON.parse` throw in `parseVisits`. Decision 2 says booking is never refused for the allowance.
Fix: wrap the notice in try/catch and log, falling back to `allowanceNotice: null`; or compute it after the booking transaction commits.

**L-3. The plan editor's summary is computed on the browser's clock and zone, not the club's, and addresses the administrator as "Your".**
Files: `components/dashboard/MembershipsManager.tsx:97` (`todayIso`) and `:131`; `lib/class-allowance.ts:371`.
Confidence: HIGH.
An owner editing from abroad sees period dates on their own calendar. On the day of a boundary they can be a day out. The engine uses `Tenant.timezone`.
Fix: pass the tenant timezone into the manager from the page and use it in `nowMinute`. Change "Your next reset is" to "The next reset is" in the editor sentence.

**L-4. The anchor date is not range-limited, and `dateMinute` uses `Date.UTC`, which maps years 0-99 to 1900-1999.**
Files: `lib/class-allowance.ts:179-182` and `:396-399`.
Confidence: HIGH.
An anchor of `0050-01-01` passes the schema and is stored as year 50, but periods are computed from 1950. This is cosmetic on today's dates but wrong.
Fix: refine the anchor to a sane window (e.g. 2000-2100) in `classLimitAnchorSchema` and `formAllowance`, or build the minute with `new Date(0).setUTCFullYear(y, m-1, d)`.

**L-5. The client-side anchor check can throw during render.**
File: `components/dashboard/MembershipsManager.tsx:123`.
Confidence: MEDIUM.
For a regex-valid but impossible value (e.g. `2026-13-01`, possible where `type="date"` falls back to text), `new Date(...)` is Invalid and `.toISOString()` throws a RangeError inside `formAllowance`. That function is called during render (`allowanceNote(formAllowance(form))`), so the editor crashes rather than showing `PERIOD_START_ERROR`. Modern browsers normally prevent such input.
Fix: guard with `Number.isNaN(d.getTime())` before `toISOString()`, as the server schema does.

**L-6. The register asks the hold, waiver and kids questions before a mark the server will refuse on eligibility.**
File: `components/dashboard/RegisterPanel.tsx:275-307`.
Confidence: HIGH.
The row already knows `m.tierNotIncluded` / `m.notOnRoster` and shows "Can't be marked in". Despite that, `mark()` can put up to three "Admit anyway" dialogs and then show the refusal.
Fix: in `mark()`, short-circuit to the refusal sentence when the row is flagged, or disable the tick for flagged rows.

**L-7. Walk-in candidates at a squad class carry no "not on the squad list" flag.**
File: `app/api/checkin/members/route.ts:34-104`.
Confidence: MEDIUM.
`hasRoster` was removed and no `notOnRoster` was added to the candidate shape, so the desk only learns of the refusal after trying.
Fix: return `notOnRoster` for candidates and render the same "Can't be marked in" line.

**L-8. Allowance copy says "this week" / "this month" for the session's period even when that period is not the current one.**
File: `lib/class-allowance.ts:293-296`, used by `allowanceAskSentence` and the refusal.
Confidence: HIGH.
Example: a desk mark for a session in a past period reads "has used all 8 classes this month (... resets on Sunday 1 November)" in November.
Fix: when the judged period does not contain now, name the period ("the week of Monday 13 October", or the date range) instead of "this ...".

**L-9. Coach tick: the tier is read for eligibility before the Member lock, with no change detection.**
File: `app/api/coach/instances/[id]/attendance/route.ts:76-90`, via `lib/checkin.ts:434`.
Confidence: MEDIUM.
A plan change that commits between `lockedClassEligibility`'s member read and `staffAllowanceAsk`'s Member lock has these effects:
- eligibility is judged on the old plan;
- the allowance is judged on the new plan.

`performCheckin` closes this with `memberChangedSince`. The tick path does not. The window is narrow, and no current UI calls this route (every screen marks through `/api/checkin`).
Fix: take the Member lock first inside `lockedClassEligibility` (still after the Class lock), or re-read the tier under the lock and refuse or restart if it changed.

**L-10. Two statement C subqueries rely on joins and RLS rather than explicit `tenantId` filters.**
File: `lib/class-allowance-count.ts:114-134`.
Confidence: HIGH.
The `alreadyIn` subquery (`a0`) and the `ClassPackRedemption` subquery have no explicit `tenantId` filter. They are scoped through `m."id"` and `a."id"`, and run under RLS, so this is not exploitable, but `docs/TENANT-SCOPE-CONVENTION.md` asks for the filter on every query.
Fix: add `AND a0."tenantId" = m."tenantId"`. For redemptions, join through the pack's tenant or accept and document the exception.

**L-11. The card route applies one `acknowledged` to every token in the request.**
File: `app/api/checkin/card/route.ts:131-134`, `:260`.
Confidence: MEDIUM.
Up to `MAX_TOKENS_PER_REQUEST` cards in one request with `["allowance_reached"]` are all admitted past their allowances on a single confirmation. The shipped client sends one card per confirm, and the shape predates this diff (it served the tier ask).
Fix: when `acknowledged` is present, require exactly one token (`tokens.length === 1`).

**L-12. The branch is behind `origin/main`.**
Confidence: HIGH.
The merge base is `1796d9dd`; `origin/main` is at `e954482f` (PRs #42 and #43). There is no migration ordering clash: main's newest migration is `20261009010000` and this branch adds `20261017*` and `20261021*`. The branch still needs a merge-forward and a re-run before a PR.

## Open questions (lower confidence; reported, not blocking on their own)

- **[HIGH] The DB suites appear not to have run on this head.**
  Confidence: MEDIUM.
  The visible full-suite runs (`full1.txt`, `full2.txt`) skip 86 files. H-1 shows `tier-class-allowance-db.test.ts` would not pass as written. The race and review DB tests that pin decision 2's concurrency claims need a run on the test branch as both roles, on the commit that ships:
  - `checkin-allowance-race-db`
  - `checkin-allowance-review-db`
  - `class-membership-tier-db`
  - `squad-class-tier-db`
- **[MEDIUM] How a raw `DATE` comes back from `$queryRaw` under `@prisma/adapter-pg`.**
  File: `lib/class-allowance-count.ts:143-149`.
  Confidence: LOW.
  `isoDateOf` handles a `YYYY-MM-DD` string or a UTC-midnight Date. If the driver ever returned a local-midnight Date (node-pg's default for DATE) on a non-UTC host, the anchor would shift a day. Vercel runs UTC, and the DB tests would show it. Worth one assertion in a DB test using a weeks-basis plan through statement C.

## Positive observations

- The lock discipline is consistent and documented:
  - Class FOR UPDATE, then eligibility, then the unconditional Member FOR NO KEY UPDATE, then a single-snapshot statement C, then pack/insert, in both engine branches and in the coach tick.
  - `MemberChangedMidCheckin` restarts are bounded.
  - Nothing is written before a restart.
- The rolling-window regression, "duplicate before allowance", the reversal landing in its own period, both-gates composition and the old-client strip are all pinned by focused tests, with fixtures that would fail under the old behaviour (`checkin-allowance-gate.test.ts:172`, `:182`, `:226`; `coach-attendance-eligibility.test.ts:105`).
- Allowance arithmetic on a wall-clock minute scale makes the DST boundaries a non-issue, and it shares `dayMarkerUtc`'s nearest-midnight rule, so legacy marker spellings agree.
- `overrideFields` emits only `allowance_reached`. A confirmation sent when nothing was asked records no override (tested). A pack paying after the allowance is used is neither counted nor reported as an override.
- On write validation:
  - `refineAllowance` and `allowanceColumns` keep the set consistent and refuse legacy/new mixes.
  - The weekly basis mirrors into `maxClassesPerWeek` for rollback.
  - The undo guard refuses inconsistent restores in words.
- Refusal copy is centralised in `checkinRefusal`, so the register, card scanner, kiosk, booking and member app read the same sentence.

## Verdict

CHANGES REQUIRED

Findings: Critical 0 · High 1 · Medium 2 · Low 12. Open questions: 2.

The required changes are small:
- H-1 is a one-line CHECK fix, plus a DB-suite run on the test branch.
- M-1 is `isoDateOf` or the response serialisation, plus a realistic test mock.
- M-2 is restoring `confirm?.at`, plus a component test.

The Low items can ride along or be logged.
## Scoped re-review of the fixes

# Re-review (head 43bcdadb)

Verdict: APPROVED WITH RESIDUALS

Counts: Critical 0, High 0, Medium 0, Low 2.

Fix checks (read from fix-diff.patch; DB suites not run by me, per brief):
- H-1: new migration is NULL-safe for both branches (weeks IS NOT NULL, anchor IS NOT NULL; non-weeks branch requires NULLs; NULL basis legacy rows still pass). Original file untouched, new file is last in order, atomic BEGIN/COMMIT, unit test pins the expression. Correct.
- M-1: isoDateOf now slices a Z timestamp; test mock now returns the JSON-serialised Date. Correct.
- M-2: `confirm?.at ?? Date.now()` restored; scanner sends exactly one token per confirm, so it matches the new L-11 guard. Correct.
- L-1, L-2 (try/catch + test), L-5 (NaN guard), L-10 (tenant filter on alreadyIn), L-11 (400 unless exactly one token + test): correct, no new defects found.

Low:
- L-A: M-2 has no component test; this exact line regressed once via a merge. Acceptable as residual (one-line restore, documented contract), but it can regress silently again. Add a CardScanner render test when camera/BarcodeDetector mocks exist.
- L-B: raised DB timeouts (120 s / 90 s) are plausible given network-bound sequential check-ins, but only a before/after timing would prove no slowdown from the added eligibility reads. Record the observed durations.

Residual list is honest: L-3, L-4, L-6, L-7, L-8, L-9, L-12 and the redemption-subquery half of L-10 are unchanged and correctly logged.
