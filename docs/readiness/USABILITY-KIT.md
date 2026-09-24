# Usability kit — formative round 1 and retest (execution prompt §7)

Status: PREPARED 2026-09-24. **No participant has been contacted and no session has run.** Human evidence is BLOCKED until Noe authorises recruitment. Nothing below is a result.

## Cohort (12 adults)
4 owners/managers (at least 2 running more than one venue or club) · 3 coaches/reception · 3 members/parents · 2 support/operator users. Mix of technical confidence; at least two participants who use assistive settings (zoom, screen reader, keyboard only). Adults only; children are synthetic records on the staging club.

## Recruitment copy (owner/manager version — adapt the role line for the others)
> We are testing MatFlow, a club-management app for martial-arts gyms, and want to watch a real gym owner use it for about 45 minutes on a video call. You will try a handful of everyday tasks on a practice club with made-up members; nothing you do affects a real gym. We are testing the software, not you — if something is confusing that is our problem to fix. £[amount] thank-you voucher. Recording is optional and you can stop at any point.

## Consent and recording guidance
Written consent before the call: purpose, what is recorded, who sees it, retention (90 days then deleted), right to withdraw. Record screen and audio only with consent; face optional. No real member data on screen: sessions run on a staging club seeded from `scripts/seed-demo-rich.mjs` with invented names. The facilitator never types for the participant. Recordings live in the private evidence folder, never in the repo.

## Staging data
One seeded club per participant pair (owner and coach tasks share a club): 55 members including a family with two children, one member on hold, one with a failed payment, one trial, three tiers (4-weekly and monthly). Two locations **once ADR-001 D2 exists — until then tasks 3, 4 and 6 are NOT TESTABLE and the round covers the other nine**.

## Facilitator script (45 minutes)
1. (5) Welcome, consent check, think-aloud instruction; we do not help unless the participant is stuck for two minutes.
2. (30) Tasks in the participant's rotated order (Latin square across the cohort so no task is always last).
3. (5) After each task: ease 1–7, "what did you expect to happen?", "which club or scope were you in?"
4. (5) Close: what would stop you switching from your current platform.

## Task cards (as given to participants — no control names)
1. Set up the club so a member could turn up tomorrow: one class, one price. Leave anything optional alone.
2. Here is a messy spreadsheet from the old system. Bring the people in, and only invite the ones you would actually want to email today.
3. Make the kids class bookable only at the Northside venue and show me one booking that works and one that is refused. *(NOT TESTABLE until Location ships)*
4. You run two clubs. Open both, then refund a payment — tell me which club you are refunding in before you click. *(NOT TESTABLE until the switcher ships; substitute: two browser tabs on one club, refund, explain scope)*
5. Change the logo and colours, check it on a phone, then put it back exactly as it was.
6. A group default sets the check-in window to 30 minutes. Make this club 15 minutes and tell me whether a later group change will overwrite it. *(NOT TESTABLE until Group ships)*
7. Put the adult price up by £5. Tell me what happens to the people already paying.
8. Sam has two memberships. Pause one for a month; tell me whether Sam can train, whether Sam owes anything, and when the next charge is. Then resume it.
9. (coach) It is 18:55, twelve people are at the door, one has not signed the waiver, the class holds ten. Get them in.
10. (parent) Book your child into Tuesday kids, sign what needs signing, and tell me who pays.
11. (member, on a phone) Your card payment failed. Sort it out. Then cancel your membership.
12. (operator) A club owner is locked out. Help them, then make sure you can no longer see their club.

## Observation sheet (one row per task per participant)
`participant | role | task | unassisted (Y/N) | interventions (count) | critical mistake (wrong club / wrong money / guardian access / data loss) | time (s) | first path taken | scope stated correctly before the critical action (Y/N) | ease 1–7 | verbatim quotes`

## Gate (proposed, per the prompt)
At least 90% unassisted completion on the critical tasks (2, 7, 8, 9, 10, 11, 12) · median ease 5/7 or better · every participant states the correct club and consequence before a refund, price or hold action · zero unresolved wrong-club, wrong-financial or guardian-access errors. A good average cannot hide a critical failure. Time targets are set after round 1, not before.

## Retest plan
Fix material findings (severity MEDIUM or above) between rounds; log exactly what changed; round 2 with fresh participants where possible, same tasks, failed tasks first. Report both samples separately with denominators by role.
