# Billing cutover manifest — production and sign-off

Written 2026-09-30 for Total BJJ's move off TeamUp. Companion to [`TEAMUP-MIGRATION.md`](TEAMUP-MIGRATION.md), which describes the engine; this document describes the paper that must exist, signed, before the engine is allowed to touch a live member. Builder: `lib/stripe/cutover-manifest.ts` (`buildCutoverManifest`, `summariseManifest`, `manifestToCsv`), pinned by `tests/unit/cutover-manifest.test.ts`.

Nothing in this document has been run against the club's live Stripe account. Every step below that says "run" is a step for the day, not a record of one.

## What the manifest is

One row per membership, derived only from a migration **preview** (`GET /api/stripe/migrate-memberships`, `lib/stripe/migrate-memberships.ts`) plus two timestamps. It is pure: the same preview and the same timestamps give the same manifest byte for byte, so a signed copy can be re-derived and compared on the day.

| Column | Meaning |
|---|---|
| Member / Member ID / Junior | The **beneficiary** — who trains. Junior if flagged, or if the email is a synthesised `kid-…@no-login.matflow.local`. |
| Payer / Payer verified / Payer basis | The owner of the Stripe customer. **`verified: NO` unless the row carries an explicit payer link** (a parent link, or an owner confirmation recorded outside the preview). An email match is recorded as `email_match_unverified` and the payer is left unnamed — a shared family email is not evidence of who pays. A junior with no link carries a `payer_unverified` exception. |
| Stripe customer / subscription / source subscription / price | The ids. For **replace**, "source subscription" is TeamUp's (the one that must stop) and "subscription" is empty until apply prints MatFlow's. |
| Amount (pence) / Currency / Cadence / Monthly equivalent | What the member pays and how often; the monthly equivalent is `amount × cycles per month` rounded to the penny (4-weekly = × 13/12). |
| Collected by | `TeamUp` until cutover; `MatFlow` once linked; `Both` when a linked member's customer still has TeamUp's subscription live — a double-charge in waiting. |
| First MatFlow collection | UTC date of the first charge MatFlow's subscription will take. |
| Exceptions | `on_hold`, `tier_mismatch`, `no_payment_method` (includes Direct Debit saved but switched off), `other_live_subscription`, `period_end_too_soon` (engine: within the hour; manifest: under **48 hours** from the snapshot, too little time to act in TeamUp), `payer_unverified`, `not_ready` (any other preview skip reason, named). |
| Decision / Reason | `replace`, `create`, `adopt`, `already_migrated`, or `remain_on_source` with the preview's reason. |
| Source action / owner / due by | **The exact TeamUp action**, owned by **Sean**, due the day before the first MatFlow collection. |

The source actions, verbatim in shape:

- **replace** — "After the MatFlow replacement is applied and checked (customer, amount, start date): end the TeamUp membership so the charge that opened the current period is its final one and nothing is taken on or after *<period end>*. Ending it cancels TeamUp's subscription *<old id>*; do NOT cancel the MatFlow subscription (`metadata.matflowReplaces` = *<old id>*)."
- **create** — "After the MatFlow subscription is applied and checked: end the TeamUp membership so its final charge falls before *<due date>* — no TeamUp charge on or after that date. Do NOT cancel the MatFlow subscription (`metadata.matflowMemberId` = *<member id>*)."
- **adopt** — "Only if TeamUp has confirmed in writing that ending a membership does not cancel its Stripe subscription: end the TeamUp membership effective *<period end>* — do NOT cancel the Stripe subscription *<id>*." TeamUp has **not** confirmed this; adopt stays off for Total BJJ (see `TEAMUP-MIGRATION.md`).
- **already_migrated** with TeamUp still live — "End the TeamUp membership now…", due the snapshot day.
- **remain_on_source** — "Change nothing in TeamUp."

The summary (`summariseManifest`) gives counts by decision (they add up to the row count), the number of rows with exceptions, the monthly-equivalent value per currency split into migrating / not migrating (the split adds up to the total, and the total is the sum of the rows), rows with no known amount (counted, never guessed), and the first-cohort candidates.

## Producing it

1. **Fresh source snapshot, immediately before.** Export the TeamUp memberships and re-import (or confirm nothing changed since the last import) **on the day of the run**. Record the export time as `sourceExportedAt`. The manifest flags `sourceStale` when the export is more than 24 hours older than the snapshot, or later than it. A stale manifest is not signed; re-export. A manifest from yesterday is a record of yesterday.
2. **Preview** (Settings → Revenue → Move memberships → Preview, "Keep existing subscriptions" unticked). Record the preview time as `snapshotAt`.
3. **Attach payer links** for every junior and every family account before building: the parent link from the member record, or Sean's written confirmation of who pays. Do not fill a payer in from the email.
4. **Build** the manifest and summary from the preview rows and export the CSV. Every cell is written through `lib/csv.ts` (RFC-4180 quoting and the formula-injection prefix), so a member named `=HYPERLINK(…)` opens as text.

## Sign-off

The manifest is signed by **two people**: Noe (MatFlow — the rows reflect the preview, the ids and dates are right) and **Sean** (the club — each beneficiary, payer and amount is the person and the price he expects, and he will perform each TeamUp action by its due date). Record against the signed copy: the snapshot time, the source export time, the summary counts and totals, and the list of member ids approved for apply. Only approved member ids are sent to apply; apply recomputes the preview and acts only on rows still actionable, so a row that changed since signing is skipped, not guessed.

## The first cohort

The first live apply is **at most five members**, chosen by the rule in `summariseManifest`:

- adults only (no junior, no synthesised address);
- all on **one plan** — the plan with the most qualifying members (ties by plan name);
- a clean actionable preview row (`replace`, `create` or `adopt`) with a known amount;
- **no exceptions** of any kind, including a first collection under 48 hours away;
- taken in manifest order, first five.

Nobody else moves until every member of the first cohort has had a first MatFlow charge succeed, TeamUp has taken nothing from them on or after that date, and Sean has confirmed each TeamUp membership is ended.

## Stop conditions

Stop the run — apply nothing more, end nothing more in TeamUp — on any of these:

1. **Wrong person or wrong payer.** A beneficiary or payer on the manifest is not who Sean expects for that membership.
2. **Unexplained amount or date.** An amount, cadence or first-collection date that does not match what the member pays in TeamUp today, with no recorded reason.
3. **Uncertain provider outcome.** Apply returned an error or timed out after Stripe may have acted. **Reconcile before any retry**: list the customer's subscriptions and look for `metadata.matflowMemberId` = the member id (the engine does the same, but a person confirms it first). Found → the subscription exists; link, do not re-create. Not found → safe to retry.
4. **Changed source state.** The member's TeamUp membership, plan, hold or payment method changed between the snapshot and the apply. Re-export, re-preview, rebuild, re-sign.
5. **Unexpected charge.** Any charge from TeamUp on or after a first MatFlow collection date, any charge from MatFlow before it, or two charges in one period.

**A replacement id is not permission to end the source membership.** Apply printing `replaced → sub_…` only says Stripe accepted a create. Before Sean ends anything in TeamUp, the replacement is checked in Stripe: right customer, `status` active, `billing_cycle_anchor` equal to the old period end, the expected price and amount, no invoice at creation, `metadata.matflowMemberId` and `matflowReplaces` present. Then, and only then, the TeamUp action.

## Rehearsals

Each rehearsal below must pass in Stripe test mode on the test branch before the first live cohort. "Covered" means an existing script exercises it; "NOT RUN" means no script does and it has not been rehearsed.

| Rehearsal | Coverage | Status |
|---|---|---|
| Preview → apply → replace / create / skip, anchors exact, nothing charged at creation, second apply a no-op | `scripts/stripe-migration-e2e.mjs` | PASS 2026-09-24 (runbook evidence) |
| First charge on the anchor succeeds and lands as one payment through the webhook | `scripts/stripe-migration-e2e.mjs` (time-travel leg on a clocked customer) | PASS 2026-09-24 |
| **Provider success then DB failure** (Stripe creates the subscription, the member-row write fails; retry must reuse via `metadata.matflowMemberId`) | Unit-tested only (`tests/unit/migrate-memberships.test.ts`, recovery from metadata). No script injects a DB failure after a real Stripe create. | **NOT RUN** end to end |
| **Duplicate webhook** delivery | `scripts/stripe-lifecycle-e2e.mjs` step 9 replays `customer.subscription.deleted` and asserts no second status event | Covered for deletion only; duplicate `invoice.payment_succeeded` / `invoice.payment_failed` **NOT RUN** |
| **Out-of-order webhooks** (e.g. `payment_succeeded` after a later `payment_failed`, or `deleted` before `updated`) | No script | **NOT RUN** |
| **Changed source state between preview and apply** (plan, hold or payment method changes after the preview) | Apply recomputes the preview (unit-tested); no script changes Stripe state between the two calls | **NOT RUN** end to end |
| **Failed first renewal** after migration | `scripts/stripe-lifecycle-e2e.mjs` (renewal on a failing card → member `overdue`, still active and linked) and `scripts/stripe-family-e2e.mjs` (per-membership failure, siblings and parent untouched, shared failing card flips each membership separately) | Covered for subscriptions created directly; **NOT RUN** for a subscription created by the migration engine (a migrated member's first renewal failing) |
| Kid billed on a parent's customer | `scripts/stripe-family-e2e.mjs` gives each child its **own** customer, so a kid billed on the parent's customer (the TeamUp shape) is **NOT RUN** | **NOT RUN** |

The scripts need the dev server on the test branch with `.env.test`, a throwaway Custom test account and `sk_test_` keys; see each script's header. None of them may be pointed at production.

## Record for the day

| Field | Value |
|---|---|
| Source export time (`sourceExportedAt`) | |
| Preview time (`snapshotAt`) | |
| `sourceStale` | |
| Counts: replace / create / adopt / already migrated / remain | |
| Monthly equivalent — migrating / not migrating / total | |
| Rows with exceptions | |
| First-cohort plan and member ids | |
| Signed — Noe (MatFlow) | |
| Signed — Sean (club) | |
| Stop condition hit? Which, when, what was done | |
