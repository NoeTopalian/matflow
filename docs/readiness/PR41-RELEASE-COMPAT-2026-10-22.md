# PR #41 — production compatibility read (22 Oct 2026, 22:24 UK)

Read-only, one `READ ONLY` transaction, aggregates and internal ids only (`scripts/readiness/release-compat-plan-limits.mjs`, production endpoint via the shared `db-target` guard). Candidate `d1841372b4d76f8bf4b0df35a333ba6f5cbff66e`. Only tables that exist before the migrations were read; the new `ClassMembershipTier` table and the new tier/member columns are assessed by their migration defaults (empty / NULL).

## What deploy activates, per club

| Club (internal id) | Allowance enforcement activating | Roster restrictions | Bookings refused by roster | Members | Billing-period data |
|---|---|---|---|---|---|
| **totalbjj** (`cmucpxc4c0000uctgouza06aj`, Sean's club) | **none** — no tier has `maxClassesPerWeek`; the new columns are NULL | none (0 rosters) | 0 of 0 bookings | 921 total, 531 active, 223 without a tier | **0 with a Stripe subscription, 0 with `nextDueAt`** — a "billing" allowance would read "no renewal date recorded" for every member until renewal dates exist |
| ironpathbjj (`cmuduit4c0000gwtgt74avg4o`, demo club) | **yes**: tier `cmuduits5003lgwtggoz320sy` has `maxClassesPerWeek = 3` with 18 active members → read as "3 each calendar week" and enforced at every door (asked at staff doors, refused at self doors) after the third class in a Mon–Sun week | none | 0 of 0 | 55 total, 42 active | 42 with `nextDueAt`, 0 Stripe |
| b1synth20261015 (`cmva6k6gj000008i780iszx7d`, synthetic) | tier `cmva7hhc7000208jvqgpp5yz5` limit 3, **0 members** | none | 0 | 0 | — |
| totalbjjarchive, noetest, deploy-smoke-test, assess-test-gym-2026-05-07, walkthrough-verification-gym | none | none | 0 | 16 / 0 / 0 / 0 / 0 | — |

Tier billing cycles: totalbjj 10 × four_weekly, 5 × monthly, 1 × none; ironpathbjj 3 × monthly; b1synth 1 × monthly.

## Conclusions
1. **Sean's club: no behaviour changes on deploy.** No allowance is configured, no class has a roster or (post-migration) a membership list, there are no bookings. Eligibility and allowance rules only bite once Sean configures them.
2. **Demo club: the existing "3x Per Week" limit starts being enforced** (the previous build showed it without enforcing). This is the intended reading of the legacy column (`CLASS-ALLOWANCE-RESET-MODEL-2026-10-21.md` "Legacy column"). No customer impact; the demo's 18 members are synthetic. If Noe prefers the demo to stay unenforced, the remedy is to clear that tier's limit in the demo club's plan editor after deploy (a customer-settings change, so not done silently).
3. **Billing-period basis is unusable at Total BJJ today**: no member carries `nextDueAt` or a Stripe subscription, so choosing "each member's billing period" would refuse/ask for everyone. Not a deploy risk (nothing selects it), but it widens open decision 3: either populate `nextDueAt` from TeamUp's "next payment date" on the next import, or keep Total BJJ on calendar/every-N-weeks bases.
4. **Billing behaviour**: the webhook change only stores the paid period on `invoice.payment_succeeded`; no club has Stripe subscribers, so it writes nothing today. No charge, price or schedule changes.
5. **Bookings**: none exist, so the "preserved but refused" policy question has no live instances.

## Migrations (six, all additive) and the old application serving during migration
- `20261017020102` creates `ClassMembershipTier` (+ indexes, FKs): new table, no existing-row effect.
- `20261017035912` adds nullable `Class.category` with a `CHECK … NOT VALID` then `VALIDATE` (SHARE UPDATE EXCLUSIVE during validation; all existing rows NULL → valid).
- `20261017052858`, `20261021140000`, `20261021170000`, `20261021230000` add nullable `MembershipTier.classLimit/classLimitWeeks/classLimitBasis/classLimitAnchor` and `Member.billingPeriodStart/End`, each CHECK added `NOT VALID` then validated; constraints dropped and re-added take a brief ACCESS EXCLUSIVE lock on `MembershipTier` (16 + 3 + 1 rows) — milliseconds. Every existing row satisfies every constraint (all new columns NULL; `maxClassesPerWeek` is not constrained).
- The old application (16.3.3 / 41b608aa code) ignores the new columns; Prisma selects named columns only. The new application tolerates NULLs everywhere. Deploy order (migrate, then serve) is Vercel's build step; both orders are compatible.
- Recovery: fix forward (`docs/security/INCIDENT-AND-RESTORE-RUNBOOK.md` §4; Instant Rollback banned). The migrations are additive, so an older build keeps running against the migrated schema.
