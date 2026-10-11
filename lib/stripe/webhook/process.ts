// The Stripe webhook's event processor (payments lane PC, 11 Oct 2026).
//
// Moved out of app/api/stripe/webhook/route.ts so that the webhook delivery and
// an operator replay (lib/stripe/replay.ts, via loadWebhookPrepare) run the
// SAME code. A Next.js route file may export only its HTTP handlers and route
// config, so the processor could not be shared from there.
//
//   prepareStripeEvent(event, { baseUrl? })
//     does the network lookups the handler needs BEFORE any transaction opens
//     (invoice payment ids, the mandate's subscriptions, a fresh subscription
//     for ordering) and returns the processor that lane PD's store
//     (lib/stripe/event-store.ts runStripeEvent) runs inside its transaction.
//     The processor does all database work through ctx.tx and RETURNS its
//     outcome, emails, audit rows and post-commit jobs; it dispatches nothing.
//
// Resolution, ordering and state-separation rules: see the branch comments and
// lib/stripe/webhook/mapping.ts.

import type { Prisma } from "@prisma/client";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { refreshStripeAccountStatus } from "@/lib/stripe-account-status";
import { getBaseUrl } from "@/lib/env-url";
import { packCreditsAfterRefund } from "@/lib/pack-refund";
import { resolveInvoicePaymentIds, resolveMandateCustomerId, resolveSubscriptionsUsingPaymentMethod, NO_INVOICE_PAYMENT, StripeLookupError, type InvoicePaymentIds } from "@/lib/stripe/invoice-payment";
import { subscriptionStatusToPaymentStatus } from "@/lib/stripe/subscription-status";
import { readPauseCollection } from "@/lib/member-hold";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";
import {
  StripeEventRetryableError,
  type ProcessorResult,
  type QueuedAudit,
  type QueuedEmail,
  type StripeEventProcessor,
} from "@/lib/stripe/event-store";
import {
  invoiceSubscriptionId,
  isTerminalSubscriptionStatus,
  orderingVerdict,
  subscriptionCurrentPeriodEnd,
  type SubscriptionMapping,
} from "@/lib/stripe/webhook/mapping";

/** The parts of a verified Stripe event the processor reads. */
export type WebhookEvent = {
  id: string;
  type: string;
  account?: string | null;
  livemode?: boolean | null;
  created?: number | null;
  data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> };
};

// What happened to a verified, attributable event. "ignored_foreign": the
// object maps to nothing MatFlow created, migrated or adopted (another
// platform's subscription on the same customer, a charge the club took outside
// MatFlow), so nothing on any member was written. "ignored_stale": the event is
// older than the state already applied for the same object. The store records
// the value on the event's StripeEvent row; both are acked with 200.
type WebhookOutcome = ProcessorResult["outcome"];

type Tx = Prisma.TransactionClient;

/**
 * The Stripe client for the lookups made BEFORE the processing transaction
 * (review RP-5): 5 s per request and no SDK retries, so a slow or failing
 * Stripe cannot hold the delivery past Stripe's own 20 s window — the lookup
 * fails, the delivery is answered non-2xx, and Stripe retries it later.
 */
async function preTransactionStripe() {
  const StripeCtor = (await import("stripe")).default;
  return new StripeCtor(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2026-03-25.dahlia",
    timeout: 5_000,
    maxNetworkRetries: 0,
  });
}

export async function prepareStripeEvent<E extends WebhookEvent>(
  event: E,
  opts: { baseUrl?: string } = {},
): Promise<StripeEventProcessor<E>> {
  // Links in emails. The webhook passes the request's origin as a fallback;
  // a replay has no request, so NEXTAUTH_URL (getBaseUrl's first choice) decides.
  const baseUrl = opts.baseUrl ?? getBaseUrl();
  const obj = event.data.object as Record<string, unknown>;
  const stripeAccountId = event.account;

  // P0-1: resolve the real PaymentIntent/Charge for invoice events.
  //
  // Invoice on apiVersion 2026-03-25.dahlia has neither a `charge` nor a
  // `payment_intent` field — verified live against a PAID invoice, where both
  // read `undefined` while invoice.payments[].payment.payment_intent carried
  // the id. The old code read those fields through `Record<string, unknown>`
  // casts, so it compiled, silently stored nulls, and left refunds, voids and
  // disputes with nothing to reconcile against.
  //
  // Deliberately resolved HERE, before the transaction opens (P1-5): these are
  // two network round-trips to Stripe and must not hold a pooled DB connection
  // open for their duration.
  let invoicePayment: InvoicePaymentIds = NO_INVOICE_PAYMENT;
  if (
    (event.type === "invoice.payment_succeeded" || event.type === "invoice.payment_failed") &&
    typeof obj.id === "string" &&
    // Without the connected account id these retrieves would run against the
    // PLATFORM account, where the club's invoice does not exist. No account,
    // no resolution — the ids stay null rather than silently wrong.
    stripeAccountId &&
    process.env.STRIPE_SECRET_KEY
  ) {
    const stripeClient = await preTransactionStripe();
    invoicePayment = await resolveInvoicePaymentIds(stripeClient, obj.id, stripeAccountId);
  }

  // P1-5b: `mandate.updated` carries no customer. Stripe.Mandate has no
  // `customer` property at all (asserting the type is a compile error against
  // the pinned SDK — that is how this was found), so the old `obj.customer`
  // read was always undefined and the BACS mandate-failure path never ran.
  // The mandate does carry payment_method, which carries the customer.
  let mandateCustomerId: string | null = null;
  let mandateSubscriptionIds: string[] = [];
  if (
    event.type === "mandate.updated" &&
    // The handler acts ONLY on an inactive mandate, so resolving the customer
    // for any other status buys a Stripe round-trip and throws it away — on
    // every card mandate update too, not just BACS.
    obj.status === "inactive" &&
    typeof obj.payment_method === "string" &&
    stripeAccountId &&
    process.env.STRIPE_SECRET_KEY
  ) {
    const stripeClient = await preTransactionStripe();
    mandateCustomerId = await resolveMandateCustomerId(stripeClient, obj.payment_method, stripeAccountId);
    // Lane PC: the customer alone is not enough — it may also carry another
    // platform's subscription. Only the subscriptions that actually collect
    // through THIS payment method are affected by its mandate going inactive;
    // the handler then acts only on those that map to a MatFlow member.
    if (mandateCustomerId) {
      mandateSubscriptionIds = await resolveSubscriptionsUsingPaymentMethod(
        stripeClient,
        mandateCustomerId,
        obj.payment_method,
        stripeAccountId,
      );
    }
  }

  // Lane PC (ordering, audit §13): Stripe does not guarantee delivery order.
  // Before a subscription.updated is applied, the mapping's lastEventCreated
  // decides: older -> stale (decided inside the transaction, atomically); same
  // second, or a mapping that has never had an event applied (the backfilled
  // rows) -> retrieve the subscription FRESH from the club's account and apply
  // that state rather than the payload's. Done here, outside the transaction,
  // so the network call never holds a pooled connection.
  let freshSubscription: Record<string, unknown> | null = null;
  if (
    event.type === "customer.subscription.updated" &&
    typeof obj.id === "string" &&
    stripeAccountId &&
    process.env.STRIPE_SECRET_KEY
  ) {
    const subscriptionId = obj.id;
    const known = await withRlsBypass(async (tx) => {
      const t = await tx.tenant.findFirst({ where: { stripeAccountId }, select: { id: true } });
      if (!t) return null;
      return tx.memberSubscription.findFirst({
        where: { tenantId: t.id, stripeSubscriptionId: subscriptionId },
        select: { lastEventCreated: true, status: true },
      });
    });
    if (known && !isTerminalSubscriptionStatus(known.status) && orderingVerdict(known, event.created) === "fetch_fresh") {
      try {
        const stripeClient = await preTransactionStripe();
        const fresh = await stripeClient.subscriptions.retrieve(subscriptionId, {}, { stripeAccount: stripeAccountId });
        freshSubscription = fresh as unknown as Record<string, unknown>;
      } catch (err) {
        // Review RP-7: the fresh state is needed precisely because the payload
        // may be stale, so falling back to the payload could apply an old
        // state. The delivery is refused (retryable) and Stripe retries.
        console.error("[stripe-webhook] fresh subscription retrieve failed — Stripe will retry", {
          eventId: event.id,
          subscriptionId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw new StripeLookupError("stripe_lookup_failed:subscription");
      }
    }
  }

  return async (_event: E, { tx }: { tx: Tx }): Promise<ProcessorResult> => {
  // Side-effects (emails, audit logs) are collected during the transaction and
  // dispatched ONLY after it commits — a rollback must never fire a duplicate
  // notification (A3H-2). The account-status refresh is likewise deferred
  // (Tier 2.5): it does network I/O + opens its own transaction, which would
  // self-deadlock on the connection_limit=1 pool if run inside this tx.
  // Lane PC wiring of lane PD's store: the processor RETURNS these; the store
  // writes the audit rows inside the processing transaction (durable) and
  // sends the emails after it commits.
  const pendingEmails: QueuedEmail[] = [];
  const pendingAuditLogs: QueuedAudit[] = [];
    let accountStatusRefresh: { tenantId: string; stripeAccountId: string } | null = null;
    let outcome = "processed" as WebhookOutcome;

      // Tier 2.4: the event must be attributable to a connected account + tenant.
      // If not (event.account missing, or the connect-callback write hasn't landed
      // yet / a disconnect→reconnect window), THROW so the tx rolls back and
      // Stripe retries — acking 200 here would mean money taken, nothing delivered.
      if (!stripeAccountId) {
        throw new StripeEventRetryableError("Event missing connected account");
      }
      const tenant = await tx.tenant.findFirst({
        where: { stripeAccountId },
        select: { id: true },
      });
      const tenantId = tenant?.id ?? null;
      if (!tenantId) {
        throw new StripeEventRetryableError("Connected account not linked to a tenant yet");
      }
    async function findMember(customerId: string) {
      // Audit iter-1-database A8I1-S-4 [High]: refuse to look up without
      // a resolved tenantId. Member.stripeCustomerId has no global unique
      // constraint (only the partial unique added in
      // 20260601000002_area8_rls_fk_indexes), so a no-tenant fallback
      // returns arbitrary rows when two tenants happen to share a
      // customer ID (test-mode re-use, Stripe Connect mis-config, dev
      // data migration). Wrong tenant's payment status gets mutated.
      // The earlier resolveTenantForEvent path already logs the failure;
      // we just refuse to act.
      if (!tenantId) {
        console.error(
          `[stripe-webhook] No tenantId resolved for customer ${customerId} — refusing member lookup (A8I1-S-4)`,
        );
        return null;
      }
      return tx.member.findFirst({
        where: { stripeCustomerId: customerId, tenantId },
        select: { id: true, tenantId: true, status: true },
      });
    }

    // ── Lane PC: verified resolution (audit §11, §13, §17) ─────────────────
    // findMember above (by customer) is now used ONLY by payment_method.detached,
    // which writes an audit row and nothing else; customer.deleted clears the
    // customer link by customer id. Every other member-affecting branch resolves
    // through a MemberSubscription mapping, a Payment row MatFlow wrote, or
    // MatFlow's own metadata — never "whoever owns this customer".
    async function mappingFor(subscriptionId: string | null): Promise<SubscriptionMapping | null> {
      if (!subscriptionId) return null;
      return tx.memberSubscription.findFirst({
        where: { tenantId: tenantId!, stripeSubscriptionId: subscriptionId },
        select: {
          id: true, tenantId: true, memberId: true, stripeSubscriptionId: true,
          status: true, lastEventCreated: true, endedAt: true, requiresActionInvoiceId: true,
          membershipTierId: true, priorPaymentStatus: true, firstPaidAt: true,
        },
      });
    }
    // The member a mapping belongs to, and whether that mapping is the member's
    // ACTIVE one (Member.stripeSubscriptionId points at it). Only the active
    // mapping may move the member's payment state.
    async function mappedMember(mapping: SubscriptionMapping) {
      const m = await tx.member.findFirst({
        where: { id: mapping.memberId, tenantId: tenantId! },
        select: { id: true, tenantId: true, status: true, stripeSubscriptionId: true },
      });
      if (!m) return null;
      return { ...m, isActive: m.stripeSubscriptionId === mapping.stripeSubscriptionId };
    }
    async function memberInTenant(memberId: string | null | undefined) {
      if (!memberId) return null;
      return tx.member.findFirst({
        where: { id: memberId, tenantId: tenantId! },
        select: { id: true, tenantId: true, status: true, stripeSubscriptionId: true },
      });
    }
    // Invoice events: the subscription's mapping first; for an invoice with no
    // subscription, MatFlow's own metadata; else a Payment row MatFlow already
    // holds for this invoice (or its resolved PaymentIntent). Nothing else.
    async function resolveInvoiceOwner(existingPayment: { memberId: string | null } | null) {
      const subscriptionId = invoiceSubscriptionId(obj);
      if (subscriptionId) {
        const mapping = await mappingFor(subscriptionId);
        if (mapping) {
          const member = await mappedMember(mapping);
          return member ? { member, mapping } : null;
        }
      } else {
        const meta = (obj.metadata as Record<string, string> | null | undefined) ?? {};
        if (meta.matflowTenantId === tenantId && meta.matflowMemberId) {
          const member = await memberInTenant(meta.matflowMemberId);
          if (member) return { member: { ...member, isActive: false }, mapping: null };
        }
      }
      if (existingPayment?.memberId) {
        const member = await memberInTenant(existingPayment.memberId);
        if (member) return { member: { ...member, isActive: false }, mapping: null };
      }
      return null;
    }
    async function existingInvoicePayment(invoiceId: string) {
      return tx.payment.findFirst({
        where: {
          tenantId: tenantId!,
          OR: [
            { stripeInvoiceId: invoiceId },
            ...(invoicePayment.paymentIntentId ? [{ stripePaymentIntentId: invoicePayment.paymentIntentId }] : []),
          ],
        },
        select: { id: true, status: true, memberId: true },
      });
    }

    // Fix 3 (T-1): refresh cached Tenant.stripeAccountStatus on every
    // account.updated event so checkout/portal gates see the latest
    // charges_enabled / payouts_enabled / past-due signals in seconds.
    if (event.type === "account.updated") {
      // Tier 2.5: do NOT call refreshStripeAccountStatus here — it makes a Stripe
      // network call and opens its own transaction, which must never run while
      // this processing transaction holds a pooled connection. Flag it; the
      // store runs it as a post-commit `after` job (returned below).
      accountStatusRefresh = { tenantId, stripeAccountId };
      pendingAuditLogs.push({
        tenantId,
        userId: null,
        action: "stripe.webhook.account_updated",
        entityType: "Tenant",
        entityId: tenantId,
        metadata: { stripeAccountId },
      });
    } else if (event.type === "customer.subscription.deleted") {
      // Lane PC: resolved through the subscription's mapping, never the
      // customer. A subscription MatFlow did not create, migrate or adopt
      // (TeamUp's, in the replace window) is acknowledged and changes nothing.
      //
      // Before 11 Oct 2026 this branch set Member.status = "cancelled",
      // cancelledAt and a MemberStatusEvent (A3C-1, D1, M1). It no longer
      // does: the end of a Stripe subscription is PAYMENT state. On the
      // member's ACTIVE subscription the pointer is cleared and paymentStatus
      // becomes "cancelled" (no coverage); whether the person's membership ends
      // is MatFlow's decision (staff action), not Stripe's. On any other
      // mapping only that mapping ends.
      const deletedSubId = typeof obj.id === "string" ? obj.id : null;
      const mapping = await mappingFor(deletedSubId);
      if (!mapping) {
        outcome = "ignored_foreign";
      } else {
        const created = typeof event.created === "number" ? event.created : null;
        await tx.memberSubscription.update({
          where: { id: mapping.id },
          data: {
            status: "canceled",
            endedAt: mapping.endedAt ?? new Date(),
            lastEventCreated: Math.max(Number(mapping.lastEventCreated ?? 0), created ?? 0) || null,
          },
        });
        const owner = await mappedMember(mapping);
        if (owner?.isActive) {
          // Review RP-2: a subscription that was never paid gave the member
          // nothing; its end puts back the payment state they had when
          // MatFlow created it (a desk payer is paid again). A paid one ends
          // as "cancelled" (no coverage).
          const endedPaymentStatus = !mapping.firstPaidAt && mapping.priorPaymentStatus ? mapping.priorPaymentStatus : "cancelled";
          await tx.member.update({
            where: { id: owner.id },
            data: { stripeSubscriptionId: null, paymentStatus: endedPaymentStatus },
          });
          // A3H-9 / D2: audit the Stripe-initiated end, keyed to Member.id so
          // the member's DSAR export and timeline carry it.
          pendingAuditLogs.push({
            tenantId,
            userId: null,
            action: "member.subscription.cancelled_by_stripe",
            entityType: "Member",
            entityId: owner.id,
            metadata: { stripeCustomerId: (obj.customer as string) ?? null, stripeSubscriptionId: deletedSubId },
          });
        }
      }
    } else if (event.type === "invoice.payment_failed") {
      // Lane PC: the invoice's subscription mapping decides whose payment this
      // is (F4), and a failure never overwrites an invoice already recorded as
      // paid (F5): Stripe can deliver payment_failed after payment_succeeded
      // for the same invoice. A failed-then-succeeded invoice still resolves to
      // succeeded (the succeeded branch overwrites "failed").
      const failedInvoiceId = obj.id as string;
      const priorPayment = await existingInvoicePayment(failedInvoiceId);
      const invoiceOwner = await resolveInvoiceOwner(priorPayment);
      if (!invoiceOwner) {
        outcome = "ignored_foreign";
      } else if (priorPayment && priorPayment.status !== "failed" && priorPayment.status !== "pending") {
        outcome = "ignored_stale";
      } else {
        const member = invoiceOwner.member;
        // Round 3 (lane PB browser runs, lane TS events): a failure of the
        // subscription's FIRST invoice — the mapping is still "incomplete"
        // (card declined at sign-up, or 3-D Secure still pending) — happens
        // while the payer is on the payment form. It is recorded on the
        // Payment row and on the mapping only: no overdue, no audit, no
        // member or owner payment-failed email. Dunning is for renewals.
        const firstPaymentAttempt =
          invoiceOwner.mapping?.status === "incomplete" || obj.billing_reason === "subscription_create";
        if (invoiceOwner.mapping) {
          await tx.memberSubscription.update({
            where: { id: invoiceOwner.mapping.id },
            data: { lastPaymentFailedAt: new Date(), lastFailedInvoiceId: failedInvoiceId },
          });
        }
        const memberFull = await tx.member.findUnique({
          where: { id: member.id },
          select: { name: true, email: true, tenant: { select: { name: true } }, parent: { select: { email: true } } },
        });
        // Overdue only for the member's ACTIVE subscription: a failed invoice
        // of a superseded or abandoned subscription is recorded, not acted on.
        if (member.isActive && !firstPaymentAttempt) {
          await tx.member.update({
            where: { id: member.id },
            data: { paymentStatus: "overdue" },
          });
        }
        await tx.payment.upsert({
          where: { stripeInvoiceId: obj.id as string },
          create: {
            tenantId: member.tenantId,
            memberId: member.id,
            stripeInvoiceId: obj.id as string,
            stripePaymentIntentId: invoicePayment.paymentIntentId,
            stripeChargeId: invoicePayment.chargeId,
            amountPence: (obj.amount_due as number) ?? 0,
            currency: ((obj.currency as string) ?? "gbp").toUpperCase(),
            status: "failed",
            description: (obj.description as string) ?? null,
            failureReason: (obj.last_finalization_error as { message?: string } | null)?.message ?? null,
          },
          update: {
            status: "failed",
            stripePaymentIntentId: invoicePayment.paymentIntentId,
            stripeChargeId: invoicePayment.chargeId,
            failureReason: (obj.last_finalization_error as { message?: string } | null)?.message ?? null,
          },
        });
        // D3: audit the failure for EVERY member, not only those with an email
        // on file. Previously this push sat inside the `if (memberFull?.email)`
        // block, so an email-less member got the overdue flip + failed ledger
        // row but no audit trail of the failure.
        const amountPence = (obj.amount_due as number) ?? 0;
        const currency = ((obj.currency as string) ?? "gbp").toUpperCase();
        const failureReason = (obj.last_finalization_error as { message?: string } | null)?.message ?? null;
        if (!firstPaymentAttempt) pendingAuditLogs.push({
          tenantId: member.tenantId,
          userId: null,
          action: "member.payment.failed",
          entityType: "Member",
          entityId: member.id,
          metadata: {
            stripeInvoiceId: (obj.id as string) ?? null,
            amountPence,
            currency,
            reason: failureReason,
          },
        });
        // A child's address is synthesised and has no inbox: tell the parent
        // who pays instead, never the placeholder (triage of the e2e suite,
        // 30 Sep 2026: payment_failed rows were queued to kid-…@no-login…).
        const failedTo = memberFull?.email && !isSynthesisedEmail(memberFull.email)
          ? memberFull.email
          : memberFull?.parent?.email && !isSynthesisedEmail(memberFull.parent.email)
            ? memberFull.parent.email
            : null;
        // Dunning emails only for a RENEWAL of the member's ACTIVE subscription (lane PC).
        if (member.isActive && !firstPaymentAttempt && memberFull && failedTo) {
          const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
          const portalUrl = `${baseUrl}/member/profile`;
          const formattedAmount = `${symbol}${(amountPence / 100).toFixed(2)}`;
          // Audit iter-1-member-lifecycle A3H-2: queue instead of dispatch.
          pendingEmails.push({
            tenantId: member.tenantId,
            templateId: "payment_failed",
            to: failedTo,
            vars: {
              memberName: memberFull.name,
              gymName: memberFull.tenant.name,
              portalUrl,
              amount: formattedAmount,
            },
          });

          // Assessment Fix #5: dunning notification to owner so they know
          // a member's payment failed without waiting for the next dashboard
          // load. Stripe Smart Retries handle the actual retry; this email
          // is purely for owner awareness ("you may want to message them").
          const owners = await tx.user.findMany({
            where: { tenantId: member.tenantId, role: "owner" },
            select: { email: true },
          }).catch(() => []);
          const dashboardUrl = `${baseUrl}/dashboard/members/${member.id}`;
          for (const owner of owners) {
            pendingEmails.push({
              tenantId: member.tenantId,
              templateId: "payment_failed_owner",
              to: owner.email,
              vars: {
                memberName: memberFull.name,
                memberEmail: memberFull.email,
                gymName: memberFull.tenant.name,
                amount: formattedAmount,
                dashboardUrl,
                reason: failureReason ?? "",
              },
            });
          }
        }
      }
    } else if (event.type === "invoice.payment_succeeded") {
      // Lane PC: whose payment this is comes from the subscription's mapping
      // (or MatFlow's metadata / an existing Payment row for an invoice with no
      // mapped subscription), never from the customer. Only the member's
      // ACTIVE subscription moves their paymentStatus.
      const succeededInvoiceId = obj.id as string;
      const priorPayment = await existingInvoicePayment(succeededInvoiceId);
      const invoiceOwner = await resolveInvoiceOwner(priorPayment);
      if (!invoiceOwner) outcome = "ignored_foreign";
      // A refund or dispute already recorded against this invoice's payment is
      // later than any "succeeded": a redelivered success must not resurrect it.
      else if (priorPayment && (priorPayment.status === "refunded" || priorPayment.status === "disputed")) outcome = "ignored_stale";
      const member = outcome === "processed" ? invoiceOwner?.member ?? null : null;
      // The renewal that was waiting on the payer is paid: clear the marker.
      if (invoiceOwner?.mapping && invoiceOwner.mapping.requiresActionInvoiceId === succeededInvoiceId) {
        await tx.memberSubscription.update({
          where: { id: invoiceOwner.mapping.id },
          data: { requiresActionInvoiceId: null, requiresActionAt: null },
        });
      }
      // Review RP-2: entitlement follows payment, not sign-up. The FIRST paid
      // invoice of the member's active mapping is when the tier the sign-up
      // was for becomes the member's tier (never at creation). The
      // conditional update makes "first" atomic across redeliveries.
      if (member && invoiceOwner?.mapping) {
        const firstPaid = await tx.memberSubscription.updateMany({
          where: { id: invoiceOwner.mapping.id, firstPaidAt: null },
          data: { firstPaidAt: new Date() },
        });
        if (firstPaid.count === 1 && member.isActive && invoiceOwner.mapping.membershipTierId) {
          const tier = await tx.membershipTier.findFirst({
            where: { id: invoiceOwner.mapping.membershipTierId, tenantId: tenantId! },
            select: { id: true, name: true },
          });
          if (tier) {
            await tx.member.update({
              where: { id: member.id },
              data: { membershipTierId: tier.id, membershipType: tier.name },
            });
          }
        }
      }
      // A £0 invoice is not a payment. Stripe issues one the moment a
      // subscription is created with a future `billing_cycle_anchor` and no
      // proration — the shape a membership migrated from another platform
      // takes, so its first real charge lands on the member's existing due
      // date. Recording it would put a £0 "payment" in the member's history
      // and the club's revenue export. The member is still confirmed paid.
      const zeroAmountInvoice = ((obj.amount_paid as number) ?? 0) === 0 && ((obj.amount_due as number) ?? 0) === 0;
      if (member && zeroAmountInvoice) {
        if (member.isActive) {
          await tx.member.update({
            where: { id: member.id },
            data: { paymentStatus: "paid" },
          });
        }
      } else if (member) {
        // A3H-9: audit-log the successful payment.
        pendingAuditLogs.push({
          tenantId: member.tenantId,
          userId: null,
          action: "member.payment.succeeded",
          entityType: "Member",
          entityId: member.id,
          metadata: {
            stripeInvoiceId: (obj.id as string) ?? null,
            amountPence: (obj.amount_paid as number) ?? 0,
            currency: ((obj.currency as string) ?? "gbp").toUpperCase(),
          },
        });
        if (member.isActive) {
          await tx.member.update({
            where: { id: member.id },
            data: { paymentStatus: "paid" },
          });
        }
        // A1: a subscription charge fires BOTH invoice.payment_succeeded and
        // payment_intent.succeeded. The PI leg keys its upsert on
        // stripePaymentIntentId; key THIS leg on the same PI (when present) so
        // the two legs converge on ONE Payment row regardless of delivery order
        // — instead of two 'succeeded' rows (double-counted revenue) or a P2002
        // collision on the @unique stripePaymentIntentId. Fall back to the
        // invoice id only when the payload carries no payment_intent.
        const invoiceId = obj.id as string;
        // main keyed this upsert on obj.payment_intent so the two legs converge
        // on one row. The intent was right and the field was wrong: Invoice on
        // 2026-03-25.dahlia carries neither payment_intent nor charge, so this
        // read undefined every time, the convergence never happened, and every
        // invoice-created row stored a null PI. The id now comes from the
        // resolver (invoice.payments[].payment), so the design does what its
        // comment says it does.
        const invoicePiId = invoicePayment.paymentIntentId;
        const invoicePaidAt = new Date(((obj.status_transitions as { paid_at?: number } | undefined)?.paid_at ?? Date.now() / 1000) * 1000);
        await tx.payment.upsert({
          where: invoicePiId ? { stripePaymentIntentId: invoicePiId } : { stripeInvoiceId: invoiceId },
          create: {
            tenantId: member.tenantId,
            memberId: member.id,
            stripeInvoiceId: invoiceId,
            stripePaymentIntentId: invoicePiId,
            stripeChargeId: invoicePayment.chargeId,
            amountPence: (obj.amount_paid as number) ?? 0,
            currency: ((obj.currency as string) ?? "gbp").toUpperCase(),
            status: "succeeded",
            description: (obj.description as string) ?? null,
            paidAt: invoicePaidAt,
          },
          update: {
            status: "succeeded",
            // Stamp the invoice id so a row first created by the PI leg gets
            // reconciled to this invoice (and isn't seen as a separate payment).
            stripeInvoiceId: invoiceId,
            // Never null out an id the PI leg already recorded: when the
            // resolver comes back empty this upsert keys on the invoice id, and
            // an unconditional write would erase a good PI/charge with null.
            ...(invoicePiId ? { stripePaymentIntentId: invoicePiId } : {}),
            ...(invoicePayment.chargeId ? { stripeChargeId: invoicePayment.chargeId } : {}),
            paidAt: invoicePaidAt,
          },
        });
      }
    } else if (event.type === "checkout.session.completed") {
      // One-off purchases (class packs etc.) flagged via metadata.matflowKind.
      // Cross-check metadata.tenantId against the tenant resolved from
      // event.account (line 92). Without this, an attacker controlling a
      // separate connected Stripe account could craft metadata pointing at a
      // different tenant's packId/memberId and we'd trust it. The signature
      // protects the payload's authenticity but Stripe metadata is set by
      // the application — and metadata.tenantId in particular shouldn't be
      // trusted as authoritative for the tenant scope of this checkout.
      // (Security audit iteration 2 / M8, 2026-05-07.)
      const metadata = (obj.metadata as Record<string, string> | undefined) ?? {};
      if (
        metadata.matflowKind === "class_pack" &&
        metadata.packId && metadata.memberId && metadata.tenantId &&
        metadata.tenantId === tenantId
      ) {
        const pack = await tx.classPack.findFirst({
          where: { id: metadata.packId, tenantId: metadata.tenantId },
        });
        // C2: validate the member exists in THIS tenant before attributing a
        // class pack + succeeded Payment to metadata.memberId. The pack beside
        // it is already re-fetched tenant-scoped, but the member was trusted
        // straight from attacker-settable metadata — and Member.id is a global
        // FK, so a foreign/invalid id would still insert, minting credits and a
        // ledger row against the wrong member. (M8 defence-in-depth, 2026-05-07.)
        const packMember = await tx.member.findFirst({
          where: { id: metadata.memberId, tenantId: metadata.tenantId },
          select: { id: true },
        });
        if (pack && packMember) {
          const expiresAt = new Date(Date.now() + pack.validityDays * 24 * 60 * 60 * 1000);
          const paymentIntentId = (obj.payment_intent as string) ?? null;
          // Mirror as a Payment row so the ledger is complete
          const amountPence = (obj.amount_total as number) ?? pack.pricePence;
          // Decide the duplicate BEFORE writing (lane PC, 11 Oct 2026). This used to
          // create first and swallow a P2002 from the unique stripePaymentIntentId;
          // but Postgres has aborted the transaction by then, so the store could not
          // mark the event and it was recorded failed and retried for ever (lane PD
          // proved it). A pack already minted for this PaymentIntent means this
          // purchase is on record: nothing to write, no second receipt. Any other
          // error, including a genuine race on the unique key, now fails the
          // handler cleanly and Stripe's retry finds the pack.
          const alreadyMinted = paymentIntentId
            ? await tx.memberClassPack.findUnique({ where: { stripePaymentIntentId: paymentIntentId }, select: { id: true } })
            : null;
          if (!alreadyMinted) {
            // Already inside a transaction (withRlsBypass) — sequential awaits
            // remain atomic without a nested $transaction.
            await tx.memberClassPack.create({
              data: {
                tenantId: metadata.tenantId,
                memberId: metadata.memberId,
                packId: pack.id,
                creditsRemaining: pack.totalCredits,
                expiresAt,
                stripePaymentIntentId: paymentIntentId,
                status: "active",
              },
            });
            await tx.payment.upsert({
              where: paymentIntentId
                ? { stripePaymentIntentId: paymentIntentId }
                : { id: "__never__" },
              create: {
                tenantId: metadata.tenantId,
                memberId: metadata.memberId,
                stripePaymentIntentId: paymentIntentId,
                amountPence,
                currency: ((obj.currency as string) ?? pack.currency).toUpperCase(),
                status: "succeeded",
                description: `Class pack: ${pack.name}`,
                paidAt: new Date(),
              },
              update: {
                status: "succeeded",
                paidAt: new Date(),
              },
            });
            // Receipt (money-gap (b)) — queued post-commit like every other
            // webhook email; reached only when this event minted the pack, so a
            // re-delivery can't queue a second receipt.
            const packBuyer = await tx.member.findFirst({
              where: { id: metadata.memberId, tenantId: metadata.tenantId },
              select: { name: true, email: true, tenant: { select: { name: true } } },
            });
            if (packBuyer?.email) {
              const cur = ((obj.currency as string) ?? pack.currency).toUpperCase();
              const symbol = cur === "USD" ? "$" : cur === "EUR" ? "€" : "£";
              pendingEmails.push({
                tenantId: metadata.tenantId,
                templateId: "receipt",
                to: packBuyer.email,
                vars: {
                  memberName: packBuyer.name,
                  gymName: packBuyer.tenant.name,
                  amount: `${symbol}${(amountPence / 100).toFixed(2)}`,
                  description: `Class pack: ${pack.name}`,
                  paidDate: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
                },
              });
            }
          }
        }
      } else if (
        metadata.matflowKind === "shop_order" &&
        metadata.tenantId && metadata.orderRef &&
        metadata.tenantId === tenantId
      ) {
        // LB-001 follow-up: Stripe-paid shop Order created in /api/member/checkout
        // is in 'pending' until this webhook flips it. Tenant-scoped + idempotent
        // (a second event for the same Order is a no-op because we filter on
        // status='pending'). Cross-check metadata.tenantId vs resolved tenantId
        // matches the class_pack branch above (M8, 2026-05-07).
        //
        // The flip is a single updateMany rather than findFirst-then-update:
        // the status filter and the write land in one statement, so two
        // concurrent deliveries of the same event cannot both pass the guard
        // and double-credit the order.
        const flipped = await tx.order.updateMany({
          where: { tenantId: metadata.tenantId, orderRef: metadata.orderRef, status: "pending" },
          data: { status: "paid", paidAt: new Date() },
        });
        // Ledger mirror and receipt both fire only when THIS event flipped the
        // order (count 0 on replay), so neither is duplicated.
        if (flipped.count > 0) {
          const order = await tx.order.findFirst({
            where: { tenantId: metadata.tenantId, orderRef: metadata.orderRef },
            select: {
              memberId: true,
              totalPence: true,
              currency: true,
              member: { select: { name: true, email: true, tenant: { select: { name: true } } } },
            },
          });
          if (order) {
            // A2: mirror a Payment row so the Stripe shop sale is visible to the
            // revenue/ledger/CSV surfaces (revenue/summary, /dashboard/payments,
            // export.csv) — all of which read Payment, never Order. Mirrors the
            // class_pack branch above. Idempotent on the @unique stripePaymentIntentId:
            // the upsert itself decides insert-or-update. There is no catch any
            // more (lane PC, 11 Oct 2026): a swallowed P2002 left the transaction
            // aborted, so the event was recorded failed and retried for ever. A
            // genuine race on the key now fails the handler cleanly; Stripe's retry
            // finds the row and the upsert updates it.
            const paymentIntentId = (obj.payment_intent as string) ?? null;
            await tx.payment.upsert({
              where: paymentIntentId
                ? { stripePaymentIntentId: paymentIntentId }
                : { id: "__never__" },
              create: {
                tenantId: metadata.tenantId,
                memberId: order.memberId,
                stripePaymentIntentId: paymentIntentId,
                amountPence: order.totalPence,
                currency: ((obj.currency as string) ?? "gbp").toUpperCase(),
                status: "succeeded",
                description: `Shop order ${metadata.orderRef}`,
                paidAt: new Date(),
              },
              update: { status: "succeeded", paidAt: new Date() },
            });

            if (order.member?.email) {
              const cur = (order.currency ?? "GBP").toUpperCase();
              const symbol = cur === "USD" ? "$" : cur === "EUR" ? "€" : "£";
              pendingEmails.push({
                tenantId: metadata.tenantId,
                templateId: "receipt",
                to: order.member.email,
                vars: {
                  memberName: order.member.name,
                  gymName: order.member.tenant.name,
                  amount: `${symbol}${(order.totalPence / 100).toFixed(2)}`,
                  description: `Shop order ${metadata.orderRef}`,
                  paidDate: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
                },
              });
            }
          }
        }
      } else {
        // Not a checkout MatFlow created for this club (no matching metadata).
        outcome = "ignored_foreign";
      }
    } else if (event.type === "payment_intent.processing") {
      // BACS Direct Debit takes ~4 working days to settle.
      //
      // Lane PC: this branch used to set Member.paymentStatus = "pending" for
      // whoever owned the CUSTOMER — which, in the replace window, included a
      // member whose processing debit was TeamUp's. A PaymentIntent now counts
      // as MatFlow's only through a Payment row MatFlow wrote for it or
      // MatFlow's own metadata, and those are one-off charges whose in-flight
      // state already lives on the Payment row ("pending"). A subscription's
      // debit is settled by its invoice events, through the mapping. So the
      // event is classified and nothing on the member is written; the first
      // payment of a new subscription is "pending" from creation
      // (lib/stripe/subscriptions.ts).
      const processingPiId = typeof obj.id === "string" ? obj.id : null;
      const processingRow = processingPiId
        ? await tx.payment.findFirst({ where: { tenantId, stripePaymentIntentId: processingPiId }, select: { id: true } })
        : null;
      const processingMeta = (obj.metadata as Record<string, string> | null | undefined) ?? {};
      const processingMember = !processingRow && processingMeta.tenantId === tenantId
        ? await memberInTenant(processingMeta.memberId)
        : null;
      if (!processingRow && !processingMember) outcome = "ignored_foreign";
    } else if (event.type === "mandate.updated") {
      // BACS mandate status flipped (active / inactive / pending). Track on member preferredPaymentMethod.
      //
      // Lane PC: the mandate's customer may also pay another platform's
      // subscription. Only MatFlow subscriptions that collect through THIS
      // payment method (resolved before the transaction) are affected, and
      // only the member whose ACTIVE subscription it is is marked overdue.
      const status = (obj.status as string) ?? "";
      if (status === "inactive") {
        const affected = mandateSubscriptionIds.length > 0
          ? await tx.memberSubscription.findMany({
              where: { tenantId, stripeSubscriptionId: { in: mandateSubscriptionIds }, endedAt: null },
              select: {
                id: true, tenantId: true, memberId: true, stripeSubscriptionId: true,
                status: true, lastEventCreated: true, endedAt: true,
              },
            })
          : [];
        if (affected.length === 0) outcome = "ignored_foreign";
        for (const mapping of affected) {
          const owner = await mappedMember(mapping);
          if (owner?.isActive) {
            await tx.member.update({
              where: { id: owner.id },
              data: { paymentStatus: "overdue", preferredPaymentMethod: "card" },
            });
          }
        }
      }
    } else if (event.type === "charge.refunded") {
      const chargeId = obj.id as string;
      const paymentIntentId = (obj.payment_intent as string | null) ?? null;
      const refundedAmount = (obj.amount_refunded as number) ?? 0;
      // Tenant-scoped, like every other query in the product. This handler
      // runs inside withRlsBypass, so row-level security cannot backstop a
      // missing filter here — the where-clause IS the boundary. Stripe ids are
      // globally unique today, which is why this has not bitten anyone; it is
      // still one mis-recorded id away from a webhook writing a refund into
      // another club's ledger. A miss now means "not this tenant's payment"
      // and is logged below rather than silently doing nothing.
      // Match by charge id first; fall back to the payment_intent id so
      // paymentIntent-only payments (refunded via the PI, with no stripeChargeId
      // stored) still reconcile — e.g. when the API DB write failed and the
      // webhook is the eventual-consistency backstop.
      let existing = await tx.payment.findFirst({ where: { tenantId, stripeChargeId: chargeId } });
      if (!existing && paymentIntentId) {
        existing = await tx.payment.findFirst({ where: { tenantId, stripePaymentIntentId: paymentIntentId } });
      }
      if (!existing) {
        outcome = "ignored_foreign";
        // Not silence: a refund we cannot attribute is a ledger that will
        // disagree with Stripe, and nobody would otherwise know.
        console.warn(
          `[stripe-webhook] charge.refunded — no Payment for tenant ${tenantId} ` +
          `(charge=${chargeId}, paymentIntent=${paymentIntentId}). Ledger not updated.`,
        );
      }
      // Status "refunded" means the charge is exhausted (under both old and
      // new semantics) — nothing further can be refunded, so replays and
      // late events are safely skipped. Partials keep status "succeeded" and
      // flow through to update the cumulative below.
      if (existing && existing.status !== "refunded") {
        // `amount_refunded` is Stripe's authoritative CUMULATIVE total. Only
        // flip status to "refunded" when the charge is exhausted — a partial
        // dashboard refund must leave the remainder refundable in MatFlow
        // (parity with app/api/payments/[id]/refund).
        const fullyRefunded = refundedAmount >= existing.amountPence;
        await tx.payment.update({
          where: { id: existing.id },
          data: {
            ...(fullyRefunded ? { status: "refunded" } : {}),
            refundedAt: new Date(),
            refundedAmountPence: refundedAmount,
          },
        });
        // ULT-022: a refund issued from the Stripe dashboard (not the owner API)
        // only ever fires charge.refunded — the pack apportionment in
        // app/api/payments/[id]/refund never runs. So if this payment funded a
        // class-pack purchase, the credits it paid for are taken back here too.
        // Otherwise the member keeps spendable credits at check-in
        // (lib/checkin.ts only filters status='active' AND creditsRemaining>0)
        // for money they got back.
        if (existing.stripePaymentIntentId) {
          const fundedPack = await tx.memberClassPack.findUnique({
            where: { stripePaymentIntentId: existing.stripePaymentIntentId },
            // The pack as it was SOLD — the denominator the apportionment needs.
            include: { pack: { select: { totalCredits: true } } },
          });
          if (fundedPack && fundedPack.tenantId === tenantId && fundedPack.status === "active") {
            // Apportioned, not all-or-nothing. This branch used to void every
            // credit on any settled refund, so a dashboard-issued £5 goodwill
            // refund destroyed a whole ten-class pack. Same helper as the owner
            // refund route, so the two can no longer disagree.
            //
            // This is usually the ECHO of a refund the owner route has already
            // applied. Counting the redemptions makes the sum a function of the
            // pack as sold, so the same cumulative total lands on the same
            // answer here as it did there.
            const creditsRedeemed = await tx.classPackRedemption.count({
              where: { memberPackId: fundedPack.id },
            });
            const outcome = packCreditsAfterRefund({
              totalCredits: fundedPack.pack.totalCredits,
              creditsRemaining: fundedPack.creditsRemaining,
              creditsRedeemed,
              paidPence: existing.amountPence,
              refundedPence: refundedAmount,
            });
            if (outcome.creditsRevoked > 0 || outcome.status !== null) {
              await tx.memberClassPack.update({
                where: { id: fundedPack.id },
                data: {
                  creditsRemaining: outcome.creditsRemaining,
                  ...(outcome.status ? { status: outcome.status } : {}),
                },
              });
            }
            console.warn(
              `[stripe-webhook] charge.refunded — MemberClassPack ${fundedPack.id}: ` +
              `revoked ${outcome.creditsRevoked} of ${fundedPack.creditsRemaining} credits ` +
              `(${outcome.status === "refunded" ? "pack voided" : "partial refund"}, ` +
              `member=${fundedPack.memberId}, paymentIntentId=${existing.stripePaymentIntentId})`,
            );
          }
        }
      }
    } else if (event.type === "customer.subscription.updated") {
      // Sprint 5 US-503: keep the member's payment state in sync when the
      // subscription status flips (active → past_due, paused → active, etc.)
      //
      // Lane PC (audit §11 F4, §13 ordering, §16):
      //  * resolved through the subscription's MAPPING, never the customer: a
      //    subscription MatFlow did not create, migrate or adopt changes
      //    nothing (ignored_foreign). It no longer re-points
      //    Member.stripeSubscriptionId at whatever subscription changed — the
      //    pointer is only ever set from a mapping row, and only cleared here;
      //  * ordered: an event older than the mapping's lastEventCreated is
      //    ignored_stale, atomically (the conditional updateMany below); a
      //    same-second event or a never-ordered mapping uses the subscription
      //    retrieved fresh before the transaction; a terminal mapping
      //    (canceled / incomplete_expired) is never revived;
      //  * separate states: the mapping always mirrors Stripe; the member's
      //    paymentStatus moves only when this is the member's ACTIVE mapping;
      //    Member.status is never written (it used to be set to "cancelled"
      //    on canceled / incomplete_expired, with cancelledAt and a
      //    MemberStatusEvent — membership is now MatFlow's decision).
      const updatedSubId = typeof obj.id === "string" ? obj.id : null;
      const mapping = await mappingFor(updatedSubId);
      // Fresh state when it was fetched (same-second or never-ordered), else the payload.
      const source = freshSubscription ?? obj;
      const status = (source.status as string) ?? "";
      const created = typeof event.created === "number" ? event.created : null;
      if (!mapping) {
        outcome = "ignored_foreign";
      } else if (isTerminalSubscriptionStatus(mapping.status) && !isTerminalSubscriptionStatus(status)) {
        // Stripe subscriptions never leave canceled / incomplete_expired.
        outcome = "ignored_stale";
      } else {
        const ended = isTerminalSubscriptionStatus(status);
        const applied = await tx.memberSubscription.updateMany({
          where: {
            id: mapping.id,
            ...(created !== null ? { OR: [{ lastEventCreated: null }, { lastEventCreated: { lte: created } }] } : {}),
          },
          data: {
            status,
            currentPeriodEnd: subscriptionCurrentPeriodEnd(source),
            ...(created !== null ? { lastEventCreated: created } : {}),
            ...(ended && !mapping.endedAt ? { endedAt: new Date() } : {}),
          },
        });
        if (applied.count === 0) {
          outcome = "ignored_stale";
        } else {
          const member = await mappedMember(mapping);
          if (member?.isActive) {
            // One map, shared with the membership migration that adopts existing
            // subscriptions (lib/stripe/subscription-status.ts). Unrecognised
            // statuses (incomplete, unpaid, incomplete_expired) leave the column
            // unchanged.
            // A hold: pause_collection does NOT change `status` (it stays
            // "active"), so the hold is read off the field itself
            // (lib/member-hold.ts). Paused wins over the status map; when
            // collection runs again the status map decides and the hold date
            // clears. Holds started from the Stripe dashboard therefore reach the
            // profile too, with their end date.
            const hold = readPauseCollection(source);
            // Review RP-2: a subscription that ends without ever having been
            // paid (incomplete_expired, or canceled before a first payment)
            // restores the payment state the member had when MatFlow created
            // it — a desk payer is paid again, a new member is back to what
            // they had. Otherwise the shared status map decides.
            const restored = ended && !mapping.firstPaidAt && mapping.priorPaymentStatus ? mapping.priorPaymentStatus : undefined;
            const paymentStatus = restored ?? (hold.paused ? "paused" : subscriptionStatusToPaymentStatus(status));
            // Tier 3.12: don't let an 'active'/'past_due' update RESURRECT the
            // payment state of a member staff have cancelled.
            const wouldResurrectCancelled = member.status === "cancelled" && paymentStatus !== "cancelled";
            const writePayment = !!paymentStatus && !wouldResurrectCancelled;
            // The pointer is cleared whenever the subscription ended, even
            // when the payment state is left alone.
            if (ended || writePayment) {
              await tx.member.update({
                where: { id: member.id },
                data: {
                  // The subscription ended: the member no longer has an active one.
                  ...(ended ? { stripeSubscriptionId: null } : {}),
                  ...(writePayment ? { paymentStatus } : {}),
                  ...(writePayment ? (hold.paused ? { holdUntil: hold.resumesAt } : { holdUntil: null }) : {}),
                },
              });
            }
          }
        }
      }
    } else if (event.type === "invoice.payment_action_required") {
      // Lane PC: a renewal is waiting on the payer (3-D Secure). Payment state
      // only: recorded on the subscription's mapping (with the invoice id, so
      // a later surface can link the payer to it); the event's store row says
      // it was processed. Entitlement and the member record are untouched; a
      // failure, if it comes, arrives as invoice.payment_failed.
      const actionInvoiceId = obj.id as string;
      const priorPayment = await existingInvoicePayment(actionInvoiceId);
      const invoiceOwner = await resolveInvoiceOwner(priorPayment);
      if (!invoiceOwner) {
        outcome = "ignored_foreign";
      } else if (invoiceOwner.mapping) {
        await tx.memberSubscription.update({
          where: { id: invoiceOwner.mapping.id },
          data: { requiresActionInvoiceId: actionInvoiceId, requiresActionAt: new Date() },
        });
      }
    } else if (event.type === "invoice.voided") {
      // Sprint 5 US-503: void = invoice cancelled before / after payment.
      // Flip the matching Payment row to refunded so the ledger reflects reality.
      //
      // Round 3 (lane TS run 7: voided after an incomplete subscription
      // expired): a Payment row for the invoice is voided as before; with no
      // Payment row, an invoice of a MAPPED subscription is MatFlow's and the
      // void is processed as a no-op (clearing a pending 3-D Secure marker for
      // it); only an invoice with neither is ignored_foreign.
      const invoiceId = obj.id as string;
      const existing = await tx.payment.findFirst({ where: { tenantId, stripeInvoiceId: invoiceId } });
      if (!existing) {
        const voidedMapping = await mappingFor(invoiceSubscriptionId(obj));
        if (!voidedMapping) {
          outcome = "ignored_foreign";
          console.warn(
            `[stripe-webhook] invoice.voided — no Payment and no MatFlow subscription for tenant ${tenantId} ` +
            `(invoice=${invoiceId}). Ledger not updated.`,
          );
        } else if (voidedMapping.requiresActionInvoiceId === invoiceId) {
          await tx.memberSubscription.update({
            where: { id: voidedMapping.id },
            data: { requiresActionInvoiceId: null, requiresActionAt: null },
          });
        }
      }
      // Review RP-4: a void returns money only if money was taken. A pending
      // attempt is closed as failed (it can never be paid now); a failed one
      // stays failed; neither gets a refundedAmountPence. Refunded and
      // disputed rows are left as they are.
      if (existing && existing.status === "pending") {
        await tx.payment.update({
          where: { id: existing.id },
          data: { status: "failed", failureReason: "Invoice voided" },
        });
      }
      if (existing && existing.status === "succeeded") {
        await tx.payment.update({
          where: { id: existing.id },
          // Tier 3.13: stamp the refunded amount (a void reverses the whole
          // invoice) so the ledger/CSV reflect it, not just the status flip.
          data: { status: "refunded", refundedAt: new Date(), refundedAmountPence: existing.amountPence },
        });
        // Tier 3.13: void any class-pack funded by this invoice's payment so the
        // refunded credits can't be redeemed at check-in (mirrors charge.refunded
        // and the dispute-lost branch).
        // Deliberately NOT apportioned like charge.refunded: a void reverses the
        // WHOLE invoice, so there is no retained payment for any credit to sit
        // against. See lib/pack-refund.ts.
        if (existing.stripePaymentIntentId) {
          const fundedPack = await tx.memberClassPack.findUnique({
            where: { stripePaymentIntentId: existing.stripePaymentIntentId },
          });
          if (fundedPack && fundedPack.tenantId === tenantId && fundedPack.status === "active") {
            await tx.memberClassPack.update({
              where: { id: fundedPack.id },
              data: { status: "refunded", creditsRemaining: 0 },
            });
          }
        }
      }
    } else if (event.type === "payment_intent.succeeded") {
      // Sprint 5 US-503: standalone payment_intent (not via invoice). Mirrors
      // invoice.payment_succeeded but keys off the PaymentIntent. The unique
      // stripePaymentIntentId on Payment makes the upsert idempotent.
      //
      // Lane PC: the PaymentIntent is MatFlow's only through a Payment row
      // MatFlow already holds for it (ad-hoc charge, class pack, shop order,
      // or the invoice leg of a subscription) or the ad-hoc charge's own
      // metadata (tenantId + memberId, set by /api/members/[id]/charge for the
      // unknown-outcome case where no row could be written). The customer no
      // longer decides: in the replace window it also pays TeamUp. A PI that
      // is neither is acknowledged and nothing is written; a subscription PI
      // that arrives before its invoice event is recorded by that invoice
      // event, keyed on the same PI.
      //
      // It also no longer sets Member.paymentStatus = "paid" (A3H-5): every PI
      // this branch can attribute is a ONE-OFF charge, and a one-off payment
      // says nothing about the member's membership standing (the mirror of
      // payment_intent.payment_failed below). A subscription's payment state
      // comes from its invoice events through the mapping.
      const paymentIntentId = typeof obj.id === "string" ? obj.id : null;
      const piRow = paymentIntentId
        ? await tx.payment.findFirst({
            where: { tenantId, stripePaymentIntentId: paymentIntentId },
            select: { id: true, memberId: true, status: true },
          })
        : null;
      const piMeta = (obj.metadata as Record<string, string> | null | undefined) ?? {};
      const piMetaMember = !piRow && piMeta.type === "adhoc" && piMeta.tenantId === tenantId
        ? await memberInTenant(piMeta.memberId)
        : null;
      if (!paymentIntentId || (!piRow && !piMetaMember)) {
        outcome = "ignored_foreign";
      } else if (piRow && (piRow.status === "refunded" || piRow.status === "disputed")) {
        // A refund or dispute is later than the success being redelivered.
        outcome = "ignored_stale";
      } else {
        const piMemberId = piRow ? piRow.memberId : piMetaMember!.id;
        // Tier 2.6: only mirror a Payment for a STANDALONE PaymentIntent. An
        // invoice-backed PI (obj.invoice set) is already recorded by the
        // invoice.payment_succeeded leg keyed on this same PI — writing one here
        // too risks a duplicate succeeded row (double-counted revenue) when the
        // payload's invoice↔PI link shape varies by API version.
        const piInvoiceId = (obj.invoice as string) ?? null;
        if (!piInvoiceId) {
          await tx.payment.upsert({
            where: { stripePaymentIntentId: paymentIntentId },
            create: {
              tenantId,
              memberId: piMemberId,
              stripePaymentIntentId: paymentIntentId,
              stripeChargeId: ((obj.latest_charge as string) ?? null),
              amountPence: (obj.amount_received as number) ?? 0,
              currency: ((obj.currency as string) ?? "gbp").toUpperCase(),
              status: "succeeded",
              description: (obj.description as string) ?? null,
              paidAt: new Date(),
            },
            update: {
              status: "succeeded",
              stripeChargeId: ((obj.latest_charge as string) ?? null),
              paidAt: new Date(),
            },
          });
        }
      }
    } else if (event.type === "customer.deleted") {
      // Sprint 5 US-503: customer record deleted at Stripe — null the FK on Member
      // so future payments don't try to attach to a dead Stripe customer.
      // Audit iter-2-database A8I2-V-GAP3 [High]: refuse the no-tenant
      // fallback (would otherwise null `stripeCustomerId` cross-tenant).
      const customerId = obj.id as string;
      if (customerId && tenantId) {
        await tx.member.updateMany({
          where: { stripeCustomerId: customerId, tenantId },
          data: { stripeCustomerId: null },
        });
      }
    } else if (event.type === "payment_method.detached") {
      // Sprint 5 US-503: payment method removed (card expired or member deleted it
      // from the Stripe portal). No DB column to update, but log it to AuditLog so
      // the owner has visibility for billing-support investigations.
      // On this event `data.object.customer` is ALWAYS null — being detached
      // from the customer is precisely what the event reports. Verified against
      // a real Stripe event: object.customer = null while
      // previous_attributes.customer held the id. Reading only obj.customer
      // meant this audit row was never written.
      const customerId =
        (obj.customer as string | null) ??
        (event.data.previous_attributes?.customer as string | undefined) ??
        null;
      const member = customerId ? await findMember(customerId) : null;
      if (!member) outcome = "ignored_foreign";
      if (member && tenantId) {
        // Audit iter-2 (verifier Gap 1): defer to pendingAuditLogs to match
        // the A3H-2 pattern. Previously this awaited logAudit was inside the
        // withRlsBypass callback — on transaction rollback the audit row
        // persisted as a phantom record while the idempotency claim got
        // deleted, causing duplicate audit entries on Stripe retry.
        pendingAuditLogs.push({
          tenantId,
          userId: null,
          action: "stripe.payment_method.detached",
          entityType: "Member",
          entityId: member.id,
          metadata: {
            paymentMethodId: obj.id as string,
            type: (obj.type as string) ?? null,
          },
        });
      }
    } else if (
      event.type === "charge.dispute.created" ||
      event.type === "charge.dispute.updated" ||
      event.type === "charge.dispute.closed"
    ) {
      // Lane PC: the member behind a dispute is the member on the Payment row it
      // contests, never "whoever owns this customer" (the customer may also pay
      // another platform). A dispute on a charge MatFlow did not record is still
      // written as the club's Dispute row and the owners are still told — it is
      // the club's money on the club's account — but no member is touched.
      const chargeId = (obj.charge as string) ?? null;
      const disputePaymentIntentId = (obj.payment_intent as string | null) ?? null;
      // B1: match the Payment by charge id first, then fall back to the
      // payment_intent — mirrors the charge.refunded reconciliation. PI-only /
      // charge-null payments (class packs, some PaymentIntents) otherwise never
      // link, so the contested funds keep counting as succeeded revenue and the
      // dispute is invisible to the ledger.
      let linkedPayment = chargeId
        ? await tx.payment.findFirst({ where: { tenantId, stripeChargeId: chargeId } })
        : null;
      if (!linkedPayment && disputePaymentIntentId) {
        linkedPayment = await tx.payment.findFirst({ where: { tenantId, stripePaymentIntentId: disputePaymentIntentId } });
      }
      if (!linkedPayment) {
        // The Dispute row is still written below (tenantIdForRow falls back to
        // the resolved tenant), but the contested charge stays counted as
        // succeeded revenue — worth saying out loud.
        console.warn(
          `[stripe-webhook] dispute — no Payment linked for tenant ${tenantId} ` +
          `(charge=${chargeId}, paymentIntent=${disputePaymentIntentId}).`,
        );
      }
      const status = ((): string => {
        const s = (obj.status as string) ?? "needs_response";
        if (s === "warning_needs_response" || s === "needs_response") return "needs_response";
        if (s === "warning_under_review" || s === "under_review") return "under_review";
        if (s === "won") return "won";
        if (s === "lost") return "lost";
        if (s === "charge_refunded") return "charge_refunded";
        return s;
      })();
      const evidenceDueAt = ((obj.evidence_details as { due_by?: number } | undefined)?.due_by ?? null);
      const tenantIdForRow = linkedPayment?.tenantId ?? tenantId;
      if (tenantIdForRow) {
        await tx.dispute.upsert({
          where: { stripeDisputeId: obj.id as string },
          create: {
            tenantId: tenantIdForRow,
            paymentId: linkedPayment?.id ?? null,
            stripeDisputeId: obj.id as string,
            amountPence: (obj.amount as number) ?? 0,
            currency: ((obj.currency as string) ?? "gbp").toUpperCase(),
            reason: (obj.reason as string) ?? "unknown",
            status,
            evidenceDueAt: evidenceDueAt ? new Date(evidenceDueAt * 1000) : null,
          },
          update: {
            status,
            evidenceDueAt: evidenceDueAt ? new Date(evidenceDueAt * 1000) : null,
          },
        });
        // Ten-club audit 2026-09-25 (connection audit 2026-08-22 BROKEN #8, still
        // live until now): this branch ALSO queued a second template
        // (dispute_created) to every owner on the same charge.dispute.created,
        // so each chargeback emailed each owner twice. The single owner
        // notification is dispute_opened_owner, queued below with the evidence
        // deadline and the dashboard link; the unit suite pins exactly one send
        // per owner per opened dispute.
        if (linkedPayment) {
          if (status === "won") {
            // B5: a dispute won AFTER a (goodwill) refund must NOT resurrect the
            // charge to 'succeeded' — the funds were still returned. Leaving the
            // row 'refunded' keeps revenue/gross honest.
            if (!linkedPayment.refundedAmountPence) {
              await tx.payment.update({
                where: { id: linkedPayment.id },
                data: { status: "succeeded" },
              });
            }
          } else if (status === "charge_refunded") {
            await tx.payment.update({
              where: { id: linkedPayment.id },
              data: { status: "refunded" },
            });
          } else if (status === "lost") {
            // WP-H (audit): the gym lost the chargeback — the customer's bank
            // pulled the funds back. Mark the payment as refunded (the gym is
            // out of pocket) and, if this payment funded a class-pack purchase,
            // void the pack so future check-ins can't redeem disputed credits.
            // Also deliberately NOT apportioned: a chargeback is adversarial, not a
            // goodwill gesture. The gym is out of pocket for the whole charge, so the
            // member does not keep spendable credits against it.
            // Already-attended sessions are kept (you can't un-attend a class)
            // but new check-ins against this pack will fail.
            await tx.payment.update({
              where: { id: linkedPayment.id },
              data: { status: "refunded" },
            });
            if (linkedPayment.stripePaymentIntentId) {
              const fundedPack = await tx.memberClassPack.findUnique({
                where: { stripePaymentIntentId: linkedPayment.stripePaymentIntentId },
              });
              if (fundedPack && fundedPack.tenantId === tenantId && fundedPack.status === "active") {
                await tx.memberClassPack.update({
                  where: { id: fundedPack.id },
                  data: { status: "refunded", creditsRemaining: 0 },
                });
                console.warn(
                  `[stripe-webhook] dispute lost — voided MemberClassPack ${fundedPack.id} ` +
                  `(member=${fundedPack.memberId}, tenantPaymentIntentId=${linkedPayment.stripePaymentIntentId})`,
                );
              }
            }
          } else {
            await tx.payment.update({
              where: { id: linkedPayment.id },
              data: { status: "disputed" },
            });
          }
        }

        // B2: keep Member.paymentStatus in sync so the dashboard "payments due"
        // tile and reports payment-health reflect an active or lost chargeback.
        // 'won' with no prior refund returns the member to paid; every other
        // dispute state is funds-at-risk/clawed-back → overdue. Mirrors the
        // invoice.payment_failed leg's overdue flip.
        const disputeMemberId = linkedPayment?.memberId ?? null;
        if (disputeMemberId) {
          const disputeMemberStatus =
            status === "won" && !linkedPayment?.refundedAmountPence ? "paid" : "overdue";
          await tx.member.update({
            where: { id: disputeMemberId },
            data: { paymentStatus: disputeMemberStatus },
          });
        }

        // B4: persist the dispute outcome to AuditLog (append-only, owner-
        // queryable) — won/lost/refund/pack-void were previously only
        // console.warn'd, so an irreversible funds write-off left no trail.
        // Keyed to the member when resolvable (so it appears on the member
        // timeline + GDPR DSAR export), else to the Dispute.
        pendingAuditLogs.push({
          tenantId: tenantIdForRow,
          userId: null,
          action: `stripe.dispute.${status}`,
          entityType: disputeMemberId ? "Member" : "Dispute",
          entityId: disputeMemberId ?? (obj.id as string),
          metadata: {
            stripeDisputeId: obj.id as string,
            chargeId,
            paymentId: linkedPayment?.id ?? null,
            status,
            amountPence: (obj.amount as number) ?? 0,
            reason: (obj.reason as string) ?? null,
            evidenceDueAt: evidenceDueAt ? new Date(evidenceDueAt * 1000).toISOString() : null,
          },
        });

        // B3: notify the gym owners when a chargeback is first opened — only on
        // 'created' (not every 'updated') so we don't spam. The gym is the
        // merchant of record and the evidence window is time-boxed, so a passive
        // dashboard surface isn't enough. Mirrors the payment_failed_owner fan-out.
        if (event.type === "charge.dispute.created") {
          const owners = await tx.user.findMany({
            where: { tenantId: tenantIdForRow, role: "owner" },
            select: { email: true },
          }).catch(() => []);
          if (owners.length > 0) {
            const tenantRow = await tx.tenant.findUnique({
              where: { id: tenantIdForRow },
              select: { name: true },
            });
            let customerName = "";
            if (disputeMemberId) {
              const m = await tx.member.findUnique({
                where: { id: disputeMemberId },
                select: { name: true },
              });
              customerName = m?.name ?? "";
            }
            const disputeCurrency = ((obj.currency as string) ?? "gbp").toUpperCase();
            const disputeSymbol = disputeCurrency === "GBP" ? "£" : disputeCurrency === "USD" ? "$" : disputeCurrency === "EUR" ? "€" : "";
            const formattedAmount = `${disputeSymbol}${(((obj.amount as number) ?? 0) / 100).toFixed(2)}`;
            const evidenceDueBy = evidenceDueAt
              ? new Date(evidenceDueAt * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
              : "";
            const dashboardUrl = `${baseUrl}/dashboard/payments`;
            for (const owner of owners) {
              pendingEmails.push({
                tenantId: tenantIdForRow,
                templateId: "dispute_opened_owner",
                to: owner.email,
                vars: {
                  gymName: tenantRow?.name ?? "your gym",
                  customerName,
                  amount: formattedAmount,
                  reason: (obj.reason as string) ?? "",
                  evidenceDueBy,
                  dashboardUrl,
                },
              });
            }
          }
        }
      }
    } else if (event.type === "checkout.session.expired") {
      // An abandoned Stripe cart used to stay "pending" for ever, and
      // /api/orders/[id]/mark-paid would accept it — so staff could record cash
      // against an order the member started, walked away from, and never meant
      // to complete. mark-paid already refuses "cancelled", so flipping the row
      // here is what makes that refusal reachable.
      //
      // Only shop orders leave a row behind at session-creation time; a class
      // pack is created on checkout.session.completed, so an expired pack
      // session has nothing to clean up.
      const expiredMeta = (obj.metadata as Record<string, string> | null) ?? {};
      if (
        expiredMeta.matflowKind === "shop_order" &&
        expiredMeta.tenantId === tenantId &&
        expiredMeta.orderRef
      ) {
        const abandoned = await tx.order.findFirst({
          where: { tenantId, orderRef: expiredMeta.orderRef, status: "pending", paymentMethod: "stripe" },
          select: { id: true },
        });
        if (abandoned) {
          await tx.order.update({ where: { id: abandoned.id }, data: { status: "cancelled" } });
          pendingAuditLogs.push({
            tenantId,
            userId: null,
            action: "stripe.checkout.expired",
            entityType: "Order",
            entityId: abandoned.id,
            metadata: { orderRef: expiredMeta.orderRef, sessionId: (obj.id as string) ?? null },
          });
        }
      } else if (expiredMeta.matflowKind !== "class_pack" || expiredMeta.tenantId !== tenantId) {
        // Not a checkout MatFlow created for this club. (An expired class-pack
        // session of this club is MatFlow's, with nothing to clean up.)
        outcome = "ignored_foreign";
      }
    } else if (event.type === "payment_intent.payment_failed") {
      // The only event that resolves a failed ad-hoc charge. Without it the
      // Payment row written by /api/members/[id]/charge stays "pending" for
      // ever — counted as neither taken nor failed, and visible on the ledger
      // as money that might still arrive.
      //
      // Deliberately does NOT flip Member.paymentStatus to overdue: that is
      // invoice.payment_failed's job, because a MEMBERSHIP payment failing says
      // something about the member's standing. A one-off charge failing does
      // not, and marking someone overdue for a declined £10 seminar fee would
      // put them on the club's chase list for a debt they do not owe.
      const failedPiId = (obj.id as string) ?? null;
      const failedPayment = failedPiId
        ? await tx.payment.findFirst({ where: { tenantId, stripePaymentIntentId: failedPiId } })
        : null;
      if (failedPayment && failedPayment.status === "pending") {
        await tx.payment.update({ where: { id: failedPayment.id }, data: { status: "failed" } });
        pendingAuditLogs.push({
          tenantId,
          userId: null,
          action: "stripe.payment_intent.failed",
          entityType: "Payment",
          entityId: failedPayment.id,
          metadata: {
            paymentIntentId: failedPiId,
            amountPence: failedPayment.amountPence,
            reason: ((obj.last_payment_error as { message?: string } | null)?.message) ?? null,
          },
        });
      } else if (!failedPayment) {
        outcome = "ignored_foreign";
        // Not every failed PaymentIntent is ours — a gym can charge through
        // Stripe directly. Said out loud rather than silently skipped, so a
        // genuine mismatch is findable.
        console.warn(
          `[stripe-webhook] payment_intent.payment_failed — no Payment for tenant ${tenantId} ` +
          `(paymentIntent=${failedPiId}). Ledger not updated.`,
        );
      }
    } else if (event.type === "account.application.deauthorized") {
      // The gym revoked MatFlow's access from their own Stripe dashboard.
      // Nothing else tells us: account.updated stops arriving too, so without
      // this branch the product goes on claiming it is connected while every
      // checkout fails at the last step with a raw Stripe error.
      //
      // stripeAccountId is deliberately KEPT. It is the only thing that maps a
      // later event back to this tenant, and clearing it would make any
      // in-flight webhook permanently unattributable. Only the flag moves.
      // The cached status is stamped disabled rather than cleared, so the
      // record says what happened ("deauthorized", with the time) instead of
      // looking like "never checked". The charge gate
      // (requireChargeableClubAccount, lib/stripe/club-account.ts) refuses on
      // the flag and on this stamp, and a stale-cache refresh against an
      // account we can no longer read now fails CLOSED (lane PA, 11 Oct 2026).
      // Review RP-9: a deauthorisation created BEFORE the club last connected
      // belongs to an earlier connection (Stripe retries and reorders); applying
      // it would disconnect a club that has just reconnected. Ignored as stale.
      const connection = await tx.tenant.findUnique({ where: { id: tenantId }, select: { stripeConnectedAt: true } });
      const connectedAt = connection?.stripeConnectedAt ?? null;
      const fromEarlierConnection =
        typeof event.created === "number" && connectedAt !== null && event.created < Math.floor(connectedAt.getTime() / 1000);
      if (fromEarlierConnection) {
        outcome = "ignored_stale";
      } else {
        await tx.tenant.updateMany({
          where: { id: tenantId },
          data: {
            stripeConnected: false,
            stripeAccountStatus: {
              chargesEnabled: false,
              payoutsEnabled: false,
              requirementsPastDue: [],
              disabledReason: "deauthorized",
              refreshedAt: new Date().toISOString(),
            },
          },
        });
        pendingAuditLogs.push({
          tenantId,
          userId: null,
          action: "stripe.account.deauthorized",
          entityType: "Tenant",
          entityId: tenantId,
          metadata: { stripeAccountId },
        });
        const deauthTenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { name: true },
        });
        const deauthOwners = await tx.user.findMany({
          where: { tenantId, role: "owner" },
          select: { email: true },
        }).catch(() => []);
        for (const owner of deauthOwners) {
          if (!owner.email) continue;
          pendingEmails.push({
            tenantId,
            templateId: "stripe_disconnected_owner",
            to: owner.email,
            vars: {
              gymName: deauthTenant?.name ?? "your gym",
              dashboardUrl: `${baseUrl}/dashboard/settings`,
            },
          });
        }
      }
    }
    // Audit iter-1-member-lifecycle A3H-2 + A3H-9: side-effects are RETURNED,
    // never dispatched here — the store writes the audit rows in this
    // transaction and sends the emails only after it commits, so a rollback
    // can never fire a notification. Tier 2.5: the account-status refresh does
    // network I/O and opens its own transaction, so it runs after the commit.
    const refresh = accountStatusRefresh as { tenantId: string; stripeAccountId: string } | null;
    return {
      outcome,
      tenantId,
      emails: pendingEmails,
      audits: pendingAuditLogs,
      after: refresh ? [() => refreshStripeAccountStatus(refresh.tenantId, refresh.stripeAccountId)] : [],
    };
  };
}
