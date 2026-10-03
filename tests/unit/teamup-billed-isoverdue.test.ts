/**
 * isOverdue (in memory) must agree with overdueClause (the database rule) for
 * a TeamUp-billed member (3 Oct 2026, specialist C audit). overdueClause has
 * excluded billedBy "teamup" since readiness spec v3 section 7; isOverdue did
 * not. A TeamUp member gets a nextDueAt the moment staff attach a tier on the
 * profile (membershipTierWrite seeds one when none exists), so one billing
 * cycle later the Members list showed them Overdue and the door
 * (lib/checkin.ts hasDeskMembership) refused them as not covered, while the
 * dashboard and Outstanding list correctly said they owe MatFlow nothing.
 */
import { describe, it, expect } from "vitest";
import { isOverdue, shownPaymentStatus } from "@/lib/overdue";

const now = new Date("2026-11-10T12:00:00Z");
const past = new Date("2026-11-03T00:00:00Z");

describe("TeamUp-billed member: no derived debt in memory either", () => {
  it("a past nextDueAt does not make a TeamUp-billed member overdue", () => {
    const m = { paymentStatus: "paid", nextDueAt: past, stripeSubscriptionId: null, billedBy: "teamup" };
    expect(isOverdue(m, now)).toBe(false);
    expect(shownPaymentStatus(m, now)).toBe("paid");
  });
  it("the same row billed by MatFlow is overdue (the rule still bites where it should)", () => {
    const m = { paymentStatus: "paid", nextDueAt: past, stripeSubscriptionId: null, billedBy: "matflow" };
    expect(isOverdue(m, now)).toBe(true);
  });
});

import { membershipTierWrite } from "@/lib/membership-tier";

describe("attaching a tier to a TeamUp-billed member seeds no due date", () => {
  const tier = { id: "t1", name: "Adults Advanced 2026", billingCycle: "monthly" };
  it("teamup: tier columns only, no nextDueAt", () => {
    const cols = membershipTierWrite(tier, { currentNextDueAt: null, billedBy: "teamup", now: new Date("2026-10-03T09:00:00Z") });
    expect(cols).toEqual({ membershipTierId: "t1", membershipType: "Adults Advanced 2026" });
  });
  it("matflow: the first due date is still seeded", () => {
    const cols = membershipTierWrite(tier, { currentNextDueAt: null, billedBy: "matflow", now: new Date("2026-10-03T09:00:00Z") });
    expect(cols.nextDueAt).toBeInstanceOf(Date);
  });
});
