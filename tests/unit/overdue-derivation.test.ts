// Deriving "who owes me?" without Stripe.
//
// `Member.paymentStatus` reaches "overdue" at exactly two lines in the product,
// both inside the Stripe webhook. A club collecting cash or by standing order
// generates no events, so every member sits for ever on the column's default of
// "paid" and the outstanding list is permanently empty. These tests pin the
// derivation that fixes it, and the two ways it could do real damage: chasing
// somebody who owes nothing, and drifting a member's billing date.

import { describe, it, expect } from "vitest";
import { isOverdue, advanceDueDate, overdueClause, NOT_CHASEABLE } from "@/lib/overdue";

const NOW = new Date("2026-09-11T12:00:00Z");
const YESTERDAY = new Date("2026-09-10T12:00:00Z");
const TOMORROW = new Date("2026-09-12T12:00:00Z");

describe("isOverdue — the boundary", () => {
  it("is overdue when the due date has passed", () => {
    expect(isOverdue({ paymentStatus: "paid", nextDueAt: YESTERDAY }, NOW)).toBe(true);
  });

  it("is NOT overdue when the due date is still ahead", () => {
    expect(isOverdue({ paymentStatus: "paid", nextDueAt: TOMORROW }, NOW)).toBe(false);
  });

  it("is not overdue with no due date tracked — the state every existing member is in", () => {
    expect(isOverdue({ paymentStatus: "paid", nextDueAt: null }, NOW)).toBe(false);
  });

  it("still honours a Stripe-written overdue with no due date at all", () => {
    // A failed card arrives long before any due date would pass, and it is a
    // real signal. The derivation adds a source, it does not replace one.
    expect(isOverdue({ paymentStatus: "overdue", nextDueAt: null }, NOW)).toBe(true);
  });
});

describe("isOverdue — people who must never be chased", () => {
  it.each(NOT_CHASEABLE)("never chases a %s member, however stale the date", (status) => {
    expect(isOverdue({ paymentStatus: status, nextDueAt: YESTERDAY }, NOW)).toBe(false);
  });

  it("chases an ordinary paid member whose date has passed", () => {
    // The control case for the above: the exclusion must be about those three
    // statuses, not about the derivation failing to fire at all.
    expect(isOverdue({ paymentStatus: "paid", nextDueAt: YESTERDAY }, NOW)).toBe(true);
  });

  it("a comped member is not resurrected by a Stripe flag either", () => {
    // paymentStatus IS the "free" marker here, so there is no conflict to
    // resolve — this pins that "free" wins over a stale date, which is the
    // case a club would notice: comped members appearing on a chase list.
    expect(isOverdue({ paymentStatus: "free", nextDueAt: YESTERDAY }, NOW)).toBe(false);
  });
});

describe("isOverdue — a member Stripe is billing is not ours to judge", () => {
  it("never derives overdue from a date for a member on a live subscription", () => {
    // Their nextDueAt is seeded when they are put on a tier, but NOTHING
    // advances it — the Stripe webhook does not touch the column. Without the
    // exclusion, a member paying perfectly by card appears on their club's
    // chase list a month after signing up.
    expect(
      isOverdue(
        { paymentStatus: "paid", nextDueAt: YESTERDAY, stripeSubscriptionId: "sub_live" },
        NOW,
      ),
    ).toBe(false);
  });

  it("still shows them overdue when Stripe itself says the card failed", () => {
    expect(
      isOverdue(
        { paymentStatus: "overdue", nextDueAt: TOMORROW, stripeSubscriptionId: "sub_live" },
        NOW,
      ),
    ).toBe(true);
  });

  it("the same member WITHOUT a subscription is derived overdue", () => {
    // Control case: the exclusion must turn on the subscription, not quietly
    // disable the derivation for everyone.
    expect(
      isOverdue({ paymentStatus: "paid", nextDueAt: YESTERDAY, stripeSubscriptionId: null }, NOW),
    ).toBe(true);
  });
});

describe("overdueClause — the query the two surfaces share", () => {
  it("matches on either source", () => {
    const clause = overdueClause(NOW);
    expect(clause).toHaveLength(2);
    expect(clause[0]).toEqual({ paymentStatus: "overdue" });
  });

  it("excludes the non-chaseable statuses from the date-derived half", () => {
    // If this half ever loses its notIn, comped and paused members land on the
    // club's chase list and the club has to apologise for our bookkeeping.
    const [, derived] = overdueClause(NOW);
    expect(derived).toEqual({
      nextDueAt: { lt: NOW },
      paymentStatus: { notIn: ["free", "paused", "cancelled"] },
      stripeSubscriptionId: null,
    });
  });

  it("excludes Stripe-subscribed members from the date-derived half", () => {
    // Pinned separately from the shape assertion above so that dropping just
    // this one condition — the one that would put paying card members on a
    // chase list — fails with a message that says so.
    const [, derived] = overdueClause(NOW) as Record<string, unknown>[];
    expect(derived.stripeSubscriptionId).toBeNull();
  });
});

describe("advanceDueDate — the schedule must not drift", () => {
  it("advances from the DUE date, not from today, when payment is late", () => {
    // Paying four days late must not move the schedule four days later for ever.
    const due = new Date("2026-09-08T12:00:00Z");
    const next = advanceDueDate(due, "monthly", NOW);
    expect(next?.toISOString().slice(0, 10)).toBe("2026-10-08");
  });

  it("keeps the billing day for a member returning after a long gap", () => {
    // Due on the 8th, lapsed since January. The next due date must be a FUTURE
    // 8th — not January's, and not arbitrarily re-based onto today's date.
    const longAgo = new Date("2026-01-08T12:00:00Z");
    const next = advanceDueDate(longAgo, "monthly", NOW);
    expect(next?.getTime()).toBeGreaterThan(NOW.getTime());
    expect(next?.toISOString().slice(0, 10)).toBe("2026-10-08");
  });

  it("terminates on a corrupt date far in the past instead of hanging", () => {
    const ancient = new Date("1900-01-08T12:00:00Z");
    const next = advanceDueDate(ancient, "monthly", NOW);
    expect(next).not.toBeNull();
  });

  it("sets a first due date a month out when none exists", () => {
    expect(advanceDueDate(null, "monthly", NOW)?.toISOString().slice(0, 10)).toBe("2026-10-11");
  });

  it("advances an annual tier by a year", () => {
    const due = new Date("2026-09-20T12:00:00Z");
    expect(advanceDueDate(due, "annual", NOW)?.toISOString().slice(0, 10)).toBe("2027-09-20");
  });

  it("returns no due date for a non-recurring tier", () => {
    expect(advanceDueDate(new Date("2026-09-20T12:00:00Z"), "none", NOW)).toBeNull();
  });

  it("still produces a date for an unrecognised cycle", () => {
    // A tier whose cycle we cannot read must not leave a member who silently
    // never comes due again.
    expect(advanceDueDate(null, "fortnightly-ish", NOW)).not.toBeNull();
  });
});

describe("advanceDueDate — month-end, where naive date maths bills eleven times a year", () => {
  it("31 January plus a month is the end of February, not 3 March", () => {
    const due = new Date("2027-01-31T12:00:00Z");
    const next = advanceDueDate(due, "monthly", new Date("2027-01-30T12:00:00Z"));
    expect(next?.toISOString().slice(0, 10)).toBe("2027-02-28");
  });

  it("31 March plus a month is 30 April", () => {
    const due = new Date("2027-03-31T12:00:00Z");
    const next = advanceDueDate(due, "monthly", new Date("2027-03-30T12:00:00Z"));
    expect(next?.toISOString().slice(0, 10)).toBe("2027-04-30");
  });

  it("29 February plus a year is 28 February", () => {
    const due = new Date("2028-02-29T12:00:00Z");
    const next = advanceDueDate(due, "annual", new Date("2028-02-28T12:00:00Z"));
    expect(next?.toISOString().slice(0, 10)).toBe("2029-02-28");
  });

  it("an ordinary mid-month date is untouched by the clamping", () => {
    const due = new Date("2027-01-15T12:00:00Z");
    const next = advanceDueDate(due, "monthly", new Date("2027-01-14T12:00:00Z"));
    expect(next?.toISOString().slice(0, 10)).toBe("2027-02-15");
  });
});
