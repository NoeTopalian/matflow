// T7 (Sean note 5): the rolling window the check-in engine judges with.
// Owner decision 17 Oct 2026: N classes in the M x 7 days ending at the start
// of the session being attended, in the club's clock; several in one week are
// fine while the rolling total stays within N. Pure; no database.
import { describe, it, expect } from "vitest";
import {
  allowanceAskSentence,
  allowanceBookingSentence,
  allowanceUsageText,
  allowanceRefusalSentence,
  allowanceVerdict,
  minuteToLocal,
  nextFreeText,
  nowMinute,
  slotMinute,
  usedInLastWeeks,
  windowUsed,
} from "@/lib/class-allowance";

/** A session on a calendar date at a wall-clock time, stored as the cron stores it (00:00Z marker). */
const at = (date: string, time: string) => slotMinute({ date: new Date(`${date}T00:00:00.000Z`), startTime: time });
const FOUR_IN_FOUR = { limit: 4, weeks: 4 };

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

describe("the rolling window", () => {
  it("allows several classes in one week while the rolling total stays within N", () => {
    const visits = [at("2026-10-12", "18:00"), at("2026-10-13", "18:00"), at("2026-10-14", "18:00")];
    const v = allowanceVerdict(FOUR_IN_FOUR, at("2026-10-15", "18:00"), visits);
    expect(v).toMatchObject({ used: 3, limit: 4, weeks: 4, exhausted: false, nextFree: null });
  });

  it("refuses the fifth class inside 4 weeks and says when the next frees up", () => {
    const visits = [
      at("2026-10-05", "18:00"),
      at("2026-10-12", "07:00"),
      at("2026-10-12", "18:00"),
      at("2026-10-14", "18:00"),
    ];
    const v = allowanceVerdict(FOUR_IN_FOUR, at("2026-10-19", "18:00"), visits);
    expect(v.used).toBe(4);
    expect(v.exhausted).toBe(true);
    // The oldest visit (5 Oct 18:00) leaves the window exactly 4 weeks later.
    expect(v.nextFree).toEqual({ date: "2026-11-02", time: "18:00" });
  });

  it("is half-open: the session exactly M weeks earlier at the same time has dropped out (weekly trainer admitted every week)", () => {
    const mondays = ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"].map((d) => at(d, "18:00"));
    expect(windowUsed(FOUR_IN_FOUR, at("2026-10-19", "18:00"), mondays)).toBe(3);
    expect(allowanceVerdict(FOUR_IN_FOUR, at("2026-10-19", "18:00"), mondays).exhausted).toBe(false);
  });

  it("counts a class starting at the same minute (two classes at once cannot both take the last place)", () => {
    const one = { limit: 1, weeks: 1 };
    expect(allowanceVerdict(one, at("2026-10-19", "18:00"), [at("2026-10-19", "18:00")]).exhausted).toBe(true);
  });

  it("is measured on the wall clock, so the March clock change does not make a weekly class count twice", () => {
    // 29 Mar 2027 is the Monday after the UK clocks go forward (28 Mar 2027).
    const before = ["2027-03-08", "2027-03-15", "2027-03-22"].map((d) => at(d, "18:00"));
    const first = at("2027-03-01", "18:00");
    const v = allowanceVerdict(FOUR_IN_FOUR, at("2027-03-29", "18:00"), [first, ...before]);
    expect(v.used).toBe(3);
    expect(v.exhausted).toBe(false);
  });

  it("judges every window containing the session, so recording a later class first cannot over-admit", () => {
    // Limit 1 a week. The evening class was recorded first (a staff mark);
    // the morning class the same day must not then pass on the window ending
    // at its own start, which does not reach the evening.
    const one = { limit: 1, weeks: 1 };
    const v = allowanceVerdict(one, at("2026-10-19", "07:00"), [at("2026-10-19", "18:00")]);
    expect(v.used).toBe(1);
    expect(v.exhausted).toBe(true);
    // Free again once the evening class is a week old: from the following Monday 18:00.
    expect(v.nextFree).toEqual({ date: "2026-10-26", time: "18:00" });
  });

  it("reads a legacy weekly allowance (maxClassesPerWeek) as N per 7 days", () => {
    const weekly = { limit: 2, weeks: 1 };
    const visits = [at("2026-10-13", "18:00"), at("2026-10-15", "18:00")];
    expect(allowanceVerdict(weekly, at("2026-10-19", "18:00"), visits).exhausted).toBe(true);
    expect(allowanceVerdict(weekly, at("2026-10-20", "18:00"), visits).exhausted).toBe(false);
  });

  it("reports more than N used truthfully when staff admitted past it or the limit was lowered", () => {
    const visits = [1, 2, 3, 4, 5].map((d) => at(`2026-10-1${d}`, "18:00"));
    expect(allowanceVerdict(FOUR_IN_FOUR, at("2026-10-16", "18:00"), visits).used).toBe(5);
  });
});

describe("usedInLastWeeks (the member portal line)", () => {
  it("counts the window ending now and ignores sessions still to come", () => {
    const visits = [at("2026-09-01", "18:00"), at("2026-10-05", "18:00"), at("2026-10-14", "18:00"), at("2026-10-20", "18:00")];
    const now = at("2026-10-17", "12:00");
    expect(usedInLastWeeks(FOUR_IN_FOUR, now, visits)).toBe(2);
  });
});

describe("the copy", () => {
  const facts = { used: 4, limit: 4, weeks: 4, nextFree: { date: "2026-11-02", time: "18:00" } };

  it("names the date the next class frees up", () => {
    expect(nextFreeText({ date: "2026-11-02", time: "18:00" })).toBe("Monday 2 November from 18:00");
  });

  it("the member app, kiosk and booking refusal", () => {
    expect(allowanceRefusalSentence(facts)).toBe(
      "4 of 4 classes used in the last 4 weeks; next free on Monday 2 November from 18:00. Ask staff if you need to train before then.",
    );
    expect(allowanceRefusalSentence({ used: 1, limit: 1, weeks: 1, nextFree: null })).toBe(
      "1 of 1 class used in the last week. Ask staff if you need to train.",
    );
  });

  it("the staff question", () => {
    expect(allowanceAskSentence("Ava Green", facts)).toBe(
      "Ava Green has used 4 of 4 classes in the last 4 weeks (next free on Monday 2 November from 18:00). Admit anyway?",
    );
  });
});

describe("review fixes (17 Oct 2026): the window copy and the portal count", () => {
  const one = { limit: 1, weeks: 1 };

  it("an out-of-order judgement is flagged around, and worded within W weeks of this class, not in the last W weeks", () => {
    const v = allowanceVerdict(one, at("2026-10-19", "07:00"), [at("2026-10-19", "18:00")]);
    expect(v.around).toBe(true);
    expect(allowanceRefusalSentence(v)).toBe(
      "1 of 1 class used within 1 week of this class; next free on Monday 26 October from 18:00. Ask staff if you need to train before then.",
    );
    expect(allowanceAskSentence("Ava Green", v)).toBe(
      "Ava Green has used 1 of 1 class within 1 week of this class (next free on Monday 26 October from 18:00). Admit anyway?",
    );
  });

  it("an in-order judgement is not flagged around", () => {
    const v = allowanceVerdict(one, at("2026-10-19", "18:00"), [at("2026-10-19", "07:00")]);
    expect(v.exhausted).toBe(true);
    expect(v.around).toBeUndefined();
  });

  it("past the allowance the copy never reads 6 of 4", () => {
    const facts = { used: 6, limit: 4, weeks: 4, nextFree: null };
    expect(allowanceUsageText(6, { limit: 4, weeks: 4 })).toBe("4 of 4 classes used in the last 4 weeks (6 recorded)");
    expect(allowanceRefusalSentence(facts)).toBe("4 of 4 classes used in the last 4 weeks (6 recorded). Ask staff if you need to train.");
    expect(allowanceAskSentence("Ava Green", facts)).toBe("Ava Green has used all 4 classes in the last 4 weeks (6 recorded). Admit anyway?");
    expect(allowanceAskSentence("Ava Green", { used: 3, limit: 1, weeks: 1, nextFree: { date: "2026-11-02", time: "18:00" } })).toBe(
      "Ava Green has used their 1 class in the last week (3 recorded; next free on Monday 2 November from 18:00). Admit anyway?",
    );
  });

  it("a parent checking in a child is told whose allowance it is", () => {
    expect(allowanceRefusalSentence({ used: 4, limit: 4, weeks: 4, nextFree: { date: "2026-11-02", time: "18:00" } }, "Sam")).toBe(
      "Sam: 4 of 4 classes used in the last 4 weeks; next free on Monday 2 November from 18:00. Ask staff if Sam needs to train before then.",
    );
  });

  it("booking has its own tail", () => {
    expect(allowanceBookingSentence({ used: 4, limit: 4, weeks: 4, nextFree: { date: "2026-11-02", time: "18:00" } })).toBe(
      "4 of 4 classes used in the last 4 weeks; you can book a session starting on or after Monday 2 November at 18:00.",
    );
    expect(allowanceBookingSentence({ used: 1, limit: 1, weeks: 1, nextFree: null })).toBe(
      "1 of 1 class used in the last week. Ask staff before booking more classes.",
    );
  });

  it("the portal counts a class checked into before it starts (17:35 for the 18:00 class)", () => {
    const visits = [at("2026-10-05", "18:00"), at("2026-10-14", "18:00"), at("2026-10-17", "18:00")];
    expect(usedInLastWeeks(FOUR_IN_FOUR, at("2026-10-17", "17:35"), visits)).toBe(3);
  });

  it("the portal moves its window end to that visit, as the next check-in will (an old visit drops out)", () => {
    // 19 Sep 17:50 is inside the 4 weeks before now (17 Oct 17:35) but not
    // inside the 4 weeks before tonight's 18:00 class.
    const visits = [at("2026-09-19", "17:50"), at("2026-10-17", "18:00")];
    expect(usedInLastWeeks(FOUR_IN_FOUR, at("2026-10-17", "17:35"), visits)).toBe(1);
  });

  it("the portal still ignores sessions on later days", () => {
    const visits = [at("2026-10-14", "18:00"), at("2026-10-18", "10:00")];
    expect(usedInLastWeeks(FOUR_IN_FOUR, at("2026-10-17", "17:35"), visits)).toBe(1);
  });
});
