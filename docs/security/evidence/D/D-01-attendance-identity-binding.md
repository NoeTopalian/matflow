# D-01 AH-D1 / SEC-053 / SEC-055: attendance import identity binding

Lane D, 9 Oct 2026. Branch `security/assurance-2026-10`, HEAD `2ec8d88` plus uncommitted working-tree changes (lanes A, C and D).
TEST branch only (ep-hidden-salad), through the guarded runners: `att/run-engine.sh` (role `neondb_owner`) and
`q78/run-restricted.sh` (role `matflow_app`, `RLS_ENFORCED=1`). Both runs log `current_user`.

## Question
Can the name+email fallback in `lib/importers/attendance.ts` COMMIT attendance history to the wrong member? Preview
visibility was not accepted as evidence. The test drives the REAL route `app/api/admin/import/attendance`
(`commit`, then `step` until done) and asserts the rows the commit wrote (`ImportedBooking.memberId`, `disposition`,
`AttendanceRecord`). Only the owner gate, CSRF, audit, mail, rate limiter and file store are stubbed.

## Result: YES, before the fix. Three false matches were committed (red on both roles)
| Scenario | Before the fix (owner and matflow_app) | After the fix |
|---|---|---|
| Identical names: hand-added Bea moved to a new address, and a DIFFERENT hand-added "Bea Lane" holds the old one. The row is Bea / old address | **attendance committed to the other Bea Lane (1 row)** | pending_person, 0 attendance, both offered as candidates |
| Roster drift: the person is unresolved at preview, and a matching member is added after `commit`, before `step` | **attendance committed to a member that was never previewed** | pending_person |
| Roster drift (re-point): the previewed member gives up the address mid-commit and a new same-name record takes it | **attendance committed to the new record** | stays with the previewed member |
| Positive control: unique name+email, and externalRef | committed (name_and_email, external_ref) | unchanged |
| Missing references (no email, no name) | pending | pending |
| Duplicate references | DB refuses a second member with the same `externalRef` (unique `tenantId, externalRef`), so the planner guard is defence in depth | same |
| Shared contacts (two names on one address) | only the name+address holder is bound | same |
| Changed source data (renamed at TeamUp) | pending, not re-bound to the same-name hand-added record or by address alone | same |
| Stale preview (roster changed between preview and commit) | 409 `stale`, nothing written (existing planHash guard) | same |
| SEC-055: two commits at once, two steps at once, replayed commit/step, second job over the same file | exactly one 202, the other step is busy, 60/60 bookings and attendance, replays change nothing | same |

Root causes. (1) The fallback bound by name+address even when another member had the same name. The unique email
constraint makes name+address unique, but it does not make the identity unambiguous. This was documented and pinned
as an accepted residual in `tests/unit/import-matching-after-contact-change.test.ts` ("the preview shows the match before
commit"). (2) `runStep` (`lib/attendance-import.ts`) re-plans every step against the LIVE roster. `commit` froze only the
decisions, not who each person resolved to, so the planHash check at commit time did not cover later steps (a resumed
or slow import).

## Fix (lane D files)
- `lib/importers/attendance.ts`: the name+email fallback now binds only when exactly one member carries that normalised
  name. Otherwise the row is pending and the candidates are offered. New `PlanDecisions.frozenPeople`: when present, it is
  the ONLY source of person resolution. A person absent from it, or whose member is gone, is pending.
- `app/api/admin/import/attendance/route.ts` `commit`: stores `frozenPeople` (every person's committed resolution) in
  `mappings.decisions`. `runStep` already passes `mappings.decisions` to the planner, so `lib/attendance-import.ts` needed no change for this.
- Also in these files, from lane C: SF-C2 (own-property decision lookups for person, offering and venue, plus
  `lib/attendance-import.ts` createHistoricalClasses; red then green with `tests/unit/sec-c-prototype-keys.test.ts`,
  `SF_C2_FIXED = true`) and SF-C5 (a JSON body of null, an array or a primitive gets 400, not 500; red then green with
  `tests/unit/sec-d-attendance-route-body-shape.test.ts`).

## Tests
- `tests/integration/sec-d-attendance-misbinding-db.test.ts`: 10 cells. Red on both roles before the fix (3 failed, 7 passed), green on both after (10/10).
- `tests/unit/sec-d-attendance-ambiguity.test.ts`: 11 cells. Mutants: removing the same-name guard fails 3, and disabling the frozen path fails 4. Both were reverted (byte-compared).
- Existing suites, owner and restricted, after the fix: `attendance-import-engine` and `contact-email-change-imports-db`, exit 0 on all four runs.
- **One existing test pins the old behaviour** and now fails as intended:
  `tests/unit/import-matching-after-contact-change.test.ts` "FALLBACK residual (documented)…". It is outside lane D's
  prefix, so it is not edited. The exact replacement is in `patches/import-matching-after-contact-change.test.ts.patch`. It was verified on a scratch copy
  (15/15) and the copy was removed. Coordinator approval is needed.

## Residual / UI
- Two TeamUp customers with the same name AND the same address collapse into one source key in TeamUp's own export,
  so no matcher can separate them. This is a source limit, and both are offered when MatFlow holds two such records.
- The UI labels candidates "same name"/"same email" (`components/dashboard/AttendanceImport.tsx`, not lane D's file).
  Now that a same-name case is pending, a label "same name and address" would help the owner. This is a proposal only.
- `GET ?list=people` on a RUNNING job shows the live roster's resolution, not the frozen one (display only).
  Proposal: select `mappings` in `JOB_SELECT` and pass the frozen set for running jobs.
- `loadClubInputs` builds the decision maps with plain `{}` assignment. A stored sourceKey `__proto__` sets the prototype
  instead of an own key. With the own-key lookups this is inert (it resolves to pending). A null-prototype map is the stronger form (proposal).

Commands: `bash <scratchpad>/att/run-engine.sh tests/integration/sec-d-attendance-misbinding-db.test.ts`, the same with
`q78/run-restricted.sh`, and `npx vitest run tests/unit/sec-d-attendance-ambiguity.test.ts`. Raw logs are in `<scratchpad>/security/D/logs/`
(`red-misbinding-*.log`, `green-misbinding-*.log`, `final-*.log`, `mutant-*.log`, `regress-*.log`).

## Retest after reviewer R (REPORT-D.md), HEAD 035e27e + lane D working tree
R refuted "never commits": accent ("Béa"), rename ("Beatrice") and zero-width variants of the original still committed
history to the different "Bea Lane" holding the released address. Red (real owner PATCH writes the audit row; real
attendance route): `sec-d-attendance-misbinding-db` 3 failed / 11 passed on both roles ("attendance committed to the
member who took the released address: expected 1 to be 0"). Planner red against HEAD: 5 failed / 13 passed.
Fix: (1) `foldName` (NFKD, strip Mn and Cf, collapse whitespace, lower-case) for the uniqueness test and candidates; a
fold collision is "not unique". (2) `loadClubInputs` reads every OLD-address digest in this club's audit rows
(`oldEmailSha256`, and `oldEmailDigest` from the operator contact-email route) and `buildPlan` passes
`releasedBy(email)`. A released address never matches by the fallback, and whoever released it is offered as a
candidate. The digest set is included in `planHashOf`. Green: misbinding 14/14 on each role (role asserted:
neondb_owner / matflow_app). attendance-import-engine 19/19 and contact-email-change-imports-db 7/7, each on both roles.
Mutants: fold reverted → 3 failed; release check removed → 2 failed. Both restored and byte-compared.
Residual: a release is recognised only through the audit trail. An address change made outside the audited writers
(raw SQL, a script) or before digests existed, or a rotated AUTH_SECRET (digest key), is not seen. Rows are then
caught only by the fold test.

## Third pass after reviewer R (REPORT-D2.md), HEAD 71cfe54 + lane D working tree
R showed that a release with no keyed audit row still let a false match commit: a raw-SQL move, a move recorded
before AH-E2 with the unkeyed SHA-256, and the original deleted with a different Bea Lane created at the address.
**The rule is now inverted.** The name+address fallback binds ONLY when all of these hold:
- the member holding the address is the only fold-match for the name;
- the member was created before the person's EARLIEST booking in the file;
- no release of that address is recorded for anyone, in any of these forms: the keyed `emailDigest`, the unkeyed
  `sha256(lower(trim(address)))` (rows before AH-E2), or the DSAR `hashToken` (`originalEmailHash`).
Anything else is pending, with the candidates offered.
Member has no `createdAt` column. Creation time is read from the immutable cuid v1 id (`cuidCreatedAt`). An id that
is not a plausible cuid gives "unknown", which never qualifies. Proposed migration (lead):
`Member.createdAt DateTime @default(now())`, backfilled from the id, then read that column instead.
Every in-app release path now writes `releasedEmailSha256 = emailDigest(address)` in its audit metadata, and
`loadClubInputs` reads it: member DELETE (target plus cascaded children), staff DELETE, DSAR erase, import rollback.
Red, real route, both roles: 4 failed / 15 passed (raw SQL, unkeyed, deleted, created-after-bookings). Green: see the
hand-back.

### Remaining residual (precise)
1. **Unaudited change on an old member.** A member that existed BEFORE the person's first booking, whose address
   was changed by raw SQL, a script or any other unaudited writer to an address that previously belonged to
   someone else, and the old holder's release was never audited. Created-before plus no-release is then satisfied, so
   the fallback binds. Only an audited writer, or an owner decision, closes this case. This is the same trust
   boundary as SEC-029 (writer bypass).
2. **Key rotation.** Keyed digests (`emailDigest`, `hashToken`) are HMACs under the auth secret. After a rotation,
   every release recorded under the old key is unmatchable. Unkeyed rows from before AH-E2 still match, because they
   carry no key. The created-before rule does not depend on a key, so a member created AFTER the bookings stays
   pending regardless. The residual is therefore limited to case 1 combined with a rotation. Mitigation: re-key the
   recorded digests during a rotation, or record a key id per row.
3. **Fold gaps (from R).** Cyrillic а/е, Greek ο, dotless ı and ß/ss do not fold together. A different-script
   look-alike can therefore pass the same-name check. It still has to pass created-before and no-release.
4. **Strictness cost.** Hand-added members created after their own historical bookings now always need an owner
   decision. Members from the TeamUp import match by externalRef and are unaffected.

## Fourth pass after reviewer R (REPORT-D3.md), HEAD 582dfce + lane D working tree
R approved the third pass. Two new residuals still bound through the real route on both roles: (2) an OLD member
acquired a never-held address through the audited owner PATCH after the bookings; (3) a keyed release, then a
rotation of AUTH_SECRET/NEXTAUTH_SECRET before the import.
**Added condition:** the candidate has NO recorded change of its OWN address after the person's earliest booking.
This is read from audit rows with entityType=Member, entityId=the member, and metadata holding oldEmailSha256,
oldEmailDigest or releasedEmailSha256, comparing the row's createdAt with the booking date. It uses the subject and
the time, never a digest value, so a key rotation cannot hide it. That closes residuals 2 and 3.
Red, real route, both roles: R15/R16 fail (2 failed / 19 passed). R17, the control (held all along, with a
non-address edit), stays bound. Green and mutant results are in the hand-back.

### Residual after the fourth pass (precise)
1. **Raw SQL, unchanged.** An OLD member (created before the bookings) acquires the address through a writer that
   writes no audit row (raw SQL, a script), and the previous holder's release was not audited either. The member
   then has no recorded change and no recorded release, so the fallback binds. Only audited writers or an owner
   decision close this. It is the SEC-029 trust boundary.
2. **Audit rows deleted or lost.** If the audit rows for an own change were deleted (a tenant purge, a manual
   cleanup), the change is no longer known. This is the same class as 1.
3. **Rotation.** Rotation no longer matters for the acquirer: its own change is detected by subject and time. It
   matters only for releases by members that no longer exist AND acquisitions by unaudited writers, which is case 1.
4. **Cost.** A member who corrected their own address after their earliest booking needs an owner decision for
   that person's rows, even when they are the same person.
