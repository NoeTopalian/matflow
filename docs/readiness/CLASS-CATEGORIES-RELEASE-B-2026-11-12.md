# Club-managed class categories, Release B: management, the stale-client control, and activation (12 Nov 2026)

## Status

- **Branch:** `feat/class-categories-b`, built on Release A (`feat/class-categories-a` at `b73c1c40`). Local only: not pushed, not merged, not deployed, not activated.
- **Sean's categories:** not touched.
- **Authority** (Noe, 12 Nov 2026): build the management UI and the server operations on the verified Release A foundation. Do not activate it, and do not modify Sean's categories.
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

**The control, in two places. Both refuse; neither guesses.**

1. **Route** (`lib/class-category-store.ts` `categoryIdToWrite`, every class create and edit). A request carrying the old `category` key, on a class whose current category is club-made, is a 409. This covers a key or null. The message: "This page is out of date: the club's categories have changed. Reload the page and choose again."
2. **Database** (migration `20261112120000_class_category_stale_writer`). The bridge trigger refuses an old-key-only UPDATE on a class whose current category is club-made (`MF_CLASS_CATEGORY_STALE_WRITER`). This covers writers that bypass the route: a server from before Release A that is still answering, and any script.

**Still allowed, because the old client can see it:**
- an old client's choice on a class whose category is one of the eight starting ones, including a renamed one, which keeps its old key;
- an unrelated edit;
- re-sending the key a class already has, which is a no-op in the trigger.

**This tightens Release A's documented behaviour.** Release A applied the explicit old choice. This was an implementation choice made for Release B, not an instruction from Noe. The Release A bridge suite's case is updated to expect the refusal.

## 3. The seven-day gate: what it is, and what it is not

**What expires after seven days? Nothing.**
- No token, cache or session is timed out by the gate. It is an observation window over two signals.
- Release A's evidence §6 defines it:
  - no `categoryKeyWrittenAt` stamp newer than the Release A deployment;
  - no `[class-category] legacy key write` log line for 7 consecutive days.
- It shows that old clients have stopped writing old keys. It does not stop them.

**Which writers does it cover?**

| Writer | Old-key writes possible? | Seen by |
|---|---|---|
| A Vercel deployment from before Release A, still answering (its own URL; production traffic moves to the new deployment) | Yes: writes `Class.category` directly | `categoryKeyWrittenAt` stamp |
| A browser tab or kiosk holding a page loaded before Release A (its JavaScript posts the old key to the current server) | Yes: the route translates it and logs the line | the log line |
| A script, cron, import or other API writer | None found (grep of `scripts/`, `app/api/cron`, `lib/importers`, the attendance import, mats and lifecycle writers; Release A evidence §6) | Release B repeats the grep (§6 below) |
| Sessions and tokens | Not writers of categories | — |

**An old browser that submits after the seven days:**

| Case | Result |
|---|---|
| Unrelated save | Accepted; `category` is not sent |
| Choosing an old category for a class on a starting category | Accepted, as before |
| Changing the category of a class on a club-made category | **409**, "This page is out of date… Reload"; nothing changes |

The same holds on day 1 and on day 100. **Elapsed time is not the control:** the route and trigger refusals in §2 are.

**What the gate is still for.** It lowers the number of people who meet that 409, and confirms no old server is still answering. It is no longer what makes a write safe.

## 4. Activation (Noe's steps; not done)

1. Release A is deployed, with its post-deploy checks recorded (Release A evidence §13).
2. Release B is deployed with the switch off. Its migration runs on deploy: only `CREATE OR REPLACE FUNCTION`, rehearsal in §5.
3. The Release A gate signals are read and recorded. They are recommended, not required for safety (§3).
4. Every production deployment older than Release A is deleted in Vercel, so no old server can answer.
5. Set `CLASS_CATEGORY_MANAGEMENT=on` in the production environment and redeploy. That is a Vercel action, so it is Noe's step.
6. Sean's setup session (§7). Never inferred from class titles, and nothing archived unless Sean names it.

## 5. Migration `20261112120000_class_category_stale_writer`

- **What it does.** One transaction with `lock_timeout 5s` and `statement_timeout 15s`. It replaces `matflow_class_category_bridge()`: the same body with the refusal added.
  - It takes no table lock.
  - The triggers keep pointing at the function.
  - The function stays `SECURITY INVOKER` with `search_path` pinned.
- **Rollback boundary.**
  - The migration is never reverted (fix forward).
  - Code rolled back to Release A is not refused by this function for its own writes, because it writes the reference. But Release A's route still applies an old page's explicit choice.
  - **After activation, Release A code is not a supported fallback.** Fix forward.
  - Builds from before Release A stay prohibited, as Release A evidence §5 says.
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

- The independent review of Release B has not run. Subagent launches are blocked by the context-mode hook. Noe chose a separate review session; the brief is in `.omc/reviews/2026-11-12/`.
- Release B is not integrated with colours PR #80. #80 touches `app/member/schedule/page.tsx` and `TimetableManager.tsx`, and Release B touches the latter. A trial merge is needed when either lands.
