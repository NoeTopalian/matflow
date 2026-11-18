# Round 7 — import accuracy and reconciliation (13 Nov 2026)

Branch `programme/rounds`, from the Round 6 close-out `effd0532`. Local only: not pushed, not merged, not deployed.
Brief: the programme brief's Round 7, and the owner's 13 Nov instruction (the rules to preserve and the cases to
cover). Synthetic data only: every test and journey club is created and torn down by its run.

## Release state

| | State |
|---|---|
| Implemented | yes, local commits on `programme/rounds` (below) |
| Independently reviewed | Round 7 commits: approved after fixes; re-review of the retry fixes: approved; review of the batching, test and harness commits: nothing blocking, two should-fix items, both fixed (Review, below) |
| Tested locally | yes, on `dbe693ce` and `06eb7030` (Verification, below) |
| Pushed / merged / deployed | no |
| Category management | a separate track (activated in production on 14 Nov 2026); nothing here touches it |
| Round status | **closed 15 Nov 2026** against the round's acceptance: every rule held with a real-route DB test, every finding fixed or recorded, both database roles green on the current test code, review approved |

## Rules held (the owner's list)

Each was traced in the code and is covered by a test that runs the real routes against Postgres.

| Rule | How it holds | Evidence |
|---|---|---|
| Existing values are not overwritten | An import never writes to a member who already exists; a difference or an uncertain match is listed for the owner. A later upload (refresh) writes no member since 25 Oct 2026 | `import-conflicts-db` (staff-edited plan and status survive; refresh changes nobody); `contact-email-change-imports-db` (refresh with the original rows writes nothing) |
| New people are added | `createMany` per 25-row slice after classification | every import DB file |
| Exact repeats are not duplicated | exact duplicates of members are skipped; rows repeating an earlier row of the file are grouped (`fileRepeats`) | `import-conflicts-db` (same file again creates nobody; rows sharing an email) |
| Ambiguous matches are flagged | uncertain matches and email/record-key disagreements are listed, nobody created or changed | `import-conflicts-db` |
| Existing edit permissions | every import handler is owner-only (`requireApiOwner`), jobs read by `{ id, tenantId }` | `import-conflicts-db` (owner-only, another club's job not found), `sec-d2-import-attacker-model-db`, `import-panel-owner-only` |
| A plan only with evidence | a plan is set only when name, billing period, price and currency agree with one active plan; TeamUp states no price, so TeamUp imports set none and list why | `import-conflicts-db`, `plan-match`, `import-plan-match`, journey `import-review` J2b/J3 |
| No manufactured join | import status events carry reason `import` and are excluded from conversion; `joinedAt` only from the file | T8 tests, `lib/attribution.ts` |
| Missing payment is not paid | a blank or unrecognised payment status is stored as "No payment yet" | `import-conflicts-db` |
| No invented historical payments | TeamUp rows are billed by TeamUp and never seed a MatFlow due date | `import-commit-integrity` F-R5-1 |
| No external effects | no charge, subscription, push or member email anywhere in the import, refresh or rollback code. One intended effect: a completion email to the owner who ran the import, through the email-delivery switch | code read (`lib/importers`, import routes, attendance import, reconciliation, storage) |

## Findings

### R7-1 — the commit re-checked everyone but did not say when the outcome differed from the preview (FIXED)
- **Reproduction:** `round7-preview-commit-drift-db`. Preview a file; before the commit, staff add one of its people
  by hand. The commit correctly did not create or overwrite that person, but the owner saw different numbers from the
  preview with no explanation. Failed 2 of 2 on the unfixed route.
- **Fix:** `fceb6c09`, review fixes `4dff812b`. `lib/importers/since-preview.ts` compares the stored preview with the
  commit like for like (rows, not addresses; a resumed run's own earlier rows counted on both sides) and the commit's
  manifest carries `sincePreview`; the import panel lists each count that changed ("<what>: N in the preview, M at
  import") under a plain sentence that the import numbers stand.
- **Behaviour unchanged:** the commit already re-classified everyone at write time; no rule changed.

### R7-4 / N1 — an interrupted import, previewed again, then resumed, did not add up (FIXED, pre-existing)
- **Reproduction:** run interrupted, the owner previews again, then commits: the resume was detected from the job's
  status only, which the new preview had reset, so the job did not reconcile and `importedRows` was too low.
  Reproduced on `4dff812b`.
- **Fix:** `2f01cd8a`. A run counts the people this job already created (not erased) and treats any as a resume.

### R7-13 — a retried import left the history of the people it created unlinked (FIXED, pre-existing)
- **P1 (data):** an interrupted TeamUp run writes every ledger row, those of people it had not created yet with no
  member; the retry's inserts of the same rows are skipped as duplicates, so the people created on the retry had no
  imported membership history on their record, in the history route or in a subject-access export.
- **P2 (accounting):** an erasure between the interrupted run and the retry left the job not adding up.
- **Fix:** `5e677b58`. Unlinked rows are linked to the person this job created for them, by the row's content
  fingerprint and disposition (both survive an erasure rewriting the stored file); members an erasure anonymised are
  counted apart (`erasedSinceImport`). Both new assertions failed on `367a662a`.
- **Q1:** the linking first ran in one transaction, which a large retry could push past the 15 s transaction limit,
  stopping every later retry at the same place. `a1cef92d` split it into batches of 100; review found 100 sequential
  round trips still pass the limit on a slow link (226 ms a round trip measured from Bali), so `06eb7030` uses 20.
  A DB case links 45 people across three batches; with the linking cut to its first batch it fails with 25 unlinked.

### Held, with new tests
- **Overlapping jobs (R7-3):** two imports naming the same people, committed at the same instant: each person once,
  the other job counts them as already here, both reconcile (`round7-import-retry-overlap-db`).
- **Retry (R7-4):** an interrupted run then run again: everyone once, the retry reports its own share, the job
  reconciles, each status event once.
- **Staff edit during a commit (R7-5):** the import never writes an existing member; the edit stands.
- **Erasure, then retry or rollback (R7-10):** `round7-erasure-retry-rollback-db`, with real private chunk storage:
  the erasure rewrites the stored file, so a retry does not recreate the person; a rollback after an erasure leaves
  nothing of the person, including after another job had listed them for review.

### Guarded, not reachable (recorded)
- **R7-2:** a new row skipped silently on a unique key other than email. Member uniques are email, `externalRef` and
  `createRequestId`; two drafts with one record key would share an email and be grouped first.
- **R7-12:** duplicates within a file without an email or under one parent: the generic importer refuses rows with no
  email and sets no parent link; TeamUp folds rows into one person per key.

### Recorded, not changed (accounting only; no data exposed)
Each needs an erasure (or a crash) between an interrupted run and its retry.
- **P3:** a resumed run's own row now refused for a staff login is counted twice.
- **Q2:** an erased person's rows with no member (already in the club, or a repeat row) still count as persisted, so
  such a retry says the job does not add up.
- **Q3:** a history row whose content the erasure blanked stays unlinked (never linked to the wrong person).
- **Q4:** the import panel does not show `erasedSinceImport`.
- **Q5:** a crash part-way through the ledger write, then an erasure, can leave a row out on retry (the ledger is keyed
  on row number, which the erasure renumbers).

## Review

- Round 7 commits (to `4dff812b`): approved with fixes (like-for-like counts; softer copy), applied.
- Re-review: P1/P2 above, both pre-existing on the retry path, fixed in `5e677b58`; re-review of that commit approved
  (checked shared fingerprints, repeats, quarantined rows, first-run unlinked rows, people already in the club,
  erased members: no wrong link possible). Q1 to be fixed before merge (done, above); Q2 to Q5 recorded (below); Q6
  (where a predicate is declared) applied in `a1cef92d`.
- Review of `a1cef92d`, `9551f129`, `d918f4a5`: nothing blocking. Should fix: the batch size (above, fixed
  `06eb7030`); the journey's privacy check could pass on a list still loading (fixed: it now requires the loaded list,
  the remove and erasure statuses, and neither the name nor the address).

- Review of `06eb7030` and `dbe693ce`: approved. Three LOW notes, recorded for the backlog, not applied (each would
  change the test file and re-open its two-role runs for no change in behaviour): assert 45 unlinked rows before the
  retry in the batch case; reset `failOnCalls` in a `finally`; the batch comment understates the fixed round trips
  (about 25 per batch of 20, about 5.7 s at 226 ms, still inside the 15 s limit).

## Verification

Neon test branch only (synthetic clubs, created and torn down by each run; a stray-club check after every killed or
finished run found none left). `dbe693ce` changes one test file from `06eb7030`; the app code is identical.

| Check | Commit | Owner role | Restricted role (`matflow_app`) |
|---|---|---|---|
| `round7-import-retry-overlap-db` | `dbe693ce` | 4/4 | 4/4 |
| `round7-preview-commit-drift-db` | `06eb7030` / `dbe693ce` | 4/4 | 4/4 |
| `round7-erasure-retry-rollback-db` | `06eb7030` | 2/2 | 2/2 |
| `import-conflicts-db` | `dbe693ce` / `06eb7030` | 18/18 | 18/18 |
| `contact-email-change-imports-db` | `06eb7030` | 6/6 | 6/6 |

| Check | Commit | Result |
|---|---|---|
| Mutation: batch linking cut to its first batch | `06eb7030` | the batch case fails, 25 unlinked |
| `tsc`, lint (UI-RULES ratchet) | `06eb7030` | 0, 0 |
| Production build | `06eb7030` | clean |
| Full unit suite | `06eb7030` | 9,683 passed, 1 failed: `csv-export-fidelity`, vitest's 30 s timeout on a dynamic import of the Reports view under full-suite load ("Test timed out in 30000ms"); 3/3 alone; not import code |
| Journey `import-review` | build of `06eb7030` | 14 passed, 0 failed; torn down |

Runs from Bali (226 ms a round trip to the test branch) use a 300 s per-test limit; earlier runs killed by the old
limits or by the machine sleeping gave no result and none is claimed from them.

## Defects found by the verification itself

- **Unit fakes:** the full unit suite on `a1cef92d` failed 8 tests in 5 files that fake the database for the import
  commit; the Round 7 commits added queries the fakes lacked. Fixed `9551f129` (fakes model the new queries; the
  migration-lock guard counts the linking batches as the fifth transaction). That commit failed `tsc` (a fake typed too
  narrowly), fixed in `06eb7030`.
- **Journey harness:** `import-review` P1 tested "delete", but since the member-archive change Remove keeps the person;
  erasure is now the only delete. The teardown did not delete kept import uploads (since 6 Nov), so it failed on a
  foreign key and left the run's club; that club was torn down with the fixed script (nothing left). Fixed `d918f4a5`.
- **Unrelated, recorded:** `sec-f3-secret-scan-residuals` failed once in the full suite. Its fixture is random; the
  exact case misclassifies 78 times in 200,000 draws (about 1 in 2,500 runs). Scanner and test unchanged since the
  programme began. Backlog: make the fixture's random stretch deterministic in shape.
