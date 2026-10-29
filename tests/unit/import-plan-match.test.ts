// The plan a genuinely new imported person gets (owner rule, 27 Oct 2026):
// assigned only when name, billing period, price and currency agree with one
// active, eligible plan; anything else is imported without a plan and listed.
import { describe, it, expect } from "vitest";
import { PLAN_RESTRICTED_SENTENCE, normaliseCurrency, normalisePeriod, parsePrice, planForNewMember, tallyPlanReview, type PlanTier } from "@/lib/importers/plan-match";
import { parseImport, type MemberDraft } from "@/lib/importers";

const tier = (over: Partial<PlanTier> = {}): PlanTier => ({
  id: "t1", name: "Adults Unlimited", pricePence: 7900, currency: "GBP", billingCycle: "monthly", isActive: true, isKids: false, ...over,
});
const draft = (facts: MemberDraft["planFacts"], over: Partial<MemberDraft> = {}): MemberDraft => ({
  name: "Ann Lee", email: "ann@example.test", membershipType: "Adults Unlimited", accountType: "adult", planFacts: facts, ...over,
});
const FULL = { price: "79.00", period: "monthly", currency: "GBP" };

describe("planForNewMember: all four facts must agree", () => {
  it("assigns the plan when name, period, price and currency agree (documented normalisation)", () => {
    const d = draft({ price: "£79", period: "Every month", currency: "gbp" }, { membershipType: "  adults   UNLIMITED " });
    expect(planForNewMember(d, [tier()], "generic")).toEqual({ kind: "assign", tier: tier() });
  });

  it("four-weekly is not calendar-monthly, in either direction", () => {
    expect(planForNewMember(draft({ ...FULL, period: "every 4 weeks" }), [tier()], "generic")).toMatchObject({ kind: "review", reason: "period_differs" });
    expect(planForNewMember(draft({ ...FULL, period: "monthly" }), [tier({ billingCycle: "four_weekly" })], "generic")).toMatchObject({ kind: "review", reason: "period_differs" });
    expect(planForNewMember(draft({ ...FULL, period: "four-weekly" }), [tier({ billingCycle: "four_weekly" })], "generic").kind).toBe("assign");
  });

  it("a conflicting price is review, never the nearest plan", () => {
    expect(planForNewMember(draft({ ...FULL, price: "75.00" }), [tier()], "generic")).toMatchObject({ kind: "review", reason: "price_differs", label: "Adults Unlimited" });
  });

  it("a missing currency (or price, or period) is review", () => {
    expect(planForNewMember(draft({ price: "79", period: "monthly" }), [tier()], "generic")).toMatchObject({ reason: "missing_currency" });
    expect(planForNewMember(draft({ period: "monthly", currency: "GBP" }), [tier()], "generic")).toMatchObject({ reason: "missing_price" });
    expect(planForNewMember(draft({ price: "79", currency: "GBP" }), [tier()], "generic")).toMatchObject({ reason: "missing_period" });
    expect(planForNewMember(draft(undefined), [tier()], "generic")).toMatchObject({ reason: "missing_period" });
  });

  it("a different currency is review", () => {
    expect(planForNewMember(draft({ ...FULL, currency: "EUR" }), [tier()], "generic")).toMatchObject({ reason: "currency_differs" });
    // A symbol that disagrees with the stated currency is not a plain amount.
    expect(planForNewMember(draft({ ...FULL, price: "€79", currency: "GBP" }), [tier()], "generic")).toMatchObject({ reason: "unreadable_price" });
  });

  it("an inactive plan is review", () => {
    expect(planForNewMember(draft(FULL), [tier({ isActive: false })], "generic")).toMatchObject({ reason: "plan_inactive" });
  });

  it("a plan name two plans share (case or spacing apart) is review, whatever the facts", () => {
    const two = [tier(), tier({ id: "t2", name: "ADULTS  unlimited" })];
    expect(planForNewMember(draft(FULL), two, "generic")).toMatchObject({ reason: "several_plans_with_name" });
  });

  it("no plan of that name is review; no plan named is nothing", () => {
    expect(planForNewMember(draft(FULL, { membershipType: "Open Mat" }), [tier()], "generic")).toMatchObject({ reason: "no_plan_with_name" });
    expect(planForNewMember(draft(FULL, { membershipType: undefined }), [tier()], "generic")).toEqual({ kind: "none" });
  });

  it("discounts and tax notes are not read: review", () => {
    for (const price of ["79 inc VAT", "79.00 (10% off)", "1,079.00", "79,00", "79-89", "79.999"]) {
      expect(planForNewMember(draft({ ...FULL, price }), [tier()], "generic"), price).toMatchObject({ reason: "unreadable_price" });
    }
  });

  it("an ambiguous period word is not guessed", () => {
    for (const period of ["biweekly", "bi-monthly", "per session", "4 week-ish"]) {
      expect(planForNewMember(draft({ ...FULL, period }), [tier()], "generic"), period).toMatchObject({ reason: "unreadable_period" });
    }
  });

  it("a kids plan is not assigned to an adult, nor an adult plan to a child", () => {
    expect(planForNewMember(draft(FULL), [tier({ isKids: true })], "generic")).toMatchObject({ reason: "plan_not_for_account_type" });
    expect(planForNewMember(draft(FULL, { accountType: "kids" }), [tier()], "generic")).toMatchObject({ reason: "plan_not_for_account_type" });
    expect(planForNewMember(draft(FULL, { accountType: "kids" }), [tier({ isKids: true })], "generic").kind).toBe("assign");
  });

  it("a TeamUp person is never given a plan: the export states no price, period or currency", () => {
    // Even with a plan of exactly that name and facts somehow present on the draft.
    expect(planForNewMember(draft(FULL), [tier()], "teamup")).toEqual({ kind: "review", label: "Adults Unlimited", reason: "source_has_no_price_facts" });
  });
});

describe("normalisation tables", () => {
  it("periods", () => {
    expect(normalisePeriod("Four_Weekly")).toBe("four_weekly");
    expect(normalisePeriod("28 days")).toBe("four_weekly");
    expect(normalisePeriod("Calendar month")).toBe("monthly");
    expect(normalisePeriod("yearly")).toBe("annual");
    expect(normalisePeriod("fortnightly")).toBe("fortnightly");
    expect(normalisePeriod("biweekly")).toBeNull();
  });
  it("prices and currencies", () => {
    expect(parsePrice("79")).toEqual({ pence: 7900, symbolCurrency: null });
    expect(parsePrice("79.5")).toEqual({ pence: 7950, symbolCurrency: null });
    expect(parsePrice("£0.99")).toEqual({ pence: 99, symbolCurrency: "GBP" });
    expect(parsePrice("$79")).toBeNull();
    expect(normaliseCurrency("usd")).toBe("USD");
    expect(normaliseCurrency("£")).toBe("GBP");
    expect(normaliseCurrency("pounds")).toBeNull();
  });
});

describe("the generic CSV carries the facts; the vendor maps do not", () => {
  it("reads plan price, billing period and currency columns", () => {
    const csv = "name,email,plan,plan price,billing period,currency\nAnn Lee,ann@example.test,Adults Unlimited,79.00,monthly,GBP\nBen Ito,ben@example.test,Adults Unlimited,,,\n";
    const { drafts } = parseImport("generic", csv);
    expect(drafts[0].planFacts).toEqual({ price: "79.00", period: "monthly", currency: "GBP" });
    expect(drafts[1].planFacts).toBeUndefined();
    expect(planForNewMember(drafts[0], [tier()], "generic").kind).toBe("assign");
    expect(planForNewMember(drafts[1], [tier()], "generic")).toMatchObject({ reason: "missing_period" });
  });
});

describe("tallyPlanReview", () => {
  it("counts by label and reason, with the owner-facing words and no person", () => {
    const t = tallyPlanReview([
      { kind: "review", label: "Open Mat", reason: "no_plan_with_name" },
      { kind: "review", label: "open  mat", reason: "no_plan_with_name" },
      { kind: "assign", tier: tier() },
      { kind: "none" },
    ]);
    expect(t).toEqual([{ label: "Open Mat", reason: "no_plan_with_name", why: "no MatFlow plan has this name", people: 2 }]);
  });
});

describe("PLAN_RESTRICTED_SENTENCE", () => {
  it("states the access consequence lib/checkin.ts applies to a member with no plan", () => {
    // Member app: requireCoverage, and a member with no plan is covered only by a class pack.
    expect(PLAN_RESTRICTED_SENTENCE).toMatch(/can't check themselves in from the member app unless they hold a class pack/);
    // Desk and kiosk: requireCoverage false, so classes no plan list limits still admit them.
    expect(PLAN_RESTRICTED_SENTENCE).toMatch(/desk and the kiosk can still check them into classes open to everyone/);
    // classEligibility refuses a member with no plan at every door.
    expect(PLAN_RESTRICTED_SENTENCE).toMatch(/classes limited to certain plans refuse them at every door/);
  });
});
