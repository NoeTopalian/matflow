# Moving a club's memberships from TeamUp (or any platform billing through the club's own Stripe) — without anyone re-signing

Written 2026-09-23 for the Total BJJ pilot. Applies to any club whose previous platform billed through **the club's own Stripe account**. A club whose old platform used GoCardless, or its own processor, cannot use this: members must re-authorise through Stripe (card or Bacs Direct Debit) instead.

## What happens, per member

| The member's Stripe customer has… | MatFlow does | Amount / cadence / date |
|---|---|---|
| a live subscription (`active`, `trialing`, `past_due`, `paused`) | **Keeps it.** Links the member to that customer and subscription; matches the tier by Stripe price id, or by amount + currency + cycle when the tier has no price id yet. Nothing new is created in Stripe. | Unchanged — it is the same subscription. Next due date = the subscription's period end. |
| a saved card or Direct Debit but no subscription | **Starts one** on that saved method, `billing_cycle_anchor` = the member's `nextDueAt`, `proration_behavior: none`. Nothing is charged at creation — observed in test mode: no invoice exists until the anchor (a £0 invoice, if a Stripe version ever issues one, is not recorded as a payment). | Amount/cycle from the member's MatFlow tier; first charge on the member's next due date, then every cycle. |
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

## Evidence (Stripe test mode) — run 2026-09-24 00:59 UTC, PASS

Script: `scripts/stripe-migration-e2e.mjs` (test branch + `sk_test_` only; creates a stamped tenant, tears it down, deletes the throwaway connected account on PASS). Connected account: a Custom test account onboarded by API with Stripe's test identity (`acct_1UIyuYJhGQu5JWOo`, deleted after the run). Dev server :3847, migration route called through a real owner NextAuth session. Output: `scratchpad/migration-e2e-run5.json` (session temp).

| Member | Stripe before | Preview | Apply | Stripe after |
|---|---|---|---|---|
| Sam Create (`cus_VJcMUeO4uBmOD1`, saved Visa 4242, no subscription, tier "Adult 4-weekly" £38, `nextDueAt` 2026-09-25 06:00 UTC) | no subscription | `create`, "Visa ending 4242", first charge 2026-09-25 | `created` → `sub_1UIz8JJhGQu5JWOoau3WktWZ` | price minted `price_1UIz8JJhGQu5JWOo0N31sKdX` (`week × 4`, 3800 gbp); `billing_cycle_anchor` = 2026-09-25T06:00:00Z exactly; status `active`; **no invoice at creation** (`latest_invoice` null); exactly one subscription on the customer |
| Alex Adopt (`cus_VJcMlPIiBWCtp8`, existing subscription `sub_1UIz8AJhGQu5JWOoUlVaj8Pj` on an unmodelled price £65 monthly) | live subscription | `adopt`, tier "Adult Monthly" matched **by amount**, first charge = period end 2026-10-23 | `adopted` (same subscription id) | nothing created; tier "Adult Monthly" learnt `stripePriceId` = the old price |
| Nobody Nocard (`cus_VJcMqaq0zyaHNg`, no payment method) | — | `skip`, `no_payment_method` | `skipped` | untouched |

Also proven in the same run: dry run reports `would_create` / `would_adopt` / `skipped` and writes nothing; a second apply on the same members returns `already_linked` for both and creates nothing in Stripe; two `member.subscription.migrated` audit rows.

**First charge, time-travelled:** a clocked customer (`cus_VJcNAbxf9mTrN9`, test clock `clock_1UIz87JhGQu5JWOo1PZdXjPu`) was given the identical subscription shape (same minted price, same anchor, same params the engine sends); the clock was advanced to anchor + 1 h → Stripe created and paid **one** invoice `in_1UIz8eJhGQu5JWOoJHH4Sx09` for 3800 gbp and nothing before it. The real `invoice.payment_succeeded` event (`evt_1UIz8lJhGQu5JWOocWhW88ty`) was signed with the local webhook secret and POSTed to `/api/stripe/webhook` → 200; the member flipped to `paid` and one `Payment` row (3800, succeeded, `paidAt` = the clock time) was written.

Two things learnt, both now in the code and the script: (1) on API version 2026-03-25.dahlia a future-anchored, unprorated subscription creates **no** invoice until the anchor — so nothing is charged and nothing is recorded at migration time; (2) Stripe's `customers.list` omits test-clock customers unless filtered by clock, which is why the time-travel leg uses a separate clocked customer rather than the engine's own preview.
