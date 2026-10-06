# Suspension and member billing — policy

Decided 6 October 2026 in response to the operator security audit (`docs/readiness/OPERATOR-ADMIN-SECURITY-2026-10-05.md`, finding 6). It applies to `POST`/`DELETE /api/admin/customers/[id]/suspend`. Restore after soft-delete is covered in the last section.

## Decision

**Suspending a club does not change its members' billing.** Suspension never calls Stripe. It records the club's previous status and the member subscriptions that were live, and nothing more.

## Why

- **The club is the merchant.** Each club connects its own Stripe account through Standard Connect. A member's subscription is a contract between that member and the club; MatFlow is the club's software supplier. On 17 September 2026 we declined to take on platform liability: clubs carry their own losses. So MatFlow cancelling a club's member subscriptions is MatFlow stepping into a relationship it is not part of.
- **Suspension does not mean the club has stopped trading.** We suspend a club's access to MatFlow, for example over our own invoice or a terms breach. The club still runs classes, and its members are still getting what they pay for. Stopping their renewals ends revenue that the club is still earning.
- **The old behaviour could not be undone safely.** It set `cancel_at_period_end` on every subscription and carried on when Stripe refused. Un-suspending then left every one of those flags in place. If a renewal date passed during the suspension, that subscription is gone for good; reviving it needs the member to sign up again, with fresh payment authentication. Before the date passes, nothing records whether a flag was set by us or by the member, so clearing them all would also resume renewals that members had cancelled themselves.
- **A club that has really closed is a soft-delete, not a suspension.** Soft-delete stops renewals at period end. The purge fails closed while any subscription refuses to cancel (`lib/tenant-purge.ts`).

## What the code does

### Suspend (`POST`)

1. Same-origin check, operator authentication and rate limit, as before.
2. A single transaction:
   - reads the member subscriptions that are live, meaning `Member.stripeSubscriptionId` is not null;
   - flips the status to `suspended` **only if it is still the status that was read**;
   - stores `Tenant.suspendedPreviousStatus` and `Tenant.suspensionBilling`, which holds the policy name, the time, the count and the subscription ids;
   - increments every User and Member `sessionVersion`.
   If anything else changed the status in the meantime, the request returns 409 and writes nothing.
3. The audit row `admin.tenant.suspended` carries the reason, `previousStatus`, `memberBilling: "member-billing-unchanged"` and the subscription ids.
4. No Stripe call is made, so a Stripe outage can neither block a suspension nor leave one half-applied.

### Un-suspend (`DELETE`)

1. Returns 409 if the club is not suspended. The old code set any club to `active`, so a trial club that had never been suspended came off its trial.
2. Restores the status the suspension recorded. A trial club goes back to trial; `trial`, `active` and `cancelled` can all be restored. For a club suspended before this change it uses the `previousStatus` in the latest `admin.tenant.suspended` audit row. If there is no record at all, it restores `active` and reports `previousStatusSource: "default"` so the operator can correct it.
3. **Never clears `cancel_at_period_end`.** It returns `billingReview`:
   - Suspended under this policy: `{ required: false }`, because nothing was changed.
   - Suspended under the old code: `{ required: true, stripeCancelledBySuspension, stripeFailedIds, currentStripeSubscriptionIds }`. That suspension asked Stripe to stop renewing these subscriptions, and nothing has reversed it.
4. The conditional write clears both suspension columns. The audit row `admin.tenant.reactivated` records `restoredStatus`, `previousStatusSource`, `billingReviewRequired` and `legacySuspension`.

### TeamUp-billed memberships

They have no Stripe subscription in MatFlow (`stripeSubscriptionId` is null), so they never appear in the inventory and nothing about them is touched. This was already true and is now tested.

## Reviewing a legacy suspension's cancellations (operator procedure)

Use this only when un-suspend returns `billingReview.required: true`.

1. Send the list to the club owner. The subscriptions sit on the **club's** Stripe account, and the club decides; MatFlow does not.
2. The club checks each subscription in its Stripe Dashboard:
   - **Not cancelled, and the member wants to continue:** the club clears "cancel at period end" for that subscription. Before doing so it must confirm that the member did not ask to cancel during the suspension.
   - **Already ended** (the period passed): it cannot be resumed. The member subscribes again through the member app.
   - **The member asked to cancel, or it is unclear:** leave it alone.
3. MatFlow never resumes renewals in bulk, and never resumes one without a recorded instruction from the club naming that subscription. A per-subscription reversal endpoint is not built. If one is added, it must act on one subscription at a time, check the live Stripe state first, and refuse any subscription not listed in this suspension's record.

## Provider failures, retries and pending commands

Suspend and un-suspend make no provider calls, so there are none to fail or retry, and no Stripe command can be left half-done. Unit tests mock Stripe to fail and assert that it is never called (`tests/unit/tenant-lifecycle-constraints.test.ts`).

## Restore after soft-delete (related, for completeness)

- **Window.** Restore is allowed only within 30 days of the soft-delete. This is the published promise in `app/legal/privacy/page.tsx` §6: "a gym marked for deletion is recoverable for 30 days, after which its records are permanently erased."
- **Refusals.** Restore is refused with 409 once the window has passed (`recovery-window-expired`), once the purge has claimed the club (`deletion-in-progress`), or once the club is gone (`permanently-deleted`). See `lib/tenant-lifecycle.ts`.
- **Billing is not reversed.** Soft-delete still sets member subscriptions to cancel at period end, and restore does not undo that, for the same consent reason as above. After restoring a club, the operator runs the review procedure above with the club, using the soft-delete audit row (`admin.tenant.soft_deleted`, which records `stripeCancelled`, `stripeFailed` and `stripeFailedIds`).

## Not covered here

- Stripe webhooks still send emails to members of suspended clubs. This is audit finding 12 (Low) and belongs to a separate lane.
- Whether suspension should pause the club's own MatFlow invoice is a commercial question, not something this policy decides.
