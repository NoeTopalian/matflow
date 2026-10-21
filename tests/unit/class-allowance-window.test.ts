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
  countInPeriod,
  currentPeriodUsage,
  dateMinute,
  dateText,
  lastDayText,
  minuteToLocal,
  nowMinute,
  periodContaining,
  slotMinute,
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
      sentence: "Attend up to 4 classes during each 4-week period. Your next reset is Tuesday 17 November 2026.",
      period: "The current period runs Tuesday 20 October to Monday 16 November 2026.",
      nextReset: "2026-11-17",
    });
    expect(allowanceSummary(WEEKLY, now).sentence).toBe("Attend up to 3 classes during each week. Your next reset is Monday 26 October 2026.");
    expect(allowanceSummary(MONTHLY, now).sentence).toBe("Attend up to 8 classes during each calendar month. Your next reset is Sunday 1 November 2026.");
    expect(allowanceSummary({ limit: 1, basis: "week" }, now).sentence).toMatch(/^Attend up to 1 class during each week\./);
  });

  it("Unlimited has no period", () => {
    expect(allowanceSummary(null, now)).toEqual({ sentence: expect.stringMatching(/^Unlimited classes\./), period: null, nextReset: null });
  });
});
