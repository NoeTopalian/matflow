# Lock order across MatFlow's writers (24 Oct 2026)

Status: analysis of branch `sean/c1-data` (from `aded8cee`), written before
the shared writers were changed and updated as they were. Synthetic test data
only; no production figures. Tests: `tests/integration/lock-order-contention-db.test.ts`
(both database roles), plus the race suites named in section 6.

## 1. What takes a lock

Postgres row locks, strongest first: `FOR UPDATE` (taken by `DELETE` and by an
explicit `SELECT … FOR UPDATE`), `FOR NO KEY UPDATE` (taken by every `UPDATE`
that does not change a key column, and explicitly), `FOR SHARE`, `FOR KEY
SHARE`. `FOR KEY SHARE` is taken **implicitly** on the referenced row by every
`INSERT` (and every update of a foreign-key column) of a referencing row: an
attendance row takes it on its Member, ClassInstance, Tenant and staff User; a
roster row on its Class and Member; a booking on its Member and Class.

| held \ wanted | KEY SHARE | SHARE | NO KEY UPDATE | UPDATE |
|---|---|---|---|---|
| KEY SHARE | – | – | – | waits |
| SHARE | – | – | waits | waits |
| NO KEY UPDATE | – | waits | waits | waits |
| UPDATE | waits | waits | waits | waits |

Two consequences matter here. A check-in's Member lock (`FOR NO KEY UPDATE`)
does **not** block an insert that references the member (KEY SHARE), so
imports and undo batches can insert for a member a check-in holds. A Class
`FOR UPDATE` **does** block every insert that references the class (a roster
row, a booking, a new session) until the holder commits.

`ON DELETE CASCADE` deletes the child rows inside the parent's DELETE (row
`FOR UPDATE` on each). Advisory transaction locks (`pg_advisory_xact_lock`)
are held to commit: rate limiting (`lib/rate-limit.ts`), sign-in lockout
(`lib/auth-lockout.ts`), login-address claims (`lib/login-email.ts`, LGID),
and, from 5 Nov 2026, the per-club mats lock (`lib/mats.ts` `lockClubMats`,
MATS): one key per club, so every mats write of a club is serial.

Every tenant transaction sets `lock_timeout` 10 s and `statement_timeout`
15 s (`lib/prisma-tenant.ts`); a wait past 10 s fails with 55P03. Postgres
detects a deadlock after `deadlock_timeout` (1 s) and aborts one side (40P01;
the check-in engine answers it as `{ kind: "error" }`).

## 2. The order every writer follows

1. **Advisory locks first** (rate limit, lockout, LGID claim, the club's mats
   lock), in their own short transaction or as the first statement of the
   writer's transaction. The mats lock is level 1 for every writer that takes
   it: nothing that already holds a Class or Member row may ask for it.
2. **Class rows**, `FOR UPDATE` (check-in, booking, class PATCH, squad
   removal) or `FOR NO KEY UPDATE` (undo batch); several Class rows in id order.
3. **Member rows**, `FOR NO KEY UPDATE` (check-in, undo batch, every member
   UPDATE) or `FOR UPDATE` (member deletion); several Member rows in id order.
4. **Rows that hang off them**: the member's pack, roster rows, bookings,
   attendance, rank rows, and (11 Nov 2026, club-managed categories) the
   class's **ClassCategory row `FOR SHARE`**, taken by the trigger
   `matflow_class_category_bridge` inside the Class `INSERT`/`UPDATE` that
   names a category, so while the Class row (and in a PATCH or an undo batch,
   Member rows) are already held.
5. **Audit rows** (insert only; KEY SHARE on Tenant and User).

A transaction may skip a level but never go back up: nothing that holds a
Member row may then lock a Class row, and nothing that holds a roster,
booking, attendance or pack row may then lock its Member row.

## 3. Path by path

Locks in the order taken. "Plain reads" take no row lock.

| Path | Order | Where |
|---|---|---|
| Check-in, every door (member app, parent, kiosk, desk, card scanner, system) | Class `FOR UPDATE` (+ the session's cancel flag re-read in the same statement, D6) → Member `FOR NO KEY UPDATE` → plain reads (squad list, membership list, allowance) → pack `UPDATE` (kiosk pack-first / fall-through) → attendance `INSERT` (KEY SHARE: Member held, session, Tenant, User) → redemption `INSERT` | `lib/checkin.ts` `capacityState`, `memberLock`, `claimPack` |
| Coach tick (mark) | Class `FOR UPDATE` → Member `FOR NO KEY UPDATE` → allowance reads → attendance upsert | `lib/checkin.ts` `lockedClassEligibility`, `staffAllowanceAsk`; `app/api/coach/instances/[id]/attendance/route.ts` |
| Unmark (desk, coach, undo of a check-in) | redemption `DELETE` → pack `UPDATE` → attendance `DELETE`; no Class or Member lock | `restorePackCreditsForAttendance`; `app/api/checkin/route.ts` DELETE |
| Booking | Class `FOR UPDATE` → plain reads → booking `INSERT` (KEY SHARE Member, Class held) | `app/api/member/class-subscriptions/[classId]/route.ts` |
| Member's own cancel | booking `DELETE` (still deletes — D2 keeps this) | same file, DELETE |
| Class PATCH | plain pre-flight → Class `FOR UPDATE` → (D2) plain reads of the rules and bookings → membership-list `DELETE`/`INSERT` → (D1, 24 Oct) new squad's Members `FOR KEY SHARE` in id order → roster `DELETE`/`INSERT` → durable audit `INSERT` → schedule `UPDATE`/`INSERT`, session `DELETE`/`INSERT`/`UPDATE` → Class `UPDATE` (held) | `app/api/classes/[id]/route.ts` |
| Class create or PATCH **naming a mat** (5 Nov 2026; by name, `matName`, 7 Nov 2026) | MATS advisory → (PATCH) Class `FOR UPDATE` → Mat plain read by `{ id, tenantId }`, or by name the club's mats read and, when none has that name, Mat `INSERT` and its `mat.create` audit `INSERT`, then the club's typed classes on no mat `FOR NO KEY UPDATE` in id order (`lib/mats.ts` `lockTypedClasses`; a PATCH already holds its own class `FOR UPDATE` first and the others follow in id order, which is safe because every writer of several Class rows takes the MATS lock first; the one exception, a bulk ClassInstance insert, takes only `FOR KEY SHARE` on its classes, which `FOR NO KEY UPDATE` does not wait for), Class `UPDATE` (mat and place) of those whose place, as now read, is that name, and a `mat.adopt` audit `INSERT`, as adopt does → the rest as above; the mat's name is written as the class's place. A PATCH that names no mat takes no MATS lock: under its Class lock it reads the row's own `matId` and drops a sent place if the class is on a mat | `app/api/classes/route.ts`, `app/api/classes/[id]/route.ts` |
| Mat add, rename, remove, reorder (5 Nov 2026) | MATS advisory → Mat rows → (rename) Class `UPDATE` of every class on the mat, (remove) the foreign key's `SET NULL` on them, in no particular order → audit `INSERT` in the same transaction. Several Class rows are updated, so every other holder of several Class rows (the undo batch) takes MATS first | `app/api/mats/route.ts`, `app/api/mats/[id]/route.ts`, `app/api/mats/order/route.ts` |
| Mats from typed places (adopt) (5 Nov 2026; locked read 7 Nov 2026) | MATS advisory → the club's typed classes on no mat `FOR NO KEY UPDATE` in id order (`lockTypedClasses`, so an edit clearing one of them is not overwritten, and no wait on a bulk ClassInstance insert's `FOR KEY SHARE`) → Mat plain reads → Mat `INSERT` → Class `UPDATE` (mat and place) for the classes whose place, as now read, matches → audit `INSERT` | `app/api/mats/adopt/route.ts`, `lib/mats-store.ts` `adoptPlaces` |
| The same-time split (5 Nov 2026) | MATS advisory → plain reads → Tenant `UPDATE` (one column) → audit `INSERT` | `app/api/timetable/layout/route.ts` |
| Class create or PATCH **naming a category** (11 Nov 2026) | as above; in the Class `INSERT`/`UPDATE` itself the trigger reads the category row `FOR SHARE` (level 4), and for a club with no category rows yet (an old key from an older build) inserts the eight starting rows first (`ON CONFLICT DO NOTHING`, which waits only on another inserter of the same rows) | `app/api/classes/route.ts`, `app/api/classes/[id]/route.ts`; migration `20261111120000_class_categories` |
| Category archive or rename (Release B, not built; the rule it must keep) | ClassCategory `UPDATE` only. It waits for every open assignment of that category (their `FOR SHARE`) and they wait for it; it takes no Class or Member row before or after | — |
| Class archive | Class `UPDATE` (one statement) | same file, DELETE |
| Single squad removal | (D2, 24 Oct) Class `FOR UPDATE` → roster row `DELETE` → plain booking read → durable audit `INSERT`. Before: roster `DELETE` → booking `DELETE`, no Class lock | `app/api/classes/[id]/roster/[memberId]/route.ts` |
| Squad add | roster `INSERT` (KEY SHARE Class, Member) | `app/api/classes/[id]/roster/route.ts` |
| Rank award / promotion | (Round 4, 10 Nov 2026) Member `FOR NO KEY UPDATE` → member-rank `UPDATE`/`UPSERT`, history `INSERT` (none for an unchanged award). Before: no Member or Class lock | `app/api/members/[id]/rank/route.ts` |
| Demotion | (Round 4) Member `FOR NO KEY UPDATE` → member-rank `UPDATE`, history `INSERT` → (D2) plain reads → durable audit `INSERT` per class (none for an unchanged demotion). Before: booking `DELETE` | `app/api/members/[id]/rank/demote/route.ts` |
| Member PATCH (plan, status, hold, details) | LGID advisory (address change only) → Member `UPDATE` → token retirement → status event `INSERT` → audit `INSERT` (durable) | `app/api/members/[id]/route.ts` |
| Member notes save (Round 4) | Member `UPDATE` of `notes` only (one conditional statement; the row version is not bumped) → audit `INSERT` (durable) | same file |
| Club settings save with `expected` (Round 4) | Tenant `FOR NO KEY UPDATE` → Tenant `UPDATE` → (after commit) audit `INSERT`. `NO KEY UPDATE` does not wait for the `KEY SHARE` inserts take on the club, so check-ins and audit rows are not held. Nothing else is locked | `app/api/settings/route.ts` |
| Plan save with `expected` (Round 4) | MembershipTier `FOR NO KEY UPDATE` → MembershipTier `UPDATE` → (after commit) audit `INSERT` | `app/api/memberships/[id]/route.ts` |
| Member deletion | Member `FOR UPDATE` → imported bookings, mappings, rank history, ranks, redemptions, packs, attendance, bookings, waitlist, login events `DELETE` → Member `DELETE` (cascades: roster rows, status events) | `lib/member-delete.ts` |
| Undo to a point (≥ 2 rows) | (5 Nov 2026, when any row touches a class) MATS advisory → Class rows `FOR NO KEY UPDATE` in id order → Member rows `FOR NO KEY UPDATE` in id order → handlers (snapshot `UPDATE`s, roster `INSERT`/`DELETE`, attendance `DELETE` with pack restore) → audit `INSERT`s | `lib/undo-batch.ts` `lockBatchRows` |
| Undo of one row | (5 Nov 2026, when the row touches a class) MATS advisory → that handler's statements only; undoing a class edit may read a Mat and write its name as the class's place, and (11 Nov 2026) its Class `UPDATE` of `categoryId` takes the category row `FOR SHARE` through the trigger | `lib/undo-batch.ts` `executeUndo`, `lib/undo-registry.ts` |
| TeamUp import, create | per 25 rows: Member `INSERT`, ledger `INSERT`; job `UPDATE` | `app/api/admin/import/[id]/commit/route.ts` |
| TeamUp status refresh | (since the 25 Oct later-upload rule) no Member `UPDATE` and no status event: the differences are listed for review → job `UPDATE` only. Before: per 25 members, Member `UPDATE` × 25 (id order from 24 Oct, file order before) → status events → job `UPDATE` | same file, `commitRefresh` |
| Refresh rollback | ONE transaction: Member `UPDATE` for every changed member (**id order since 24 Oct**) → status events → job `UPDATE` → audit. Writes only for a refresh recorded before 25 Oct; a later refresh changed nobody, so its rollback restores nobody | `app/api/admin/import/[id]/rollback/route.ts` |
| Import rollback (create) | ONE transaction (budget = function limit − 10 s): imported attendance `DELETE` → Member `DELETE` (children, then adults; one statement each, scan order) → ledger `DELETE` → job `UPDATE` → audit | same file |
| Attendance-history import | job lease `UPDATE` → per 400 rows (60 s budget): Class/session `INSERT` (KEY SHARE Class), attendance `INSERT` (KEY SHARE Member, session), imported-booking `INSERT`/`UPDATE`, mapping upserts. No Member `UPDATE`, no Class `FOR UPDATE` | `lib/attendance-import.ts` |
| Stripe webhook (dispute) | Member `UPDATE` → pack `UPDATE` | `app/api/stripe/webhook/route.ts` |
| Refund | pack `UPDATE` | `app/api/payments/[id]/refund` |

## 4. Cycles

| # | Pair | Cycle | Status |
|---|---|---|---|
| C-1 | TeamUp refresh batch / refresh rollback **vs** undo batch | Refresh updated two members B then A (file order) while the undo batch locked A then B (id order): each holds one and waits for the other. | **Fixed 24 Oct**: both refresh writers update in id order. Test A proves the opposite order deadlocks; test F proves the same order queues. Since 25 Oct the refresh commit writes no member at all; only the rollback of an older refresh remains a writer. |
| C-2 | Class PATCH squad rewrite **vs** member deletion | The PATCH (holding the Class) deleted the class's roster rows, then inserting the new squad waited for KEY SHARE on member M; the deletion (holding M `FOR UPDATE`) cascaded to M's roster rows, one of which the PATCH had deleted, and waited for the PATCH. | **Fixed 24 Oct**: the PATCH takes KEY SHARE on the new squad's members, id order, before touching any roster row. Test G. |
| C-3 | Import rollback **vs** undo batch | The rollback deletes members in one statement (scan order); the undo batch locks members in id order. A cycle needs two members in both sets. | Not reachable in practice: the rollback keeps every member edited after the import ("edited after the import"), and an undo batch only covers staff edits. Recommendation if it ever matters: lock the removable members `ORDER BY id FOR UPDATE` before the deletes. |
| — | Check-in **vs** any writer above | None: no writer takes a Member row and then a Class row (test B shows that would deadlock), and the writers that lock both take Class first (tests C, D, E). The attendance import's KEY SHARE on members does not conflict with the check-in's Member lock. | Holds. |

## 5. Risky waits (no cycle, but a long queue)

- **W-1. A check-in holds the Class row while it waits for the Member row.**
  Any long transaction holding a Member row stalls that member's check-in and,
  behind it, every check-in and booking for that class, until `lock_timeout`
  (10 s) fails them. The long holders: the import rollback (one transaction
  for the whole run), the refresh rollback (one transaction for every changed
  member; only for a refresh recorded before 25 Oct), a member deletion with a long history. (A refresh batch no longer writes members.)
  Recommendation (not implemented; changes the check-in's failure mode): take
  the Member lock with a short `SET LOCAL lock_timeout` (about 3 s) and answer
  "busy — try again" rather than hold the class for 10 s; and split the two
  rollbacks into batches.
- **W-2. The undo batch locks the Class rows first**, so check-ins to a class in
  the batch wait for the whole batch.
- **W-3. A class PATCH with a timetable change** holds the Class row across the
  schedule and session writes; check-ins and bookings for that class wait.
- **W-4. Booking and check-in serialise on the Class row by design**; a burst
  at the start of a class queues, each check-in costing its statements under
  the lock. From a distant client (about 0.2 s a round trip) a single card
  scan measured 54 round trips before D6 and the Member lock was reached about
  10 s after a scan started; on Vercel beside Neon the round trip is
  milliseconds.

## 6. Tests

`tests/integration/lock-order-contention-db.test.ts` (both roles). Each case
forces the worst interleaving and observes it in `pg_stat_activity`:

- **A** (probe control): refresh-order (descending) against the undo batch's
  ascending lock — Postgres reports a deadlock; the probe can see one.
- **B** (control): a writer taking Member then Class against a check-in parked
  on that member — deadlock: the rule in section 2 is load-bearing.
- **C**: the undo batch's own lock against a parked check-in — queues, no deadlock.
- **D**: a class PATCH squad rewrite (real route) against a parked check-in —
  queues on the Class row; the check-in is judged on the list it locked first;
  the dropped member's booking is kept (D2).
- **E**: a single squad removal (real route, now under the Class lock) against
  a parked check-in — queues; both complete; the next session refuses.
- **F**: refresh-order (ascending, as now) against the undo batch — queues.
- **G**: a member deletion's lock and cascade against a class PATCH squad
  rewrite that keeps that member — no deadlock (C-2).

Related: `checkin-allowance-race-db.test.ts` (two check-ins, member deletion
against a pack check-in), `booking-preservation-db.test.ts` (a booking
committed while the PATCH waits on the Class lock is judged),
`card-scan-concurrency-db.test.ts` (concurrent card scans; revocation under
the Member lock).

## 7. Rules for a new writer

1. Lock in the order of section 2. Lock several rows of one table in id order
   (`ORDER BY "id" FOR …`, or sort before a loop of `UPDATE`s).
2. Never take a Class row after a Member row, nor a Member row after a row
   that references it — take the Member (KEY SHARE is enough) first.
3. Keep transactions that hold Member rows short; batch bulk writers.
4. A new door into attendance goes through `performCheckin` (or the coach
   tick's `lockedClassEligibility`), never a bare insert.
5. (11 Nov 2026, club-managed categories) Never lock a Class or Member row
   after a ClassCategory row. A category rename, archive, restore or reorder
   writes ClassCategory rows only, in id order when several, and nothing else
   in that transaction except its audit row. A transaction that assigns a class
   to a category (which takes the category row `FOR SHARE` through the trigger)
   must not then rename or archive that category: two such transactions would
   deadlock on the share-to-exclusive upgrade. Moving many classes off a
   category is a separate transaction from changing the category. Tests:
   `tests/integration/class-categories-bridge-db.test.ts` ("archive against
   assignment, on two connections").

## 8. Session cover (26 Nov 2026, round 2 of PR #134)

`lib/session-cover.ts`. One order in every path: **cover advisory lock (COVR, level 1) → the session's
`ClassInstance` row → its `SessionCover` row → audit**.

- **COVR** is `pg_advisory_xact_lock(COVR, hashtext(tenantId:userId))`, one key per coach per club, and a
  transaction takes **at most one**, before any row lock: the coach a claim, assign, replace or reconfirm puts on a
  session, or the regular coach a give up, withdraw or return puts back on it (read with a plain query first). It
  serialises that coach's overlap check, so two of their claims, or a claim and an assignment of them, cannot both
  pass.
- **The session row** is then locked `FOR NO KEY UPDATE` (`lockSessionForCover`). Two cover changes of one session
  are serial; a cancel or restore (an `UPDATE` of the row) waits for a cover change and a cover change waits for a
  cancel, and reads the session again after the lock, so a claim or assignment never lands on a cancelled session
  and a cancel never misses a cover committed under it. A check-in's attendance insert takes only `KEY SHARE` on the
  session and does not wait.
- **Cancel / restore** (`app/api/classes/[id]/instances/[instanceId]/route.ts`): the session `UPDATE`, then
  `closeCoverOnCancel` (re-takes the same row lock, a no-op, then closes the cover row with a count-checked audit).
- **Weekly-slot edit** (class PATCH): Class `FOR UPDATE` (level 2) → the sessions it will delete `FOR UPDATE` in id
  order (`lockSessionsForDelete`) → their cover rows (moved or closed, every update pinned and count-checked) →
  the session `DELETE`. A re-timed session's `UPDATE` holds its row while its cover is flagged.
- **Archive, pause, undo of a resume or restore** (class DELETE, class PATCH, `lib/undo-registry.ts`): the Class row →
  the class's upcoming sessions with an active cover, `FOR NO KEY UPDATE` in id order (`lockSessionsForCover`) →
  their cover rows closed (`closeCoversForClass`). **Superseded in round 3 (below): every session of the class.**
- **Staff deactivation** (`app/api/staff/[id]/route.ts` DELETE): that person's COVR key first → the User row →
  their covered upcoming sessions `FOR NO KEY UPDATE` in id order → the cover rows reopened
  (`reopenCoversOfDeactivatedCoach`).
- No cover path takes a Class or Member lock after a session row, and no cover path holds a session row while asking
  for a COVR key. A class PATCH that changes `coachUserId` takes no COVR key: the regular-coach form has never had an
  overlap rule (unchanged by cover). **Superseded in round 3: it now takes the new coach's COVR key.**
- Tests that force each interleaving (a parked transaction, the other side seen waiting in `pg_stat_activity`):
  `tests/integration/session-cover-races-db.test.ts`.

### 8.1 Round 3 of PR #134 (26 Nov 2026): class-wide session locks

Round 2 left two gaps (review of 7d7b17df): archive and pause locked only the sessions they already saw with a cover,
so a Request or Assign on another session of the class slipped past them (should-fix 1); and three writers locked
several session rows in different orders, so a weekly-slot edit and a deactivation could deadlock (nit 2), and the
replacement a slot edit carries a cover to was not locked at all (nit 1). Round 3 adds ONE class-wide lock and uses
it in every writer that touches more than one session of a class:

`lockClassSessions(tx, tenantId, classId)`: every `ClassInstance` of the class dated from three days ago on, **one
statement, `ORDER BY ci.id FOR NO KEY UPDATE`**. It is taken after the Class row and before any cover row is read.
A check-in's attendance insert (`KEY SHARE` on the session) does not wait for it.

Levels, in the order every path takes them (a path may skip levels, never go back up):

| Level | Lock | Taken by |
|---|---|---|
| 1a | MATS advisory (club) | class create or PATCH naming a mat, mats writers, undo touching a class |
| 1b | COVR advisory (club:coach), **at most one per transaction**, after MATS when both | cover actions, class PATCH naming a regular coach, staff deactivation |
| 2 | `Class` row (`FOR UPDATE`, or `NO KEY UPDATE` by an `UPDATE`) | class PATCH, archive, undo, check-in, booking |
| 2b | `User` row (`NO KEY UPDATE` by an `UPDATE`) | staff deactivation only |
| 3 | `ClassInstance` rows: ONE row, or several in ONE statement `ORDER BY id` (a second statement may only re-lock rows already held, e.g. the slot edit's `FOR UPDATE` before its deletes) | every path below |
| 4 | `SessionCover` rows, only of sessions this transaction holds at level 3 | every cover writer |
| 5 | audit `INSERT` | every writer |

Every path that touches cover:

| Path | Order | Where |
|---|---|---|
| Request | session S `FOR NO KEY UPDATE` → its cover row (insert `ON CONFLICT DO NOTHING`, or a pinned update) → audit | `applyCoverAction` |
| Claim, reconfirm | COVR(self) → S → cover row → audit | `applyCoverAction` |
| Assign, replace | COVR(the coach named) → S → cover row → audit | `applyCoverAction` |
| Give up, withdraw, return | COVR(regular coach, plain read) → S → (refused as CHANGED if the regular coach changed in between) → cover row → audit | `applyCoverAction` |
| Cancel | S `UPDATE` → S re-locked (no-op) → cover row → audit. Restore: S `UPDATE` only | `instances/[instanceId]/route.ts`, `closeCoverOnCancel` |
| Weekly-slot edit | [MATS] → [COVR(new coach) if the PATCH names one] → Class `FOR UPDATE` → **class-wide session lock** → new sessions `INSERT` (own rows) → doomed sessions `FOR UPDATE` in id order (rows already held) → cover rows moved or closed (the replacement is held: class-wide lock, or this transaction's own insert) → session `DELETE` → re-timed session `UPDATE` (held) → their cover rows flagged → audit | `classes/[id]/route.ts` `reconcileSchedules`, `moveCoversBeforeDelete`, `flagCoversForRetime` |
| Pause (class PATCH) | Class `FOR UPDATE` → Class `UPDATE` → **class-wide session lock** → cover rows closed → audit | `closeCoversForClass` |
| Change of regular coach (class PATCH) | [MATS] → COVR(new coach) → Class `FOR UPDATE` → (slot edit, if any, as above) → Class `UPDATE` → (resume or restore in the same PATCH: session `INSERT`s, own rows) → **class-wide session lock** → plain reads of that coach's covers; a clash throws and rolls back. Round 4: the check runs after the resume's inserts, so the sessions it mints are checked too; the class-wide statement re-locks those rows (already held) with the rest in id order | `regularCoachCoverClash` |
| Archive (class DELETE) | Class `UPDATE` → **class-wide session lock** → cover rows closed → audit | `closeCoversForClass` |
| Undo of a resume or restore | one row: [MATS] → the Class `UPDATE` → **class-wide session lock** → cover rows closed → audit. A batch (undo to a point): MATS → Class rows (`NO KEY UPDATE`, id order) → **every session of those classes, one statement in id order** (`lockBatchRows`) → Member rows → handlers, whose class-wide locks then land on rows already held | `lib/undo-registry.ts`, `lib/undo-batch.ts` |
| Resume, restore | Class `FOR UPDATE` → Class `UPDATE` → session `INSERT`s (own rows). No cover row is touched. With a change of regular coach: then the class-wide session lock and the clash check (row above) | `mintUpcomingSessions` |
| Staff deactivation | COVR(person) → User `UPDATE` → that person's covered upcoming sessions, one statement in id order → cover rows reopened → audit | `staff/[id]/route.ts`, `reopenCoversOfDeactivatedCoach` |
| Check-in, coach tick | Class `FOR UPDATE` → Member → attendance `INSERT` (`KEY SHARE` on S: compatible with every cover lock) | `lib/checkin.ts` |

Why no two paths can take the same locks in opposite orders:

1. **Advisory keys.** Every transaction takes at most one COVR key, before any row; the only transaction with two
   advisory keys is a class PATCH naming both a mat and a coach (MATS then COVR), and nothing takes COVR then MATS.
   No transaction holds a row while it waits for an advisory key.
2. **Class before session.** Every path that holds a Class row takes it before any session row; no cover path, cancel
   or deactivation takes a Class row at all. So nothing holds a session row and waits for a Class row.
3. **User.** Only deactivation locks a User row, after its COVR key and before sessions. Cover inserts take `KEY SHARE`
   on the User they name, which `NO KEY UPDATE` does not block.
4. **Sessions.** A cover action, cancel or restore locks exactly ONE session and asks for no other. Every writer of
   several sessions (slot edit, pause, coach change, archive, undo, deactivation) locks them in ONE statement ordered
   by id; two ascending lock sequences cannot wait on each other in a cycle. An undo batch over several classes locks
   all their sessions in one statement before any handler, so its per-class locks later are re-locks of held rows. The slot edit's later statements
   (`FOR UPDATE` before the delete, the re-time `UPDATE`) touch only rows the class-wide statement already holds, so
   they cannot wait on another session writer (nit 2 closed: before round 3 the edit locked its doomed rows, then its
   re-timed rows in scan order, and deactivation could hold one of each).
5. **Cover rows.** A cover row is written only by a transaction that holds its session at level 3; the unique key on
   `classInstanceId` is therefore never contended by two writers that do not already queue on that session (nit 1
   closed: the replacement session is held by the class-wide lock, so a same-moment Request on it waits, and the
   edit then sees its row and does not carry the old cover onto it).
6. **Residual waits, not cycles.** A row the slot edit means to delete that another transaction holds with `KEY SHARE`
   (an attendance or waitlist insert) makes the edit wait, as before round 3; the check-in and coach tick hold the
   Class row first, which the edit already holds. Every wait is bounded by the 10 s `lock_timeout`.

Forced-order tests (both directions; `tests/integration/session-cover-races-db.test.ts`): archive against Request
(K1, K2) and Assign (K3, K4); pause against Request (K5, K6) and Assign (K7, K8); change of regular coach against a
claim (L1, L2); deactivation against a claim (L3, L4); reconfirm against a slot edit (L5, L6); a Request on the
replacement against the slot edit that carries a cover to it (M). Each case records what the second side waited on
(advisory key, single-session lock, or the class-wide `ORDER BY ci.id … FOR NO KEY UPDATE`).

### 8.2 Round 4 of PR #134 (27 Nov 2026)

- The clash flag (one person shown on two overlapping sessions, one a cover) is worked out at read time by
  `lib/session-clash.ts` `loadTeacherClashes`: two plain `SELECT`s, no lock, no write, so it adds nothing to the
  orders above.
- The change-of-regular-coach check now runs after a same-PATCH resume's session `INSERT`s (row above). Withdraw and
  Return of an OPEN request count only the sessions the regular coach covers; the locks they take are unchanged.
