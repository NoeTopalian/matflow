# Class allowance: reset model and the open anchor-date decision (21 Oct 2026)

Branch `sean/batch-d-plan-limits` (PR #41). Product decisions received 20 Oct 2026: memberships recur and attendance limits are optional; the administrator picks Unlimited or an allowance, and can clear one; weekly, calendar-month and multi-week options (including four classes every four weeks); the reset basis must be explicit, never a silent rolling window; a plain summary and the actual period dates are shown before saving; billing frequency and attendance allowance stay separate.

## What the branch did before this change (da405e89)
The allowance was `N classes every M weeks` judged on a **rolling** window of M × 7 days ending at the start of the class being attended (`lib/class-allowance.ts`, header and lines 125–150). The plan editor's note said "Counted over the N weeks before each class". No reset date existed, because a rolling window never resets. A legacy `maxClassesPerWeek` value was read as a rolling 7-day window too. Both are what the decision forbids.

## Reset bases now supported
All periods are half-open `[start, end)` on the club's wall clock (`Tenant.timezone`, Europe/London for Total BJJ), measured by the class's calendar date and start time, not by when the check-in was recorded. A class is judged against the period that contains it.

| Basis | Period | Anchor needed | Status |
|---|---|---|---|
| `week` | Monday 00:00 to the next Monday 00:00 | none (ISO week, Monday start) | settled |
| `month` | the 1st 00:00 to the next 1st 00:00 | none (`Tenant.timezone`) | settled |
| `weeks` (every N weeks, N = 2–8) | `anchor + k × N × 7 days`, for the k whose period contains the class | **yes** — see below | open: anchor decision |

Why Monday: the only week starts in the codebase (`lib/member-stats.ts`, `lib/reports.ts`) are Monday, and a Sunday-start option would need a tenant setting that does not exist. Not offered now; it can be added as a tenant setting later without changing the period maths.

## The open decision: what anchors "every N weeks"
A multi-week period has no natural calendar boundary, so something must say when period 1 started. The data MatFlow holds today:

| Candidate | What it is | Fit |
|---|---|---|
| `Member.joinedAt` | the member's join date; for the 3 Oct import it is the TeamUp join date where the file had one, otherwise the import day | Poor. Thousands of members would share 3 Oct; a rejoin does not reset it |
| `Member.nextDueAt` | the next billing due date MatFlow tracks | Poor. NULL for every existing member and for anyone billed by Stripe or TeamUp; it is billing, which the decision says to keep separate |
| `ImportedMembership.startDate` | TeamUp's plan start date, import only | Partial. Only imported members have it; nothing maintains it after import |
| A per-member "plan period start" stamped when a tier is assigned (`lib/membership-tier.ts` `membershipTierWrite`) | would be accurate from the day it is introduced | Needs a backfill rule for every existing member, which the data above cannot supply honestly |
| **A per-plan period start date on the tier** (`MembershipTier.classLimitAnchor`) | the administrator chooses the date the plan's periods count from; every member on the plan shares the same periods | **Fits existing data.** Needs no member history, is shown before saving, and gives one reset date the club can put on a notice board |

**Recommendation: the per-plan anchor.** It is the simplest model compatible with the data MatFlow has: the administrator sets "4 classes every 4 weeks, periods starting Monday 20 October 2026", the editor shows "Your next reset is Monday 17 November 2026", and every member on that plan resets together. It also matches how block-period allowances are usually run in a gym (the club's four-week blocks, not each member's own).

What is **not** settled, and is left for Noe or Sean:
- Whether members should instead each have their own periods counted from their own plan start (per-member anchor). That is a different product: a notice board cannot state a reset date, the editor cannot show one before saving, and existing members would need an invented start date. If chosen later, `classLimitAnchor` moves from the tier to the member and the backfill rule has to be decided then.
- The default anchor the editor offers. This change proposes the Monday of the week the allowance is saved; the administrator can change it to any date.

Until the decision is taken, the "every N weeks" option is implemented with the per-plan anchor and the editor states the period start date in the summary, so nothing is silent. Switching models later changes where the anchor is stored, not the period maths.

## The missing option: "per billing period" (identified 21 Oct 2026, evening — NOT implemented)

The agreed scope includes "four attendances per billing period". None of the three bases above is that: a shared per-plan start date gives every member the same four-week blocks, which is not each member's own subscription period. It was not silently replaced — it is absent, and this section says what it needs.

**What "per billing period" requires:** for each member, the start and end of their current paid period. MatFlow holds that only partly:

| Member billed by | Where the period could come from | State today |
|---|---|---|
| Desk / cash / standing order (`billedBy` matflow, no Stripe subscription) | `Member.nextDueAt` is the period end; start = end − `MembershipTier.billingCycle` (`lib/overdue.ts` `advanceDueDate` steps it when a payment is recorded) | **available** where a due date has been recorded; NULL for members without one |
| TeamUp-imported (Total BJJ) | the import maps "next payment date" into `Member.nextDueAt` (`lib/importers/index.ts`), refreshed by later imports | **available** for members whose export carried a date; not maintained between imports |
| Stripe subscription | Stripe's `current_period_start/end`; the webhook (`invoice.payment_succeeded`) records the payment and sets `paymentStatus` but stores **no period**; `nextDueAt` is NULL by design ("Stripe owns the schedule", `prisma/schema.prisma` Member comment) | **not stored** |

**Design when approved:** a fourth basis `billing`: period = `[nextDueAt − cycle, nextDueAt)` stepped forward or back by the tier's cycle until it contains the class (so a four-weekly plan gives each member their own 28-day blocks ending on their renewal date); for Stripe-billed members the webhook must first store the invoice line period (`lines.data[0].period.start/end`) — a change to the production webhook that needs its own review and migration. A member on a `billing` plan with no recorded period cannot be counted: the honest behaviour is to refuse at member-decided doors with "no renewal date is recorded — ask staff" and to ask at staff doors, never to fall back to a calendar period silently. The editor would describe the option as "each member's own billing period (from their renewal date)" and could show no shared reset date.

**Decision required (Noe):** (1) add the `billing` basis on `nextDueAt` now (covers desk and TeamUp-billed members, which is Total BJJ today) and treat Stripe-billed members as "period unknown" until the webhook stores it; or (2) store the subscription period for every member first (webhook + import + manual payments), then add the basis. Either way, "billing is separate" below still holds: the allowance basis is chosen explicitly; it is never derived from the billing cycle without the administrator picking it.

## Legacy column
`maxClassesPerWeek` (the previous build's "Classes per week") now reads as `N each calendar week`, not a rolling seven days. Every Total BJJ plan had it NULL on 15 Oct (PR #41); the demo seed's "3x Per Week" tier is the only known value. A weekly allowance still mirrors N into the column so a rollback to the previous build shows the right number.

## What attendance consumes (settled, 20 Oct)
- Booking consumes nothing. A booking saves a place in the class; the allowance is counted when the member attends, and eligibility is checked again then. A booking is never described as guaranteeing admission.
- Confirmed attendance consumes one session of the period containing that class.
- Cancelling a booking consumes nothing. "Absent" is the absence of an attendance row, so it consumes nothing.
- Reversing attendance (unmark, undo) deletes the row; the count is always recomputed from rows, so the session is restored to its own period, never to the current one.
- Duplicate check-ins are refused as duplicates before the allowance is judged (and by the unique key); simultaneous check-ins queue on the member's row lock, so two cannot both take the last place.

## Billing is separate
`MembershipTier.billingCycle` (weekly, fortnightly, four-weekly, monthly, annual, none) drives payments only. The allowance basis is its own column and is never derived from the billing cycle.
