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
(`lib/auth-lockout.ts`), login-address claims (`lib/login-email.ts`, LGID).

Every tenant transaction sets `lock_timeout` 10 s and `statement_timeout`
15 s (`lib/prisma-tenant.ts`); a wait past 10 s fails with 55P03. Postgres
detects a deadlock after `deadlock_timeout` (1 s) and aborts one side (40P01;
the check-in engine answers it as `{ kind: "error" }`).

## 2. The order every writer follows

1. **Advisory locks first** (rate limit, lockout, LGID claim), in their own
   short transaction or as the first statement of the writer's transaction.
2. **Class rows**, `FOR UPDATE` (check-in, booking, class PATCH, squad
   removal) or `FOR NO KEY UPDATE` (undo batch); several Class rows in id order.
3. **Member rows**, `FOR NO KEY UPDATE` (check-in, undo batch, every member
   UPDATE) or `FOR UPDATE` (member deletion); several Member rows in id order.
4. **Rows that hang off them**: the member's pack, roster rows, bookings,
   attendance, rank rows.
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
| Class archive | Class `UPDATE` (one statement) | same file, DELETE |
| Single squad removal | (D2, 24 Oct) Class `FOR UPDATE` → roster row `DELETE` → plain booking read → durable audit `INSERT`. Before: roster `DELETE` → booking `DELETE`, no Class lock | `app/api/classes/[id]/roster/[memberId]/route.ts` |
| Squad add | roster `INSERT` (KEY SHARE Class, Member) | `app/api/classes/[id]/roster/route.ts` |
| Rank award / promotion | member-rank `UPDATE`/`UPSERT`, history `INSERT`; no Member or Class lock | `app/api/members/[id]/rank/route.ts` |
| Demotion | member-rank `UPDATE`, history `INSERT` → (D2) plain reads → durable audit `INSERT` per class. Before: booking `DELETE` | `app/api/members/[id]/rank/demote/route.ts` |
| Member PATCH (plan, status, hold, details) | LGID advisory (address change only) → Member `UPDATE` → token retirement → status event `INSERT` → audit `INSERT` (durable) | `app/api/members/[id]/route.ts` |
| Member deletion | Member `FOR UPDATE` → imported bookings, mappings, rank history, ranks, redemptions, packs, attendance, bookings, waitlist, login events `DELETE` → Member `DELETE` (cascades: roster rows, status events) | `lib/member-delete.ts` |
| Undo to a point (≥ 2 rows) | Class rows `FOR NO KEY UPDATE` in id order → Member rows `FOR NO KEY UPDATE` in id order → handlers (snapshot `UPDATE`s, roster `INSERT`/`DELETE`, attendance `DELETE` with pack restore) → audit `INSERT`s | `lib/undo-batch.ts` `lockBatchRows` |
| Undo of one row | that handler's statements only | `lib/undo-registry.ts` |
| TeamUp import, create | per 25 rows: Member `INSERT`, ledger `INSERT`; job `UPDATE` | `app/api/admin/import/[id]/commit/route.ts` |
| TeamUp status refresh | per 25 members: Member `UPDATE` × 25 (**id order since 24 Oct**, was file order) → status events → job `UPDATE` | same file, `commitRefresh` |
| Refresh rollback | ONE transaction: Member `UPDATE` for every changed member (**id order since 24 Oct**) → status events → job `UPDATE` → audit | `app/api/admin/import/[id]/rollback/route.ts` |
| Import rollback (create) | ONE transaction (budget = function limit − 10 s): imported attendance `DELETE` → Member `DELETE` (children, then adults; one statement each, scan order) → ledger `DELETE` → job `UPDATE` → audit | same file |
| Attendance-history import | job lease `UPDATE` → per 400 rows (60 s budget): Class/session `INSERT` (KEY SHARE Class), attendance `INSERT` (KEY SHARE Member, session), imported-booking `INSERT`/`UPDATE`, mapping upserts. No Member `UPDATE`, no Class `FOR UPDATE` | `lib/attendance-import.ts` |
| Stripe webhook (dispute) | Member `UPDATE` → pack `UPDATE` | `app/api/stripe/webhook/route.ts` |
| Refund | pack `UPDATE` | `app/api/payments/[id]/refund` |

## 4. Cycles

| # | Pair | Cycle | Status |
|---|---|---|---|
| C-1 | TeamUp refresh batch / refresh rollback **vs** undo batch | Refresh updated two members B then A (file order) while the undo batch locked A then B (id order): each holds one and waits for the other. | **Fixed 24 Oct**: both refresh writers update in id order. Test A proves the opposite order deadlocks; test F proves the same order queues. |
| C-2 | Class PATCH squad rewrite **vs** member deletion | The PATCH (holding the Class) deleted the class's roster rows, then inserting the new squad waited for KEY SHARE on member M; the deletion (holding M `FOR UPDATE`) cascaded to M's roster rows, one of which the PATCH had deleted, and waited for the PATCH. | **Fixed 24 Oct**: the PATCH takes KEY SHARE on the new squad's members, id order, before touching any roster row. Test G. |
| C-3 | Import rollback **vs** undo batch | The rollback deletes members in one statement (scan order); the undo batch locks members in id order. A cycle needs two members in both sets. | Not reachable in practice: the rollback keeps every member edited after the import ("edited after the import"), and an undo batch only covers staff edits. Recommendation if it ever matters: lock the removable members `ORDER BY id FOR UPDATE` before the deletes. |
| — | Check-in **vs** any writer above | None: no writer takes a Member row and then a Class row (test B shows that would deadlock), and the writers that lock both take Class first (tests C, D, E). The attendance import's KEY SHARE on members does not conflict with the check-in's Member lock. | Holds. |

## 5. Risky waits (no cycle, but a long queue)

- **W-1. A check-in holds the Class row while it waits for the Member row.**
  Any long transaction holding a Member row stalls that member's check-in and,
  behind it, every check-in and booking for that class, until `lock_timeout`
  (10 s) fails them. The long holders: the import rollback (one transaction
  for the whole run), the refresh rollback (one transaction for every changed
  member), a refresh batch (25 members), a member deletion with a long history.
  Recommendation (not implemented; changes the check-in's failure mode): take
  the Member lock with a short `SET LOCAL lock_timeout` (about 3 s) and answer
  "busy — try again" rather than hold the class for 10 s; and split the two
  rollbacks into batches like the refresh.
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
