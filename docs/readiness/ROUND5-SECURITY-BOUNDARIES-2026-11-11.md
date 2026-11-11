# Round 5: security and permission boundaries (11 Nov 2026)

- **Branch:** `programme/rounds`.
- **Baseline:** `b3d33a43` (Round 4 closed out).
- **State:** not pushed, merged or deployed. Synthetic data on the Neon test branch only. No production access.
- **Code head:** `347c383f`.
- **Verdict:** see "Verdict" at the end.

The round mapped every boundary in the brief: member MFA and recovery codes, sign-out everywhere, stale and revoked sessions, the roles, client-supplied ids, cross-club access, server enforcement of settings, uploads, import conflict access, erased members in import records, guardians and children, the public leaderboard, and support read-only enforcement. The map (file-by-file, with the checks that are sound) is kept outside the repo at the session scratchpad `round5-map.md`. Its findings and their dispositions are all listed below.

Method for every confirmed vulnerability:
1. Reproduce it with synthetic data against the real handlers, under both database roles (`neondb_owner` and `matflow_app`). UI-only defects are reproduced in a jsdom unit test.
2. Name the boundary it breaks.
3. Make a narrow fix.
4. Keep the reproducing test as the regression test.
5. Check that authorised use still works.
6. Check the neighbouring routes.

"A hidden button is not authorisation": every fix is server-side, except R5-3, which is a client honesty defect.

## Vulnerabilities found and fixed

| ID | Vulnerability (reproduced) | Boundary | Fix | Commit |
|---|---|---|---|---|
| R5-1 | **A member could delete club files.** A member set their own profile picture to any blob URL in the club's namespace, for example the club logo URL that `GET /api/tenant/<slug>` publishes, or another member's photo. Removing the picture then deleted that file. The same adoption let a member read another person's private image through the image proxy. A parent's child photo accepted any URL, including an outside tracking image shown in staff views. `upload/delete-orphan` let any role delete any unreferenced club blob. | Member → club and other members' files (integrity, privacy). | **Uploads for a member are stored under `tenants/<club>/members/<member>/`** (`app/api/upload`). Each member-photo write (profile picture PUT, staff member photos POST, parent child photos POST) now accepts only a blob under that member's path, or an inline image. Each member-photo delete now deletes only such a blob (`lib/blob-url.ts` `isMemberBlobUrl`, `isInlineImageUrl`). `delete-orphan` lets a non-staff caller delete only their own member path. | `044c9a6f` |
| R5-2 | **An erased member's name and address survived in the import manifest.** A TeamUp import keeps its exception list in `manifest.teamup2.exceptionRows` (name, email, detail), with no member id or source key. The erasure scrubbed the manifest by id and source key only, and scrubbed names only in `errorLog` and `dryRunSummary`. So after `POST /api/admin/dsar/erase`, `GET /api/admin/import/<id>/exceptions` and `GET /api/admin/import/<id>` still served her name and address. | DSAR erasure completeness (UK GDPR Art. 17). | **The erasure's name and address scrub now covers `manifest`,** for every job in the club, attendance jobs included. This also closes map items G10-2 (other name-only manifest lists) and G10-3 (attendance manifests). The id/key rule for an ordinary member deletion is unchanged. | `d8813cd1` |
| R5-3 | **"Sign out all devices" reported success when it had failed.** Topbar and MobileNav ignored the `logout-all` reply and signed this device out regardless. So a 500, a 403 or a network error looked the same as success, while every other device (say, a lost phone) stayed signed in. | Revocation honesty. | **This device signs out only after a confirmed revoke.** A failure keeps it signed in, says "Your other devices are still signed in…", and leaves the control usable for a retry. | `5357e4c0` |
| R5-4 | **A member's recovery codes could be replaced with a stolen session alone.** Regeneration needed no authenticator code and had no attempt limit; the staff route has required a code since L1-I2-S-01. Codes left from before a self-service recovery (which keeps the unused ones, with the second factor off) worked again against the next enrolment. | Second factor persisting after session theft. | **Regeneration needs a current six-digit code.** The previous 30-second step is accepted, because the enrolment step passes on the code it has just verified. Attempts are capped at 5 per 15 minutes per member, and support sessions are refused. A new enrolment clears `totpRecoveryCodes`. The staff route gets the same attempt limit. The e2e enrol helper now sends the code. | `8c4998bd` |
| R5-5 | **Anyone presenting a push endpoint could overwrite its subscription.** The endpoint is unique across every club, and the subscribe upsert updated whichever row held it. Another member of the same club replaced the row's keys under both roles (row-level security does not separate members of one club); another club could do the same under the owner role. | Cross-subject row write. Push delivery is not live. | **Only the subject who registered an endpoint can update its row.** Anyone else gets a 409 and the row is unchanged. | `f27c54be` |

## Independent review (of `044c9a6f~1..f27c54be`) and follow-ups

A separate reviewer read the five commits without running anything against a database. Verdict: **CHANGES REQUIRED**, with 1 Medium, 6 Low and 6 Nit findings. It found no new hole, and every regression test fails on the old code. The full report is in the session scratchpad, `r5-review-report.md`.

Fixed in `d174daf4`:

| Finding | What was wrong | Fix |
|---|---|---|
| M-1 (blocker) | **A DB test was stale.** `member-children-photos` still posted an outside URL to the child-photo route, which R5-1 now refuses, so the test failed in both roles. My R5-1 DB run had not included that file. | The test posts an inline image, which is what the real parent flow sends. |
| L-4 | **The manifest scrub reached structure.** Over the whole manifest, a plan named after the erased person ("Jane Smith (Privates)") made a pre-rule refresh change's `before`/`after` look like that person. It became `{removed:true}`, and that job's rollback then failed permanently. | **The manifest scrub is limited to the person lists**: `teamup2.exceptionRows`, `decisions`, `scheduled`; every list under `refresh.exceptions`; `rollback.kept` (`scrubSubjectFromManifest`). Entries carrying an id or source key are still removed anywhere by the id/key scrub, which runs first. Unit tests on a commit-shaped and a refresh-shaped manifest fail on `d8813cd1` and pass on `d174daf4`. |
| L-5 | **Re-enrolment could leave a member with no recovery codes.** It wiped the old codes, and if the follow-up codes request then failed, the member had none. Members have no screen to get more. | **Member enrolment issues its codes in the enabling write** (`issueRecoveryCodes`), as staff enrolment does, and audits it. `TotpEnrollmentStep` already uses the codes the setup reply returns. |
| L-1 | **No test tied the upload route's write path to the ownership check.** | A unit test now checks that a member-scoped upload is stored under the member's path and passes `isMemberBlobUrl`. |
| N-1 | Inline `image/jpg` was refused. | Accepted. |
| N-3 | **Every sign-out failure was described as a connection problem.** | The server's reason is shown; a 401 (session already gone) signs out. |
| N-6 | **A double first registration was misreported.** Two first registrations of one endpoint by the same person at once told the loser "registered to someone else". | It re-reads the row and returns 201. |

**Re-review of `d174daf4`: APPROVE WITH NITS.** Every fix above is confirmed. Fixed in `347c383f`:
- **R-1 (Low): narrowing the manifest scrub had dropped the review list (`manifest.conflicts`).** An ambiguous entry for the erased person often has no member id the id/key scrub can match. It kept her name and the key that embeds her address. That entry is now reduced to its kind, so the counts still add up. In another member's entry, a compared value holding her name or address is blanked, not dropped. The unit test fails on `d174daf4`.
- **R-3 (Nit):** a stale comment.
- **R-4 (Nit):** member setup POST now refuses support sessions, because it issues codes.

R-2 (Nit, deferred): **inside the person lists, a plan named after the erased person is still blanked** in other people's scheduled starts and decision options. It is cosmetic only, because nothing replays these lists. Fix later: count a name only in person-name and free-text fields.

Deferred and recorded:
- **L-2: a picture uploaded before R5-1 stays in the store when the member removes it.** It sits at the club root, which is no longer deleted. A DSAR erasure still deletes it. Fix later: delete a club-root file only when nothing else references it, as `delete-orphan` does.
- **L-3: neighbouring writers still accept any club blob.**
  - A promotion photo (`members/[id]/rank`, any staff role) can point at another member's picture. Fixing it needs the promotion upload to become member-scoped first.
  - A row planted before R5-1 could make a DSAR erasure delete the logo. Fix: skip `del()` when the URL is still referenced.
- **L-6: on a shared device, the second person can never subscribe to push**, and the first person's notifications keep arriving there. Sign-out should disable that browser's subscription. This must be settled before push goes live.
- **N-4:** member codes are checked, not spent (map #11).
- **N-5:** the owner's Settings card is broken (above).

## Regression tests (each fails on the code before its fix)

| ID | Test | Before the fix | After |
|---|---|---|---|
| R5-1 | `tests/integration/round5-blob-ownership-db.test.ts` (6) + `tests/unit/upload-blob.test.ts` | logo accepted as picture and deleted; child photo took an outside URL | 6/6 both roles |
| R5-2 | `tests/integration/round5-erase-manifest-db.test.ts` | exceptions CSV still held her address after erasure (both roles) | 1/1 both roles |
| R5-3 | `tests/unit/round5-logout-all-failure.test.tsx` (10) | 8 failed: signed out on 500, 403 and network error, on both callers | 10/10 |
| R5-4 | `tests/integration/round5-member-recovery-codes-db.test.ts` (6) | 3 failed both roles: no code needed, no limit, old codes survived re-enrolment | 6/6 both roles |
| R5-5 | `tests/integration/push-subscribe.test.ts` (2) | another member's re-registration returned 201 and replaced the keys (both roles) | 2/2 both roles |

Authorised use is asserted in the same files:
- a member's own upload is accepted and removing it deletes exactly that file;
- the inline-image fallback still works;
- a staff photo upload for a member still works;
- other members' and children's import rows stay after an erasure, and only the subject's name leaves a child's detail;
- a confirmed revoke still signs out;
- a member with the current code gets eight codes;
- a member re-registering their own push endpoint renews it.

## Map findings not fixed in this round, with dispositions

| Map # | Finding | Disposition |
|---|---|---|
| 4 (G4-2) | **A member's login-email change needs no re-authentication.** No confirmation goes to the new address and no notice to the old one, so a stolen session plus a magic link gives a durable takeover. Staff need password plus single-use TOTP. | **Decision for Noe.** Recommendation: require the current password (or a magic-link confirmation sent to the *old* address for a passwordless member), and send a notice to the old address. This changes a member journey, so it was not made under "smallest change". |
| 6 (G4-1) | **The `admin` role is inconsistent.** It may PATCH a member's email, status, plan and payment status, while `totp-reset` and `unlock` exclude it as "level with coach". | **Decision for Noe.** Recommendation: treat `admin` as coach-level for member identity and money fields (refuse email, status, plan and payment status changes by `admin`), matching the routes that already say so. This is a business-policy change. |
| 8 | **Children appear on the public TV leaderboard by default,** as first name plus last initial. Only staff can opt a member out, and a single-word name is shown whole. | **Decision for Noe.** Recommendation: leave children off the public board unless a guardian opts in. This is a product default and a safeguarding call, not a code defect. |
| 7 (G9-1) | Support view sessions can read import exception rows on screen. | **Not a defect.** The support policy refuses personal-data *export files* (`lib/support-session.ts` `SUPPORT_REFUSED_READS`, reason "export"), not on-screen reads. A support view session can already read members' contact details on screen by design. |
| 9 | Blob adoption defeats the image-proxy ownership check. | **Closed by R5-1.** |
| 10 | Child-photo URL unvalidated. | **Closed by R5-1.** |
| 12 | `delete-orphan` open to every role. | **Closed by R5-1.** |
| 11 | **Member TOTP codes can be replayed within their window.** Member has no `totpLastUsedStep` column; staff and operators spend each step. R5-4's step-up therefore checks the code without spending it. | **Open: needs an additive migration** (`Member.totpLastUsedStep Int?`) and a conditional update, as `consumeUserTotp` does. Not made in this round, because it migrates the shared test branch and production on merge. Low severity: it needs a code captured within about 30 to 60 seconds. |
| G3-3 | **Members have no "sign out everywhere".** The route supports members, but no member page calls it. | **Open, product gap.** A member who loses a phone cannot revoke their own sessions; staff can reset them. Recommendation: add it to the member profile in a UI round. |
| G10-4 | **`ImportedMembership` ledger rows stay linked to an erased member's anonymised row** (plan label and dates). | **Open, low.** The data is pseudonymised, not identifying. Recommendation: delete the erased member's ledger rows in the erasure, in a later round. |
| G4-3 | **Member self check-in resolves the member by the token's email.** A stale email could later belong to another member. | **Open, low.** It depends on G4-2 and is fixed by it, or by resolving by `memberId`. |
| G1-3 | **Member setup GET changes state.** A cross-site navigation can reset an enrolment that has not finished. | **Open, nuisance only.** |

**Found while testing, not security:**
- **The owner's Settings "Recovery Codes" card cannot work.** Its Generate button posts with no `totpCode` (`components/dashboard/SettingsPage.tsx` around line 2964), so it always answers "Six-digit TOTP code required". The other regenerate control on the same page prompts for the code and works. Recommendation: remove the duplicate card, or have it prompt for the code. This is for a UI round.
- **otplib's default tolerance is the current step only** (`epochTolerance` 0), so a code typed just as the 30 seconds roll over is refused at sign-in and enrolment across the app. It is a usability limit rather than a security one, recorded here because R5-4's test exposed it.

## Pre-existing failures and environment

- **`sec-d2-deletion-provenance-db` failed with 503 "a database update is being applied".** It failed identically on the base commit. Cause: another session's `migrate-test.mjs deploy` ran through the pooled URL and left Prisma Migrate's advisory lock (72707369) held on one pgbouncer server connection. The import routes' `holdOffMigrations` correctly refused. That session released the lock and will raise moving `migrate-test.mjs` to the direct host. Re-run after the release: see Verification.
- **`login-identity-claims-db` exceeds the runner's 10-minute limit, on the base too** (recorded in Round 4).

## Verification

Filled in below from runs on the code head.
