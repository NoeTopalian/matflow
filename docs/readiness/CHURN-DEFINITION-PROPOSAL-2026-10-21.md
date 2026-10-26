# Churn: proposed definition, checked against the code (21 Oct 2026) — NOT YET APPROVED

Branches read: `sean/batch-a-reporting-truth` (5046d763, the churn tile) and `sean/batch-c-headcount` (58055659, membership movement). Nothing here is implemented; this records the proposal, what the code and the data can support, one worked example, and the decisions Noe or Sean must take.

## The proposal (Noe, 20 Oct 2026)
- A cancellation is a departure. Pauses are reported separately.
- A member who pauses and later cancels counts **once**, at the cancellation, never twice in the same departure measure.
- Active-headcount movement is kept separate from cancellation churn: a pause can reduce active headcount without being called churn.
- The denominator is defined, and the count is shown beside the percentage.

## What the code does today
| | batch-a churn tile (`lib/reports.ts`) | batch-c movement (`lib/membership-movement.ts`) |
|---|---|---|
| Numerator | member rows with `status = cancelled` and `cancelledAt` in the current calendar month (server time, UTC on Vercel) | `lostCancelled`: every move into `cancelled` replayed from `MemberStatusEvent`, per club month in the club's timezone |
| Denominator | active members **now** (holds included) + the numerator | none; it reports headcount at each month end |
| Shown as | "3.8% (4 of 104)", formula "Cancelled this month ÷ (active members now + cancelled this month)" | tally "N new · N rejoined · N lost (N cancelled, N completed course)" |
| Double counting | none: one row counts once. But a cancel-then-rejoin inside the month counts **zero** (the rejoin clears `cancelledAt`) | none: pause → cancel is one `lostCancelled` (plus a paired "other in" so the headcount still adds up) |

Two kinds of "pause" exist in the data, and they behave differently:
- **A hold** (`paymentStatus = "paused"`, `holdUntil`): billing only. The member's `status` stays `active`, so they stay in the Active headcount on both branches (Noe's 17 Oct decision Q4 A-1: "holds stay inside Active members, marked as such"). A hold writes **no status event and no start date**; the only trace is an Activity-log row, purged after 365 days.
- **A status pause** (staff set the member to `inactive` or `taster`): batch-c counts it as "other out" and the member leaves the headcount; when they return it is "other in", not a rejoin.

## Worked example (shapes the code supports; no history invented)
One month, read at its last instant. All adult training members.
- 100 active at the start of the month (holds included, as both branches count Active).
- 3 cancellations of active members.
- 2 new holds this month (still on hold at month end).
- 1 member who went on hold earlier in the month and then cancelled this month (a 4th cancellation).
- 4 new joins (first ever entry to active).

| Measure | Today, batch-a | Proposed | batch-c movement row |
|---|---|---|---|
| Churn numerator | 4 | 4 (each member once, at the cancellation) | lost 4 (4 cancelled, 0 completed course) |
| Denominator | 104 (100 active now + 4 cancelled) | **100 active on the 1st** | — |
| Rate | **3.8% (4 of 104)** | **4.0% (4 of 100 active on 1 Oct)** | — |
| Joined | 4 (by join date) | 4 | new 4, rejoined 0 |
| Net | 0 | 0 | net 0 |
| Active at month end | 100 | 100 | 100 (the 2 on hold included) |
| Paused | "includes 2 on hold" (a snapshot now) | 2 on hold at month end; **3 holds started this month is not producible** | other in 0 / out 0 (holds are not status moves) |

If the three pauses had been **status** pauses instead of holds, batch-a's rate would read 3.9% (4 of 102) because the paused members leave the "active now" base while not being counted as churn, and batch-c would show other out 3 / in 1 with 98 active at month end. The held-then-cancelled member is one loss in every reading.

## Verdict on the proposal
- **No double counting** either today or under the proposal. Confirmed in the code of both branches.
- **The proposed rate can only be built on batch-c:** numerator = `lostCancelled` for the current club month; denominator = the previous month's `headcount` (active on the 1st, holds included). batch-a has no start-of-month headcount. The ratio, its copy and the "(n of m)" display still need writing.
- **"A pause can reduce active headcount" conflicts with decision Q4 A-1** unless "pause" means a status pause. Recommendation: keep Q4 A-1 (holds stay inside Active, shown as "includes N on hold"), define churn's "pause" as a hold, and let only status changes move the headcount.
- **"Paused this month" cannot be reported** until holds are recorded as events with a start date (the hold route, the resume route, the Stripe `pause_collection` webhook, and imports with the start unknown). Today only "on hold now" exists.

## Decisions needed before this is finalised
1. Denominator: **active on the 1st of the month, holds included** (recommended), or keep "active now + cancelled" with its counts shown.
2. Whether a completed prepaid course (`lostCompleted`) counts as churn. Recommended: no; show it beside the rate.
3. Whether to record hold events so holds can be counted by month. Recommended: yes, as a separate small change, before any "paused this month" figure is shown.
4. Whether a status pause (staff "inactive") should ever be labelled a pause on screens, or stays "other changes".

## Defects found while checking (to fix with the churn change)
- batch-c's "Joined this month" tile shows the join-date count, but the net printed beside it comes from the movement figures; the two definitions disagree.
- batch-a builds months in server time (UTC on Vercel); batch-c uses the club's timezone. A cancellation in the first hour of a BST month lands in different months on the two surfaces.
- The TeamUp import stamps every member's first status event on the import day (3 Oct 2026), so any event-based figure for October is an artefact unless the history back-fill (batch-c, T8b) is applied. Months before it are labelled "estimated".
