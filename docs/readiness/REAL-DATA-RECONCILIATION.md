# Real-data reconciliation (readiness spec v3 §8)

**Status: synthetic rehearsals PASS; the real Total BJJ import is BLOCKED** on Sean's exports and Noe's written go. No real member data has been loaded anywhere.

## The rule every import follows
Every source row ends in exactly one disposition, recorded in the job's manifest and shown on screen:

| Disposition | Meaning |
|---|---|
| created | a new member, carrying the job id (`importJobId`) and the source key (`externalRef`) |
| already in the club | matched an existing person (email, or parent + name + date of birth for children) and left untouched |
| folded | a TeamUp history row (upgraded, cancelled, hold) folded into its person's current membership |
| payer record | a guardian made from a child's emergency contact, marked UNVERIFIED — never inferred as the payer of anything else |
| refused, with reason | e.g. a child under 13 with no email to find a parent; listed with the file's real line number (`a8a54c2`) |
| exception (status refresh) | new at TeamUp or renamed there; billed by TeamUp but missing from the file; billed by MatFlow now; on hold in MatFlow while TeamUp says otherwise |

`reconciles` is true only when created + already in the club + refused equals the people in the file. A run that stopped on a system error ends **failed**, says how many were saved, and can be re-run (nobody is created twice) or rolled back (`2572e50`).

Never inferred: identity from a shared email, guardianship from an emergency contact, the payer from the guardian, the next charge date from the start date (an estimate is written into the member's notes as UNVERIFIED).

## Rehearsals (synthetic data, test branch)
| Rehearsal | Result | Evidence |
|---|---|---|
| Member import: upload → preview → commit → reconcile → same-file refusal → interrupted re-run → rollback | 19 / 19 | `0c97206`; rehearsal script in the session scratchpad |
| Import panel on screen | 2 / 2 | same |
| Attendance import: parse → commit → rollback, no credits, charges, email or waiver change | 8 / 8 on the wire | `804c8f3`, `ce1d6a6` |
| TeamUp import marks the cohort (billed by TeamUp, standing date, source job, source key) | CONFIRMED by the independent functional reviewer on `10776a4` | `review-functional-result.md` |
| Status refresh: owned fields only; MatFlow edits survive; exceptions listed; rollback restores only untouched members | CONFIRMED except F1 (hold lifted) — fixed `d97a3c4`, re-check pending | same |
| Two tabs committing one job; same file twice at once; interrupted run resumed | one runs; the second refused; no duplicates (F2, F6 fixed `d97a3c4`) | same |

## Before the real import (all required)
1. Sean's fresh TeamUp memberships export (all statuses) and the attendance export, with the time each was taken.
2. Noe's written go naming the destination (the Total BJJ tenant on production, in review mode), after G1.
3. A point-in-time restore rehearsal done (Noe, Neon console).
4. The mapping reviewed against the real file: plan names to tiers, the four account types, the plans marked "(OLD)".
5. Automation suppressed: the import sends no invitations; the only email is the completion note to the operator.
6. Personal data kept out of logs, screenshots, commits and test artefacts.

## Snapshot and delta between rehearsal and final load
The final load uses the export taken on the day. Any later change at TeamUp reaches MatFlow through the weekly status refresh (`TEAMUP-OPERATIONS-CONTRACT.md` §3), which previews every change before it writes.

## 3 Oct 2026 — exports, independent reconciliation, rehearsal gaps

### Owner exports, as they stand (commit `310d1a8`)
| Export | Who | Cap | Audit | Encoding |
|---|---|---|---|---|
| Payments CSV (`GET /api/payments/export.csv`, Payments screen) | owner, manager; 10 per hour per club | newest 5,000 payments. Above that the file itself says nothing, but the response carries `X-Row-Cap` / `X-Rows-Truncated`, the Export button tells the owner older payments are missing, and the audit row records it | `payments.export`: actor, club, `rowCount`, `rowCap`, `truncated` | UTF-8 with BOM, CRLF, every cell through `csvCell` |
| Reports CSV (Reports screen, built in the browser) | whoever can open Reports (owner, manager) | none: it is the on-screen report | none (no server call; the numbers are already on screen) | UTF-8 with BOM, CRLF, every cell through `csvCell` |
| Import exceptions CSV (`/api/admin/import/[id]/exceptions`) | owner | none | `import.exceptions.download` | UTF-8, every text cell guarded |

What every file guarantees: each value's bytes survive a round trip (commas, quotes, line breaks, accents, emoji, leading zeros, a 24,000-character cell — `tests/unit/csv-export-fidelity.test.ts`), and no cell opens as a live formula (`= + - @` and a leading tab or CR get a `'`). What no CSV can guarantee: how a spreadsheet displays a value — Excel still shows `07700900123` as a number without its zero. Before 3 Oct neither export wrote a BOM, so Excel on Windows showed "é" as "Ã©".

There is **no member-roster export** in the product. A MatFlow CSV is **not** importable into TeamUp — the columns, plan names and statuses are MatFlow's own. Leaving MatFlow means the club's own records plus a support request, not a round trip.

### Independent reconciliation in the product (commit `2e8add1`)
Settings → Import → **Check an import** (owner only) runs `lib/import-reconciliation.ts` against one import: members carrying the job id by account type, status, payment status and who bills them; live members with no tier; ledger rows by entitlement and by plan label with today's tier match; guardian links suggested versus confirmed; the same name and date of birth created twice; members with a MatFlow placeholder email; payments, check-ins and signed waivers attached since. Each is compared with the job's manifest and counters. Invariants must match; baselines are true at the moment of import and are expected to move once the club uses MatFlow; counts carry no expectation. The response carries counts, plan labels and source row numbers only. It shares no counting code with the importer.

Operator use after the production import: open Settings → Import as the owner, press **Check the latest import**, and record the summary line ("Every fixed check matches.") with the job id in the evidence record. `scripts/readiness/teamup-reconcile.mjs` remains the CSV-side reconciliation and still refuses any database but the test branch.

### What the 2 Oct rehearsal proved, and what it did not
Proved on the real file through the production build: an interrupted commit (process killed 12 s in) answers 409 while its claim is live and resumes after the stale window with no duplicate people or ledger rows; an older export cannot overwrite newer standing; rollback, then re-import; another club's owner gets 404.

Not exercised there, now pinned by unit tests against the real routes (`tests/unit/import-reconciliation-rehearsal-gaps.test.ts`, 11 cases, `2e25bef`, plus the existing `import-commit-integrity.test.ts`):

| Failure mode | Proven by |
|---|---|
| Double submit while the run is live → 409 "Job already running", claim untouched | rehearsal-gaps |
| Response lost after commit, owner retries → 409 "Job already complete", no second copy | rehearsal-gaps |
| Two tabs on one job → one runs, the other 409 and writes nothing | import-commit-integrity (gap 13) |
| Same file from a second job: earlier run complete or live → 409 naming it; earlier run rolled back → allowed | rehearsal-gaps; two jobs in the same instant: import-commit-integrity (F6) |
| Stale boundary: 5 s inside the 360 s window → 409; 5 s past it → reclaimed, finishes, nothing duplicated | rehearsal-gaps |
| Interruption between batches → the resumed run reconciles and does not count its own rows as skipped | import-commit-integrity (F2) and the rehearsal |
| Rollback after a partial failure: parent and child both removed; parent alone removed; a kept child keeps its parent; a child the club already had keeps its imported parent — never an orphan | rehearsal-gaps |

Still untested anywhere: the upload route's own same-file refusal (`upload/route.ts` around line 134) at unit level — covered only by the 2 Oct synthetic pipeline run; two different browsers (separate sessions) rather than two tabs of one; a connection dropping inside a slice transaction on real Postgres (the unit harness throws from `createMany`; it does not drop a connection).
