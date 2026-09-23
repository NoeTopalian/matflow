# Moving a club's memberships from TeamUp (or any platform billing through the club's own Stripe) — without anyone re-signing

Written 2026-09-23 for the Total BJJ pilot. Applies to any club whose previous platform billed through **the club's own Stripe account**. A club whose old platform used GoCardless, or its own processor, cannot use this: members must re-authorise through Stripe (card or Bacs Direct Debit) instead.

## What happens, per member

| The member's Stripe customer has… | MatFlow does | Amount / cadence / date |
|---|---|---|
| a live subscription (`active`, `trialing`, `past_due`, `paused`) | **Keeps it.** Links the member to that customer and subscription; matches the tier by Stripe price id, or by amount + currency + cycle when the tier has no price id yet. Nothing new is created in Stripe. | Unchanged — it is the same subscription. Next due date = the subscription's period end. |
| a saved card or Direct Debit but no subscription | **Starts one** on that saved method, `billing_cycle_anchor` = the member's `nextDueAt`, `proration_behavior: none`. Stripe issues a £0 invoice at creation (the webhook records no payment for it). | Amount/cycle from the member's MatFlow tier; first charge on the member's next due date, then every cycle. |
| nothing usable | **Nothing.** The row says why (no customer, no saved method, no tier, no due date, due date past, tier not recurring, Direct Debit saved but switched off). | — |

Implementation: `lib/stripe/migrate-memberships.ts` (engine), `app/api/stripe/migrate-memberships/route.ts` (owner-only preview/apply), `components/dashboard/MigrateMembershipsPanel.tsx` (Settings → Revenue). Cycle model: `lib/billing-cycle.ts` (`weekly | fortnightly | four_weekly | monthly | annual | none`).

## Cutover, in order

1. **Connect Stripe.** Settings → Revenue → Connect Stripe, signed in to the club's existing Stripe account (the one TeamUp charges through). This does not disturb TeamUp; both platforms hold API access to the same account.
2. **Export the roster from TeamUp** as CSV with, per member: name, email, plan name, next payment date. The email must be the one on the Stripe customer — that is the match key.
3. **Create one membership tier per TeamUp plan** (Dashboard → Memberships) with the same amount and cycle. Name it exactly as the plan appears in the CSV so the importer attaches it. Leave the Stripe price fields blank; a price is minted on the connected account the first time it is needed.
4. **Import the CSV** (Members → Import, source "generic" or the vendor preset). The importer sets `membershipTierId` from the plan name and `nextDueAt` from the next payment date. Do not send login invites yet — that is a separate, later step.
5. **Settings → Revenue → Move memberships → Preview.** Read every row. Fix what the "not ready" rows ask for (a missing tier, a past due date, a member with no Stripe customer under that email) and preview again.
6. **Tick and confirm.** Members with an existing subscription are linked instantly. Members starting on a saved method get a subscription whose first charge is on the date shown.
7. **End the memberships on TeamUp before each first-charge date.** This is the only double-charge guard and it is human: the confirm dialog and the results list print the dates. For "keep existing subscription" rows there is nothing to end — TeamUp was not the biller, Stripe was, and the subscription is unchanged.
8. **Verify.** Payments → the first `invoice.payment_succeeded` for each member appears as a succeeded payment on their due date; Members → the member shows the tier and "paid". Once `CRON_SECRET` is set, the nightly reconcile reports any subscription whose events did not arrive.

## Rollback

A created subscription can be cancelled in the Stripe dashboard (or via the member's profile) — its id is in the audit log (`member.subscription.migrated`, `metadata.stripeSubscriptionId`). The member keeps their tier and due date. A linked (adopted) subscription was never changed; unlinking is clearing `stripeCustomerId` / `stripeSubscriptionId` on the member row.

## Idempotency and guards

- Apply recomputes the preview and acts only on rows that still classify as actionable; the request body only chooses which members.
- A created subscription uses idempotency key `matflow_migrate_<memberId>`: a retried click cannot mint a second one.
- A member already carrying `stripeSubscriptionId` is skipped (`already_linked`); the link write is a compare-and-set on that column being null.
- Anchors must be at least one hour ahead; otherwise the row is `due_date_past`.
- Rate limits: 30 previews / 10 min, 10 applies / hour per club.

## Evidence (Stripe test mode)

_To be filled after the test-mode run on a verified test connected account: redacted customer / subscription / price ids, the test-clock advance past the anchor, and the resulting webhook → Payment row._
