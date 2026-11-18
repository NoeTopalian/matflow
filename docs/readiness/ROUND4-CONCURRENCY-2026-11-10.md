# Round 4: simultaneous editing and transaction integrity (10 Nov 2026)

- **Branch:** `programme/rounds`.
- **Baseline:** `e188a615` (Round 3 closed out).
- **State:** not pushed, merged or deployed. Synthetic data on the Neon test branch only.
- **Final code head:** `e6efec3a`.
- **Verdict: READY FOR REVIEW.**
  - Every defect found was reproduced first and is now fixed.
  - The remaining last-write-wins cases are listed and justified under Limitations.
  - One finding is a live production data-loss defect (R4-0). It needs Noe's decision on a hotfix and on recovering the erased notes.

Noe's priorities for this round, in order:
1. Actual data loss and duplicate actions.
2. Different fields from two admins both kept.
3. A newer value never silently overwritten.
4. A committed save whose reply is lost does not overwrite a later change when it is retried (CONCURRENCY-1).
5. Double clicks and retries do not duplicate records, charges, credits or notifications.
6. Overlapping membership, roster, capacity and check-in requests stay consistent.
7. The audit trail matches what committed.

Every defect below was **reproduced first** against the real database under both roles (`neondb_owner` and `matflow_app`). The test that shows the defect is kept in the suite. Where it documents the legacy behaviour of a body without the new precondition, it stays as a passing record of that behaviour.

## Defects found and fixed

| ID | Defect (reproduced) | Fix | Commit |
|---|---|---|---|
| R4-1 (CONCURRENCY-1) | **Settings and branding.** Admin A's save committed with its reply lost. Admin B changed the same field. A's retry put A's value back over B's. Waiver text could be replaced the same way. | **Per-field precondition.** The client sends `expected`: the value it last saw for each changed field (`lib/settings-precondition.ts`). The route holds the club row `FOR NO KEY UPDATE` for its short transaction and writes a field only while it still holds that value. A retry that finds its own value already stored writes nothing and is not audited again. Anything else is a 409 `stale_settings` naming the current values, and nothing in that save is written. | `bfad4ba6` |
| R4-2 | **Belt award.** Two identical awards at once, or a retry after a lost reply, wrote two history rows, two audit entries and two pushes. | **Member row lock.** The member row is held `FOR NO KEY UPDATE` (lock order level 3). An award of the belt and stripes already held is "unchanged": no history, audit or push, and the same photo is not attached twice. | `755cdc4e` |
| R4-3 | **Demotion.** Two identical demotions with "tell the member" wrote two history rows and sent two emails. | **Same lock, same rule.** A demotion to the belt already held, with no stripes, is "unchanged". | `755cdc4e` |
| R4-4 | **Payment chase.** Two chases at once sent two reminder emails. The 3-a-day limit allows it. | **One per minute.** One reminder per member per minute, through the rate-limit store (advisory lock plus conditional insert). The repeat is a 409 `chase_just_sent`, checked before the daily allowance so it does not use one up. | `fcae6633` |
| R4-5 | **Member notes.** The notes box sent `{ notes }` with no precondition, so a save from an older page replaced newer notes. | **`expectedNotes` precondition.** A notes-only save is one conditional `UPDATE … WHERE notes IS NOT DISTINCT FROM expected`, with the audit row in the same transaction. It does **not** bump the row version (review H): a notes save that moved `updatedAt` let a page adopt another admin's version and then pass a stale whole-form profile save. The page keeps the stored, sanitised text. A retry already stored is a 200 with nothing written; a conflict is a 409 `stale_notes` carrying the current notes. | `074d15c1`, `d73f3408` |
| R4-6 | **Plan editor.** It sent every field it had loaded, so a rename from an older tab put back the old price. | **Only changed fields.** The editor sends only what changed, with `expected`. The route takes a plan row lock and applies the same per-field precondition. A 409 `stale_plan` keeps the form open. | `5e78e249` |
| R4-7 | **Class editor.** It sent name, coach, venue, duration, capacity, kids, description and the rank gates on every edit, so a coach change from an older tab put back the old capacity. The days were already protected (P6, `baseScheduleIds`). | **Only changed fields.** Those fields are sent only when changed, with `expected` (`withClassPreconditions`). The route checks them under its existing Class row lock, before any roster, tier, schedule or booking write. A conflict rolls the whole edit back (409 `stale_class`). | `08690667` |
| R4-8 | **Announcements.** Two identical posts at once, or a retry, created two notices. | **Once per two minutes.** One post per club per notice text per two minutes, through the rate-limit store. The repeat gets the notice already posted (200), or a 409 `announcement_in_flight` while the first is still committing. | `79b5fe3c` |
| R4-0 (data loss, live on main) | **Profile edits erased internal notes.** Every member PATCH that did not send notes erased the member's internal notes. That covers a staff profile save, a plan change from the Subscribe drawer, a status change and a support edit session. `notesField` turned an absent key into `null` (`.nullish().transform(s => sanitiseNoteText(s ?? null))`), and the route spread it into the update. In place since `39385235` (1 Jun 2026). | **The transform keeps an absent key absent.** `null`, blank and whitespace-only still become `null`. The text erased in production is **not** in the audit log (notes are not in the diff fields). Affected edits can be identified because their audit rows list `notes` in `metadata.fields` although the screen never sent notes. | `e21de5f1` |
| R4-9 | **Add child.** The owner's Add child form sent no request id (Add member does), so a retry added a second child. A request with no reply threw an error nobody saw. | **Retry-stable request id.** The server already replays a known id (unique `tenantId`+`createRequestId`, P2002 replay). A request with no reply now says the outcome is unknown and that adding again is safe. | `6c02f77d` |

**On a conflict, every affected screen does the same thing.** Settings → Branding, both waivers, Internal notes and the plan editor:
- keep the draft;
- say which fields someone else changed (`SettingsConflictNotice`);
- offer **Use the latest**, which shows the current values and sends nothing, or **Save mine instead**, which saves knowingly against the current values.

Nothing resubmits by itself, and an actively edited form is never replaced by a server snapshot unless the owner chooses to. The class editor shows the server's sentence and keeps its form open; it has no inline Use latest / Save mine (see Limitations).

## Independent review (of `e188a615..6c02f77d`)

A code-reviewer pass found **1 high, 6 medium and 7 low** issues. All fixes are in `d73f3408`.

| Finding | Disposition |
|---|---|
| **H** The notes conflict and success paths adopted another admin's row version, so a later profile save could silently undo their phone change | Fixed. A notes-only save leaves the version alone, and the page never takes one from it. DB test "Y changes the phone and the notes; X's profile save from before is still refused"; screen test "after 'Use the latest', a profile save still sends the version the page opened with" |
| **M** Trailing whitespace made the next notes save a false conflict | Fixed: the page keeps the stored text |
| **M** The class squad and rank-gate switch overwrote the other mode with no precondition | Partly fixed. A squad save always expects both rank fields, so a gate set elsewhere is a conflict. Still open: a rank save from an older tab can clear a squad edited elsewhere (no `baseRosterIds`; listed under Limitations) |
| **M** A `stale_class` refusal had no way out | Fixed: Reload, as for `stale_schedules` |
| **M** The announcement fingerprint was title and body only | Fixed. Pinned, image and expiry are included, and the hit is released when the create fails |
| **M** The plan allowance and description were last write wins | Fixed: both expect what the editor loaded, and dates compare by day |
| **M** The chase hit was spent before the lookups and the send | Fixed: released on every refusal and on a failed send |
| **L** `""` versus `null`; BigInt and Decimal; plan audit fields; `expectedNotes` without `notes`; lock-order doc | Fixed |
| **L** The rank photo check sits outside the Member lock (a double click can attach a photo twice) | Open (Limitations) |
| **L** A rate-limit store outage refuses a `*-once` action as a duplicate | Open (Limitations) |

## Mutation paths (what protects each one)

"Last write wins (justified)" means a body without a precondition still replaces the stored value. The reason is given in each case.

| Path | Read before write | Transaction and lock | Constraint / version check | Retry and stale client | Audit |
|---|---|---|---|---|---|
| Member profile (staff) | row | one tx, conditional `updateMany` | `updatedAt` (US-508 D1): a whole-form save from an older page is a 409 | the 409 keeps the form; a retry after a lost reply is refused, not applied (safe, but it reads as "someone else") | in tx |
| Member notes | row | same `updateMany` | `expectedNotes` (R4-5) | retry already stored = 200, nothing written | in tx |
| Member status and plan (profile save) | row + Stripe | profile tx; Stripe cancel before the write | `updatedAt` | as profile | in tx |
| Member create / add child | requestId replay | one tx | unique `(tenantId, createRequestId)`, `(tenantId, email)` | replay returns the existing member (R4-9) | after commit |
| Rank award / demotion | current rank | one tx, Member `FOR NO KEY UPDATE` (R4-2/3) | unique `(memberId, rankSystemId)` | same award = no-op | after commit; none for a no-op |
| Class settings | Class row | one tx, Class `FOR UPDATE` first (T6a) | `baseScheduleIds` (P6) for days; `expected` for fields (R4-7) | stale field = 409, whole edit rolled back | after commit |
| Roster add/remove | Class row | Class `FOR UPDATE` (D2) | unique roster row | idempotent | after commit |
| Booking and capacity | Class row | Class `FOR UPDATE` before counting | unique booking | covered by the race suites below | — |
| Check-in and attendance | Class, then Member | Class then Member locks (LOCK-ORDER) | unique `(memberId, classInstanceId)` | a duplicate scan is the same row; card-scan retry suite | check-in rows |
| Pack credits and allowance | Member lock, then pack/allowance read | one tx | allowance read after the Member lock (T7) | race suites below | — |
| Club settings and branding | club row | `FOR NO KEY UPDATE` when `expected` (R4-1) | `expected` per field | retry already stored = 200, not audited again | after commit; none for a no-op or a conflict |
| Plans (tiers) | tier row | `FOR NO KEY UPDATE` when `expected` (R4-6) | `expected` per field | as settings | after commit |
| Initiatives | — | single statements | — | last write wins (justified: one owner's own notes on campaigns; no money or access) | after commit |
| Announcements | — | rate-limit advisory lock | once per text per 2 min (R4-8) | repeat returns the same notice | after commit |
| Manual payments, ad-hoc charges | idempotency key | one tx | idempotency key (existing) | replay | after commit |
| Order mark-paid | status | conditional `updateMany` on status | the transition itself | second call is a no-op | after commit |
| Refunds | pack row lock (W6) | `SELECT … FOR UPDATE` | refund race suites | — | after commit |
| Payment chase | rate limit | advisory lock | once per member per minute (R4-4) | repeat 409 | after send |
| Imports and refresh | job state | per-job transactions | file hash, job status, `skipDuplicates`; a live check-in wins over an imported one | duplicate committed file refused (409) | job rows |
| Stripe webhook | event id | claim inside the tx | unique `StripeEvent.eventId` | a redelivery is a P2002 and is skipped | — |
| Nightly class sessions | — | — | `createMany({ skipDuplicates })` on `(classId, date, startTime)` | re-run inserts nothing new | — |
| Monthly report cron | — | — | unique `(tenantId, periodStart, generationType)` | a re-run is skipped (P2002) | — |

**Lock order** (`docs/design/LOCK-ORDER-2026-10-24.md`):
- The new locks are the club row (`FOR NO KEY UPDATE`, settings), the plan row (`FOR NO KEY UPDATE`) and the member row (`FOR NO KEY UPDATE`, rank).
- None of these writers holds a Class or Member row before taking them.
- `FOR NO KEY UPDATE` does not block the `KEY SHARE` that inserts take on a referenced row, so check-ins and audit rows for the club are not held up.
- Each lock lasts one short transaction, with no network call inside it.

## Required scenarios: results

| Scenario | Result | Evidence |
|---|---|---|
| Two admins edit different fields | **Both kept** for settings, notes beside a phone edit, plans and classes. The member profile's whole-form save is refused (409) rather than overwriting: nothing is lost, but the second admin has to reapply their edit | `round4-*-db` tests ("different fields both kept") |
| Two admins edit the same field | **Exactly one wins; the other is told** for settings, notes, plans and classes | concurrent tests in each `round4-*-db` file |
| Stale save after a critical change | **Archived, cancelled and erased members are protected by earlier rounds.** Archived members are read-only (`refuseArchivedMember`), erased ones refuse resurrection, and a class archive's resume and restore are explicit. Stale class edits are now refused per field. | existing archive/erasure suites; `round4-class-edits-db` |
| Concurrent capacity, allowance, packs and check-in | **Existing serialisation holds**, re-run under both roles | race suites below |
| Double clicks, retries and lost responses | **Recorded once** for rank, demotion, chase, announcement, add child, settings, notes and plans | `round4-*-db` and the browser journey |
| Imports and staff edits | **Unchanged in this round.** A live check-in wins over an imported one (`skipDuplicates`); a refresh never restores an earlier status (T8b status backfill, per-club advisory lock) | earlier rounds' import suites; Round 7 re-examines imports |
| Delete and update races | **Existing:** member deletion takes the Member `FOR UPDATE` lock (D3); deletion race suite re-run | `sec-d3-deletion-race-db` |
| Background jobs and webhooks | **Idempotent** by unique keys (table above). Not run against live providers | static review + existing unit tests |

## Verification

### Commits
App code is in the commits listed under "Defects found and fixed". The journey was committed separately as `2a0f8ae7`.

### New database tests (both roles)

| File | Cases |
|---|---|
| `round4-settings-concurrency-db` | 9 |
| `round4-rank-awards-db` | 5 |
| `round4-payment-chase-db` | 3 |
| `round4-member-notes-db` | 6 |
| `round4-plan-edits-db` | 6 |
| `round4-class-edits-db` | 6 |
| `round4-announcement-once-db` | 3 |
| `round4-child-create-db` | 2 |

Each file covers the reproduction, the fix, a lost-reply retry, a real concurrent pair through `Promise.all` (both requests in flight against the same rows), cross-club refusal and, where relevant, role refusal.

### New and changed unit tests
- `round4-settings-precondition`: 7 cases.
- `round4-class-preconditions`: 3 cases.
- `round4-add-child-request-id`: 1 case.
- Conflict-UI cases added to `round2-settings-truth` (4), `verifier-lane7-screen-errors` (4) and `memberships-manager-description` (4).
- Mocks updated for the new row lock in 5 rank and demotion tests; the `sec-c-static-guards` raw-SQL list gains the 4 reviewed lock sites.

### Existing race suites, both roles
Run on `6c02f77d` in three batches, so each role stays inside the runner's 10-minute limit. All 12 files pass under both roles: 66 tests per role.
- **Batch 1 (13/13):**
  - `card-scan-concurrency-db`
  - `card-scan-retry-db`
  - `checkin-allowance-race-db`
  - `checkin-pack-race`
- **Batch 2 (39/39):**
  - `checkin-allowance-review-db`
  - `lock-order-contention-db`
  - `sec-d3-deletion-race-db`
  - `tier-class-allowance-db`
- **Batch 3 (14/14):**
  - `sec-pre-resend-owner-refund-race-db`
  - `sec-pre-resend-pack-refund-race-db`
  - `booking-preservation-db`
  - `class-lifecycle-db`

### Round 4 database files after the review fixes
All 8 files on `d73f3408`: 50/50 under `neondb_owner` and 50/50 under `matflow_app`.

### Browser (synthetic club, test branch)
**On `e6efec3a`:**
- `round4-settings-conflict`: 7 PASS / 0 FAIL, two browser contexts:
  - C1: stale tab refused, draft kept;
  - C2: Save mine instead, by keyboard;
  - C3: Use the latest, sends nothing;
  - C4: lost reply (the server commits, then the browser's response is aborted), retry succeeds, one audit row;
  - C5: Noe's scenario. A's save commits with its reply lost, B changes the field, A retries: A refused, B's value kept, A's draft kept;
  - M1: phone at 390 px;
  - J1: no page errors.
- `timetable-lost-update`: 6/0.
- `timetable-location`: 12/0.

**On `6c02f77d`:** `classes-lifecycle` 56/0/4.

**Build:** clean on `6c02f77d` and on `e6efec3a`.

### Mutation proof
17 planted regressions, each run against its own test (database tests through `db-tests.mjs`, both roles), all caught. Scratchpad runner: `mutations-r4.py`.
- **Server preconditions ignored:**
  - settings (R4-1, R4-13 double audit, R4-14 partial write);
  - plans (R4-6);
  - classes (R4-7).
- **Duplicate guards removed:**
  - the rank no-op (R4-3);
  - the chase once-check (R4-4);
  - the announcement once-check (R4-8).
- **Notes guard dropped** (R4-5).
- **Client preconditions not sent:**
  - branding (R4-2);
  - notes (R4-12);
  - plan editor sending every field (R4-10);
  - class editor sending the whole form (R4-9);
  - add child with no request id (R4-11).
- **Notes regressions:**
  - absent notes becoming null again (R4-15, the data-loss fix);
  - a notes-only save bumping the row version (R4-16);
  - the page adopting a conflict's row version (R4-17, the review H fix).

R4-9 first survived: the helper's unit test does not see the form. A form-level test in `timetable-save-refused` now kills it.

### Full suite, typecheck, lint
- **Suite on `e6efec3a`:** 670 files and 9,437 tests passed. The 132 files skipped are the database files, run separately above.
- **Typecheck:** clean.
- **Lint:** passes, with every UI-RULES ratchet at its baseline.

## Performance (measured 11 Nov 2026; replaces the earlier unmeasured claims)

**How it was measured.**
- File: `tests/integration/round4-perf-db.test.ts`.
- Real `PATCH /api/settings` against the Neon test branch, run as both roles.
- The numbers below are from the `matflow_app` run.
- They are from this machine over the internet, so each request includes several network round trips. They are not production latencies.

| Measure | Result |
|---|---|
| Settings save, no `expected` (n = 20) | p50 1,404 ms, p95 1,552 ms |
| Settings save with `expected` (row lock + compare, n = 20) | p50 1,639 ms, p95 1,839 ms: about +235 ms, consistent with one extra statement |
| 10 concurrent saves of the same field from the same base | One 200 and nine 409. They **queue on the row lock**: the last answered after 8.65 s |

**Limitations.**
- **Writers queue.** Same-field writers to one club's settings, or one plan, are served one at a time. Ten at once took about 9 s here. Real clubs have one or two staff editing settings, but the queue is real.
- **Lock timeout.** `lock_timeout` is 10 s per transaction (`lib/prisma-tenant.ts`). A queue longer than that fails the later saves (Postgres 55P03), which the route answers as a 500.
- **Other routes not measured.** Rank, notes, plan and class locks were not measured separately. They are the same single-row primary-key lock pattern; the class route already held its lock before Round 4.
- **Rate-limit checks.** The chase and announcement checks are one store hit each, like the existing daily limit. Not measured separately.

## Duplicate protection: what each mechanism is (Round 4 substantiation)

| Action | Mechanism | Kind | Persistence | Window | Simultaneous requests | Committed, reply lost, then retried | After the window | A legitimate later action |
|---|---|---|---|---|---|---|---|---|
| Belt award / demotion | Member row lock; the request is compared with the rank held | **Idempotency by state** | `MemberRank` row (Postgres) | None (state-based) | One recorded; the other is "unchanged" (tested) | "Unchanged", nothing written (tested) | n/a: still unchanged while the rank is the same | Re-awarding a belt after a demotion is recorded once (tested) |
| Payment chase | `RateLimitHit` bucket `payment-chase-once:<club>:<member>`, max 1 | **Rate limit** | `RateLimitHit` rows (Postgres, advisory lock) | 60 s | One 200, one 409 `chase_just_sent` (tested) | 409 inside the minute; no second email (tested) | A new reminder is sent (tested, by back-dating the hit) | Allowed after 60 s, up to the existing 3 a day |
| Announcement | `RateLimitHit` bucket `announcement-once:<club>:<hash of title, body, pinned, image, expiry>`, max 1 | **Rate limit** plus lookup of the notice just posted | `RateLimitHit` rows; `Announcement` rows | 2 min | One 201; the other gets that notice (200) or 409 `announcement_in_flight` (tested) | The same notice back, 200 (tested) | A deliberate repost is created (tested) | A different notice (text, pinned, image or expiry) is created at once (tested) |
| Add child | `requestId` stored as `Member.createRequestId`, unique per club; replay on match or P2002 | **Idempotency key** | `Member` row (Postgres unique index) | None: permanent | One child, both answered with it (tested) | 200 with the same child (tested) | Still the same child, however late (tested) | A new Add child (new id) is a new child (tested) |

**Rate limit versus idempotency.**
- **Rate limit (chase, announcement).** Bounds how often an action can happen. It is not tied to one request. If the store is down, these "once" buckets are in the security class and are **refused**. The person is then told the action is a repeat when it may not be (listed under limitations).
- **Idempotency (child, rank).** Ties a retry to the original result with no time limit.

**Email and push: what "once" means here.**
- **Chase.** One committed chase is one `sendEmail` call. That call writes one `EmailLog` row and makes at most one provider request (`lib/email.ts`). The tests count `sendEmail` calls. Delivery by Resend, and the member actually receiving it, is **not** tested and not claimed. Exactly-once delivery is not claimed: a provider timeout after acceptance could still lead to a resend if staff chase again after the minute.
- **Rank.** One committed award queues one `sendPushToMember` call. Push delivery is not live (per `CLAUDE.md`) and is not tested.
- **Demotion "tell the member".** One `sendEmail` call per committed demotion (tested). Delivery is not tested.

## Remaining limitations (explicit last-write-wins and gaps)

- **Bodies without `expected`.** Settings and plan routes still accept them, as last write wins: onboarding, the single toggles (payment rail, BACS, timezone, member check-in) and older clients. The toggles send absolute values, so a stale toggle cannot invert anyone's change.
- **Member profile whole-form save.**
  - It is still protected by `updatedAt` (a 409), not per field. Two admins editing different profile fields means the second must reapply their edit; nothing is lost.
  - A retry after a lost reply is refused as "someone else changed this member". That is safe, but it is the wrong explanation.
- **Class editor on a conflict.** It shows the server's sentence and keeps the form, but has no inline Use latest / Save mine. Reopening the class loads the latest. Belongs to Round 6 (the timetable editor).
- **Initiatives** are last write wins (owner-only campaign notes).
- **Announcement fingerprint.** The whole notice (title, body, pinned, image, expiry). The same notice reposted deliberately within two minutes is treated as a repeat.
- **Squad versus rank gate: fixed in `51b1b7b9`.** The class editor sends `baseRosterIds`. A squad change or rank gate is refused if the squad changed since. Reproduced with two editors and fixed, both roles.
- **Rank photos.** A double click on an unchanged award with a new photo can attach that photo twice; the check runs outside the Member lock.
- **Rate-limit store outage.** If the store is down, the chase and announcement "once" checks follow the store's outage policy and can refuse a genuine action as a repeat.
- **Audit.** Most routes write the audit row after the transaction commits. A failure there leaves a committed change without its audit row. It is logged; it never records a change that rolled back. Member, staff and notes edits are audited inside their transaction.
- **Not exercised here:** live Stripe, Resend and push providers.
- **Pre-existing test failures**, which fail the same way on the Round 2 base `78e84038` under both roles:
  - `cron-smoke` class-instances (240 s timeout);
  - `contact-email-change-imports-db` (30 s timeout).

## Close-out (11 Nov 2026)

**Containment of R4-0.**
- **Hotfix branch:** `hotfix/member-notes-preserved` (worktree `matflow-worktrees/hotfix-notes`), from `origin/main` `33592fe0`. It holds the cherry-picked fix plus its DB test and review nits.
- **Evidence:** in the hotfix report to Noe. Not pushed.
- **Recovery plan:** `docs/readiness/NOTES-RECOVERY-PLAN-2026-11-11.md`, read-only.

**Squad versus rank gate:** fixed and verified in `51b1b7b9`, see Limitations.

**Unresolved findings, explicitly:**
- **Member profile whole-form save.** Protected by `updatedAt`, not per field. A retry after a lost reply reads as "someone else changed this member".
- **Class editor conflict UI.** Reload only, with no Use latest / Save mine. Round 6.
- **Rank photo.** A double click on an unchanged award with a new photo can attach it twice.
- **Rate-limit store outage.** The "once" checks refuse, and the message says "repeat".
- **Initiatives.** Last write wins.
- **Writers queue.** Same-field writers queue on the row lock. 10 at once took about 9 s on the test branch. Beyond the 10 s `lock_timeout`, later saves fail with a 500.
- **Bodies without `expected`.** Settings and plans still accept them, as last write wins (onboarding, toggles).

**Pre-existing test failures,** which fail the same way on the base `78e84038`, both roles:
- `cron-smoke` class-instances: 240 s timeout.
- `contact-email-change-imports-db`: 30 s timeout.
