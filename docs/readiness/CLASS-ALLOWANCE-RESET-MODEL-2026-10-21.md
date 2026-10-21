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

## The fourth option: "per member's billing period" (implemented 21 Oct 2026, late evening)

The agreed scope includes "four attendances per billing period". A shared per-plan start date is not that, so a fourth basis `billing` exists: each member's own period, from one renewal date to the next. The period belongs to the member, not the plan, and comes from the most authoritative date MatFlow holds, in this order (`lib/class-allowance.ts` `withMemberBillingPeriod`):

| Member billed by | Period source | Authority | What is missing |
|---|---|---|---|
| Stripe subscription | `Member.billingPeriodStart/End` = the paid period Stripe states on the last paid invoice's first line, written by the webhook on `invoice.payment_succeeded` (migration `20261021230000`) | Stripe's own statement | nothing once the first invoice after this release is paid; members whose last invoice predates it have no stored period until their next renewal (or a one-off backfill from Stripe, not written) |
| Desk / cash / standing order | `[nextDueAt − cycle, nextDueAt)`, stepped by the tier's `billingCycle` to the period containing the class; each recorded payment advances `nextDueAt` (`lib/overdue.ts`) | MatFlow's own due-date record | a member with no due date recorded |
| TeamUp-billed (Total BJJ) | the same `nextDueAt` rule; the import writes `nextDueAt` from the export's "next payment date" when the row has one | TeamUp's export at import time | **the period is only as fresh as the last import**: TeamUp does not tell MatFlow about renewals between imports, and the export does not carry the current period's start, so the start is derived from the tier's cycle. A member whose export row had no next payment date has no period |

A member with **no period** on a `billing` plan cannot be counted: the member app and the kiosk refuse ("Your plan counts classes per billing period, but no renewal date is recorded for you. Ask staff."), the desk, the scanner and the coach tick ask ("No renewal date is recorded for X, so their 4 classes per billing period can't be counted. Admit anyway?") and an admission is recorded as the `allowance_reached` override with `periodUnknown: true`. There is never a silent fall-back to a calendar period. The editor says there is no shared reset date, and that unknown-period members are refused or asked about.

**Period boundaries (review rounds 3–4, 22 Oct):** a period runs from 00:00 on one renewal date to 00:00 on the next, on the club's calendar; the renewal day belongs to the new period. For a Stripe member the stored period is used as stated while the class falls inside it; outside it (the next period before the next invoice arrives, or a past one) the recurrence is inferred from the stored period's length measured on Stripe's UTC instants — 7/14/28 days step by days, 29–31 days step by calendar months, 365/366 by a year — and the day of the month is kept across clamped month ends (a plan on the 31st renews on 28 Feb and 31 Mar again, never drifting to the 28th). A desk member whose due date is the last day of its month stays on month ends, exactly as `lib/overdue.ts` advances the due date. Residuals (review rounds 5–6, all Low, none blocking; they affect only sessions *outside* the stored paid period, i.e. back-dated marks and sessions after an unpaid or not-yet-recorded renewal): (1) a 28-day Stripe period is read as monthly when it starts and ends on the same day of the month *or* when it ends on a clamped month end (31 Jan → 28 Feb) — **once a year for every four-weekly Stripe subscriber** (the period starting 31 Jan–28 Feb in a non-leap year): forwards, a session after an unpaid renewal is judged in a monthly projection (2 Mar → 2 Apr instead of 30 Mar); backwards, a back-dated mark before that period is judged in a monthly projection too; the next paid invoice overwrites the stored period and the stated period is used again; the proper fix is to store the price's recurring interval with the period; (2) projections use the club's calendar day while Stripe anchors on a UTC instant, so when Stripe's boundary falls after midnight UTC minus the club's offset (in London, 23:00–00:00Z during BST) the projected previous *and* next boundaries can be a day off, and the projected period immediately before the stored one is clamped to the stored start and can be a single day — a back-dated mark on that day is judged in a one-day period, never against the paid period's visits; (3) the webhook stores no period from a **£0 invoice** (the zero-amount branch: a subscription created with a future billing anchor, as a membership migrated from another platform is, a 100 % coupon, or a free trial), so a member whose first MatFlow-era invoice is £0 reads "no renewal date recorded" on a `billing` plan until their first paid invoice, and a member who already had a paid period keeps projecting from it; (4) **members already on a Stripe subscription when this release deploys have no stored period until their next paid invoice** — until then they read "no renewal date recorded" (refused at self doors, asked at staff doors) on a `billing` plan. A one-off backfill from Stripe (`subscriptions.retrieve` → current period) is not written; it is Noe's decision whether to add it before any plan is switched to this basis.

The earlier analysis that led to this design is kept below for the record.

### Earlier analysis (same evening, before implementation)

**What "per billing period" requires:** for each member, the start and end of their current paid period. MatFlow holds that only partly:

| Member billed by | Where the period could come from | State today |
|---|---|---|
| Desk / cash / standing order (`billedBy` matflow, no Stripe subscription) | `Member.nextDueAt` is the period end; start = end − `MembershipTier.billingCycle` (`lib/overdue.ts` `advanceDueDate` steps it when a payment is recorded) | **available** where a due date has been recorded; NULL for members without one |
| TeamUp-imported (Total BJJ) | the import maps "next payment date" into `Member.nextDueAt` (`lib/importers/index.ts`), refreshed by later imports | **available** for members whose export carried a date; not maintained between imports |
| Stripe subscription | Stripe's `current_period_start/end`; the webhook (`invoice.payment_succeeded`) records the payment and sets `paymentStatus` but stores **no period**; `nextDueAt` is NULL by design ("Stripe owns the schedule", `prisma/schema.prisma` Member comment) | **not stored** |

**Design when approved:** a fourth basis `billing`: period = `[nextDueAt − cycle, nextDueAt)` stepped forward or back by the tier's cycle until it contains the class (so a four-weekly plan gives each member their own 28-day blocks ending on their renewal date); for Stripe-billed members the webhook must first store the invoice line period (`lines.data[0].period.start/end`) — a change to the production webhook that needs its own review and migration. A member on a `billing` plan with no recorded period cannot be counted: the honest behaviour is to refuse at member-decided doors with "no renewal date is recorded — ask staff" and to ask at staff doors, never to fall back to a calendar period silently. The editor would describe the option as "each member's own billing period (from their renewal date)" and could show no shared reset date.

**Resolved the same evening:** both were done — the webhook stores Stripe's paid period, and desk / TeamUp members use `nextDueAt` — see the section above. "Billing is separate" below still holds: the allowance basis is chosen explicitly by the administrator; the billing cycle alone never creates an allowance.

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
