# Urgent remediation: release packets (11 Nov 2026)

- **State:** local only. Nothing pushed, merged or deployed. No production access was used.
- **Base of every branch:** origin/main `33592fe0` (unchanged today).
- **Order:** three independent branches, no migration in any of them. They merge cleanly with each other (`git merge-tree` checked).

| Packet | Branch | Head | Code head | What |
|---|---|---|---|---|
| 1 | `hotfix/member-notes-preserved` | `5a2d1896` | `5a2d1896` | Member internal notes erased by every profile, plan or status edit since 1 Jun 2026 |
| 2 | `security/round5-remediation` | the branch head (the commit that adds this revision, docs only) | `46d2dd6c` (built and tested at `46d2dd6c`; docs only after it) | Round 5 security fixes, file-ownership remediation, owner Recovery Codes card |
| 3 | `chore/migrate-test-direct-host` | `3243e38b` | `3243e38b` | Test-only tooling: Prisma Migrate lock handling on the shared test branch |

**Recommended order:** 1, then 2, then 3. Packet 1 is the data-loss stop and the smallest change.

---

## Severity and exposure: all 13 Round 5 findings, plus those found during remediation

"Reachable on main" means reachable on `33592fe0`, which is deployed. Exploitation in production is unknown: the detection queries in Packet 2 are for Noe to run.

| # | Finding | Actor | Access needed | Impact | Reachable on main | Fix | Remaining limitation |
|---|---|---|---|---|---|---|---|
| 1 | Member deletes club or others' files through their own picture | Member | Own session, plus a file URL (the logo URL is public via `GET /api/tenant/<slug>`) | Deletes the club logo, announcement images or other members' photos | Yes | `5454fd82`, `40dd7d38`, `6cad2568` | Files already deleted cannot be restored (no blob versioning) |
| 2 | Erased member's name and email kept in the import manifest and served | Owner (views it) | Owner session | Erasure incomplete (UK GDPR Art. 17) | Yes | `2cb55fc7`, `af14930b`, `7588b014` | **Applies to erasures from now on.** Erasures already done in production may have left names in manifests. Noe checks the count (detection query D5); a one-off re-scrub needs a decision. A plan named after the erased person is blanked inside person lists (cosmetic). |
| 3 | "Sign out all devices" reports success when the revoke failed | Any staff user | Own session | Believes other devices are signed out when they are not | Yes | `e5af6179`, `af14930b` | Members have no "sign out everywhere" (G3-3) |
| 4 | Member login-email change needs no re-authentication | Session thief | A stolen member session | Durable account takeover (email change, then a magic link) | Yes | **None: decision** | Open. Recommendation in the Round 5 doc. |
| 5 | Member recovery codes replaceable without a code; old codes survive re-enrolment | Session thief | A stolen member session (TOTP enrolled) | Second factor kept by the thief | Yes | `0ba63069`, `af14930b`, `7588b014` | The code is checked, not spent (replay within about 60 s): design in `MEMBER-TOTP-REPLAY-DESIGN-2026-11-11.md` |
| 6 | `admin` role can change member email, status, plan and payment status | `admin` staff account | An `admin` account | Member takeover through an email change; money fields | Yes | **None: decision** | Proposal in `ADMIN-ROLE-PERMISSIONS-PROPOSAL-2026-11-11.md` |
| 7 | Support view session reads import exception rows on screen | Operator in support view | Operator MFA session | None beyond what support may already read | Yes | Not a defect | The policy refuses export files, not screens |
| 8 | Children on the public TV leaderboard by default | Anyone viewing the board | The board link or display | Minors' first name and initial shown publicly | Yes | **None: decision** | Open |
| 9 | Image-proxy read through an adopted URL | Member | Own session plus a URL | Reads other members' private photos | Yes | `5454fd82`, `40dd7d38`, `6cad2568` | Staff read every image of their own club (by design) |
| 10 | Child photo accepts any URL | Parent member | Own session | Tracking image or outside content in staff views | Yes | `5454fd82` | None |
| 11 | Member authenticator code reusable within its window | Someone who sees a code | The password plus an observed code, or a stolen session | Second factor reused | Yes | **Design only** (needs an additive migration) | Open |
| 12 | `upload/delete-orphan` open to members | Member | Own session plus an unreferenced URL | Deletes unreferenced club files (import hand-offs) | Yes | `5454fd82` | None |
| 13 | Push subscription overwrite | Any signed-in user | The victim's endpoint (a secret) | Victim's notifications broken (push not live) | Yes | `b213a76c`, `af14930b` | Shared device: the next person can't subscribe (L-6, before push goes live) |
| R-1 | Promotion photo can be another member's file | Any staff role | Staff session | That member can read another member's photo | Yes | `40dd7d38` | None |
| R-2 | Announcement image deletion removes a member's photo | Owner or manager | Staff session | Member photo deleted | Yes | `40dd7d38`, `6cad2568` | None |
| R-3 | Erasure deletes a file a planted row pointed at (the logo, another member's photo) | Member (plants the row), then the erasure | Member session before the fix | Club file deleted at erasure | Yes | `40dd7d38` | None |
| R-4 | Legacy photo survives the owner's removal or erasure when a planted row exists; the planter keeps reading it | Member who planted a row before the fix | Earlier member session | Photo readable after removal or erasure | Yes | `6cad2568` | None |
| R-5 | Logo or announcement can be set to a member's photo, locking the member out of it | Owner or manager | Staff session | Member loses their own photo; it outlives their erasure | Yes | `6cad2568` | None |
| R-6 | Owner Settings "Recovery Codes" button never worked | Owner | n/a | Owner can't regenerate codes from that card | Yes | `bd1fa8a0`, `6cad2568` | None |
| R-7 | `migrate-test.mjs` strands Prisma Migrate's lock on the shared test branch | Developer or agent | Test branch only | Every import route on the test branch answers 503 | n/a (tooling) | Packet 3 | Never affects production |

## How file ownership is enforced

Same-club is not ownership. The model and its single implementation are in `lib/blob-ownership.ts`.

| Stage | Rule | Where | Proven by |
|---|---|---|---|
| **Upload** | A file for a member is written under `tenants/<club>/members/<member>/`; club files go at the club root; imports under `imports/`. | `app/api/upload` | `tests/unit/sec-c2-upload-controls.test.ts` (the path is the member's and passes `isMemberBlobUrl`) |
| **Attach** | A member's photo row (picture, gallery, child, promotion) accepts only that member's path or an inline image. A logo or announcement image accepts only a club-root file that no member photo uses. | profile-picture PUT, `members/[id]/photos` POST, `member/children/[id]/photos` POST, `members/[id]/rank` POST, `announcements` POST, `settings` PATCH | `round5-blob-ownership-db`, `round5-file-ownership-db` (attach cases) |
| **Read** (member sessions) | A member-path file needs a photo row of its owner, who must be the member or their confirmed child. A legacy club-root file is readable only by the member whose photo row is earliest by `uploadedAt`, never when it is the logo or an announcement image. Imports are never readable. | `app/api/blob-image` | `round5-file-ownership-db` (read cases), `blob-image-member-scope` unit test |
| **Delete** | The member's own file, when nothing else references it. A legacy file only if the member owned it (earliest row), and then rows planted later by others do not keep it. A club asset only when unreferenced. | profile-picture DELETE, `members/[id]/photos` DELETE, `dsar/erase`, `announcements/[id]` DELETE, `upload/delete-orphan` | `round5-file-ownership-db` (delete and erasure cases) |

**Legacy photos** (club root, uploaded before per-member paths) are treated safely:
- existing rows are untouched and still served to their owner;
- removing or erasing one deletes the file only when nothing legitimate still uses it;
- no new reference to a legacy file can be created.

**Known limit:** members don't see a blob-stored logo or announcement image through the proxy. That was already so on main (the member branch always needed a photo row). It needs a separate club-asset read rule, which is not in this release.

## Erasure, then rollback or retry

`tests/integration/round5-erase-then-rollback-db.test.ts` uses real routes, real private upload storage, and both roles. It runs:
- import, then erase;
- a rollback, which removes the member only that import created;
- a resume of a genuinely failed run (200);
- a fresh job from the kept file.

After each step it searches:
- every table with a `tenantId` column;
- the kept file;
- the job view, the exceptions download and the review list;

for her name, address and phone. Nothing is found at any step.

On main's erasure, her details are still in the `ImportJob` row, the job view and the exceptions download.

**Out of scope:** re-uploading the original TeamUp export re-adds her, because the source still holds her. The club must erase her in TeamUp too.

---

## Packet 1: member-notes hotfix

**Branch and changes**
- **Branch:** `hotfix/member-notes-preserved`.
- **Head:** `5a2d1896` (on base `33592fe0`; fast-forwards main).
- **Diff:** 4 files, +157 / −4.
- **The runtime change is one transform** in `lib/schemas/notes-sanitiser.ts`: an absent notes key stays absent instead of becoming `null`.
- **Migration:** none.

**Verified on `5a2d1896`, 10 Nov 2026** (main has not moved since):
- full suite 9,338 passed, 0 failed;
- production build clean;
- DB suites under both roles:
  - cross-tenant matrix 63/63;
  - role matrix 59/59;
  - support edit 5/5;
  - member archive 10/10;
  - token scoping 7/7;
  - member notes 8/8;
  - attribution 5/5;
- `login-identity-claims-db` exceeds the runner's limit, on main as well;
- independent review: APPROVE WITH NITS (nits fixed);
- rerun 12 Nov 2026 on `5a2d1896`: member-notes DB suite 8/8 under both roles. It covers omitted notes kept on profile, plan and status saves; explicit edit and clear still working; sanitising; a coach refused; another club refused; and the audit listing notes only when they changed;
- CI: none yet (not pushed).

**Deploy (Noe)**
1. `git push -u origin hotfix/member-notes-preserved`.
2. Open a draft PR to main and let CI pass.
3. `gh pr merge <n> --merge --match-head-commit 5a2d1896`. This auto-deploys; there is no migration.
4. Check `/api/health` returns 200.
5. In the app, edit a test member's phone and confirm their notes are still there.

**Recovery:** fix forward with a new PR. Never Instant Rollback.

**Lost notes:** the plan for restoring notes already erased is `docs/readiness/NOTES-RECOVERY-PLAN-2026-11-11.md` on `programme/rounds`. It is read-only and needs Noe's decisions.

## Packet 2: Round 5 security remediation

**Branch:** `security/round5-remediation`, on base `33592fe0`.

**Commits** (oldest first; the first nine are cherry-picks of the reviewed Round 5 commits, identical by `git range-diff`):

| Commit | What |
|---|---|
| `5454fd82` | member-photo files bound to their member |
| `2cb55fc7` | erasure reaches the import manifest |
| `e5af6179` | "Sign out all devices" is honest |
| `0ba63069` | member recovery codes need a step-up; enrolment starts a fresh set |
| `b213a76c` | push subscription scoped to its subject |
| `af14930b` | review follow-ups |
| `7588b014` | re-review follow-ups |
| `ac9644b7` | journey |
| `383b4b88` | journey |
| `40dd7d38` | file ownership at attach, read and delete |
| `42b5be2a` | erase-then-rollback test |
| `bd1fa8a0` | owner Recovery Codes card |
| `6cad2568` | remediation review follow-ups F1–F6 |
| `cb107b57` | design and decision documents |
| `cd7894f4`, `5aecda33` | this document (docs only) |
| `08e84d27` | recovery codes keep focus in their drawer (re-review N2); re-review record |
| `46d2dd6c` | ownership rules accept only a stored file's canonical URL; the settings undo cannot restore a member's photo as the logo (second re-review) |
| the branch head | this revision of the document (docs only) |

**Migration:** none.

**Reviews**
- Round 5 commits: CHANGES REQUIRED, then APPROVE WITH NITS.
- Remediation commits: APPROVE WITH NITS. F1–F6 were fixed in `6cad2568`, and each new case fails on the previous code under both roles.
- Re-review of `6cad2568` (12 Nov): APPROVE WITH NITS. N2 fixed in `08e84d27`.
- Re-review of `08e84d27` (12 Nov): CHANGES REQUIRED.
  - The focus code is correct on every path.
  - It found that a variant spelling of a member's legacy photo URL passed the club-asset check. Proved under both roles: `?v=1` was accepted as an announcement image, 201.
  - It found that the settings undo restored a logo unchecked.
  - Both are fixed in `46d2dd6c`. The new DB case fails on `08e84d27` and passes on `46d2dd6c`, under both roles.
- **Not yet independently re-reviewed: `46d2dd6c`.** The reviewer launch was refused twice: a context-mode hook rewrites the call after auto mode has checked it, so the classifier gave no verdict. The brief is ready. This is an open release gate for packet 2, not a pass.

**Verification on the final code head `46d2dd6c`** (12 Nov 2026; built and tested on that commit):

| Gate | Result |
|---|---|
| Full suite (`npm test`, no database) | 9,361 passed, 0 failed, 928 skipped (database-backed files, run below), 3 todo |
| Lint (eslint plus UI-RULES ratchet) | passed, ratchets at baseline |
| Type-check | clean |
| Production build | `BUILD EXIT 0 commit 46d2dd6c tree clean` |
| Journey `round5-recovery-codes-card` | 11 PASS / 0 FAIL. It covers the wrong code, a forced 500, a network failure, a fresh code, the field's accessible state, 390 px and the keyboard. **A3** (focus stays inside the codes drawer) and **A4** (Done returns focus to "Generate new") failed on the old build `cb107b57` and pass here. |
| Journey `round5-sign-out-everywhere` | 6 PASS / 0 FAIL / 1 NOTE (48 Tab presses reach the control, through the More sheet's existing focus order) |
| Database suites, both roles | see below |

Database suites on the Neon test branch, each batch under `neondb_owner` and `matflow_app`. Commit `46d2dd6c` for the suites this branch's later commits touch; `cb107b57` for the rest (marked).

| Batch | Commit | Owner | Restricted |
|---|---|---|---|
| round5-blob-ownership, round5-erase-manifest, round5-member-recovery-codes, push-subscribe, member-children-photos | `46d2dd6c` | **19/20 on the first run, 1 failure**: "a new enrolment replaces recovery codes kept from an earlier one", 7.4 s. The file rerun alone passed 6/6. The cause is not diagnosed. | 20/20 pass |
| round5-file-ownership (11 cases, including the variant-URL and undo case), promote-with-photo, staff-photo-viewer | `46d2dd6c` | 15/15 pass | 15/15 pass |
| round5-erase-then-rollback | `46d2dd6c` | 2/2 pass | 2/2 pass |
| erase-import-data, erase-large-club | `46d2dd6c` | 8/8 pass | 8/8 pass |
| sec-pre-resend-packs-settings-imports (settings undo), class-lifecycle (undo) | `46d2dd6c` | 16/16 pass | 16/16 pass |
| cross-tenant-authorisation-matrix | `46d2dd6c` | 63/63 pass | 63/63 pass |
| sec-b-role-matrix | `cb107b57` | 59/59 pass | 59/59 pass |
| member-archive, t8a-status-history | `cb107b57` | 16/16 pass | 16/16 pass |
| sec-d3-deletion-race, security, tenant-isolation | `cb107b57` | 17/17 pass | 17/17 pass |
| support-session-binding, operator-member-totp-reset, totp-login-paths | `cb107b57` | 27/27 pass | 27/27 pass |
| sec-d2-deletion-provenance | `cb107b57` | **7 pass, 3 timed out (30 s)** | **7 pass, 3 timed out (30 s)** |

The `cb107b57` rows were not rerun on `46d2dd6c`. The later commits change `lib/blob-url.ts`, `lib/blob-ownership.ts`, the settings undo handler and the owner card. Those suites exercise none of them directly; the role matrix reaches photo routes only with canonical URLs.

**The `sec-d2` timeouts are an existing failure,** not a pass, and this branch did not cause them.
- All three are the import-based cases.
- The same three time out on main `33592fe0`.
- This branch changes no import code.
- They stay open.

**Not run on this head:**
- `login-identity-claims-db`: it exceeds the runner's 10-minute limit, on main too.
- Every other DB file has not been run against this branch on the test branch. **CI does not fully cover them** (checked 12 Nov 2026 on PR #80's CI run, the same workflow):
  - CI's own Postgres runs the DB files guarded by `DATABASE_URL`, but only as the `postgres` superuser, so RLS is not enforced there. The exception is `rls-foundation.test.ts`, which CI reruns as a NOBYPASSRLS role.
  - CI skips 29 files that need `TEST_DATABASE_URL`. Examples: `member-archive-db` (run above, both roles), `activity-feed-db`, `sec-f2-auditlog-append-only-db`, `sec-l1-*`, `support-mats-db`, `timetable-multiday-db`. This branch has no CI run yet, because it is not pushed.
  - The suites this branch's diff touches or directly covers are the ones listed above.

**Not exercised:**
- real Vercel Blob storage (the store is stubbed; the path and ownership rules are what is tested);
- push delivery (not live);
- member enrolment in a browser (DB test and unit test only);
- production data.

**Deploy (Noe)**
1. Push the branch.
2. Open a draft PR and let CI pass.
3. `gh pr merge <n> --merge --match-head-commit <final head>`.
4. Check health is 200.
5. Check in the app:
   - an owner can still upload a promotion photo (all staff roles can now, member-scoped);
   - an announcement image works;
   - the Settings → Account Recovery Codes card works with an authenticator code.

**Post-deploy detection** (read-only; Noe runs these against production; nothing here writes):
- **D1, member photo rows pointing at a club logo** (planted before the fix):
  ```sql
  SELECT p.id, p."tenantId", p."memberId", p.kind, p."uploadedAt" FROM "MemberPhoto" p JOIN "Tenant" t ON t.id = p."tenantId" WHERE p.url = t."logoUrl";
  ```
- **D2, a stored file referenced by more than one member's photo rows** (possible plants; review F1):
  ```sql
  SELECT "tenantId", url, count(DISTINCT "memberId") AS members FROM "MemberPhoto" WHERE url LIKE 'https://%' GROUP BY "tenantId", url HAVING count(DISTINCT "memberId") > 1;
  ```
- **D3, announcement images that are also member photos:**
  ```sql
  SELECT a.id, a."tenantId" FROM "Announcement" a JOIN "MemberPhoto" p ON p.url = a."imageUrl" AND p."tenantId" = a."tenantId";
  ```
- **D4, photo rows with an outside or unexpected URL** (child-photo hole):
  ```sql
  SELECT id, "tenantId", "memberId", left(url, 40) FROM "MemberPhoto" WHERE url !~ '^(https://[a-z0-9]+\.(private\.|public\.)?blob\.vercel-storage\.com/|data:image/)';
  ```
- **D5, erasures done before the fix** (their import manifests may still hold names):
  ```sql
  SELECT "tenantId", count(*) FROM "AuditLog" WHERE action = 'member.dsar_erase' GROUP BY "tenantId";
  ```

If D1 to D4 return no rows, no exploitation of the file holes is visible in stored data. Deletions leave no row, so they cannot be ruled out. If D5 is not zero, a one-off manifest re-scrub needs a decision.

**Recovery:** fix forward. Every change is additive validation or narrower deletion; none changes stored data. Never Instant Rollback.

## Packet 3: test tooling

**Branch and changes**
- **Branch:** `chore/migrate-test-direct-host`.
- **Head:** `3243e38b` (base `33592fe0`).
- **Diff:** `.claude/skills/matflow-verify-local/scripts/migrate-test.mjs` and the skill doc.
- **No application code, no migration.**

**What it does**
- runs Prisma Migrate on the test branch's direct host;
- tags its connections `mf-migrate-test-<host>-<pid>-<hex>`;
- refuses (exit 3) when the lock is held by another session or another machine, and never ends that session;
- ends only an orphan of its own runs on this machine, matching pid, name and start time;
- confirms after any outcome that none of its own backends still holds the lock.

**Verified on scratch databases of the test endpoint** (created and dropped with `scripts/readiness/migration-rehearsal.mjs`):

| Case | Result |
|---|---|
| Success | 116 migrations applied; lock released |
| Failure | P3009, exit 1; lock released |
| Whole process tree killed mid-migration | The lock holder carried the run's tag mid-run, which shows `application_name` reaches Prisma's connection; the lock was released at once. The next run stops at P3009 (interrupted migration; `migrate resolve` needed, as designed). |
| Second run while one is live | Refused, exit 3; the live run untouched and completed |
| Unrelated holder | Refused; its session still alive after 40 s |
| Orphan of this machine | Ended (the holder saw 57P01 after 13 s of a 120 s hold) |
| Another machine's tag | Refused; its session still alive after 30 s |
| `status` on the shared test branch | Up to date; lock released |

**Deploy (Noe):** push, then a PR, then merge. Nothing runs in production. After it merges, peer sessions may use `migrate-test.mjs` again (`matflow-e8` is holding off until then).

---

## Re-review of the fixes (12 Nov 2026, independent, read-only)

| Packet | Verdict | Status of earlier findings |
|---|---|---|
| 2: security | APPROVE WITH NITS | F1–F6 fixed. `uploadedAt` is always server-set, so the earliest-row rule cannot be backdated. Every new query is tenant-filtered inside `withTenantContext`. The recovery-codes route still requires the code; its only change is a rate limit. The test changed in `6cad2568` was not loosened: a null `get` for a deleted file matches `@vercel/blob` 2.3.3. |
| 3: tooling | APPROVE WITH NITS | F7 and F8 fixed. |

**Packet 2 findings, and what was done:**

- **Variant URL spellings and the settings undo (fixed in `46d2dd6c`, from the re-review of `08e84d27`).**
  - Rows are matched to files by URL string, so `?v=1`, `#x` or an upper-case host named a member's legacy photo under a string no photo row held.
  - Every ownership rule now accepts only the canonical URL (`isCanonicalBlobUrl`). The app stores only `blob.url` from Vercel's `put`, which is canonical, and percent-encoding was already refused.
  - Restoring a logo by undo applies the same club-asset rule as the settings save.
  - A non-canonical URL stored before this release fails closed: a member can't read it, and these rules never delete it. Staff still see it.
- **N2 (fixed, the one regression).** The F6 fix moved focus to "Generate new" whenever the code field closed, including after a successful generation. That pulled focus out of the codes drawer, onto a button behind it.
  - Fix: focus returns only after Cancel, or after the drawer is closed with Done or Escape.
  - Journey checks: **A3**, codes issued, focus is inside the drawer; **A4**, Done returns focus to "Generate new".
  - A3 failed on the previous build; results are in the verification table.
- **N1 and N4 (historical, not changed in code).** Take a legacy club-root photo that has a row planted by another member *before this release*. When the owner replaces the photo (PUT), the file is not deleted, by the keep-everything rule (#72). The planter's row then becomes the earliest, so the planter can read it.
  - After this release no new reference to a legacy file can be made, in any spelling (`46d2dd6c`). The exposure is therefore limited to rows planted before deploy.
  - Detection query **D2** finds them.
  - Removing planted rows would be a production data write. It needs Noe's separate approval, after he has run D2. Nothing is prepared to run automatically.
- **N3 (open, nit).** A branding save resends the current logo. If a planted row points at that logo (D1 finds these), every settings save is refused with 400 until the row is removed. It fails closed; no data is exposed.
- **N5 (nit, fails safe).** The read rule breaks a tie on equal timestamps by id; the delete rule keeps the file on a tie.
- **N6 (test limits).**
  - The erasure sweep searches tables with a `tenantId` column only.
  - The F2/F3 test depends on a file created by an earlier test.
  - A logo or announcement set to an erased member's photo before this release keeps that file.

**Packet 3 findings (documented, not changed):**

- **N8.** A host is identified by its name hash alone. WSL, or a container sharing the hostname, could have a live run judged dead.
- **N9.** An orphan with an old-format tag is refused as "another machine" and must be cleared by hand.
- **N10.** With no run record, a dead parent's live Prisma child could be ended mid-migration.
- **N11.** On a Prisma failure, the exit code does not say whether the lock is still held.
- **N12.** The guards do not parse `host=` or `hostaddr=`; this is theoretical.

The tag is a naming convention, not authentication. A refused lock is cleared by its owner, or by Noe.

## Existing failures and open items (unchanged by this release)

- **`sec-d2-deletion-provenance-db`:** three import-based cases time out at 30 s, on main and on this branch. The cause is not diagnosed; it is not introduced here.
- **`login-identity-claims-db`:** exceeds the runner's 10-minute limit, on main too.
- **Members can't see a blob-stored club logo or announcement image** (see above).
- **Shared-device push subscription (L-6):** must be settled before push goes live.
- **Decisions for Noe:**
  - #4 member email re-authentication;
  - #6 the `admin` role;
  - #8 children on the leaderboard;
  - #11 the authenticator replay migration;
  - the past-erasure manifest re-scrub if D5 is not zero.
- **Round 6** is paused until these packets are reviewed.
