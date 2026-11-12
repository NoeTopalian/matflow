# Club-managed class categories, Release B: management, the stale-client control, and activation (12 Nov 2026)

## Status

- **Branch:** `feat/class-categories-b`, built on Release A (`feat/class-categories-a` at `b73c1c40`). Pushed as draft PR #84, stacked on #79. Not merged, not deployed, not activated.
- **Sean's categories:** not touched.
- **Authority** (Noe, 12 Nov 2026):
  - First: build the management UI and the server operations on the verified Release A foundation, without activating it.
  - Then, about 16:51 Bali: open PRs, merge and deploy once the release conditions hold. Run the documented read-only production checks. Activate Release B only after the safety conditions in §3 are verified.
  - Sean's own category changes need a prepared proposal and his approval (§7).
- **Results:** each result below names the commit it ran on. Anything without a commit has not run.

## 1. What Release B adds

- **Management, for owners and managers** (`requireApiOwnerOrManager`). Coaches, admins and members are refused. A support session is refused, whatever its scope (`refuseSupportSession`).
  - `GET /api/class-categories` lists the club's categories. It is open to any staff role and says whether management is switched on.
  - `POST /api/class-categories {name}` adds a category at the end.
  - `PATCH /api/class-categories/:id {version, name?, archived?}` renames, archives or restores one.
  - `PUT /api/class-categories/order {items: [{id, version}]}` sets the order.
- **The Categories sheet** on the Timetable page (`components/dashboard/CategoriesSheet.tsx`). A category is renamed in place, moved up or down, archived, restored or added. The sheet shows how many classes use each one.
  - Every write says what happened beside it, or in the live region.
  - A refusal keeps what was typed.
- **One category per class, unchanged.** `Class.categoryId` is still the only link.
  - A class's category is still chosen in the class form, and those changes keep their Undo (Release A).
  - Class names are never changed by any category operation.
- **Names.**
  - At most 32 characters.
  - Unique per club whatever their capitals and spacing, archived names included. A clash is a 409 that names the existing category, and says "restore it" when that category is archived.
  - A cap of 40 categories per club.
- **Archive keeps; restore re-offers.**
  - Archiving never removes a category from a class. The class keeps showing it on the timetable, the member schedule and the kiosk.
  - It is no longer offered for a class, and choosing it is a 409, both in the route and in the bridge trigger.
  - Restoring makes it choosable again.
- **Concurrency.**
  - Every rename, archive, restore and reorder carries the category's `version` as the caller saw it. A stale version is a 409 that changes nothing. The sheet then reads the list again and says so.
  - Rename, archive and restore lock the row `FOR UPDATE`.
  - Create and reorder take the club's categories lock: an advisory lock, bind-parameter keys, the same shape as the mats lock.
  - Writes touch ClassCategory rows only, in id order when there are several (docs/design/LOCK-ORDER-2026-10-24.md).
  - An archive and an assignment in flight wait for each other through the bridge's `FOR SHARE`, as Release A proved.
- **Tenant isolation.**
  - Every query filters by the caller's club inside `withTenantContext`.
  - Another club's category id is a 404 for rename or archive, a 409 in a reorder list, and a 400 for a class assignment (Release A's composite foreign key and trigger).
- **Audit.**
  - The actions are `class_category.create`, `class_category.rename`, `class_category.archive`, `class_category.restore` and `class_category.reorder`. Each is written in the same transaction as the change.
  - They are shown in Activity under Classes, staff-only, with **no Undo** (Noe, 11 Nov 2026). The undo registry has no handler for them, so `decideUndo` refuses.
- **The activation switch:** `CLASS_CATEGORY_MANAGEMENT=on` in the deployment's environment.
  - While it is off, every management write is a 404 and the Categories button is not shown. The list still reads.
  - It is off by default. Noe sets it in production (§4).

## 2. The stale-client control: what makes an old client's write safe

**The risk.**
- A category the club makes has no old key (`legacyKey` is NULL). A page or server from before Release A knows only the eight old keys, so it shows such a class as "Uncategorised".
- Release A applied an old client's explicit choice as genuine, so a person on an old page could replace "Intermediate" with "Gi" without ever seeing "Intermediate" (Release A evidence §4–§5).
- An unrelated save from an old page never sends `category` (main's form sends it only when its select changed). That is safe already.

**The control, in three places. Each refuses; none guesses. None reads the activation switch.**

1. **Route, pages older than Release B** (`lib/class-category-store.ts` `categoryIdToWrite`, every class edit). On a class whose current category is club-made, such a page's category change is a 409:
   - an old key or null (a page from before Release A);
   - a `categoryId` without `categoryBaseId` (a Release A page left open across Release B's deploy). No club-made category existed while Release A was served, so it cannot have shown one (review B-2).

   Choosing the category the class already has is never refused. The message: "This page is out of date: the club's categories have changed. Reload the page and choose again."
2. **Route, current forms left open** (same function; added 12 Nov after the first review brief). On an edit, this release's class form sends `categoryBaseId`, the category it saw on the class, with any category change. If the class's category has changed since, judged under the Class row lock, the change is a 409: "Someone else changed this class's category since you opened it. Reload the page and choose again." Before this, a form left open overwrote another person's category choice (last writer wins).
3. **Database** (migration `20261112120000_class_category_stale_writer`). The bridge trigger refuses an old-key-only UPDATE on a class whose current category is club-made (`MF_CLASS_CATEGORY_STALE_WRITER`). It also refuses when that category row is not visible to the writer: it fails closed. This covers writers that bypass the route: a server from before Release A that is still answering, and any script.
   - A Release A server writes references and is not refused here. That is why Release A code is not a fallback after activation (§5a).

**Still allowed:**
- an old client's choice on a class whose category is one of the eight starting ones, including a renamed one, which keeps its old key (the old client shows it under its old name);
- an unrelated edit, from any writer: no category is sent, so the class keeps its current one;
- re-sending the key a class already has: no category change (the trigger stamps it for O1).

**The limit that remains.** An old page carries no record of what it saw. On a class whose category is a starting one, its explicit change applies even if someone changed that class since. This is the same as Release A and main today. It cannot be closed for pages that already exist, and it ends when they are reloaded. A test pins this limit, so a change to it is seen.

**This tightens Release A's documented behaviour.** Release A applied the explicit old choice. This was an implementation choice made for Release B, not an instruction from Noe. The Release A bridge suite's case is updated to expect the refusal.

### 2a. Editors left open while the club's categories change: what each writer gets

Proved in `tests/integration/class-categories-b-stale-editors-db.test.ts`. The five scenario cases (the four rows below and the Release A page) run with management switched on **and** switched off; the signal case and the limit case run with it on.
- "Old page" = a page from before club-managed categories (old key).
- "Current form" = this release's form opened before the change (`categoryId` with `categoryBaseId`).
- "Direct" = a writer of the old key column only (a pre-Release-A server, or a script).
- A Release A page behaves as the old page does in the club-made row: 409, and applied on a starting category.

| Change while the editor is open | Old page | Current form | Direct old-key writer |
|---|---|---|---|
| **Fundamentals renamed to Beginners** | Unrelated save keeps it. Choosing another starting category applies. Choosing "Fundamentals" lands on Beginners, the same row. | Its choice is by id, so it lands on Beginners. | Same as the old page. |
| **A starting category archived** (Competition) | Choosing it: 409 (archived). A class already on it keeps it through unrelated saves and re-sends. | Choosing it: 409 (archived). | Choosing it: `MF_CLASS_CATEGORY_ARCHIVED`. Re-writing the key the class has: no category change (stamped for O1). |
| **A category the club made** (Advanced) | Any change to a class on it (key or null): 409 (stale). Unrelated save keeps it. | Saw it, so its change applies. | Any key: `MF_CLASS_CATEGORY_STALE_WRITER`. NULL, the key the class already has: no category change (stamped for O1). |
| **Someone else changed the class's category** | Club-made category now: 409 (stale). Starting category now: applied (the limit above). | Explicit change or clear: 409 (changed), nothing changes. Choosing the category it already has: accepted. Unrelated save keeps theirs. After reload: applied. | Club-made: refused. Starting: applied. |

The browser journey `class-categories-b` step B12 shows the current-form refusal in the form, beside the buttons, and checks that the other tab's choice is kept.

## 3. Activation: the technical safety gate, and the seven-day observation period

These are two different things.
- **The safety gate** is a set of checks that the protections are in production. Each passes or fails now; none waits for time to pass. It is what makes every write safe.
- **The observation period** is seven days of watching for old writers. It makes nothing safe. It shows whether anyone would meet the refusals, and confirms that no old server or script is writing.

**Both block activation.** `CLASS_CATEGORY_MANAGEMENT` stays off until every safety-gate check has passed and the observation period has ended clean. The dated results go in §6 before Noe sets the switch.

### 3.1 The technical safety gate (required; deterministic)

| # | Check | How | Who | Blocks activation when |
|---|---|---|---|---|
| G1 | Production runs Release B | The production deployment's SHA (GitHub deployments API) contains the Release B merge, and `/api/health` returns 200 `db: ok` | Agent (read-only, the established checks) | Any other SHA, or health not ok |
| G2 | The database refusal is in production | `class-categories-prod-check.mjs gate-b`: `staleWriterRefusalPresent` true; migration `20261112120000_class_category_stale_writer` finished, not rolled back | Agent, read-only (authorised 12 Nov 2026) | `staleWriterRefusalPresent` or `everyOldKeyWriteStamped` false; the migration missing or rolled back |
| G3 | No server from before Release A can answer | Vercel lists no production deployment older than Release A: each was deleted | Noe (Vercel) | Any such deployment still exists |
| G4 | The data agrees | `gate-b`: `classesWithKeyButNoReference` and `referencesWhoseKeyDiffers` both 0 (Release A evidence §6 item 4) | Agent, read-only (authorised 12 Nov 2026) | Any row |
| G5 | No new category writer | Repeat the grep on the merged head (`scripts/`, `app/api/cron`, `lib/importers`, the attendance import, mats and lifecycle writers), and record it | Agent | Any writer of `Class.category` or `Class.categoryId` outside the class routes and undo |
| G6 | No pre-Release-A server changed a key between Release A's and Release B's deploys | `observe <Release A deploy time>`: `o1StampAfterSince` false. Release A's trigger stamps changes only, so this is the weaker reading; O1 is the full one from Release B's deploy | Agent, read-only (authorised 12 Nov 2026) | true: find the writer before the period starts |

Every database read in G2, G4, G6, O1 and O2 is made by `scripts/readiness/class-categories-prod-check.mjs`.
- It runs in one REPEATABLE READ READ ONLY transaction, always rolled back, with a 15 s statement timeout.
- It uses stage0's host and routing guard and a client with TLS verified.
- It sets `app.bypass_rls` for that transaction, because row-level security is forced on these tables. It refuses to report if it can see no club.
- It prints counts, booleans, timestamps and the database role name. It never prints a person's name, email or record id, or a connection string.
- Its `pre` check confirms, before Release A, that the runtime role `matflow_app` gets new tables' rights through default privileges granted for `neondb_owner`.
  - That assumes production migrations run as `neondb_owner`. The check prints the owner of `Mat`, a table an earlier migration made, so a different migration role would show.
  - If the owner is not `neondb_owner`, Release A is not merged until the default privileges for that role are confirmed.
- **The O2 query's cost.** It filters `AuditLog` on `createdAt > since` first (indexed: `AuditLog(createdAt)`), then on the two class actions, then on the marker. Its cost is bounded by seven days of audit rows, and the check has a 15 s statement timeout. Its `post-a` check is Release A's post-deploy read: every club has exactly its eight starting rows, the two consistency counts are 0, and `matflow_app` has its rights on `ClassCategory`. On the test branch, fixture clubs inserted directly by the journey harness have no rows until first use; clubs made in the app are seeded on creation (`create-tenant`, application approval).

The route refusals need no production check of their own: they ship in the code that G1 verifies. They are proved by the suites in §6.

### 3.2 The observation period (seven days; blocks activation; does not make anything safe)

**What expires after seven days? Nothing.** No token, cache, session or page is timed out. Nothing bounds how long an open tab keeps its old code: a tablet left open at the desk can hold a page from before Release A for weeks. The period only watches.

**It starts** when Release B is deployed with the switch off (§4 step 2). **It restarts** after any blocking signal is resolved. `since` in every `observe` run is the start of the current period.

| Signal | What it shows | Where it is kept | Who reads it | Blocks activation when |
|---|---|---|---|---|
| O1 `observe <since>`: the latest `categoryKeyWrittenAt` | A pre-Release-A server or a script wrote the old key column directly. Release B's function stamps every such write, even one re-sending the same key; this release's code never writes that way. | The database (durable) | Agent, read-only (authorised 12 Nov 2026) | A stamp later than `since`. Find the writer, delete the deployment or stop the script, then restart the period. |
| O2 `observe <since>`: `class.updated` / `class.created` audit rows with `metadata.categoryOldKey = true`, and how many people made them | A page older than Release B (a pre-Release-A page or a Release A page) is still open **and changing a class's category**. Old pages that only edit names, times or rosters are not seen, and need not be: the refusals in §2 apply only to category changes. **New in Release B.** | The audit log. The row is awaited before the save answers, and lost only if that audit write itself fails, which is logged | Agent, read-only (authorised 12 Nov 2026). If the count is not 0, Noe finds who on the Activity page (Classes, the same days), which shows each class change and who made it. No further production query | Any row. That person reloads every MatFlow tab and device they edit classes from, then the period restarts. Without this, they would meet the 409 after activation. That is safe, but it is avoidable confusion. |
| The `[class-category] legacy key write` runtime log line (Release A) | The same as O2 | Vercel runtime logs: **1 hour** on the Hobby plan (Vercel docs, checked 12 Nov 2026) | — | Not used. It cannot cover seven days on Hobby, so Release A §6 item 2 could not have been collected as written. O2 replaces it. |

A create made by this release's form, in a club that has no category rows yet, also sets `categoryOldKey`. All production clubs are seeded by Release A's migration, so in practice this needs a club created by an older build during the changeover. Such a row names a current user and is read as a false alarm.

**Why seven days.**
- A club's timetable repeats weekly. Staff edit a class around the day it runs.
- A page that is kept open and used for edits (a desk tablet, a coach's phone tab) is used on at least one day of any week it is used at all.
- Seven days covers every weekday once.
- **What it does not prove.** Category changes are rarer than other edits. A clean week therefore means "no old page changed a category this week", not "no old page is open".
- That is the population that matters: only a category change from an old page meets a refusal.
- **Shorter** would miss someone who only edits one day's classes, for example the Saturday coach.
- **Longer** adds little. A page used less often than weekly is not reliably caught by any fixed window, and the refusals in §2 cover it anyway.
- This is a judgement from how the product is used, not a measurement. Seven days is kept on that basis, not because Release A chose it.

### 3.3 Which writers the protections and signals cover

| Writer | Old-key writes possible? | Protected by | Seen by |
|---|---|---|---|
| A Vercel deployment from before Release A, still answering (its own URL; production traffic moves to the new deployment) | Yes: writes `Class.category` directly | The trigger (§2, control 3); and G3 deletes it | O1 |
| A browser tab or kiosk holding a page loaded before Release A | Yes: posts the old key to the current server | The route (§2, control 1) | O2 |
| A Release A page left open across Release B's deploy | Posts `categoryId` without `categoryBaseId` | The route (§2, control 1) | O2 |
| This release's class form, left open | No: posts `categoryId` with `categoryBaseId` | The route (§2, control 2) | — (not an old writer) |
| A script, cron, import or other API writer | None found (grep of `scripts/`, `app/api/cron`, `lib/importers`, the attendance import, mats and lifecycle writers; Release A evidence §6) | The trigger, if one ever writes the old key | O1; G5 repeats the grep |
| Undo of a class edit | Writes the reference (Release A §7) | The trigger's archived and tenant rules; Release A's undo refusals | — |
| Sessions and tokens | Not writers of categories | — | — |

**An old browser that submits after the seven days:**

| Case | Result |
|---|---|
| Unrelated save | Accepted; `category` is not sent; the class keeps its category |
| Choosing an old category for a class on a starting category | Accepted, as before (the limit in §2) |
| Changing the category of a class on a club-made category | **409**, "This page is out of date… Reload"; nothing changes |

The same holds on day 1 and on day 100. **Elapsed time is not the control:** the refusals in §2 are.

## 4. Deployment and activation (not done)

Under Noe's authority of 12 Nov 2026, the agent merges, deploys and runs the read-only checks once the release conditions hold. Two steps stay Noe's:
- deleting old Vercel deployments (destructive);
- setting the production environment variable, unless the agent has Vercel access to production variables.

1. Release A is merged and deployed, with its post-deploy checks recorded (Release A evidence §13; `prod-check post-a`). Before it: `prod-check pre`.
2. Release B is merged and deployed **with the switch off**. Its migration runs on deploy: only `CREATE OR REPLACE FUNCTION`, rehearsal in §5. Deploying it changes behaviour for every club at once, even with the switch off:
   - an old page's change to a class on a club-made category is refused (no club has one until activation, so this cannot fire yet);
   - an open form's category change is refused when another person changed that class's category since;
   - a Release A page's change to a class on a club-made category is refused (none exists before activation);
   - category changes from pages older than Release B are marked in the audit log;
   - every old-key-only database write is stamped (O1).
3. Every production deployment older than Release A is deleted in Vercel (G3).
4. The safety gate G1–G6 (§3.1) passes, with each result and its date recorded in §6.
5. The seven-day observation period (§3.2) ends clean: O1 and O2 have shown nothing for seven consecutive days since step 2, or since the last restart. Recorded in §6 with dates.
6. `CLASS_CATEGORY_MANAGEMENT=on` is set for production and production is redeployed (a Vercel action: Noe's, unless the agent has that access). The earliest date is seven clean days after step 2.
7. Post-activation check, read-only. The Categories button shows for an owner on the Timetable page, and `GET /api/class-categories` reports `managementEnabled: true`. **No category is created, renamed or archived to test it:** that is Sean's club's data (§7).
8. Sean's setup session (§7). Never inferred from class titles, and nothing archived unless Sean names it.

## 5. Migration `20261112120000_class_category_stale_writer`

- **What it does.** One transaction with `lock_timeout 5s` and `statement_timeout 15s`. It replaces `matflow_class_category_bridge()`: the same body as Release A, with three changes in the old-key-only branch:
  - the stale-writer refusal;
  - fail closed when the current category row is not visible;
  - stamp `categoryKeyWrittenAt` on every old-key-only write, not only on a change (fix re-review 4, B1).
  - It takes no table lock.
  - The triggers keep pointing at the function.
  - The function stays `SECURITY INVOKER` with `search_path` pinned.
- **The migration is never reverted** (fix forward). It only refuses more, so leaving it in place is safe whichever code runs.

## 5a. Switching management off, and rolling back

**Switching management off** (`CLASS_CATEGORY_MANAGEMENT` unset or not `on`, then redeploy; Noe's Vercel action).

- **What stops:**
  - adding, renaming, archiving, restoring and reordering categories (each is a 404 that changes nothing);
  - the Categories button.
- **What stays exactly as it was:**
  - every category's name, archived state and order;
  - every class's category;
  - the class form, which still offers the club's active categories (club-made and renamed ones included) and still has Undo.
- **What stays protected.** None of the protections reads the switch:
  - the refusal of pages older than Release B (old key, or a Release A page) on club-made categories;
  - the open-form refusal;
  - the archived refusal (route and trigger);
  - the trigger's stale-writer refusal.

  The scenario suite (§2a) runs its five scenario cases with the switch on and with it off, to prove it.
- **The cost:** an archived category cannot be restored, and a mistaken name cannot be corrected, until the switch is on again. Classes keep showing them meanwhile.

**Rolling back the code.**

| Roll back to | Before activation | After activation (any club-made, renamed or archived category exists) |
|---|---|---|
| An earlier Release B deployment | Supported | Supported, with the switch on or off |
| **Release A** | Supported. It writes references, which this function accepts. It drops the open-form refusal (back to last writer wins), the Release A page refusal and the audit marker. The stale-writer rule cannot fire, because no club-made category exists yet. Evidence: Release A's own bridge suite, run against a database carrying this migration, passes 24 of 25 as both roles. The one failure is the case this release tightens: a direct old-key write replacing a club-made category is now refused (§6). | **Not a supported fallback, and not demonstrated safe.** It is unsafe in one known case. Release A's route turns an old page's key into a reference write, which the trigger's old-key refusal does not see, and Release A has no route refusal. So an old page can replace or clear a club-made category it never saw. Release A also has no open-form refusal. **If Release B's code must be withdrawn after activation, deploy Release B with the switch off; never Release A.** |
| A build from before Release A | Supported only until G3 has run (Release A evidence §5: while only the eight starting rows exist). After G3, no such deployment exists to fall back to. | Prohibited (Release A evidence §5). This function would refuse its old-key writes on club-made categories, but it stays prohibited. |
- **Recovery from a failed migration.** As in Release A evidence §9:
  1. The deploy stops at P3009.
  2. Noe runs `prisma migrate resolve --rolled-back 20261112120000_class_category_stale_writer`.
  3. Redeploy.
  4. Check with `SELECT prosrc LIKE '%STALE_WRITER%' FROM pg_proc WHERE proname = 'matflow_class_category_bridge'`.
- **Rehearsal:** Two throwaway databases on the TEST endpoint, both dropped afterwards. Durations were measured from this machine (226 ms per database round trip). They are rehearsal evidence, not a guarantee of production duration.
  - **`matflow_rehearsal_20261112035750`**: every migration through Release B applied. This migration took 1,942 ms (Release A's took 1,212 ms).
  - **`matflow_rehearsal_20261112042451`**:
    - migrated to Release A from Release A's own checkout (1,125 ms);
    - then another session took ACCESS EXCLUSIVE on `Class` and held it for 25 s;
    - Release B's migration then applied in 1,895 ms and finished before the holder released (holder 04:30:42–04:31:07 UTC; the whole `migrate` command took 20.5 s).
  - Had the migration needed a `Class` lock, its 5 s `lock_timeout` would have failed it. It takes none.

## 6. Results

Code `8d080073`. Later commits change journeys only (`b57a47bf`, `00f1be86`).

| Gate | Result |
|---|---|
| Type-check | clean |
| Lint (eslint and the UI-RULES ratchet) | passed |
| Full unit suite | 655 files passed. Two guard files failed on the new routes and the new raw SQL (`journeys-manifest`, `sec-c-static-guards`); both were updated and pass (18/18). |
| DB suites on rehearsal database `matflow_rehearsal_20261112035750`, owner role | `class-categories-b-db` and `class-categories-bridge-db`: 34/34 |
| The same, `matflow_app` with RLS enforced | 34/34 |
| Journey `class-categories-b` (switch on) | 12 PASS / 0 FAIL. Earlier runs failed on the journey itself: substring name matches, 5 s waits on 8–12 s saves, and opening the form before the page refresh landed. |
| Journey `class-categories-a` (switch on) | 13 PASS / 0 FAIL. It is updated for the new rule: C8 failed 11/2 against the old expectation, which was the intended refusal. |
| Journey `classes-lifecycle` (switch on) | 56 PASS / 0 FAIL / 4 NOTE |
| CI | none: not pushed |
| Independent review | not run (§8) |

The journeys ran on the shared test branch, where Release B's migration is **not** applied: the database refusal is proved on the rehearsal database only. The route-level refusal is proved on both.

## 7. Sean's setup and acceptance checklist (after activation; with Sean, never inferred)

1. **Rename** Fundamentals to **Beginners**. Every class on it keeps it.
2. **Kids** and **Competition** already exist. Rename "Open mat" to **Open Mat** if Sean wants the capital.
3. **Add** **Intermediate** and **Advanced**.
4. **Assign** each class Sean names in the class form. Every class now on Gi, No-Gi, Private or Other is Sean's decision.
5. **Archive** only what Sean names. An archived category stays shown on its classes.
6. **Order:** Kids, Beginners, Intermediate, Advanced, Competition, Open Mat.
7. **Acceptance:**
   - the names show on the timetable (week chip and card), the member schedule and the kiosk;
   - bookings, attendance, plans, ranks, squads, ages and capacity are unchanged;
   - Activity shows each category change, with no Undo;
   - a class's category change still has Undo.

## 8. Open items

- **Independent reviews** ran in separate sessions on 12 Nov 2026. The findings and what was done about each are in §6.
- **Colours PR #80.** A trial merge with Release B conflicts in `app/member/schedule/page.tsx`, an import block that Release A changed. The resolution is the union of the imports, as recorded in `b7b59805`. `TimetableManager.tsx` merges automatically. The release order puts colours after Release B, integrated and tested on top of it.
- **The class form after a save.** A successful save closes the form (`setDrawerOpen(false)`) and the timetable takes the server's copy of the class. So a second change starts from the new category, and is never refused as someone else's (review B-N5).
- **Categories sheet inputs** now use the `Input` primitive (UI-RULES §5; review B-N4). They were raw `<input>`s copied from `MatsSheet`, which UI-RULES lists as a violation. `MatsSheet` itself is unchanged and outside this release.
