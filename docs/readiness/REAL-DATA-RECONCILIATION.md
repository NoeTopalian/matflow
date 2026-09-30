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
