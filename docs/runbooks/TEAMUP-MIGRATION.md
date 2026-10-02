# Moving a club's memberships from TeamUp (or any platform billing through the club's own Stripe) — without anyone re-signing

Written 2026-09-23 for the Total BJJ pilot; revised 2026-09-24 after the TeamUp export and plan catalogue were read. Applies to any club whose previous platform billed through **the club's own Stripe account**. A club whose old platform used GoCardless, or its own processor, cannot use this: members must re-authorise through Stripe (card or Bacs Direct Debit) instead.

## What happens, per member

| The member's Stripe customer has… | MatFlow does | Amount / cadence / date |
|---|---|---|
| a live subscription (`active`, `trialing`, `past_due`) | **Replaces it at its period end** (the default). A MatFlow subscription is created on the same customer, same payment method, on the club's own price for the matching tier, `billing_cycle_anchor` = the existing subscription's **verified** `current_period_end`, `proration_behavior: none`. Nothing is charged at creation. The old subscription is **not touched by MatFlow** — the owner ends the membership in TeamUp right away, which cancels it there. | Same amount, same cycle; the first MatFlow charge lands on the day the old one would have. |
| a live subscription, and the previous platform has confirmed that ending a membership does **not** cancel the Stripe subscription | **Adopts it** — only with the "Keep existing subscriptions as they are" box ticked. Links the member to that customer and subscription; nothing new in Stripe. **Not for TeamUp**: ending a TeamUp membership cancels its Stripe subscription, so an adopted member would stop paying the moment TeamUp was switched off. | Unchanged. |
| a saved card or Direct Debit but no subscription | **Starts one** on that saved method, anchored to the member's `nextDueAt` (a date the owner has confirmed, never one the importer estimated). Observed in test mode: no invoice exists until the anchor. | Amount/cycle from the member's MatFlow tier; first charge on the due date, then every cycle. |
| nothing usable | **Nothing.** The row says why: no customer, no saved method, no tier, tier not recurring, the imported tier disagrees with what the subscription bills (`tier_mismatch`, both named), the period ends within the hour, no due date, due date past, on hold, Direct Debit saved but switched off. | — |

Tier matching: by the tier's Stripe price id, else by amount + currency + cycle among the club's tiers (a 4-weekly Stripe price is `week × 4`). Two candidates → `ambiguous_tier`; none → `needs_tier`, with the amount and interval shown so the tier can be created. A member already carrying a MatFlow subscription is `already_linked`; if their customer still has **another** live subscription, the row says so — that is a TeamUp membership not yet ended.

Recovery: every subscription MatFlow creates carries `metadata.matflowMemberId`. Before creating, the engine lists the customer's subscriptions and reuses one that already names the member, so a run that died after Stripe answered but before the member row was written cannot mint a second subscription even after Stripe's idempotency window has closed.

Implementation: `lib/stripe/migrate-memberships.ts` (engine), `app/api/stripe/migrate-memberships/route.ts` (owner-only preview/apply, `?allowAdopt=1`), `components/dashboard/MigrateMembershipsPanel.tsx` (Settings → Revenue). Cycle model: `lib/billing-cycle.ts`. Holds: `lib/member-hold.ts`.

## Total BJJ's plans → MatFlow tiers

From the TeamUp catalogue as pasted on 2026-09-24 (re-check on the day — prices and counts move). Every "2026" plan and the un-suffixed legacy plans bill **every 4 weeks**; the "(OLD)" plans bill **per month** at the same nominal price and are a different Stripe price, so they stay separate tiers. Create the tiers that hold members in Dashboard → Memberships **named exactly as below** (the importer attaches tiers by name). "Active" is TeamUp's count that day — the reconciliation target; 296 in total on 24 Sep (adults 157, packages 1, kids 138).

| Tier name (exactly) | Price | Cycle | Kids | Active 24 Sep | Offered? |
|---|---|---|---|---|---|
| Beginners Course 2026 | £88.00 | Every 4 weeks | no | 25 | active tier |
| Adults Advanced 2026 | £98.00 | Every 4 weeks | no | 50 | active tier |
| Beginners Once Per Week 2026 | £55.00 | Every 4 weeks | no | 9 | active tier |
| Advanced Once Per Week 2026 | £55.00 | Every 4 weeks | no | 11 | active tier |
| Advanced Unlimited Adult Classes | £88.00 | Every 4 weeks | no | 27 | inactive (Not for Sale) |
| Advanced Unlimited Adult Classes (OLD) | £88.00 | Monthly | no | 35 | inactive |
| Kids Unlimited 2026 | £75.00 | Every 4 weeks | yes | 19 | active tier |
| Kids Once-A-Week 2026 | £49.00 | Every 4 weeks | yes | 35 | active tier |
| Kids Unlimited Membership | £66.00 | Every 4 weeks | yes | 44 | inactive |
| Kids Once A Week Membership | £45.00 | Every 4 weeks | yes | 26 | inactive |
| Kids Unlimited Membership (OLD) | £66.00 | Monthly | yes | 11 | inactive |
| Kids Once A Week Membership (OLD) | £45.00 | Monthly | yes | 3 | inactive |
| Advanced Adult + Juniors & Comp Classes Once Per Week (OLD) | £55.00 | Monthly | no | 1 | inactive; package — assign to the paying adult, the child gets the matching kids tier |

Plans with **0 active** on 24 Sep need no tier unless someone is on them by cutover: Beginner Course (£88 / 4 weeks), 8 Week Beginners Course (£159 one-off, prepaid), and the seven "Kids & Adults" packages (Adult Advanced + Juniors & Comp 2026 £98, Kids & Beginners Course 2026 £88, Advanced Adults + Juniors Classes Once Per Week 2026 £55, Kids & Beginners Course Once Per Week 2026 £55, Kids & Beginners Course (OLD) £88/month, Adult Advanced + Juniors & Comp (OLD) £98/month, Kids & Beginners Course Once Per Week (OLD) £55/month).

Most plans carry a 2-billing-cycle commitment and "Cancel via business dashboard only"; MatFlow enforces the second by leaving member self-cancel off for this club, and does not model the first (see the plan). A "Not for Sale" plan with members is an **inactive** tier here: it keeps its members and its price, and is not offered to anyone new.

## Cutover, in order

1. **Connect Stripe.** Settings → Revenue → Connect Stripe, signed in to the club's existing Stripe account (the one TeamUp charges through). This does not disturb TeamUp; both platforms hold API access to the same account.
2. **Create the tiers** from the table above (Dashboard → Memberships). Leave the Stripe price fields blank; a price is minted on the connected account the first time it is needed.
3. **Export the memberships from TeamUp** — the standard memberships export, one row per membership, with the columns as they come (customer name/email, membership name, status, start/expiry/cancelled dates, phone, date of birth, emergency contact). The email must be the one on the Stripe customer — that is the match key.
4. **Import it** (Members → Import, source **TeamUp**, mode **Add people**, and **enter the export time** — the file carries none; a wrong time moves memberships that start or end around it). Mapping `teamup-2` (2 Oct 2026, contract `docs/readiness/TOTAL-BJJ-TEAMUP-IMPORT-CONTRACT.md`): rows fold into people by (email, name) and nothing else; **every source row is kept** as membership history with one disposition; entitlement is read per membership at the export time (one started active = current; a future start = scheduled, named, not applied; a hold counts only when it is the only live row; **two started actives = a decision the owner makes, nothing is picked**); a person with only history is cancelled, with a cancellation date **only** from the Cancelled Date column. Kids never keep the row's email. **A parent link is suggested, never granted**: an adult on the same address, or a no-login guardian draft made from the emergency contact that holds the payer address — confirm or reject each on the child's Family card before that parent can see or act for the child. It writes **no due dates** and nothing in Stripe. **Read the preview**: the reconciliation block must match TeamUp's own counts, and the "items need your decision" list is the owner's work after commit; the exceptions CSV download is the same list. Do not send login invites yet.
   Proven on the real Total BJJ file on 2 Oct 2026 (`docs/readiness/TOTAL-BJJ-TEAMUP-IMPORT-REHEARSAL.md`): 1,082 records, 922 people imported, independent reconciliation exact, a server kill mid-commit resumed without duplicates, an older export refused as a refresh. **A status refresh** (mode Status refresh) updates only TeamUp-owned standing for people already imported, never touches contact, medical, waiver, hold or guardian fields, and **refuses a file exported before the standing already recorded**.
5. **Settings → Revenue → Move memberships → Preview.** Leave "Keep existing subscriptions" **unticked** for TeamUp. Read every row. Fix what the "not ready" rows ask for (a missing tier, a tier mismatch, a member with no Stripe customer under that email) and preview again.
6. **Tick and confirm.** Members with a live subscription get a replacement that starts billing on their existing period end. Members on a saved card with an owner-confirmed due date get a new subscription anchored there.
7. **End memberships in TeamUp per member, by the path each one took** — never as one blanket cancellation before the migration has run, and never for a member the migration skipped:
   - **Replaced** (the default for a live subscription): end the TeamUp membership **the same day, after** the results list shows the replacement id. The replacement is anchored on the old period end and creates no invoice until then; TeamUp ending its membership cancels the old subscription, which is exactly what stops the double charge. Ending it *before* the migration runs would leave the member with no live subscription to replace, and the preview would then offer only `create` (a new anchor the owner has to confirm).
   - **Adopted** (only with "Keep existing subscriptions" ticked, never for TeamUp): do **not** cancel anything — the subscription is the one MatFlow now bills on.
   - **Created** (saved card, owner-confirmed due date): end the TeamUp membership before that due date; the confirm dialog prints it.
   - **Skipped** (`on_hold`, `tier_mismatch`, `needs_tier`, `no_customer`…): leave TeamUp as it is until the row is fixed and migrated.
   A member still carrying a second live subscription shows in the preview as "old subscription still running" — that is a TeamUp membership not yet ended. **Last safe rollback point:** before step 7. Up to then every created or replacement subscription can be cancelled from the audit log (Rollback, below) and TeamUp is untouched; once TeamUp memberships are ended, rolling back means re-creating them on TeamUp by hand.
8. **Send login invites** (Members → Send login invites) once mail is proven. Synthesised payers and non-contactable placeholders are never invited; give them a real address first.
9. **Verify.** Payments → the first `invoice.payment_succeeded` for each member appears on their due date; Members → the member shows the tier and "paid". Once `CRON_SECRET` is set, the nightly reconcile reports any subscription whose events did not arrive.

## Holds

Members on hold in TeamUp arrive as `paused` and are **skipped** by the migration (`on_hold`). Move them when they come back: resume in TeamUp is not needed — put them on MatFlow's own hold (member profile → Put on hold…) after migrating, or migrate on the day they resume. MatFlow's hold pauses the Stripe subscription with `behavior: void` (no invoices while paused, resumes on the date) and refuses self/kiosk check-in with the date; a staff mark still admits.

## Rollback

**Import rollback** (Settings → Import → Roll back this import) removes only the people the run created who have not been used since — no sign-in, no edit, no payment, no waiver, no check-in made in MatFlow, no child being kept — and lists everyone it kept with the reason; a run whose rollback kept people can be finished later once those reasons no longer apply. The run's membership-history ledger goes with it. A confirmed guardian link counts as an edit, so a confirmed family is kept.

A created or replacement subscription can be cancelled in the Stripe dashboard (or via the member's profile) — its id is in the audit log (`member.subscription.migrated`, `metadata.stripeSubscriptionId`; for a replacement `metadata.replacesSubscriptionId` names the old one). The member keeps their tier and due date. An adopted subscription was never changed; unlinking is clearing `stripeCustomerId` / `stripeSubscriptionId` on the member row.

## Idempotency and guards

- Apply recomputes the preview and acts only on rows that still classify as actionable; the request body only chooses which members (and whether adopting is allowed).
- A created subscription uses idempotency key `matflow_migrate_<memberId>` and carries `metadata.matflowMemberId`; a retried click, or a re-run after a crash, reuses rather than mints.
- A member already carrying `stripeSubscriptionId` is skipped (`already_linked`); the link write is a compare-and-set on that column being null.
- Anchors must be at least one hour ahead (`period_end_too_soon` / `due_date_past`).
- The imported tier and the subscription's price must agree (`tier_mismatch`), so a wrong plan name in the CSV cannot silently change what a member pays.
- Rate limits: 30 previews / 10 min, 10 applies / hour per club.

## Evidence (Stripe test mode) — run 2026-09-24 00:59 UTC, PASS (adopt + create; replace pinned by unit tests, script updated, re-run pending)

Script: `scripts/stripe-migration-e2e.mjs` (test branch + `sk_test_` only; creates a stamped tenant, tears it down, deletes the throwaway connected account on PASS). Connected account: a Custom test account onboarded by API with Stripe's test identity (`acct_1UIyuYJhGQu5JWOo`, deleted after the run). Dev server :3847, migration route called through a real owner NextAuth session. Output: `scratchpad/migration-e2e-run5.json` (session temp).

| Member | Stripe before | Preview | Apply | Stripe after |
|---|---|---|---|---|
| Sam Create (`cus_VJcMUeO4uBmOD1`, saved Visa 4242, no subscription, tier "Adult 4-weekly" £38, `nextDueAt` 2026-09-25 06:00 UTC) | no subscription | `create`, "Visa ending 4242", first charge 2026-09-25 | `created` → `sub_1UIz8JJhGQu5JWOoau3WktWZ` | price minted `price_1UIz8JJhGQu5JWOo0N31sKdX` (`week × 4`, 3800 gbp); `billing_cycle_anchor` = 2026-09-25T06:00:00Z exactly; status `active`; **no invoice at creation** (`latest_invoice` null); exactly one subscription on the customer |
| Alex Adopt (`cus_VJcMlPIiBWCtp8`, existing subscription `sub_1UIz8AJhGQu5JWOoUlVaj8Pj` on an unmodelled price £65 monthly) | live subscription | `adopt`, tier "Adult Monthly" matched **by amount**, first charge = period end 2026-10-23 | `adopted` (same subscription id) | nothing created; tier "Adult Monthly" learnt `stripePriceId` = the old price |
| Nobody Nocard (`cus_VJcMqaq0zyaHNg`, no payment method) | — | `skip`, `no_payment_method` | `skipped` | untouched |

Also proven in the same run: dry run reports `would_create` / `would_adopt` / `skipped` and writes nothing; a second apply on the same members returns `already_linked` for both and creates nothing in Stripe; two `member.subscription.migrated` audit rows.

**First charge, time-travelled:** a clocked customer (`cus_VJcNAbxf9mTrN9`, test clock `clock_1UIz87JhGQu5JWOo1PZdXjPu`) was given the identical subscription shape (same minted price, same anchor, same params the engine sends); the clock was advanced to anchor + 1 h → Stripe created and paid **one** invoice `in_1UIz8eJhGQu5JWOoJHH4Sx09` for 3800 gbp and nothing before it. The real `invoice.payment_succeeded` event (`evt_1UIz8lJhGQu5JWOocWhW88ty`) was signed with the local webhook secret and POSTed to `/api/stripe/webhook` → 200; the member flipped to `paid` and one `Payment` row (3800, succeeded, `paidAt` = the clock time) was written.

**Since that run** the default for a live subscription changed from adopt to **replace at period end** (design review: ending a TeamUp membership cancels its Stripe subscription, so adopting is only safe where the old platform hands subscriptions over). The unit suite (`tests/unit/migrate-memberships.test.ts`, 38 cases) pins the replace path and the `allowAdopt` gate.

### Replace path — run 2026-09-24 21:23 UTC, PASS

Same script, fresh Custom test account `acct_1UJJxsJBKy4yNUGQ` (created by API, `charges_enabled` in under a minute, deleted after the run), SHA `9993565`, dev server :3847 on the test branch.

| Member | Stripe before | Preview | Apply | Stripe after |
|---|---|---|---|---|
| Alex Replace (`cus_VJy28MAa6OM73c`, existing subscription `sub_1UJK6sJBKy4yNUGQF8cQMfzg` on an unmodelled £65 monthly price, saved Visa 4242) | live subscription, period end 2026-10-24 21:23:17 UTC | `replace`, tier "Adult Monthly" matched **by amount**, first charge = 2026-10-24 (the old period end); with `?allowAdopt=1` the same row reads `adopt` | `replaced` → new `sub_1UJK74JBKy4yNUGQ29fcL8Xw`, `replacesSubscriptionId` = the old id | new subscription `active`, `billing_cycle_anchor` = **exactly** the old subscription's `current_period_end`; bills the tier's own minted price `price_1UJK73JBKy4yNUGQrRq8WM1y` at 6500 gbp (not the old price); no invoice at creation; metadata `matflowMemberId` / `matflowReplaces` / `matflowTenantId`; **both** subscriptions live on the customer — the old one is untouched for the owner to end in the previous platform |
| Sam Create | saved card, no subscription | `create`, first charge 2026-09-26 | `created` | as in the first run: 4-weekly 3800 gbp, anchor exact, no invoice at creation, one subscription |
| Nobody Nocard | no payment method | `skip` `no_payment_method` | `skipped` | untouched |

Also re-proven in this run: dry run writes nothing; second apply is `already_linked` for both; two `member.subscription.migrated` audit rows (`mode: replace` with `replacesSubscriptionId`, `mode: create`); the time-travelled first charge on a clocked customer (one £38 invoice `in_1UJK7RJBKy4yNUGQoRvgOdcK`, nothing before the anchor) replayed into the local webhook → member `paid`, one succeeded Payment.

Two things learnt, both now in the code and the script: (1) on API version 2026-03-25.dahlia a future-anchored, unprorated subscription creates **no** invoice until the anchor — so nothing is charged and nothing is recorded at migration time; (2) Stripe's `customers.list` omits test-clock customers unless filtered by clock, which is why the time-travel leg uses a separate clocked customer rather than the engine's own preview.
