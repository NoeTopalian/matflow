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

import { cycleDays, cycleMonths } from "@/lib/billing-cycle";
import { CHASEABLE_PAYER } from "@/lib/member-population";

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
      // The same rule for TeamUp (readiness spec v3 §7): their schedule is
      // TeamUp's, and the import never writes a due date for them.
      billedBy: { not: "teamup" },
    },
  ];
}

/**
 * NOT overdue, as a Prisma where — the exact complement of overdueClause /
 * isOverdue, written positively.
 *
 * Do not write `NOT: { OR: overdueClause(now) }` instead. Postgres evaluates
 * `"nextDueAt" < $1` on a NULL due date as UNKNOWN, `NOT (unknown)` is still
 * UNKNOWN, and the row drops out — so every paid member with no due date would
 * vanish from a "Paid" count. Each branch here is NULL-safe.
 */
export function notOverdueWhere(now: Date) {
  return {
    AND: [
      { paymentStatus: { not: "overdue" } },
      {
        OR: [
          { paymentStatus: { in: [...NOT_CHASEABLE] } },
          { billedBy: "teamup" },
          { stripeSubscriptionId: { not: null } },
          { nextDueAt: null },
          { nextDueAt: { gte: now } },
        ],
      },
    ],
  };
}

/**
 * "No payment yet" (decision 1, 30 Sep 2026): a member on a plan whom nobody
 * has ever recorded a payment for. MatFlow-billed only — TeamUp's members are
 * TeamUp's to chase. This is the Payments → Outstanding list's definition;
 * the dashboard and Reports import it so no screen says "nobody owes" while
 * Outstanding lists names (end-user check, 30 Sep 2026).
 */
export function noPaymentYetWhere() {
  return {
    paymentStatus: "pending",
    membershipTierId: { not: null },
    billedBy: { not: "teamup" },
  };
}

/**
 * Everyone the Outstanding list shows: overdue OR "No payment yet". Use as the
 * single top-level `OR`, like overdueClause.
 */
export function owesMoneyClause(now: Date) {
  return [...overdueClause(now), noPaymentYetWhere()];
}

/** The null-safe complement of noPaymentYetWhere (membershipTierId is nullable). */
function notNoPaymentYetWhere() {
  return { OR: [{ paymentStatus: { not: "pending" } }, { membershipTierId: null }, { billedBy: "teamup" }] };
}

/**
 * PAYERS OVERDUE (review L2, 23 Oct 2026) — the one definition Reports, the
 * Members "Payers overdue" tile and chip, and Payments → Outstanding share.
 * Spread beside an explicit `tenantId`.
 *
 * - Payers, not members: any account type, guardians included, status active
 *   or taster (CHASEABLE_PAYER in lib/member-population.ts).
 * - Overdue by Stripe or by a passed due date (overdueClause).
 * - Minus "No payment yet": a plan nobody has paid for whose seeded due date
 *   has also passed is shown as "No payment yet", as Outstanding has done
 *   since decision 1 (30 Sep 2026). So overdue and "No payment yet" never
 *   overlap, and the two together are exactly the Outstanding list.
 */
export function overduePayerWhere(now: Date) {
  return {
    ...CHASEABLE_PAYER,
    AND: [{ OR: overdueClause(now) }, notNoPaymentYetWhere()],
  };
}

/**
 * OTHER ACCOUNTS OWING (owner direction D9, Noe 23 Oct 2026).
 *
 * "Payers overdue" counts only accounts the club chases — active and taster.
 * An account set inactive, or one that has left, can still owe: a Stripe
 * charge that failed after the member was set inactive, or a subscription
 * Stripe cancelled after its last charge failed. Those debts were in no total
 * anywhere. They are not chased and never join a member total; they are
 * counted beside the payers under their own label so the debt stays visible.
 *
 * The evidence must be a GENUINE debt, never a stale date:
 * - the account's latest settled payment (succeeded or failed) is a failed
 *   charge — a later successful payment clears it; or
 * - the stored payment status is "overdue" (Stripe said so, or staff marked
 *   it) — the same signal overdueClause trusts for payers.
 * A passed `nextDueAt` alone does NOT count here: an inactive or cancelled
 * member's due date is not advanced by anything, so deriving a debt from it
 * would invent one (the NOT_CHASEABLE reasoning above).
 *
 * Any account type, guardians included, as for payers.
 */
export const OTHER_OWING_STATUSES = ["inactive", "cancelled"] as const;

/**
 * The candidates for "other accounts owing", as a Prisma where. A superset:
 * the "latest settled payment" rule cannot be written as a where, so callers
 * load these with their latest settled payment and keep the rows
 * `otherOwingEvidence` accepts (lib/other-accounts-owing.ts does both). Use as
 * the single top-level `OR`, like overdueClause; spread beside `tenantId`.
 */
export function otherOwingCandidateWhere() {
  return {
    status: { in: [...OTHER_OWING_STATUSES] },
    OR: [{ paymentStatus: "overdue" }, { payments: { some: { status: "failed" } } }],
  };
}

/** A payment as the owing rules read it. Only "succeeded" and "failed" are settled. */
export type SettledPaymentInput = {
  status: string;
  createdAt: Date;
  amountPence?: number | null;
  failureReason?: string | null;
};

/** The newest succeeded-or-failed payment, whatever order the rows arrive in. */
export function latestSettledPayment<T extends SettledPaymentInput>(payments: readonly T[]): T | null {
  let latest: T | null = null;
  for (const p of payments) {
    if (p.status !== "succeeded" && p.status !== "failed") continue;
    if (!latest || p.createdAt.getTime() > latest.createdAt.getTime()) latest = p;
  }
  return latest;
}

export type OtherOwingEvidence =
  | { kind: "failed_charge"; at: Date; amountPence: number | null; reason: string | null }
  | { kind: "marked_overdue" };

/** Why an inactive or cancelled account still owes, or null when it does not (see OTHER_OWING_STATUSES). */
export function otherOwingEvidence(m: {
  status: string;
  paymentStatus: string;
  payments?: readonly SettledPaymentInput[] | null;
}): OtherOwingEvidence | null {
  if (!(OTHER_OWING_STATUSES as readonly string[]).includes(m.status)) return null;
  const latest = latestSettledPayment(m.payments ?? []);
  if (latest?.status === "failed") {
    return { kind: "failed_charge", at: latest.createdAt, amountPence: latest.amountPence ?? null, reason: latest.failureReason ?? null };
  }
  if (m.paymentStatus === "overdue") return { kind: "marked_overdue" };
  return null;
}

/** Payers on a plan with nothing ever recorded (the Outstanding "No payment yet" rows). Spread beside `tenantId`. */
export function noPaymentYetPayerWhere() {
  return { ...CHASEABLE_PAYER, ...noPaymentYetWhere() };
}

/** noPaymentYetWhere for a member already in memory. */
export function isNoPaymentYet(member: { paymentStatus: string; membershipTierId?: string | null; billedBy?: string | null }): boolean {
  return member.paymentStatus === "pending" && !!member.membershipTierId && member.billedBy !== "teamup";
}

/**
 * The same rule for a member already in memory, so a profile screen and a list
 * query cannot disagree about one person.
 */
export function isOverdue(
  member: { paymentStatus: string; nextDueAt: Date | null; stripeSubscriptionId?: string | null; billedBy?: string | null },
  now: Date,
): boolean {
  if (member.paymentStatus === "overdue") return true;
  // See overdueClause: TeamUp collects for these members, so MatFlow holds no
  // debt against them and a nextDueAt on the row is not ours to judge by.
  if (member.billedBy === "teamup") return false;
  if (!member.nextDueAt) return false;
  if ((NOT_CHASEABLE as readonly string[]).includes(member.paymentStatus)) return false;
  // See overdueClause: Stripe owns the schedule for a subscribed member, and
  // nothing advances their nextDueAt, so the date is not ours to judge them by.
  if (member.stripeSubscriptionId) return false;
  return member.nextDueAt.getTime() < now.getTime();
}

/**
 * The payment status a screen should show. The stored column only turns
 * "overdue" when Stripe says so; a cash member whose due date passed stays
 * "paid" in the row, so every list and profile must derive it the same way the
 * dashboard and Outstanding tab do (verifier lane 4, 30 Sep 2026: the Members
 * list said "Paid" for someone the dashboard said was overdue).
 *
 * A plan nobody has paid for stays "pending" ("No payment yet") even once its
 * seeded due date passes — the Outstanding list's rule (decision 1, 30 Sep
 * 2026), so the Members list, Reports and Outstanding name one member one way
 * (review L2). Pass `membershipTierId`: without it "No payment yet" cannot be
 * told from overdue, and the member reads as overdue (the old behaviour).
 */
export function shownPaymentStatus(
  member: { paymentStatus: string; nextDueAt: Date | null; stripeSubscriptionId?: string | null; billedBy?: string | null; membershipTierId?: string | null },
  now: Date,
): string {
  return isOverdue(member, now) && !isNoPaymentYet(member) ? "overdue" : member.paymentStatus;
}

/**
 * THE EVIDENCE BEHIND "NOT PAID" (owner direction D10, Noe 23 Oct 2026).
 *
 * The self check-in door refuses a member on a plan who is behind (lib/checkin
 * hasDeskMembership), and that ACCESS rule is unchanged. What changes is that
 * the refusal and the Members badge now say WHICH evidence applies, because
 * "never paid" and "did not pay" are different conversations at the desk:
 *
 * - no_payment_recorded: on a plan, nothing ever recorded ("No payment yet"),
 *   and the first payment date seeded with the plan has passed;
 * - payment_failed: the latest settled payment is a failed charge (a declined
 *   first charge included);
 * - payment_outstanding: a due date passed with a payment history, or the
 *   account is marked overdue with no failed charge on record.
 *
 * Returns null when the member is not behind by the existing rules
 * (isOverdue, or a stored "overdue"). `lastSettled` is the member's newest
 * succeeded-or-failed payment, when the caller has it.
 */
export type PaymentEvidence =
  | { kind: "no_payment_recorded"; firstDueAt: Date | null }
  | { kind: "payment_failed"; failedAt: Date }
  | { kind: "payment_outstanding"; dueAt: Date | null };

export function paymentEvidence(
  member: { paymentStatus: string; nextDueAt: Date | null; stripeSubscriptionId?: string | null; billedBy?: string | null; membershipTierId?: string | null },
  now: Date,
  lastSettled?: { status: string; createdAt: Date } | null,
): PaymentEvidence | null {
  if (!isOverdue(member, now)) return null;
  if (lastSettled?.status === "failed") return { kind: "payment_failed", failedAt: lastSettled.createdAt };
  // A date MatFlow does not maintain is not quoted: Stripe owns a subscribed
  // member's schedule and TeamUp a TeamUp-billed one (see overdueClause).
  const ownDate = member.stripeSubscriptionId || member.billedBy === "teamup" ? null : member.nextDueAt;
  if (isNoPaymentYet(member)) return { kind: "no_payment_recorded", firstDueAt: ownDate };
  return { kind: "payment_outstanding", dueAt: ownDate };
}

/**
 * "3 Oct". Due dates are UTC wall-clock dates (see addMonthsClamped), so they
 * are read in UTC; a failed charge is an instant, read in the club's zone.
 */
function dayMonth(d: Date, timeZone: string): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone });
}

/** The sentence every surface uses for a PaymentEvidence — the door refusal, the Members badge title. */
export function paymentEvidenceSentence(e: PaymentEvidence, clubTimeZone: string = "Europe/London"): string {
  switch (e.kind) {
    case "no_payment_recorded":
      return e.firstDueAt
        ? `No payment has been recorded for this membership and its first payment date (${dayMonth(e.firstDueAt, "UTC")}) has passed.`
        : "No payment has been recorded for this membership and its first payment date has passed.";
    case "payment_failed":
      return `A payment failed on ${dayMonth(e.failedAt, clubTimeZone)}.`;
    case "payment_outstanding":
      return e.dueAt
        ? `The payment due on ${dayMonth(e.dueAt, "UTC")} is outstanding.`
        : "A payment on this membership is outstanding.";
  }
}

/** The short badge label for each kind (Members list). */
export const PAYMENT_EVIDENCE_LABEL: Record<PaymentEvidence["kind"], string> = {
  no_payment_recorded: "No payment recorded",
  payment_failed: "Payment failed",
  payment_outstanding: "Payment outstanding",
};

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
 * The cycle values are the tier's own (lib/billing-cycle.ts): the week-based
 * ones step by exact days, the month-based ones by clamped months; `none`
 * means the tier is not recurring, so there is no next due date to set.
 */
export function advanceDueDate(
  current: Date | null,
  billingCycle: string,
  now: Date,
): Date | null {
  if (billingCycle === "none") return null;

  const days = cycleDays(billingCycle);
  // monthly is also the default for an unrecognised cycle: a recurring tier
  // whose cycle we cannot read should still produce a date, because the
  // alternative is a member who silently never comes due again.
  const months = days ? 0 : (cycleMonths(billingCycle) ?? 1);
  const step = (from: Date) => (days ? addDaysUtc(from, days) : addMonthsClamped(from, months));

  let next = step(current ?? now);
  // Bounded: 1200 monthly steps is a century (1200 weekly steps is 23 years —
  // still finite), so a corrupt date far in the past terminates instead of
  // hanging a request.
  for (let i = 0; i < 1200 && next.getTime() <= now.getTime(); i += 1) {
    next = step(next);
  }
  return next;
}

/**
 * Add whole days in UTC. `nextDueAt` is a zoneless timestamp read as a UTC wall
 * clock (see addMonthsClamped), so the day arithmetic must be UTC too — a local
 * `setDate` across a DST change would land an hour off and be stored as the
 * previous day.
 */
function addDaysUtc(from: Date, days: number): Date {
  const result = new Date(from.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
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
