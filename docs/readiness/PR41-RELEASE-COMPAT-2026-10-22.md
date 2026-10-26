# PR #41 — production compatibility read (summary)

Sanitised summary (24 Oct 2026). The repository is public: club-level counts, internal ids and infrastructure names were removed from this file. The full read-only results are kept privately by the owner. Earlier versions of this file in git history contained more detail.

## How it was read
Read-only, one `READ ONLY` transaction, aggregates only, through the shared host guard (`scripts/readiness/release-compat-plan-limits.mjs`). Reads on 22 Oct and 23 Oct 2026. Only tables that exist before the migrations were read; the new table and columns are assessed by their migration defaults (empty / NULL).

## What deploy activates
1. **The customer club:** no behaviour change on deploy. No plan has a weekly limit, no class has a squad list or (after migration) a membership list, and there are no bookings. Eligibility and allowance rules apply only once the owner configures them.
2. **The demo club:** one plan's existing legacy weekly limit (`maxClassesPerWeek`) becomes enforced: read as "N each calendar week", refused at self doors and asked at staff doors. Its members are synthetic demo accounts. Whether to keep it enforced is an open owner decision; it is not cleared silently.
3. **Billing-period basis:** unusable at the customer club today (no member carries a renewal date or a Stripe subscription). It ships switched off (`BILLING_BASIS_AVAILABLE = false`).
4. **Billing behaviour:** the webhook stores the paid period on `invoice.payment_succeeded`; no club has Stripe subscribers, so it writes nothing today.
5. **Bookings:** none exist, so the booking-preservation policy has no live instances yet.

The read holds only as of its date. Repeat it immediately before merge: a limit, squad list, booking or paused class created after it changes what deploy activates. Since 26 Oct the read also reports F, active classes an attendance-history import created (expected 0): the release's live-class counts in Reports, Analysis, the AI report and Settings leave them out, so a non-zero count would drop those numbers on deploy. Proven on the test branch only (26 Oct: 0 at every club).

## Migrations (six, all additive) and the application serving during migration
- `20261017020102` creates `ClassMembershipTier` (indexes, foreign keys, row-level security): new table, no existing-row effect.
- `20261017035912` adds nullable `Class.category` with a `CHECK … NOT VALID` then `VALIDATE`.
- `20261017052858`, `20261021140000`, `20261021170000`, `20261021230000` add nullable `MembershipTier.classLimit/classLimitWeeks/classLimitBasis/classLimitAnchor` and `Member.billingPeriodStart/End`; each CHECK is added `NOT VALID` then validated. `20261021230000` takes exclusive locks on `Member` and `MembershipTier` for the length of the file. Every existing row satisfies every constraint (all new columns NULL).
- The previous application ignores the new columns (Prisma selects named columns). The new application tolerates NULLs everywhere.
- Lock-wait bounds and deploy-window coordination are being added before release (see the release task record).
- Recovery: fix forward (`docs/security/INCIDENT-AND-RESTORE-RUNBOOK.md` §4; Instant Rollback is not used).
