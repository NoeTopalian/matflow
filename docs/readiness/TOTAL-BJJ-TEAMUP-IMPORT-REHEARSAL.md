# Total BJJ — private real-data import rehearsal (2 Oct 2026)

Evidence for the brief "MatFlow — real TeamUp import, family accounts and billing integrity". One private, isolated rehearsal of the real Total BJJ TeamUp export on the Neon **test** branch, through the **production build** and the **real routes with a real owner session**. This document carries aggregates only; row-level ledgers, previews, screenshots and the reconciliation differences are restricted files under the session scratchpad (`scratchpad/rehearsal/private-*`), never committed, deleted with the rehearsal data.

## 1. Candidate and environment

| | |
|---|---|
| Tree under test | `a72a347` (importer v2 `79981a5`, guardianship `8d2e696`, billing honesty `5e32586`, rehearsal fixes `a72a347`); schema through migration `20261002120000_imported_membership_and_guardianship` |
| Mapping | `teamup-2@2026-10-02` |
| Source file | `<TeamUp export file>.csv`, SHA-256 `<sha-256 held privately>`, N records |
| As-of | `2026-10-02T11:27:00Z` entered at upload = the file's modification time (12:27 UK). **Provisional** — the export carries no timestamp; Sean confirms the real export time before production |
| Older file (refresh pair) | `<TeamUp export file>.csv`, N records, as-of entered `2026-09-24T12:00:00Z` (provisional) |
| Server | `next build` + `next start` on :3949 behind the TLS proxy :3950, launcher flag `isolated` |
| Isolation (names only, printed by the launcher) | `DATABASE_URL=ep-hidden-salad…-pooler` · `TESTING_MODE=present` (local import storage only) · `STRIPE_SECRET_KEY=invalid-key` · `STRIPE_CLIENT_ID=invalid-key` · `RESEND_API_KEY=invalid-key` · `RESEND_FROM=absent` · `VAPID_PUBLIC_KEY=absent` · `VAPID_PRIVATE_KEY=absent` · `BLOB_READ_WRITE_TOKEN=absent`. The production env guard refuses to boot with the Stripe/mail keys absent, so they are present but unacceptable to the providers: any attempted call fails with 401 and appears in the server log. None appeared. |
| Auth bypasses | `TESTING_MODE` was on in this process (the local storage adapter needs it), so elevated-role TOTP enforcement and the login throttle were not exercised here. They were verified separately on a bypass-off production build (owner-account release, 1 Oct). Recorded, not hidden. |
| Club | throwaway tenant `totalbjjreh…` created through the operator door, review mode ON (`review-lock`), owner signed in through the real login form, 13 catalogue tiers at the 24 Sep prices created with the owner's session (labelled setup, not a screen walk) |
| Driver | `scratchpad/rehearsal/real-rehearsal.mjs` (phases setup · import · rollback · refresh-older · verify-ui), `kill-mid-commit.mjs`, `synthetic-pipeline.mjs`; ledger `state.json` (restricted) |

## 2. What ran, in order, and what was seen

| Step | Result |
|---|---|
| Upload (create mode) | 201, mapping `teamup-2@2026-10-02`, hash recorded |
| Preview | N parsed rows (N records − N deleted − N duplicates − N quarantined rows… see ledger) → N drafts, N refused (under-13s with no email and no adult: a parent must be added first); people N: adults N, kids/juniors N, guardian drafts 219; ledger `member_history N · excluded N · quarantined N · duplicate_of N` = 1,082; decisions N; scheduled N |
| Independent controls vs preview | records N/N · duplicates N/N · deleted N/N · decisions N/N · scheduled N/N · undated cancellations 5/5 — **agree** |
| Commit (first run, tree before `a72a347`) | 200 in 51 s, N imported, reconciles true — **but** the independent reconciliation found two defects (§3) |
| Rollback (real route) | 200: N removed, N kept; second call 409 "already rolled back" |
| Commit (after `a72a347`) | 200 in 48–51 s, **N imported, 0 commit errors, 0 skipped-existing, reconciles true**; ledger rows N parsed = N persisted; entitlement `history N · current N · held N · scheduled N · excluded N · quarantined N · duplicate 3` |
| Job reload | status complete, mapping recorded |
| Exceptions CSV | 200 `text/csv`, N lines; kinds: guardian_suggested N · guardian_draft N · shared_email_adult N · cancelled_without_date N · plan_without_tier N · refused_row N · decision_required N · scheduled_start N |
| Independent reconciliation (`scripts/readiness/teamup-reconcile.mjs`, pure CSV + pg) | **RECONCILED**: N people matched on status, payment standing, plan, cancellation date and age band; N under-13s correctly absent (quarantined); 0 missing; every family link unconfirmed and suggested by shared email or emergency contact; every guardian draft has a no-login address and keeps the payer address; every member `billedBy teamup` with the as-of date; no Stripe ids, no due dates, no payments; mail = the owner's `import_complete` notice only; job reconciles |
| Outward actions | `EmailLog`: `import_complete` to the throwaway owner only (one per commit; the invalid key means none left the machine); `Payment` rows N; no Stripe call in the log |
| Older export as a refresh | upload 201; preview `olderThanRecorded { fileExportedAt 2026-09-24, newestRecordedAt 2026-10-02, members N }`; commit **409** "This file was exported 2026-09-24, but N members already carry standing from 2026-10-02. Export a newer file — nothing was changed."; N/N members still on the 2 Oct standing; job marked failed |
| UI (owner, production build) | decision member's profile shows "Two plans active at TeamUp — A and B. MatFlow has not chosen one"; a child suggested from an emergency contact shows "Suggested guardian … has no access to … until you confirm" with the adopt-address option; a child suggested from a shared email shows the shared-email sentence; members list shows "Billed by TeamUp" on every imported row; Outstanding lists nobody; Reports overdue 0 |
| **Fault injection on the real file** | rolled back; re-uploaded; commit started; **server process killed 12 s in** (N members landed, job `running`, N rows processed; the client saw 502); server restarted; a fresh commit answered **409 "Job already running"** while the claim was live; after the stale window (moved by a labelled clock edit, 6-minute rule unit-pinned) the commit **resumed**: 447 more, 922 total, `resumed: true`, reconciles true; N duplicate people, N duplicate ledger rows; independent reconciliation **RECONCILED** again |
| Synthetic pipeline on the same server (`synthetic-pipeline.mjs`, 402-row source-shaped file) | 19/19: upload/preview/commit exact per-plan and hold totals; same file refused naming the prior run; future export date refused; interrupted run resumes without duplicates; live run refused; rollback keeps rows that were signed in, edited, or have a kept child (4 named reasons) and removes the rest; a second rollback re-evaluates kept rows (`1ec7d88`); re-import after rollback allowed; another club's owner gets 404 on read and rollback |

Two harness corrections during the run (no product change): the owner wizard must be completed before member pages render (a new club is held at `/onboarding`); the decision block is fetched after mount, so the check waits for it.

## 3. Defects found by the rehearsal and fixed (`a72a347`, each red on revert)

| Id | What the data showed | Fix |
|---|---|---|
| F-R5-1 | N imported members carried a MatFlow `nextDueAt` seeded from their tier's billing cycle — an executable billing date invented from a cycle, which the contract forbids and which the migration engine's create path would anchor a subscription to | A TeamUp import never seeds a due date |
| F-R5-2 | One child was not imported: "parent … was not imported". Guardian drafts made from emergency contacts were de-duplicated by name + date of birth; two fathers with the same first name and no date of birth collapsed into one | Drafts are identified by their payer address only; a bare first name is not identity |
| (ledger) | A rolled-back run left its 20 no-member ledger rows behind, so a later reconciliation counted two runs | Rollback removes the run's ledger rows (rows of kept members stay) and reports `ledgerRemoved` |

The reconciliation script itself was corrected once: "last membership" is the latest by start date, not the last row in file order (the parser's rule).

## 4. Decisions the owner must make (from the exceptions list; names in the restricted CSV only)

| Item | Count | Where |
|---|---|---|
| Two plans active at TeamUp — choose one | 2 | Profile → set the plan; standing note names both |
| Guardian links suggested from a shared email — confirm or reject | 42 | Child's Family card |
| Guardian drafts from emergency contacts (no login, payer address held) and the children on them — confirm, optionally adopt the address | N drafts / N children | Child's Family card |
| Second adult on a shared email — give them their own address | 6 | Profile |
| Cancelled at TeamUp with no cancellation date | 5 | Nothing invented; add if known |
| Plan labels with no tier yet (`Beginners Course Unlimited Classes`, `8 Week Beginners Course`, `Beginner Course`, `Adult Advanced + Juniors & Comp (OLD)`, `Kids & Beginners Course 2026`) — all history-only people | N labels | Create the tier if anyone is to be put on it |
| Under-13s with no email and no adult on the row — not imported | 4 | Add the parent, re-import |
| Plans starting after the export date | 2 | Nothing now; a refresh after the date moves them |

## 5. Cleanup (within 24 h of 2 Oct 15:10 UK)

Rehearsal rows live only in the throwaway tenants (`totalbjjreh…`, two `importreh…` synthetic clubs, one `importreh…b` cross-club probe) on the test branch and in the restricted scratchpad files. Cleanup = operator soft-delete of each tenant followed by the purge path, removal of the `local-import://` temp files, deletion of `scratchpad/rehearsal/private-*` and `state.json`. Status: **pending until the independent acceptance walk (Phase F) has finished with the data**; recorded in the ledger when done.

## 6. Verdicts (this document's part)

- **IMPORTER VERIFIED** — importer v2 + ledger + refresh ordering + rollback + resume proven on the real file through the production build, with the independent reconciliation exact and two real defects found and fixed in the loop.
- **DATA RECONCILED / DECISIONS REQUIRED** — every one of N records has one disposition; the owner's decisions are enumerated above and in the exceptions CSV.
- **READY FOR PRODUCTION IMPORT** — not yet: see the acceptance document and the release package for what is BLOCKED and whose (export time, push/deploy, prod DB role, restore rehearsal, Sean's private identity, decisions that gate activation).
