// T7 (Sean note 5): the period the check-in engine judges with. Product
// decision 20 Oct 2026: N classes per EXPLICIT period — each calendar week
// (Monday start), each calendar month, or every N weeks from a plan-level start
// date — never a rolling window. A class is judged against the period that
// contains it, half-open [start, end), on the club's wall clock. Pure; no database.
import { describe, it, expect } from "vitest";
import {
  allowanceAskSentence,
  allowanceBookingNotice,
  allowanceCountPhrase,
  allowanceRefusalSentence,
  allowanceSummary,
  allowanceUsageText,
  allowanceVerdict,
  withMemberBillingPeriod,
  billingPeriodContaining,
  BillingPeriodUnknown,
  periodContaining,
  classLimitText,
  countInPeriod,
  currentPeriodUsage,
  dateMinute,
  dateText,
  lastDayText,
  minuteToLocal,
  nowMinute,
  slotMinute,
  type BillingPeriodAnchor,
  type ClassAllowance,
} from "@/lib/class-allowance";

/** A session on a calendar date at a wall-clock time, stored as the cron stores it (00:00Z marker). */
const at = (date: string, time: string) => slotMinute({ date: new Date(`${date}T00:00:00.000Z`), startTime: time });
const local = (minute: number) => minuteToLocal(minute).date;

const WEEKLY: ClassAllowance = { limit: 3, basis: "week" };
const MONTHLY: ClassAllowance = { limit: 8, basis: "month" };
// Four every four weeks, periods counted from Tuesday 20 October 2026.
const FOUR_IN_FOUR: ClassAllowance = { limit: 4, basis: "weeks", weeks: 4, anchor: "2026-10-20" };

describe("slotMinute (the club's wall clock)", () => {
  it("reads every spelling of one calendar date as that date (00:00Z, 23:00Z the day before, 16:00Z the day before)", () => {
    const cron = slotMinute({ date: new Date("2026-10-19T00:00:00.000Z"), startTime: "18:00" });
    const bstLaptop = slotMinute({ date: new Date("2026-10-18T23:00:00.000Z"), startTime: "18:00" });
    const baliLaptop = slotMinute({ date: new Date("2026-10-18T16:00:00.000Z"), startTime: "18:00" });
    expect(bstLaptop).toBe(cron);
    expect(baliLaptop).toBe(cron);
    expect(minuteToLocal(cron)).toEqual({ date: "2026-10-19", time: "18:00" });
  });

  it("puts now on the same scale, in the club's zone (BST is UTC+1 in October)", () => {
    const now = new Date("2026-10-17T17:30:00.000Z");
    expect(minuteToLocal(nowMinute(now, "Europe/London"))).toEqual({ date: "2026-10-17", time: "18:30" });
  });
});

describe("periodContaining", () => {
  it("each week runs Monday 00:00 to the next Monday 00:00 (Sunday 25 October is still the week of Monday 19 October)", () => {
    const p = periodContaining(WEEKLY, at("2026-10-25", "23:59"));
    expect([local(p.start), local(p.end)]).toEqual(["2026-10-19", "2026-10-26"]);
    const q = periodContaining(WEEKLY, at("2026-10-26", "00:00"));
    expect(local(q.start)).toBe("2026-10-26");
  });

  it("each month runs the 1st to the next 1st, year end and leap day included", () => {
    const p = periodContaining(MONTHLY, at("2026-12-31", "20:00"));
    expect([local(p.start), local(p.end)]).toEqual(["2026-12-01", "2027-01-01"]);
    const feb = periodContaining(MONTHLY, at("2028-02-29", "09:00"));
    expect([local(feb.start), local(feb.end)]).toEqual(["2028-02-01", "2028-03-01"]);
  });

  it("every N weeks counts from the plan's start date: 20 Oct → 17 Nov → 15 Dec", () => {
    const p1 = periodContaining(FOUR_IN_FOUR, at("2026-11-16", "18:00"));
    expect([local(p1.start), local(p1.end)]).toEqual(["2026-10-20", "2026-11-17"]);
    const p2 = periodContaining(FOUR_IN_FOUR, at("2026-11-17", "06:00"));
    expect([local(p2.start), local(p2.end)]).toEqual(["2026-11-17", "2026-12-15"]);
  });

  it("a class before the start date still falls in a period (the one ending at the start date), so nothing is unjudged", () => {
    const p = periodContaining(FOUR_IN_FOUR, at("2026-10-01", "18:00"));
    expect([local(p.start), local(p.end)]).toEqual(["2026-09-22", "2026-10-20"]);
  });

  it("boundaries are calendar dates, so the March and October clock changes never move them", () => {
    const p = periodContaining(WEEKLY, at("2026-03-29", "10:00")); // clocks go forward 29 March 2026
    expect([local(p.start), local(p.end)]).toEqual(["2026-03-23", "2026-03-30"]);
    expect(dateMinute("2026-03-30") - dateMinute("2026-03-23")).toBe(7 * 1440);
  });
});

describe("allowanceVerdict (the period containing the session)", () => {
  it("allows several classes in one week while the period total stays within N", () => {
    const visits = [at("2026-10-20", "18:00"), at("2026-10-21", "18:00"), at("2026-10-22", "18:00")];
    const v = allowanceVerdict(FOUR_IN_FOUR, at("2026-10-23", "18:00"), visits);
    expect(v).toMatchObject({ used: 3, limit: 4, basis: "weeks", weeks: 4, exhausted: false, resetsOn: "2026-11-17" });
    expect(v.period).toEqual({ start: "2026-10-20", end: "2026-11-17" });
  });

  it("refuses the fifth class inside the period and names the reset date", () => {
    const visits = [at("2026-10-20", "18:00"), at("2026-10-21", "18:00"), at("2026-10-22", "18:00"), at("2026-11-10", "18:00")];
    const v = allowanceVerdict(FOUR_IN_FOUR, at("2026-11-16", "18:00"), visits);
    expect(v.exhausted).toBe(true);
    expect(v.resetsOn).toBe("2026-11-17");
    expect(allowanceRefusalSentence(v)).toBe(
      "4 of 4 classes used this 4-week period; it resets on Tuesday 17 November. Ask staff if you need to train before then.",
    );
  });

  it("resets on the period boundary: the first class of the next period sees 0 used", () => {
    const visits = [at("2026-10-20", "18:00"), at("2026-10-21", "18:00"), at("2026-10-22", "18:00"), at("2026-11-10", "18:00")];
    expect(allowanceVerdict(FOUR_IN_FOUR, at("2026-11-17", "06:00"), visits).used).toBe(0);
  });

  it("a weekly plan resets every Monday: three classes Mon–Wed, the fourth on Thursday is refused, Monday is free again", () => {
    const visits = [at("2026-10-19", "18:00"), at("2026-10-20", "18:00"), at("2026-10-21", "18:00")];
    expect(allowanceVerdict(WEEKLY, at("2026-10-22", "18:00"), visits)).toMatchObject({ used: 3, exhausted: true, resetsOn: "2026-10-26" });
    expect(allowanceVerdict(WEEKLY, at("2026-10-26", "07:00"), visits)).toMatchObject({ used: 0, exhausted: false, resetsOn: "2026-11-02" });
  });

  it("a monthly plan counts the calendar month whatever the gaps between classes", () => {
    const visits = Array.from({ length: 8 }, (_, i) => at(`2026-11-${String(2 + i * 3).padStart(2, "0")}`, "18:00"));
    expect(allowanceVerdict(MONTHLY, at("2026-11-30", "18:00"), visits)).toMatchObject({ used: 8, exhausted: true, resetsOn: "2026-12-01" });
    expect(allowanceVerdict(MONTHLY, at("2026-12-01", "18:00"), visits).used).toBe(0);
  });

  it("is order-independent: a later class recorded first lands in its own period and cannot over-admit an earlier one", () => {
    // Period 20 Oct–16 Nov already holds 4; a class on 10 Nov is refused however the rows were recorded.
    const visits = [at("2026-11-15", "18:00"), at("2026-11-14", "18:00"), at("2026-10-20", "18:00"), at("2026-10-21", "18:00")];
    expect(allowanceVerdict(FOUR_IN_FOUR, at("2026-11-10", "18:00"), visits).exhausted).toBe(true);
    // And a class in the NEXT period is unaffected by all of them.
    expect(allowanceVerdict(FOUR_IN_FOUR, at("2026-11-18", "18:00"), visits).used).toBe(0);
  });

  it("a reversed visit restores the allowance for its own period, never the current one (the count is the rows)", () => {
    const before = [at("2026-10-20", "18:00"), at("2026-10-21", "18:00"), at("2026-10-22", "18:00"), at("2026-10-23", "18:00")];
    expect(allowanceVerdict(FOUR_IN_FOUR, at("2026-11-02", "18:00"), before).exhausted).toBe(true);
    const afterUnmark = before.filter((v) => v !== at("2026-10-22", "18:00"));
    expect(allowanceVerdict(FOUR_IN_FOUR, at("2026-11-02", "18:00"), afterUnmark)).toMatchObject({ used: 3, exhausted: false });
  });

  it("reports more than N used truthfully when staff admitted past it or the limit was lowered, and never reads 6 of 4", () => {
    const visits = Array.from({ length: 6 }, (_, i) => at(`2026-10-2${i}`, "18:00"));
    const v = allowanceVerdict(FOUR_IN_FOUR, at("2026-10-27", "18:00"), visits);
    expect(v.used).toBe(6);
    expect(allowanceCountPhrase(v)).toBe("4 of 4 classes used this 4-week period (6 recorded)");
  });

  it("countInPeriod is half-open at the end", () => {
    const p = periodContaining(WEEKLY, at("2026-10-19", "10:00"));
    expect(countInPeriod([at("2026-10-26", "00:00"), at("2026-10-25", "23:59"), at("2026-10-19", "00:00")], p)).toBe(2);
  });
});

describe("currentPeriodUsage (the member portal line)", () => {
  it("counts the period containing now, including a class later today that is already recorded", () => {
    const now = at("2026-10-21", "17:35");
    const visits = [at("2026-10-20", "18:00"), at("2026-10-21", "18:00")];
    const v = currentPeriodUsage(FOUR_IN_FOUR, now, visits);
    expect(v).toMatchObject({ used: 2, limit: 4, resetsOn: "2026-11-17" });
    expect(allowanceUsageText(v)).toBe("2 of 4 classes used this 4-week period — resets Tuesday 17 November");
  });

  it("ignores visits in other periods", () => {
    const v = currentPeriodUsage(WEEKLY, at("2026-10-28", "12:00"), [at("2026-10-19", "18:00"), at("2026-11-02", "18:00")]);
    expect(v.used).toBe(0);
  });
});

describe("the copy", () => {
  const v = allowanceVerdict(FOUR_IN_FOUR, at("2026-11-16", "18:00"), [at("2026-10-20", "18:00"), at("2026-10-21", "18:00"), at("2026-10-22", "18:00"), at("2026-11-10", "18:00")]);

  it("dates read as weekday, day and month, with the year on request", () => {
    expect(dateText("2026-11-17")).toBe("Tuesday 17 November");
    expect(dateText("2026-11-17", true)).toBe("Tuesday 17 November 2026");
    expect(lastDayText("2026-11-17")).toBe("Monday 16 November");
  });

  it("a parent checking in a child is told whose allowance it is", () => {
    expect(allowanceRefusalSentence(v, "Sam")).toBe(
      "Sam: 4 of 4 classes used this 4-week period; it resets on Tuesday 17 November. Ask staff if Sam needs to train before then.",
    );
  });

  it("booking is never refused for the allowance: the notice says what happens at the door", () => {
    expect(allowanceBookingNotice(v)).toBe(
      "4 of 4 classes used this 4-week period. Booking doesn't use a class, but checking in before Tuesday 17 November will need a class-pack credit or staff to admit you.",
    );
  });

  it("the staff question", () => {
    expect(allowanceAskSentence("Jordan", v)).toBe("Jordan has used 4 of 4 classes this 4-week period (resets on Tuesday 17 November). Admit anyway?");
    expect(allowanceAskSentence("Jordan", { ...v, used: 6 })).toBe("Jordan has used all 4 classes this 4-week period (6 recorded; resets on Tuesday 17 November). Admit anyway?");
    const weekly = allowanceVerdict(WEEKLY, at("2026-10-22", "18:00"), [at("2026-10-19", "18:00"), at("2026-10-20", "18:00"), at("2026-10-21", "18:00")]);
    expect(allowanceAskSentence("Jordan", weekly)).toBe("Jordan has used 3 of 3 classes this week (resets on Monday 26 October). Admit anyway?");
  });

  it("a monthly plan says this month", () => {
    const m = allowanceVerdict(MONTHLY, at("2026-11-05", "18:00"), [at("2026-11-02", "18:00")]);
    expect(allowanceUsageText(m)).toBe("1 of 8 classes used this month — resets Tuesday 1 December");
  });
});

describe("allowanceSummary (what the plan editor shows before saving)", () => {
  const now = at("2026-10-21", "15:00");

  it("states the allowance in plain words with the next reset and the actual period dates", () => {
    expect(allowanceSummary(FOUR_IN_FOUR, now)).toEqual({
      sentence: "Attend up to 4 classes during each 4-week period. The next reset is Tuesday 17 November 2026.",
      period: "The current period runs Tuesday 20 October to Monday 16 November 2026.",
      nextReset: "2026-11-17",
    });
    expect(allowanceSummary(WEEKLY, now).sentence).toBe("Attend up to 3 classes during each week. The next reset is Monday 26 October 2026.");
    expect(allowanceSummary(MONTHLY, now).sentence).toBe("Attend up to 8 classes during each calendar month. The next reset is Sunday 1 November 2026.");
    expect(allowanceSummary({ limit: 1, basis: "week" }, now).sentence).toMatch(/^Attend up to 1 class during each week\./);
  });

  it("Unlimited has no period", () => {
    expect(allowanceSummary(null, now)).toEqual({ sentence: expect.stringMatching(/^Unlimited classes\./), period: null, nextReset: null });
  });
});

describe("historical periods are named, never called \"this\" (review gap 5)", () => {
  // Four visits in 28 Sep – 26 Oct; a session in that period judged in November.
  const visits = ["2026-10-05", "2026-10-12", "2026-10-14", "2026-10-15"].map((d) => at(d, "18:00"));
  const nowNov = at("2026-11-03", "12:00");

  it("allowanceVerdict reports whether the judged period is the current one", () => {
    const past = allowanceVerdict(FOUR_IN_FOUR, at("2026-10-19", "18:00"), visits, nowNov);
    expect(past.current).toBe(false);
    const current = allowanceVerdict(FOUR_IN_FOUR, at("2026-11-03", "18:00"), visits, nowNov);
    expect(current.current).toBe(true);
    expect(allowanceVerdict(FOUR_IN_FOUR, at("2026-10-19", "18:00"), visits)).not.toHaveProperty("current");
  });

  it("every-N-weeks: the period is named from its start date", () => {
    const past = allowanceVerdict(FOUR_IN_FOUR, at("2026-10-19", "18:00"), visits, nowNov);
    expect(allowanceCountPhrase(past)).toBe("4 of 4 classes used the 4-week period from Tuesday 22 September");
    expect(allowanceAskSentence("Ava Green", past)).toBe(
      "Ava Green has used 4 of 4 classes the 4-week period from Tuesday 22 September (resets on Tuesday 20 October). Admit anyway?",
    );
  });

  it("week: the week of its Monday; month: the month by name", () => {
    const week = allowanceVerdict({ limit: 2, basis: "week" }, at("2026-10-14", "18:00"), [at("2026-10-12", "18:00"), at("2026-10-13", "18:00")], nowNov);
    expect(allowanceCountPhrase(week)).toBe("2 of 2 classes used the week of Monday 12 October");
    const month = allowanceVerdict({ limit: 1, basis: "month" }, at("2026-10-14", "18:00"), [at("2026-10-02", "18:00")], nowNov);
    expect(allowanceCountPhrase(month)).toBe("1 of 1 class used October 2026");
  });

  it("the current period still reads \"this\"", () => {
    const current = allowanceVerdict(FOUR_IN_FOUR, at("2026-11-03", "18:00"), visits, nowNov);
    expect(allowanceCountPhrase(current)).toBe("0 of 4 classes used this 4-week period");
  });
});

describe("per member's billing period (owner scope, 21 Oct 2026; review round 3)", () => {
  const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const tier = { limit: 4, basis: "billing" as const };
  const LONDON = "Europe/London";
  const live = (over: object) => ({ stripeSubscriptionId: "sub_1", ...over });

  it("a live Stripe member: the stated period's END is the anchor and its own length is the recurrence, stepped forwards and backwards contiguously", () => {
    const a = withMemberBillingPeriod(tier, live({ billingPeriodStart: D("2026-09-28"), billingPeriodEnd: D("2026-10-26"), billingCycle: "monthly" }), LONDON)!;
    // 28 days: four-weekly recurrence, whatever the tier says (M-2).
    expect(periodContaining(a, at("2026-10-19", "18:00"))).toEqual({ start: dateMinute("2026-09-28"), end: dateMinute("2026-10-26") });
    expect(periodContaining(a, at("2026-11-02", "18:00"))).toEqual({ start: dateMinute("2026-10-26"), end: dateMinute("2026-11-23") });
    expect(periodContaining(a, at("2026-09-01", "18:00"))).toEqual({ start: dateMinute("2026-08-31"), end: dateMinute("2026-09-28") });
    // The session on 27 Oct (the round-3 M-2 case) is in the period that starts 26 Oct.
    expect(periodContaining(a, at("2026-10-27", "07:00")).start).toBe(dateMinute("2026-10-26"));
  });

  it("monthly periods are contiguous for anchors on the 28th, 29th, 30th and 31st across February (M-1)", () => {
    for (const anchor of ["2026-01-28", "2026-01-29", "2026-01-30", "2026-01-31"]) {
      const a: BillingPeriodAnchor = { anchor, stepMonths: 1 };
      let prev = billingPeriodContaining(a, at("2025-12-15", "12:00"))!;
      for (const day of ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15", "2026-05-15"]) {
        const p = billingPeriodContaining(a, at(day, "12:00"))!;
        expect(p.start).toBe(prev.end);
        prev = p;
      }
    }
    // Stripe-like anchor on the 28th: 28 Jan → 28 Feb → 28 Mar (never the 31st).
    const a28: BillingPeriodAnchor = { anchor: "2026-02-28", stepMonths: 1 };
    expect(minuteToLocal(billingPeriodContaining(a28, at("2026-03-10", "12:00"))!.end).date).toBe("2026-03-28");
    // Anchor on the 31st: 28 Feb in a non-leap year, 31 Mar again.
    const a31: BillingPeriodAnchor = { anchor: "2026-01-31", stepMonths: 1 };
    expect(minuteToLocal(billingPeriodContaining(a31, at("2026-02-10", "12:00"))!.end).date).toBe("2026-02-28");
    expect(minuteToLocal(billingPeriodContaining(a31, at("2026-03-10", "12:00"))!.end).date).toBe("2026-03-31");
  });

  it("the renewal day belongs to the NEW period (desk member, monthly, due on the 30th)", () => {
    const a = withMemberBillingPeriod(tier, { nextDueAt: D("2026-03-30"), billingCycle: "monthly" }, LONDON)!;
    expect(periodContaining(a, at("2026-03-29", "18:00"))).toEqual({ start: dateMinute("2026-02-28"), end: dateMinute("2026-03-30") });
    expect(periodContaining(a, at("2026-03-30", "07:00"))).toEqual({ start: dateMinute("2026-03-30"), end: dateMinute("2026-04-30") });
  });

  it("a desk member: the period ends on the next due date, recurring by the tier's cycle (four-weekly = 28 days)", () => {
    const fw = withMemberBillingPeriod(tier, { nextDueAt: D("2026-11-02"), billingCycle: "four_weekly" }, LONDON)!;
    expect(periodContaining(fw, at("2026-10-19", "18:00"))).toEqual({ start: dateMinute("2026-10-05"), end: dateMinute("2026-11-02") });
    expect(periodContaining(fw, at("2026-11-02", "06:00"))).toEqual({ start: dateMinute("2026-11-02"), end: dateMinute("2026-11-30") });
  });

  it("Stripe instants land on the club's calendar date: a boundary at 00:30 BST (23:30Z the day before) and a mid-day boundary both reset at local midnight (M-3)", () => {
    const a = withMemberBillingPeriod(tier, live({ billingPeriodStart: new Date("2026-06-20T23:30:00.000Z"), billingPeriodEnd: new Date("2026-07-20T23:30:00.000Z") }), LONDON)!;
    const p = periodContaining(a, at("2026-07-21", "07:00"));
    // 21 Jul 00:30 BST is the renewal day: the 07:00 class on the 21st is in the NEW period, resetting on 21 Aug.
    expect(minuteToLocal(p.start).date).toBe("2026-07-21");
    expect(minuteToLocal(p.end).date).toBe("2026-08-21");
    const mid = withMemberBillingPeriod(tier, live({ billingPeriodStart: new Date("2026-09-28T14:32:00.000Z"), billingPeriodEnd: new Date("2026-10-26T14:32:00.000Z") }), LONDON)!;
    expect(periodContaining(mid, at("2026-10-26", "07:00")).start).toBe(dateMinute("2026-10-26"));
    expect(periodContaining(mid, at("2026-10-25", "23:45")).end).toBe(dateMinute("2026-10-26"));
  });

  it("who bills decides the source: a live Stripe member ignores nextDueAt and is unknown without a stored period; an ended subscription's period is ignored (M-5)", () => {
    expect(withMemberBillingPeriod(tier, live({ nextDueAt: D("2026-11-02"), billingCycle: "four_weekly" }), LONDON)).toBeNull();
    const ended = withMemberBillingPeriod(tier, { stripeSubscriptionId: null, billingPeriodStart: D("2026-01-01"), billingPeriodEnd: D("2026-02-01"), nextDueAt: D("2026-11-02"), billingCycle: "four_weekly" }, LONDON)!;
    expect(periodContaining(ended, at("2026-10-19", "18:00")).end).toBe(dateMinute("2026-11-02"));
    expect(withMemberBillingPeriod(tier, { billingCycle: "four_weekly" }, LONDON)).toBeNull();
    expect(withMemberBillingPeriod(tier, { nextDueAt: D("2026-11-02"), billingCycle: "none" }, LONDON)).toBeNull();
    expect(withMemberBillingPeriod(FOUR_IN_FOUR, { billingCycle: "four_weekly" }, LONDON)).toBe(FOUR_IN_FOUR);
    expect(withMemberBillingPeriod(null, {}, LONDON)).toBeNull();
    expect(() => periodContaining(tier, at("2026-10-19", "18:00"))).toThrow(/member's period/);
  });

  it("an annual Stripe period recurs yearly; a 10-day one literally", () => {
    const year = withMemberBillingPeriod(tier, live({ billingPeriodStart: D("2026-01-10"), billingPeriodEnd: D("2027-01-10") }), LONDON)!;
    expect(periodContaining(year, at("2026-11-15", "18:00"))).toEqual({ start: dateMinute("2026-01-10"), end: dateMinute("2027-01-10") });
    expect(periodContaining(year, at("2027-03-01", "18:00")).end).toBe(dateMinute("2028-01-10"));
    const odd = withMemberBillingPeriod(tier, live({ billingPeriodStart: D("2026-10-01"), billingPeriodEnd: D("2026-10-11") }), LONDON)!;
    expect(periodContaining(odd, at("2026-10-25", "18:00"))).toEqual({ start: dateMinute("2026-10-21"), end: dateMinute("2026-10-31") });
  });

  it("the plan reads '4 each billing period' and the editor summary says there is no shared reset date", () => {
    expect(classLimitText(tier)).toBe("4 each billing period");
    const s = allowanceSummary(tier, at("2026-10-21", "12:00"));
    expect(s.sentence).toMatch(/^Attend up to 4 classes during each member's own billing period/);
    expect(s.nextReset).toBeNull();
    expect(s.period).toMatch(/no renewal date recorded/);
  });

  it("copy for a member whose period is unknown: refusal, question, booking notice, portal line", () => {
    const v = { used: 0, limit: 4, basis: "billing" as const, periodUnknown: true as const };
    expect(allowanceRefusalSentence(v)).toBe("Your plan counts classes per billing period, but no renewal date is recorded for you. Ask staff.");
    expect(allowanceRefusalSentence(v, "Sam")).toBe("Sam's plan counts classes per billing period, but no renewal date is recorded for Sam. Ask staff.");
    expect(allowanceAskSentence("Ava Green", v)).toBe("No renewal date is recorded for Ava Green, so their 4 classes per billing period can't be counted. Admit anyway?");
    expect(allowanceBookingNotice(v)).toMatch(/^Your plan counts classes per billing period, but no renewal date is recorded for you\. Ask staff\. Booking doesn't use a class/);
    expect(allowanceUsageText(v)).toBe("Your plan allows 4 classes per billing period, but no renewal date is recorded for you — ask staff");
  });

  it("R4-M1: a Stripe period 31 Jan → 28 Feb keeps the 31st: the stored period is returned verbatim and the next ends 31 Mar, then 30 Apr", () => {
    const a = withMemberBillingPeriod(tier, live({ billingPeriodStart: D("2026-01-31"), billingPeriodEnd: D("2026-02-28") }), LONDON)!;
    expect(a.basis === "billing" ? a.member : null).toMatchObject({ anchor: "2026-02-28", anchorDay: 31, stepMonths: 1 });
    expect(periodContaining(a, at("2026-02-10", "12:00"))).toEqual({ start: dateMinute("2026-01-31"), end: dateMinute("2026-02-28") });
    expect(periodContaining(a, at("2026-03-10", "12:00"))).toEqual({ start: dateMinute("2026-02-28"), end: dateMinute("2026-03-31") });
    expect(periodContaining(a, at("2026-04-10", "12:00"))).toEqual({ start: dateMinute("2026-03-31"), end: dateMinute("2026-04-30") });
    expect(periodContaining(a, at("2025-12-31", "12:00"))).toEqual({ start: dateMinute("2025-12-31"), end: dateMinute("2026-01-31") });
    // Leap year: 31 Jan 2028 → 29 Feb 2028 (29 days) is also monthly on the 31st.
    const leap = withMemberBillingPeriod(tier, live({ billingPeriodStart: D("2028-01-31"), billingPeriodEnd: D("2028-02-29") }), LONDON)!;
    expect(periodContaining(leap, at("2028-03-10", "12:00")).end).toBe(dateMinute("2028-03-31"));
    // 30 Jan → 28 Feb keeps the 30th.
    const d30 = withMemberBillingPeriod(tier, live({ billingPeriodStart: D("2026-01-30"), billingPeriodEnd: D("2026-02-28") }), LONDON)!;
    expect(periodContaining(d30, at("2026-03-10", "12:00")).end).toBe(dateMinute("2026-03-30"));
  });

  it("R4-M1: a desk member due on a month end stays on month ends (lib/overdue.ts): 28 Feb → 31 Mar → 30 Apr; due on the 30th stays the 30th", () => {
    const feb = withMemberBillingPeriod(tier, { nextDueAt: D("2026-02-28"), billingCycle: "monthly" }, LONDON)!;
    expect(periodContaining(feb, at("2026-03-10", "12:00"))).toEqual({ start: dateMinute("2026-02-28"), end: dateMinute("2026-03-31") });
    expect(periodContaining(feb, at("2026-04-10", "12:00"))).toEqual({ start: dateMinute("2026-03-31"), end: dateMinute("2026-04-30") });
    expect(periodContaining(feb, at("2026-02-10", "12:00"))).toEqual({ start: dateMinute("2026-01-31"), end: dateMinute("2026-02-28") });
    const d30 = withMemberBillingPeriod(tier, { nextDueAt: D("2026-04-30"), billingCycle: "monthly" }, LONDON)!;
    // 30 Apr IS April's last day, so overdue.ts advances it to 31 May: mirrored here.
    expect(periodContaining(d30, at("2026-05-10", "12:00")).end).toBe(dateMinute("2026-05-31"));
  });

  it("R4-L1: the recurrence is measured on Stripe's UTC instants across a clock change, and a 28-day period on the same day of the month is February of a monthly plan", () => {
    // 28 Mar → 28 Apr spans the BST change: 31 days on the UTC clock, not 30 days 23 hours.
    const dst = withMemberBillingPeriod(tier, live({ billingPeriodStart: new Date("2026-03-28T10:00:00.000Z"), billingPeriodEnd: new Date("2026-04-28T10:00:00.000Z") }), LONDON)!;
    expect(dst.basis === "billing" ? dst.member : null).toMatchObject({ stepMonths: 1, anchorDay: 28 });
    expect(periodContaining(dst, at("2026-05-10", "12:00")).end).toBe(dateMinute("2026-05-28"));
    // 2 Feb → 2 Mar is 28 days: the same day of the month means monthly, not four-weekly.
    const feb = withMemberBillingPeriod(tier, live({ billingPeriodStart: D("2026-02-02"), billingPeriodEnd: D("2026-03-02") }), LONDON)!;
    expect(feb.basis === "billing" ? feb.member : null).toMatchObject({ stepMonths: 1, anchorDay: 2 });
    expect(periodContaining(feb, at("2026-03-15", "12:00")).end).toBe(dateMinute("2026-04-02"));
    // 28 Sep → 26 Oct is 28 days on different days: four-weekly.
    const fw = withMemberBillingPeriod(tier, live({ billingPeriodStart: D("2026-09-28"), billingPeriodEnd: D("2026-10-26") }), LONDON)!;
    expect(fw.basis === "billing" ? fw.member : null).toMatchObject({ stepDays: 28 });
  });

  it("R4-L3: a session far from the anchor is placed arithmetically (no step cap); an unplaceable session reads as unknown, never a wrong period", () => {
    const a = withMemberBillingPeriod(tier, { nextDueAt: D("2026-11-02"), billingCycle: "four_weekly" }, LONDON)!;
    expect(periodContaining(a, at("2016-01-01", "12:00")).end).toBeLessThanOrEqual(dateMinute("2016-01-29"));
    expect(periodContaining(a, at("2046-06-01", "12:00")).start).toBeGreaterThan(dateMinute("2046-05-04"));
    const monthly = withMemberBillingPeriod(tier, { nextDueAt: D("2026-11-30"), billingCycle: "monthly" }, LONDON)!;
    expect(periodContaining(monthly, at("2019-02-10", "12:00"))).toEqual({ start: dateMinute("2019-01-31"), end: dateMinute("2019-02-28") });
    expect(billingPeriodContaining({ anchor: "2026-11-02", stepDays: 28 }, Number.NaN)).toBeNull();
    expect(billingPeriodContaining({ anchor: "2026-11-02" }, at("2026-10-01", "12:00"))).toBeNull();
    expect(() => periodContaining({ limit: 4, basis: "billing", member: { anchor: "2026-11-02" } }, at("2026-10-01", "12:00"))).toThrow(BillingPeriodUnknown);
  });

  it("R5-L1: a period projected behind the stated one never overlaps it (a 23:30Z boundary across the clock change)", () => {
    // [27 Sep 23:30Z, 25 Oct 23:30Z) is local [28 Sep, 25 Oct): 27 local days on a 28-day step.
    const a = withMemberBillingPeriod(tier, live({ billingPeriodStart: new Date("2026-09-27T23:30:00.000Z"), billingPeriodEnd: new Date("2026-10-25T23:30:00.000Z") }), LONDON)!;
    const before = periodContaining(a, at("2026-09-27", "18:00"));
    expect(before.end).toBe(dateMinute("2026-09-28"));
    expect(before.start).toBeLessThan(before.end);
    expect(periodContaining(a, at("2026-09-28", "07:00"))).toEqual({ start: dateMinute("2026-09-28"), end: dateMinute("2026-10-25") });
    // Monthly on the 31st: [30 Sep 23:30Z, 31 Oct 23:30Z) is local [1 Oct, 31 Oct); 30 Sep ends at 1 Oct.
    const m = withMemberBillingPeriod(tier, live({ billingPeriodStart: new Date("2026-09-30T23:30:00.000Z"), billingPeriodEnd: new Date("2026-10-31T23:30:00.000Z") }), LONDON)!;
    expect(periodContaining(m, at("2026-09-30", "18:00")).end).toBe(dateMinute("2026-10-01"));
  });

  it("copy for a known billing period reads like any other period", () => {
    const a = withMemberBillingPeriod(tier, { nextDueAt: D("2026-11-02"), billingCycle: "four_weekly" }, LONDON)!;
    const v = allowanceVerdict(a, at("2026-10-19", "18:00"), [at("2026-10-05", "18:00"), at("2026-10-12", "07:00"), at("2026-10-12", "18:00"), at("2026-10-14", "18:00")], at("2026-10-21", "12:00"));
    expect(v).toMatchObject({ used: 4, limit: 4, basis: "billing", exhausted: true, period: { start: "2026-10-05", end: "2026-11-02" }, resetsOn: "2026-11-02", current: true });
    expect(allowanceRefusalSentence(v)).toBe("4 of 4 classes used this billing period; it resets on Monday 2 November. Ask staff if you need to train before then.");
  });
});
