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
