/**
 * Who counts as a MEMBER in headline numbers (2 Oct 2026, independent
 * acceptance of the TeamUp import, finding P1): a parent/guardian account —
 * including the no-login guardian drafts an import makes from emergency
 * contacts — is an account holder, not a training member. Counting them made
 * Reports say "531 active members" and "226 new this month" for a club whose
 * import created 219 guardian records. Every population count (active, new,
 * retention, net-new, status breakdown) spreads this into its `where`.
 *
 * Children are members (they train); parents are not unless they also hold a
 * membership of their own, in which case their row is typed `adult`.
 */
export const TRAINING_MEMBER = { accountType: { not: "parent" } } as const;
