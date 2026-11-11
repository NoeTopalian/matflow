# Club-managed class categories, Release A: design, compatibility and evidence (11 Nov 2026)

## Status

- **Branch:** `feat/class-categories-a`, local only. Not pushed, not merged, not deployed.
- **Commits:** base `main` `33592fe0` → `6e3aebae` (release) → `9712e19e` (fixes from the independent review). The document itself is committed after that; the commits it records are `9712e19e`.
- **Results:** each result below names the commit it ran on. Anything without a commit has not run.
- **Data:** synthetic only, on the Neon test branch and on throwaway `matflow_rehearsal_*` databases.

**Authority** (Noe, 11 Nov 2026):

- Implement Release A of the two-release approach.
- Category names are limited to 32 characters.
- Category management goes in Activity without Undo; a class's category changes stay undoable.
- Implementation and isolated non-production testing only. No push, merge, deploy or change to Sean's records.

**Release approval** is a separate decision for Noe (§13).

## 1. What Release A is

- **Club-owned rows.** Each club gets its own `ClassCategory` rows.
  - Every existing club starts with the eight categories that used to be fixed. They are named exactly as today, "Open mat" included, and each carries its old key in `legacyKey`.
  - A club created from now on starts with the same eight, but spelled "Open Mat".
- **The class's link.** A class points at one category through `Class.categoryId`. The composite foreign key `(categoryId, tenantId)` → `ClassCategory(id, tenantId)` makes another club's category impossible.
- **The old column.** `Class.category` and its CHECK stay, so a build from before this release keeps working. Database triggers keep the two columns in step on every write, whichever build writes (§3).
- **Readers** show the club's name for the category, and still return the old key for pages from before the release. They are:
  - the timetable class card and week chip;
  - the member schedule;
  - member home;
  - the kiosk.
- **Create and edit** write `categoryId`. An old key from an older page is translated to the club's category with that key.
- **Undo** restores `categoryId`. Rows recorded before the release are translated (§7).
- **Activity** shows the category's name.
- **Release B's job.** There is no category management screen in this release.

## 2. Migration `20261111120000_class_categories`

It runs as one transaction with `lock_timeout 5s` and `statement_timeout 15s`.

1. `LOCK TABLE "Class" IN ACCESS EXCLUSIVE MODE`, then `LOCK TABLE "Tenant" IN SHARE ROW EXCLUSIVE MODE`.
   - Class comes first, as in the application. Taking the Tenant lock first, through the foreign key, could deadlock with a live transaction that holds a Class row and then updates its Tenant.
   - Both locks fall under the 5 s wait.
2. `app.bypass_rls` is set for this transaction only.
3. The `ClassCategory` table, with:
   - unique keys on `(id, tenantId)`, `(tenantId, nameKey)` (archived names stay taken) and `(tenantId, legacyKey)`;
   - CHECKs: `legacyKey` is one of the eight or NULL, and `char_length(name)` is between 1 and 32;
   - a tenant foreign key with ON DELETE CASCADE;
   - row-level security enabled and forced, with the standard `tenant_isolation` policy.
4. `Class.categoryId` with its composite foreign key (MATCH SIMPLE, so NULL means uncategorised; NO ACTION) and its index. Also `Class.categoryKeyWrittenAt`, which the trigger stamps on old-key-only writes (§6).
5. `matflow_seed_class_categories(tenant, open_mat_name DEFAULT 'Open Mat')`.
   - Ids are deterministic (`'cc_' || md5(tenant || ':' || key)`) and inserts use `ON CONFLICT DO NOTHING`, so it can be rerun.
   - It is the one seed used by the migration, by the trigger (for a club made by an older build) and by every club-creation path.
6. Every existing club is seeded with "Open mat".
7. The marker triggers and the bridge (§3). Every function is SECURITY INVOKER with `search_path` pinned to `public, pg_temp`.
8. Backfill: each class with an old key gets its own club's row for that key, matched by (club, key) only.
9. A closing check refuses to commit unless every class's key and reference agree.

Nothing is renamed, archived or matched by name, and uncategorised classes stay uncategorised.

## 3. The trigger's exact rules

A row trigger sees values, not which columns a statement named. So two marker triggers, each `BEFORE UPDATE OF` one column, record the row's id in a transaction-local setting before the bridge runs. Their names sort first, and triggers on a row fire in name order. The bridge reads the markers and clears them, so a later statement in the same transaction never inherits them.

"Named" means:

- for an UPDATE, the statement set that column;
- for an INSERT, the column was given a value.

| The write | The bridge does | Proved by (DB suite, both roles, `9712e19e`) |
|---|---|---|
| names neither column (an unrelated edit) | Does not fire (`UPDATE OF`). Nothing changes. | "an unrelated edit leaves both alone" |
| names both, and they agree (the key is the row's `legacyKey`, or both are NULL, or the row is club-made and the key is NULL) | Accepts. A new assignment to an archived row is still refused. | "both named … still refused when they disagree" (its agreeing half); "both in one write" |
| names both, and they disagree, **even when one equals its current value** | Refuses the whole write (`MF_CLASS_CATEGORY_CONFLICT`). It never resolves the conflict in favour of either column. | the same two tests, through raw SQL and through Prisma |
| names only `categoryId`, changed to a row | Reads that row of this club `FOR SHARE`. Refuses if the row is missing (`NOT_FOUND`) or archived (`ARCHIVED`). Otherwise sets `category` to the row's `legacyKey`, which is NULL for a club-made category. | "reference only"; "archived categories" |
| names only `categoryId`, changed to NULL | Sets `category` to NULL. | "reference only" |
| names only `category`, changed to a key | Stamps `categoryKeyWrittenAt`. Finds this club's row for that key `FOR SHARE`; if the club has no rows yet, seeds the eight first. Refuses if the row is archived, otherwise sets `categoryId`. | "old key only"; "seeded by its first class"; "an old-key-only write is stamped" |
| names only `category`, changed to NULL | Stamps `categoryKeyWrittenAt` and sets `categoryId` to NULL. | "old key only" |
| names one column but leaves it unchanged | Does nothing. | "a column named in one statement is not carried into the next" |

The `FOR SHARE` read makes an archive of a category and an assignment to it wait for each other, whichever comes first:

- If the archive comes first, the assignment waits and is then refused.
- If the assignment comes first, the archive waits, then lands, and the class keeps its category.

Both orders were proved on two real connections, each asserting that the second transaction was still waiting while the first was uncommitted. A foreign key's `KEY SHARE` alone would not have made the archive wait.

The lock order is recorded in `docs/design/LOCK-ORDER-2026-10-24.md`: level 4, with the rules Release B must keep.

## 4. Compatibility matrix

The builds are:

- **pre-A:** `main` at `33592fe0` or earlier, with every migration up to `20261106120000`.
- **A:** this branch.
- **B:** category management, not built yet.

| | During the migration (one transaction) | After it, before B is activated (only the eight starting rows) | After B is activated (renamed, club-made or archived categories) |
|---|---|---|---|
| pre-A build reads | blocked for the migration (1.5 s on 5,120 classes), then served | correct; the old key is accurate for every class | renamed categories show their old label; club-made ones show nothing |
| pre-A build writes a key | waits for the lock (longest write 503 ms), then goes through the bridge | correct; the reference follows; stamped | refused if the target is archived. An explicit old choice **replaces** a club-made category. An edit that does not touch the category keeps it. |
| pre-A build's undo of a row recorded by A (it records `categoryId`) | — | restores the other fields and **leaves the category**, which it does not know (review N7); not destructive | same |
| pre-A build's undo of a pre-A row that cleared a category | — | correct | can **overwrite** a club-made category: its stale check compares the key, NULL with NULL (review S3) |
| pre-A Activity | — | shows the field name `categoryId` and a raw id on rows recorded by A (N7) | same |
| A build reads | — (the deploy migrates first) | correct, by name | correct: renamed and club-made categories show by name |
| A build writes | — | correct | correct. Choosing an archived category is a 409; keeping it is allowed. |
| A page against a pre-A server (version skew during a deploy) | — | sends `categoryId`; the old schema ignores the field, so the save succeeds **without the category** (review N8). The window is the deploy overlap. | same |
| pre-A page against an A server | — | sends an old key; A translates it and logs `[class-category] legacy key write` | same; a rename shows its old label on that page until it is reloaded |

## 5. Supported rollback boundary

Rollback is fix-forward only: deploy a build of the chosen commit. Never use Vercel Instant Rollback or Promote (CLAUDE.md; runbook §4).

- **The migration is never reverted.** There is no down migration. Its table, columns, functions and triggers are harmless to pre-A builds (rehearsal `oldnew`, §8).
- **Before Release B is activated,** while no club has a renamed, club-made or archived category, a pre-A build is a supported fallback.
  - Conditions: only the eight starting rows exist; and the gaps N7 and N8 in §4 are accepted. Neither destroys data.
  - Evidence:
    - rehearsal `verify` and `oldnew`;
    - the old-build writer during the migration (0 errors);
    - DB tests "old key only" and "an old edit form's save keeps the club-made category".
- **Once Release B is activated, every pre-A build is PROHIBITED.**
  - It shows renamed categories by their old label and club-made ones as uncategorised.
  - An explicit old choice replaces a club-made category (DB test, proved).
  - Its undo of an old "cleared category" row can overwrite a club-made category.
- **A builds stay supported after B** (§4).
- **Builds older than `20261017035912_class_category`,** from before `Class.category` existed, were already unsupported and stay so.

## 6. Activation gate for Release B

Release B's controls must not be enabled until all of these are observed and recorded with their dates. A successful deployment of A is not enough.

1. **No pre-A server is serving.**
   - The database signal is `SELECT max("categoryKeyWrittenAt") FROM "Class"`. It must be older than the A deployment and stay so for 7 days.
   - Only a pre-A server, or a script, writes the old key by itself. This release's code never does: the route translates an old key into a reference write, and undo converts keys before writing. So any stamp after A is live means a pre-A server or a script wrote.
   - In addition: every Vercel production deployment older than A is deleted, or Vercel shows no request served by one for 7 days.
   - Noe reads this. It is a read-only production query, and agents never touch production.
2. **No old browser page or API client is writing.** No `[class-category] legacy key write` line in the production logs for 7 consecutive days, long enough for a kiosk tablet or a phone left open for days. Noe reads this.
3. **No other writer.** A grep of `scripts/`, `app/api/cron`, `lib/importers`, the attendance import, mats and lifecycle writers found no cron, import or script writing a class's category (11 Nov 2026, on this branch). Release B's PR repeats the grep; a new writer resets the gate.
4. **The data agrees.** A read-only production query, adapted from `scripts/readiness/class-categories-rehearsal.mjs verify`, returns 0 for:
   - a class with a key but no reference;
   - a reference whose row's key differs.

   Noe runs it.
5. **Recorded.** The dates and evidence for 1–4 go into Release B's readiness record before its first deploy.

## 7. Undo compatibility

- **Rows from before A** store old keys (`before.category`, `after.category`).
  - `prepareCategoryUndo` turns both into this club's category ids before the stale check, so the comparison is on `categoryId`.
  - A class put on a club-made category since is therefore "changed since" and is not overwritten. That holds even when the recorded edit cleared the category, where a key-only comparison sees NULL = NULL.
  - Proved by the unit tests and DB test "never overwrites a category the club made since". It asserts the stale refusal itself.
- **Putting back a category** requires it to still be this club's and not archived. Undoing to the class's current category is no change.
  - An older row naming a key the club has no row for is refused, not guessed.
  - A category archived between the check and the write is refused by the trigger, and undo reports it as the same stale sentence, not a server error (`lib/undo-batch.ts`; unit test `undo-batch-category`).
- **Rows recorded by A** carry `categoryId`. Category management events in Release B will appear in Activity without Undo (Noe).

## 8. Results

| What | Result | Commit |
|---|---|---|
| Type-check (`tsc --noEmit`) | exit 0 | `9712e19e` |
| Full unit suite (`npm test`) | 657 files passed, 124 skipped (database files: they need `TEST_DATABASE_URL` and run below); 9,376 tests passed, 926 skipped, 3 todo | `9712e19e` |
| Lint (`npm run lint`, including the UI-rules ratchet) | exit 0 | `9712e19e` |
| Production build (`server.mjs build`, no database variable) | exit 0, tree clean | `9712e19e` |
| DB suite `class-categories-bridge-db`, owner `neondb_owner` | 25 / 25 passed | `9712e19e` |
| DB suite `class-categories-bridge-db`, restricted `matflow_app` (`RLS_ENFORCED=1`, asserts no BYPASSRLS) | 25 / 25 passed | `9712e19e` |
| Related DB suites, both roles | §8.1 | `9712e19e` |
| Rehearsal 1: migrate while an old build writes (`matflow_rehearsal_20261111020446`; 21 clubs, 5,120 classes) | migration 1,507 ms; writer 126 updates + 42 inserts, 0 errors, longest write 503 ms; every `verify` and `oldnew` check PASS (13) | `9712e19e`, migration sha256 `042618063D6EE281…` |
| Rehearsal 2: lock contention and recovery (`matflow_rehearsal_20261111021220`) | With another session holding `Class`, the deploy waited 4,988 ms, failed (exit 1), and left the migration unfinished with 0 steps. `resolve --rolled-back` then a fresh deploy applied it whole (1,265 ms): the re-created table proves nothing was left behind. Every `verify` check PASS. | `9712e19e` |
| Browser journeys | §8.2 | `9712e19e` |
| Independent review (Opus, read-only) | CHANGES-REQUIRED on `6e3aebae`; every blocker and should-fix answered in `9712e19e` (§10) | `6e3aebae` |

Both rehearsal databases were dropped afterwards.

### 8.1 Related DB suites

On the test branch after the migration, through `db-tests.mjs`, in small batches. Every suite ran as both the owner and `matflow_app`, on `9712e19e`.

| Suite | Owner | `matflow_app` |
|---|---|---|
| `class-lifecycle-db`, `class-membership-tier-db` | 11 / 11 | 11 / 11 |
| `class-location-db`, `class-lost-update-db` | 20 / 20 | 20 / 20 |
| `squad-class-tier-db`, `timetable-multiday-db` | 11 / 11 | 11 / 11 |
| `mats-db` | 22 passed, 1 skipped | 23 / 23 |
| `member-timetable-db` | 2 / 2 | 2 / 2 |
| `cross-tenant-authorisation-matrix` | 63 / 63 | 63 / 63 |
| `lock-order-contention-db`, `tenant-restore-purge-race` | 10 passed, 3 failed | 10 passed, 3 failed |

**The three failures are already on `main`; Release A did not cause them.** They are the three `tenant-restore-purge-race` race tests ("purge wins", "deadline mid-purge", "duplicate concurrent runs"). Each times out at 30 s, and the hook times out at 60 s.

They fail identically:

- with `main`'s code (`33592fe0`) against the migrated test branch;
- in an A/B on a fresh scratch database (`matflow_rehearsal_20261111035339`, dropped afterwards):
  - **A:** `main`'s schema and code, before this migration existed → the same 3 failures;
  - **B:** after this migration, with this branch's code → the same 3 failures.

They are listed as a separate defect for whoever owns the purge.

### 8.2 Browser journeys

Production build of `9712e19e` (clean tree), served over HTTPS on localhost against the test branch, with synthetic `mfv-` clubs. Every teardown left 0 rows, `classCategories` included.

| Journey | Result | Run |
|---|---|---|
| smoke | 11 PASS / 0 FAIL / 1 NOTE | `rmwboue6g1743db` |
| classes-lifecycle: create, edit, lists, pause, archive, restore, every door; categories now chosen by name | 56 PASS / 0 FAIL / 4 NOTE | `rmwboue6g1743db` |
| class-categories-a (new) | 13 PASS / 0 FAIL / 0 NOTE | `rmwbpvkli02c568` |

The class-categories-a journey covers:

- the club's names in the form, with an archived category absent;
- keyboard choice;
- a refused save (409) and a network failure, each keeping the choice;
- a single retry, carrying `categoryId` only;
- a club-made category leaving the old key empty;
- an old key translated without the old-write stamp;
- choosing an archived category refused;
- the phone timetable with no sideways scroll;
- the member's schedule on a phone;
- the kiosk;
- no page errors.

Its first two runs failed on the journey itself, not the app:

1. It opened the class through a label that a hidden phone grid also carries. Fixed: it now uses the visible week chip, as classes-lifecycle does.
2. It expected "Open mat" where a club created after the release correctly shows "Open Mat".

Only the journey file changed between runs. The app build stayed `9712e19e`.

### 8.3 Incident during testing (test branch only)

`migrate-test.mjs deploy` applied this migration through `.env.test`'s pooled URL. Prisma Migrate's session advisory lock (72707369) stayed on a pooled server connection. Import routes on the test branch answered 503 for another session's suites until the holding backend was ended, at a moment it was idle between transactions.

- Production is not affected: production migrations run on Vercel.
- Recommendation: `migrate-test.mjs` should use the direct host, as `scripts/readiness/migration-rehearsal.mjs` does.

## 9. Recovery from a failed migration

When the deploy's migration fails (a 5 s lock wait on `Class` or `Tenant`, a deadlock, or a 15 s statement):

1. Nothing of the file is applied, because it is one transaction. Rehearsal 2 showed this.
2. Prisma records the migration as failed, and every later deploy stops with P3009.
3. Noe runs `prisma migrate resolve --rolled-back 20261111120000_class_categories` against production, the way production migrations are run (a step for Noe, never an agent).
4. Deploy again, at a quieter time if the cause was lock contention.
5. Check:
   - `SELECT count(*) FROM "ClassCategory"` equals 8 × the number of clubs;
   - the consistency query in §6 item 4 returns 0.

There is no reconcile script: the trigger seeds a club made by an older build on its first categorised write, and the class form offers the old keys to a club with no rows.

## 10. Independent review and what changed

The review (Opus, read-only, on `6e3aebae`) found no tenant-isolation hole and no data-destroying path that an A build can reach. Answered in `9712e19e`:

- **B1.** This document is the record, with the recovery section §9. The reconcile script is dropped from the design.
- **B2.** Named-column detection: a write naming both columns where one is unchanged is refused when they disagree.
- **S1.** Both race tests assert that the second transaction is still waiting.
- **S2.** The undo test asserts the stale sentence.
- **S3.** `categoryKeyWrittenAt` is the database-side gate signal.
- **S4.** The lock-order document is updated.
- **S5.** The real Prisma error is checked against `classCategoryDbError`.
- **S6.** The undo mapping is fixed.
- **S7.** The role check is asserted.
- **S8.** Explicit lock order at the top of the migration.
- **N1–N6** fixed. **N7 and N8** are recorded in §4 and §5.

## 11. Open PRs: integration risks

Trial merges were done in memory (`git merge-tree`) against `9712e19e`'s parent commit `6e3aebae`. The review fixes touch no file these PRs touch. "Added by A" lists conflicts this branch adds on top of those the PR already has with `main`.

| PR | Textual | Semantic risk and dependency |
|---|---|---|
| #76 perf/s1-quick-wins | clean | Touches `lib/class-category.ts` (zod import) and the kiosk check-in route. No overlap in meaning. Rerun `t6d-kiosk-squad` and `kiosk-class-start-limits` on the integrated tree. |
| #75 perf/s3-db-roundtrips | added by A: `class-roster-survives-edit.test.ts`, `class-soft-delete-filter.test.ts`. Already conflicts with main on the timetable page, `mats-store`, reports and the static guards. | **Dependency:** #75 rewrites the timetable page into one transaction. Whichever lands second must carry `categoryRef` in the class read and the club's category list into that transaction, or the class form loses its options. Its page still reads the legacy `category`. |
| #69 feat/activity-events | none added by A (it already conflicts with main on members, checkin, undo-registry) | Both add Activity labels and undo entries. Rebase onto whichever lands first and rerun the activity tests. No category metadata in its events. |
| #35 fix/onboarding-batch1 | none added by A | Touches `app/api/classes/route.ts` (create). Recheck that create still resolves `categoryId` inside the write transaction after the rebase. |
| #38 sean/batch-e-public-page | clean | It shows the public timetable without category labels today. If it ever shows them, it must read `categoryRef.name`. |
| #45, #53, #74, #29 | clean or unrelated | — |

Affected tests are rerun on the actual integrated candidate when each PR is rebased. None of them has been merged into this branch.

## 12. Correction to the design checkpoint

The checkpoint (`.omc/plans/class-categories-design-checkpoint-2026-11-11.md`) said going back past A after B would be "display-only damage". That was wrong, and the checkpoint is now corrected to point here. §5 is the record.

## 13. What a release approval would cover (not given)

Each step needs its own approval from Noe:

1. **Push** `feat/class-categories-a` and open a draft PR. CI's six checks run on it.
2. **Merge to `main`** at the exact head. That deploys and **migrates production** (this migration: about 1.5 s of exclusive locks on `Class` and `Tenant`), at a quiet time.
3. **After the deploy,** Noe confirms:
   - the deployment and health check;
   - `SELECT count(*) FROM "ClassCategory"` equals 8 × clubs;
   - the §6 consistency query returns 0.
4. **The §6 clock starts** for Release B's activation gate.

Sean's records are not touched by Release A: his existing categories carry over exactly as they are.
