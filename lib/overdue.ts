/**
 * What "overdue" means, defined once.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `Member.paymentStatus` reaches "overdue" at exactly two lines in the whole
 * codebase, and both are inside the Stripe webhook. A club that collects cash
 * or by standing order generates no Stripe events, so every one of its members
 * sits for ever on the column's shipped default of "paid": the outstanding list
 * is permanently empty, the chase button is unreachable, and the product cannot
 * answer the first question any gym owner asks — who owes me this month?
 *
 * So overdue is DERIVED rather than pushed: a due date in the past with nothing
 * recorded against it IS overdue. That needs no cron, cannot drift out of date,
 * and is true for a club that has never touched Stripe. Recording a payment
 * advances `nextDueAt`, so the state maintains itself.
 *
 * The Stripe-written `paymentStatus: "overdue"` is kept as a second source
 * rather than replaced — a failed card is a real signal, and it arrives before
 * any due date would pass.
 *
 * TWO CALLERS MUST NOT DISAGREE. The dashboard's action list and the
 * outstanding-payments API both answer "who is behind", on the same screenful
 * of product. Defining it twice is how they end up showing different numbers,
 * so both import from here.
 */

/**
 * Statuses that mean "this member is not being charged right now", and so must
 * never be chased however old their due date is.
 *
 * `free` is a comped member, `paused` a freeze, `cancelled` someone who has
 * left. Dunning any of them over a stale date would be the product inventing a
 * debt — and the club would be the one that has to apologise for it.
 */
export const NOT_CHASEABLE = ["free", "paused", "cancelled"] as const;

/**
 * Prisma `OR` clause selecting members who are behind.
 *
 * Spread into a where that already carries `tenantId` and whatever membership
 * status filter the caller wants:
 *
 *   where: { tenantId, status: { in: ["active", "taster"] }, OR: overdueClause(now) }
 *
 * Callers must not add their own top-level `OR` alongside it — Prisma keeps
 * only one, and the silent loser would be this one.
 */
export function overdueClause(now: Date) {
  return [
    // Stripe said so.
    { paymentStatus: "overdue" },
    // Or the due date has passed and nothing has been recorded since.
    {
      nextDueAt: { lt: now },
      paymentStatus: { notIn: [...NOT_CHASEABLE] },
      // ONE SOURCE OF TRUTH PER MEMBER. A member on a live Stripe subscription
      // has their schedule owned by Stripe, and the webhook already flags them
      // overdue the moment a card fails. Their `nextDueAt` is seeded when they
      // are put on a tier but NOTHING advances it — the webhook does not touch
      // the column — so without this exclusion a member paying perfectly by
      // card would silently appear on their club's chase list a month later.
      // Deriving from a date we do not maintain would be inventing a debt.
      stripeSubscriptionId: null,
    },
  ];
}

/**
 * The same rule for a member already in memory, so a profile screen and a list
 * query cannot disagree about one person.
 */
export function isOverdue(
  member: { paymentStatus: string; nextDueAt: Date | null; stripeSubscriptionId?: string | null },
  now: Date,
): boolean {
  if (member.paymentStatus === "overdue") return true;
  if (!member.nextDueAt) return false;
  if ((NOT_CHASEABLE as readonly string[]).includes(member.paymentStatus)) return false;
  // See overdueClause: Stripe owns the schedule for a subscribed member, and
  // nothing advances their nextDueAt, so the date is not ours to judge them by.
  if (member.stripeSubscriptionId) return false;
  return member.nextDueAt.getTime() < now.getTime();
}

/**
 * Advance a due date to the next one in the future.
 *
 * Advances from the DUE DATE rather than from today, so a member who pays three
 * days late keeps their billing day. Advancing from "now" instead would move
 * that day every time they paid late, and a year of slightly late payments
 * would walk a member due on the 8th into the middle of the month.
 *
 * A member who lapsed for six months and came back has a due date long past, so
 * one cycle would land on another past date. The loop keeps stepping until the
 * result is genuinely in the future — which preserves the day of the month
 * (still the 8th) rather than arbitrarily re-basing them on today. It does not
 * bill anyone for the gap: this sets the NEXT due date, it creates no charges.
 *
 * `annual` and `monthly` are the tier's own cycle values; `none` means the tier
 * is not recurring, so there is no next due date to set.
 */
export function advanceDueDate(
  current: Date | null,
  billingCycle: string,
  now: Date,
): Date | null {
  if (billingCycle === "none") return null;

  // monthly is also the default for an unrecognised cycle: a recurring tier
  // whose cycle we cannot read should still produce a date, because the
  // alternative is a member who silently never comes due again.
  const months = billingCycle === "annual" ? 12 : 1;

  let next = addMonthsClamped(current ?? now, months);
  // Bounded: 1200 monthly steps is a century, so a corrupt date far in the past
  // terminates instead of hanging a request.
  for (let i = 0; i < 1200 && next.getTime() <= now.getTime(); i += 1) {
    next = addMonthsClamped(next, months);
  }
  return next;
}

/**
 * Add whole months, clamping to the end of the target month.
 *
 * `setMonth` alone overflows: 31 January plus one month is 3 March, so a member
 * due on the 31st would skip February every year and be billed eleven times.
 * 29 February plus twelve months is 1 March for the same reason. Clamping gives
 * 28/29 February and 28/29 February respectively, which is what a human doing
 * the books would write.
 *
 * The clamp used to be one-way, and that was the defect: February moved a
 * member due on the 31st to the 28th, and the NEXT advance started from the
 * 28th, so March came out as the 28th too. The billing day walked three days
 * earlier and never walked back — for every member on a month-end date, for
 * ever.
 *
 * Nothing on `Member` records the day the member actually chose (there is only
 * `nextDueAt`), so the anchor is recovered from the date itself: a due date
 * that IS the last day of its month is treated as a month-end date and advances
 * to the last day of the target month. 31 Jan → 28 Feb → 31 Mar → 30 Apr.
 *
 * The one case this reads differently from a stored anchor is a member whose
 * chosen day happens to be their month's last (28 February, 30 April): they are
 * advanced to the next month end rather than to the same numbered day, so they
 * can be billed a day or two LATER than their anchor. That direction is the
 * safe one — it never takes money before the member expects it — and it is the
 * most a date alone can know. A stored anchor day would need a migration.
 *
 * Every step of the arithmetic is in UTC, and that is not a detail. `nextDueAt`
 * is a `timestamp(3)` WITHOUT a zone: Prisma writes and reads it as a UTC wall
 * clock, and every report reads it back with `to_char`. Doing the sums with the
 * LOCAL getters instead made the result depend on the server's zone — on a
 * host an hour ahead of UTC, 28 February advanced to local midnight on 31 March
 * and was stored as 30 March 23:00, so the club billed a day EARLY, which is
 * exactly the direction the paragraph above promises never to take. Production
 * runs in UTC and could not see it; a club's books must not depend on that.
 */
function addMonthsClamped(from: Date, months: number): Date {
  const day = from.getUTCDate();
  const result = new Date(from.getTime());
  // Move to the 1st first, so the month shift cannot overflow on the way.
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  // Day 0 of the FOLLOWING month is the last day of this one.
  const lastDayOfTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const lastDayOfSourceMonth = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const anchoredToMonthEnd = day === lastDayOfSourceMonth;
  result.setUTCDate(anchoredToMonthEnd ? lastDayOfTargetMonth : Math.min(day, lastDayOfTargetMonth));
  return result;
}
