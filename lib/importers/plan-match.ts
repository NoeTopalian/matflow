/**
 * Which MatFlow plan, if any, a GENUINELY NEW imported person is put on
 * (owner rule, 27 Oct 2026, quoted):
 *
 *   "For genuinely new members only, automatically assign a unique eligible
 *   existing MatFlow plan when name, billing period, price and currency agree.
 *   Use documented normalisation, not fuzzy guesses. Four-weekly is not
 *   calendar-monthly. Missing facts, conflicting prices, discounts/tax
 *   ambiguity, inactive or duplicate candidates require owner review."
 *
 *   "For a confidently identified new person whose plan cannot be matched,
 *   import without a plan and visibly flag the exception."
 *
 * Pure. The preview and the commit both call `planForNewMember`, so the plan
 * the preview reports is the plan the commit writes. Existing members are
 * never given a plan here (a later upload writes nothing to them).
 *
 * Documented normalisation (nothing else is accepted):
 *  - Plan name: trimmed, runs of white space read as one space, any case.
 *    "Adults  Unlimited" = "adults unlimited". Nothing else is folded: no
 *    punctuation stripping, no plural/singular, no partial match.
 *  - Billing period: the phrases in PERIOD_WORDS below (hyphens and
 *    underscores read as spaces, any case). "four weekly", "every 4 weeks",
 *    "28 days" are four-weekly; "monthly", "every month" are calendar-monthly;
 *    the two are never equal. "biweekly", "bimonthly" and anything else not
 *    listed are not understood: owner review.
 *  - Price: digits with up to two decimals ("79", "79.00"), optionally after
 *    a "£" or "€" that must agree with the currency. Thousands separators,
 *    decimal commas, ranges, "inc VAT", "ex VAT", discounts or any other text
 *    are not understood: owner review (discount and tax ambiguity).
 *  - Currency: a three-letter code (GBP, EUR, USD…; any case), or "£" / "€".
 *  - Eligible plan: active (`isActive`), and for the person's account type:
 *    a kids plan (`isKids`) for a child, a non-kids plan for an adult or a
 *    parent, either for a junior (MatFlow has no junior flag on a plan).
 *
 * A TeamUp memberships export carries a plan NAME only — no price, billing
 * period or currency (lib/importers/teamup.ts) — so a TeamUp person is never
 * given a plan by an import: they are imported without one and listed.
 * `cycleForPlan` (a guess from the plan's wording) is never used here.
 */
import type { MemberDraft } from "@/lib/importers";

export type PlanTier = {
  id: string;
  name: string;
  pricePence: number;
  currency: string;
  billingCycle: string;
  isActive: boolean;
  isKids: boolean;
};

/** The select the preview and the commit read plans with. */
export const PLAN_TIER_SELECT = {
  id: true, name: true, pricePence: true, currency: true, billingCycle: true, isActive: true, isKids: true,
} as const;

export type PlanReviewReason =
  | "source_has_no_price_facts"
  | "missing_price"
  | "missing_period"
  | "missing_currency"
  | "unreadable_price"
  | "unreadable_period"
  | "unreadable_currency"
  | "no_plan_with_name"
  | "several_plans_with_name"
  | "plan_inactive"
  | "plan_not_for_account_type"
  | "period_differs"
  | "price_differs"
  | "currency_differs";

/** The owner-facing reason, one sentence fragment each. */
export const PLAN_REVIEW_WORDS: Record<PlanReviewReason, string> = {
  source_has_no_price_facts: "the TeamUp export has no price, billing period or currency, so no plan can be confirmed",
  missing_price: "the file gives no price for the plan",
  missing_period: "the file gives no billing period for the plan",
  missing_currency: "the file gives no currency for the plan",
  unreadable_price: "the file's price is not a plain amount (a discount, tax note or other text needs checking)",
  unreadable_period: "the file's billing period is not one MatFlow reads without guessing",
  unreadable_currency: "the file's currency is not a currency code",
  no_plan_with_name: "no MatFlow plan has this name",
  several_plans_with_name: "more than one MatFlow plan has this name",
  plan_inactive: "the MatFlow plan with this name is inactive",
  plan_not_for_account_type: "the MatFlow plan with this name is for a different account type (kids or adults)",
  period_differs: "the file's billing period differs from the MatFlow plan's",
  price_differs: "the file's price differs from the MatFlow plan's",
  currency_differs: "the file's currency differs from the MatFlow plan's",
};

export type PlanDecision =
  /** The file names no plan for this person: nothing to assign, nothing to flag. */
  | { kind: "none" }
  | { kind: "assign"; tier: PlanTier }
  | { kind: "review"; label: string; reason: PlanReviewReason };

export const squashName = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

const PERIOD_WORDS: Record<string, string> = {
  weekly: "weekly", "every week": "weekly", "per week": "weekly", "1 week": "weekly",
  fortnightly: "fortnightly", "every 2 weeks": "fortnightly", "every two weeks": "fortnightly", "2 weekly": "fortnightly", "two weekly": "fortnightly",
  "four weekly": "four_weekly", "4 weekly": "four_weekly", "every 4 weeks": "four_weekly", "every four weeks": "four_weekly", "4 weeks": "four_weekly", "28 days": "four_weekly", "every 28 days": "four_weekly",
  monthly: "monthly", "every month": "monthly", "per month": "monthly", "calendar monthly": "monthly", "calendar month": "monthly", "1 month": "monthly",
  annual: "annual", annually: "annual", yearly: "annual", "every year": "annual", "per year": "annual", "12 months": "annual",
  none: "none", "one off": "none", "drop in": "none",
};

/** The billing period a file cell names, or null when it is not one of the documented phrases. */
export function normalisePeriod(raw: string): string | null {
  const k = raw.trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ").toLowerCase();
  return PERIOD_WORDS[k] ?? null;
}

const SYMBOL_CURRENCY: Record<string, string> = { "£": "GBP", "€": "EUR" };

/** A currency cell as an upper-case code, or null when it is not one. */
export function normaliseCurrency(raw: string): string | null {
  const t = raw.trim();
  if (SYMBOL_CURRENCY[t]) return SYMBOL_CURRENCY[t];
  return /^[A-Za-z]{3}$/.test(t) ? t.toUpperCase() : null;
}

/** A price cell in pence (and the symbol it carried, if any), or null when it is not a plain amount. */
export function parsePrice(raw: string): { pence: number; symbolCurrency: string | null } | null {
  const m = raw.trim().match(/^([£€])?\s*(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const pence = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
  return Number.isSafeInteger(pence) ? { pence, symbolCurrency: m[1] ? SYMBOL_CURRENCY[m[1]] : null } : null;
}

function eligibleFor(tier: PlanTier, accountType: string | undefined): boolean {
  const t = accountType ?? "adult";
  if (t === "kids") return tier.isKids;
  if (t === "junior") return true;
  return !tier.isKids;
}

/**
 * The plan a genuinely new person gets: assigned only when one active,
 * eligible plan has the file's plan name AND its billing period, price and
 * currency all equal the file's. Anything less is review (imported without a
 * plan and listed). `source` is the import's source: TeamUp states no money.
 */
export function planForNewMember(d: MemberDraft, tiers: readonly PlanTier[], source: string): PlanDecision {
  const label = d.membershipType?.trim();
  if (!label) return { kind: "none" };
  const review = (reason: PlanReviewReason): PlanDecision => ({ kind: "review", label, reason });

  if (source === "teamup") return review("source_has_no_price_facts");

  const named = tiers.filter((t) => squashName(t.name) === squashName(label));
  if (named.length === 0) return review("no_plan_with_name");
  if (named.length > 1) return review("several_plans_with_name");
  const tier = named[0];
  if (!tier.isActive) return review("plan_inactive");
  if (!eligibleFor(tier, d.accountType)) return review("plan_not_for_account_type");

  const f = d.planFacts ?? {};
  if (!f.period?.trim()) return review("missing_period");
  if (!f.price?.trim()) return review("missing_price");
  if (!f.currency?.trim()) return review("missing_currency");
  const period = normalisePeriod(f.period);
  if (!period) return review("unreadable_period");
  const currency = normaliseCurrency(f.currency);
  if (!currency) return review("unreadable_currency");
  const price = parsePrice(f.price);
  if (!price || (price.symbolCurrency && price.symbolCurrency !== currency)) return review("unreadable_price");

  if (period !== tier.billingCycle) return review("period_differs");
  if (currency !== tier.currency.trim().toUpperCase()) return review("currency_differs");
  if (price.pence !== tier.pricePence) return review("price_differs");
  return { kind: "assign", tier };
}

/** People imported without a plan, by the file's label and the reason — counts only, no person. */
export type PlanReviewTally = { label: string; reason: PlanReviewReason; why: string; people: number }[];

export function tallyPlanReview(decisions: readonly PlanDecision[]): PlanReviewTally {
  const by = new Map<string, PlanReviewTally[number]>();
  for (const p of decisions) {
    if (p.kind !== "review") continue;
    const k = `${squashName(p.label)}\u0000${p.reason}`;
    const row = by.get(k) ?? { label: p.label, reason: p.reason, why: PLAN_REVIEW_WORDS[p.reason], people: 0 };
    row.people += 1;
    by.set(k, row);
  }
  return [...by.values()].sort((a, b) => a.label.localeCompare(b.label, "en-GB") || a.reason.localeCompare(b.reason));
}

/** The sentence every "imported without a plan" surface carries (owner rule, 27 Oct 2026). */
export const PLAN_RESTRICTED_SENTENCE = "Plan-restricted classes may refuse them until staff assign a plan.";
