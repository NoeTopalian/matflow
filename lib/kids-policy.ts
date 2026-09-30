// Shared kid-account policy constants.
//
// Both the staff create-member flow (POST /api/members) and the parent
// self-serve flow (POST /api/member/children) must enforce the same caps,
// otherwise one route can pile on rows the other refuses and we end up with
// data shapes the UI doesn't expect.

// Sanity cap on kids per parent. Ratchets if a real gym needs more —
// the hard rule is "we noticed", not "10 is sacred." Five-kid households
// are common in BJJ; ten is plenty of headroom.
export const MAX_KIDS_PER_PARENT = 10;

/**
 * The child account type a date of birth implies: under 13 is `kids`, 13–17
 * is `junior`, 18 and over is `null` (an adult). The same thresholds as the
 * member app's invite path (app/api/members/accept-invite) and the TeamUp
 * importer. Age is counted in UTC because a date-only DOB ("2017-07-07")
 * parses to UTC midnight.
 *
 * End-user round 2 (2.9): a child the desk added was stored as `adult`, so the
 * parent's card read "Adult · age 9" and the desk device offered the adult
 * waiver. Every staff path that makes someone a child now asks this.
 */
export function childAccountTypeFor(dob: Date, now: Date = new Date()): "kids" | "junior" | null {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  if (age < 13) return "kids";
  if (age < 18) return "junior";
  return null;
}
