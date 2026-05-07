import { withRlsBypass } from "@/lib/prisma-tenant";
import { NextRequest, NextResponse } from "next/server";
import { sendEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit-log";
import { refreshStripeAccountStatus } from "@/lib/stripe-account-status";
import { getBaseUrl } from "@/lib/env-url";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: { id: string; type: string; account?: string; data: { object: Record<string, unknown> } };
  try {
    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" });
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret) as unknown as typeof event;
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Only claim the eventId for event types we actually handle. Claiming for
  // unknown types is a footgun: if a future deploy adds a handler for that type,
  // it would be permanently skipped because we already recorded the claim and
  // Stripe stops retrying after our 200 ack.
  const HANDLED_EVENT_TYPES = new Set([
    "customer.subscription.deleted",
    "customer.subscription.updated",
    "invoice.payment_failed",
    "invoice.payment_succeeded",
    "invoice.voided",
    "checkout.session.completed",
    "payment_intent.processing",
    "payment_intent.succeeded",
    "mandate.updated",
    "charge.refunded",
    "customer.deleted",
    "payment_method.detached",
    "charge.dispute.created",
    "charge.dispute.updated",
    "account.updated",  // Fix 3 (T-1): refresh cached Tenant.stripeAccountStatus
  ]);
  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    // Ack but don't claim — preserves the option to handle this type later.
    return NextResponse.json({ received: true, ignored: true, type: event.type });
  }

  // Idempotency: claim the event ID before processing.
  // If the unique constraint fires (P2002), Stripe is replaying — return 200 and skip.
  // StripeEvent + the tenant lookup are cross-tenant by definition (the webhook
  // doesn't know which tenant the event belongs to until we resolve it via
  // stripeAccountId). Bypass is intentional and correct here.
  let claimedEventRowId: string | null = null;
  try {
    const row = await withRlsBypass((tx) =>
      tx.stripeEvent.create({ data: { eventId: event.id, type: event.type } }),
    );
    claimedEventRowId = row.id;
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ received: true, alreadyProcessed: true });
    }
    return NextResponse.json({ error: "DB unavailable" }, { status: 500 });
  }

  // Map connected account to tenant
  const stripeAccountId = event.account;
  if (!stripeAccountId) {
    console.warn("[stripe-webhook] event.account missing", { eventId: event.id, type: event.type });
    // Roll back the StripeEvent claim so we don't block legit retries.
    if (claimedEventRowId) {
      await withRlsBypass((tx) =>
        tx.stripeEvent.delete({ where: { id: claimedEventRowId! } }),
      ).catch(() => {});
    }
    return NextResponse.json({ error: "Event missing connected account" }, { status: 400 });
  }
  let tenantId: string | null = null;
  if (stripeAccountId) {
    const tenant = await withRlsBypass((tx) =>
      tx.tenant.findFirst({
        where: { stripeAccountId },
        select: { id: true },
      }),
    );
    tenantId = tenant?.id ?? null;
  }

  const obj = event.data.object as Record<string, unknown>;

  // The Stripe webhook is signature-verified at the top of this handler and
  // resolves tenantId from event.account before processing. From here it is a
  // trusted cross-tenant context — one Stripe webhook serves every tenant's
  // connected account. We bypass RLS for the entire processing block so each
  // event handler can read/write across the tables involved (Member, Payment,
  // Order, Dispute, MemberClassPack, Tenant) without piecewise context plumbing.
  try {
    await withRlsBypass(async (tx) => {
    async function findMember(customerId: string) {
      return tx.member.findFirst({
        where: tenantId ? { stripeCustomerId: customerId, tenantId } : { stripeCustomerId: customerId },
        select: { id: true, tenantId: true },
      });
    }

    // Fix 3 (T-1): refresh cached Tenant.stripeAccountStatus on every
    // account.updated event so checkout/portal gates see the latest
    // charges_enabled / payouts_enabled / past-due signals in seconds.
    if (event.type === "account.updated") {
      if (tenantId) {
        await refreshStripeAccountStatus(tenantId, stripeAccountId);
        await logAudit({
          tenantId,
          userId: null,
          action: "stripe.webhook.account_updated",
          entityType: "Tenant",
          entityId: tenantId,
          metadata: { stripeAccountId },
          req,
        });
      }
    } else if (event.type === "customer.subscription.deleted") {
      const customerId = obj.customer as string;
      if (customerId) {
        await tx.member.updateMany({
          where: tenantId ? { stripeCustomerId: customerId, tenantId } : { stripeCustomerId: customerId },
          data: { paymentStatus: "cancelled", stripeSubscriptionId: null },
        });
      }
    } else if (event.type === "invoice.payment_failed") {
      const customerId = obj.customer as string;
      const member = customerId ? await findMember(customerId) : null;
      if (member) {
        const memberFull = await tx.member.findUnique({
          where: { id: member.id },
          select: { name: true, email: true, tenant: { select: { name: true } } },
        });
        await tx.member.update({
          where: { id: member.id },
          data: { paymentStatus: "overdue" },
        });
        await tx.payment.upsert({
          where: { stripeInvoiceId: obj.id as string },
          create: {
            tenantId: member.tenantId,
            memberId: member.id,
            stripeInvoiceId: obj.id as string,
            stripePaymentIntentId: (obj.payment_intent as string) ?? null,
            stripeChargeId: (obj.charge as string) ?? null,
            amountPence: (obj.amount_due as number) ?? 0,
            currency: ((obj.currency as string) ?? "gbp").toUpperCase(),
            status: "failed",
            description: (obj.description as string) ?? null,
            failureReason: (obj.last_finalization_error as { message?: string } | null)?.message ?? null,
          },
          update: {
            status: "failed",
            stripePaymentIntentId: (obj.payment_intent as string) ?? null,
            stripeChargeId: (obj.charge as string) ?? null,
            failureReason: (obj.last_finalization_error as { message?: string } | null)?.message ?? null,
          },
        });
        if (memberFull?.email) {
          const amountPence = (obj.amount_due as number) ?? 0;
          const currency = ((obj.currency as string) ?? "gbp").toUpperCase();
          const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
          const portalUrl = `${getBaseUrl(req)}/member/profile`;
          const formattedAmount = `${symbol}${(amountPence / 100).toFixed(2)}`;
          sendEmail({
            tenantId: member.tenantId,
            templateId: "payment_failed",
            to: memberFull.email,
            vars: {
              memberName: memberFull.name,
              gymName: memberFull.tenant.name,
              portalUrl,
              amount: formattedAmount,
            },
          }).catch(() => {});

          // Assessment Fix #5: dunning notification to owner so they know
          // a member's payment failed without waiting for the next dashboard
          // load. Stripe Smart Retries handle the actual retry; this email
          // is purely for owner awareness ("you may want to message them").
          const owners = await tx.user.findMany({
            where: { tenantId: member.tenantId, role: "owner" },
            select: { email: true },
          }).catch(() => []);
          const dashboardUrl = `${getBaseUrl(req)}/dashboard/members/${member.id}`;
          const failureReason = (obj.last_finalization_error as { message?: string } | null)?.message ?? null;
          for (const owner of owners) {
            sendEmail({
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
            }).catch(() => {});
          }
        }
      }
    } else if (event.type === "invoice.payment_succeeded") {
      const customerId = obj.customer as string;
      const member = customerId ? await findMember(customerId) : null;
      if (member) {
        await tx.member.update({
          where: { id: member.id },
          data: { paymentStatus: "paid" },
        });
        await tx.payment.upsert({
          where: { stripeInvoiceId: obj.id as string },
          create: {
            tenantId: member.tenantId,
            memberId: member.id,
            stripeInvoiceId: obj.id as string,
            stripePaymentIntentId: (obj.payment_intent as string) ?? null,
            stripeChargeId: (obj.charge as string) ?? null,
            amountPence: (obj.amount_paid as number) ?? 0,
            currency: ((obj.currency as string) ?? "gbp").toUpperCase(),
            status: "succeeded",
            description: (obj.description as string) ?? null,
            paidAt: new Date(((obj.status_transitions as { paid_at?: number } | undefined)?.paid_at ?? Date.now() / 1000) * 1000),
          },
          update: {
            status: "succeeded",
            stripePaymentIntentId: (obj.payment_intent as string) ?? null,
            stripeChargeId: (obj.charge as string) ?? null,
            paidAt: new Date(((obj.status_transitions as { paid_at?: number } | undefined)?.paid_at ?? Date.now() / 1000) * 1000),
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
        if (pack) {
          const expiresAt = new Date(Date.now() + pack.validityDays * 24 * 60 * 60 * 1000);
          const paymentIntentId = (obj.payment_intent as string) ?? null;
          // Mirror as a Payment row so the ledger is complete
          const amountPence = (obj.amount_total as number) ?? pack.pricePence;
          try {
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
          } catch (e: unknown) {
            // Idempotent on stripePaymentIntentId @unique — duplicate replays are fine
            if ((e as { code?: string }).code !== "P2002") throw e;
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
        await tx.order.updateMany({
          where: { tenantId: metadata.tenantId, orderRef: metadata.orderRef, status: "pending" },
          data: { status: "paid", paidAt: new Date() },
        });
      }
    } else if (event.type === "payment_intent.processing") {
      // BACS Direct Debit takes ~4 working days to settle. Show "pending" state in the UI.
      const customerId = obj.customer as string;
      const member = customerId ? await findMember(customerId) : null;
      if (member) {
        await tx.member.update({
          where: { id: member.id },
          data: { paymentStatus: "pending" },
        });
      }
    } else if (event.type === "mandate.updated") {
      // BACS mandate status flipped (active / inactive / pending). Track on member preferredPaymentMethod.
      const status = (obj.status as string) ?? "";
      const customerId = (obj.customer as string) ?? null;
      const member = customerId ? await findMember(customerId) : null;
      if (member && status === "inactive") {
        await tx.member.update({
          where: { id: member.id },
          data: { paymentStatus: "overdue", preferredPaymentMethod: "card" },
        });
      }
    } else if (event.type === "charge.refunded") {
      const chargeId = obj.id as string;
      const refundedAmount = (obj.amount_refunded as number) ?? 0;
      const existing = await tx.payment.findFirst({ where: { stripeChargeId: chargeId } });
      if (existing) {
        await tx.payment.update({
          where: { id: existing.id },
          data: {
            status: "refunded",
            refundedAt: new Date(),
            refundedAmountPence: refundedAmount,
          },
        });
      }
    } else if (event.type === "customer.subscription.updated") {
      // Sprint 5 US-503: keep Member.stripeSubscriptionId + paymentStatus in sync
      // when the subscription status flips (active → past_due, paused → active, etc.)
      const customerId = obj.customer as string;
      const status = (obj.status as string) ?? "";
      const subscriptionId = obj.id as string;
      const member = customerId ? await findMember(customerId) : null;
      if (member) {
        const paymentStatus =
          status === "active" || status === "trialing" ? "paid"
          : status === "past_due" ? "overdue"
          : status === "paused" ? "paused"
          : status === "canceled" || status === "incomplete_expired" ? "cancelled"
          : undefined; // leave unchanged for unrecognised statuses
        await tx.member.update({
          where: { id: member.id },
          data: {
            stripeSubscriptionId: status === "canceled" ? null : subscriptionId,
            ...(paymentStatus ? { paymentStatus } : {}),
          },
        });
      }
    } else if (event.type === "invoice.voided") {
      // Sprint 5 US-503: void = invoice cancelled before / after payment.
      // Flip the matching Payment row to refunded so the ledger reflects reality.
      const invoiceId = obj.id as string;
      const existing = await tx.payment.findFirst({ where: { stripeInvoiceId: invoiceId } });
      if (existing) {
        await tx.payment.update({
          where: { id: existing.id },
          data: { status: "refunded", refundedAt: new Date() },
        });
      }
    } else if (event.type === "payment_intent.succeeded") {
      // Sprint 5 US-503: standalone payment_intent (not via invoice). Mirrors
      // invoice.payment_succeeded but keys off the PaymentIntent. The unique
      // stripePaymentIntentId on Payment makes the upsert idempotent.
      const customerId = obj.customer as string;
      const member = customerId ? await findMember(customerId) : null;
      const paymentIntentId = obj.id as string;
      if (member && paymentIntentId) {
        await tx.payment.upsert({
          where: { stripePaymentIntentId: paymentIntentId },
          create: {
            tenantId: member.tenantId,
            memberId: member.id,
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
    } else if (event.type === "customer.deleted") {
      // Sprint 5 US-503: customer record deleted at Stripe — null the FK on Member
      // so future payments don't try to attach to a dead Stripe customer.
      const customerId = obj.id as string;
      if (customerId) {
        await tx.member.updateMany({
          where: tenantId ? { stripeCustomerId: customerId, tenantId } : { stripeCustomerId: customerId },
          data: { stripeCustomerId: null },
        });
      }
    } else if (event.type === "payment_method.detached") {
      // Sprint 5 US-503: payment method removed (card expired or member deleted it
      // from the Stripe portal). No DB column to update, but log it to AuditLog so
      // the owner has visibility for billing-support investigations.
      const customerId = (obj.customer as string) ?? null;
      const member = customerId ? await findMember(customerId) : null;
      if (member && tenantId) {
        await logAudit({
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
    } else if (event.type === "charge.dispute.created" || event.type === "charge.dispute.updated") {
      const customerId = (obj.customer as string) ?? null;
      const chargeId = (obj.charge as string) ?? null;
      const member = customerId ? await findMember(customerId) : null;
      const linkedPayment = chargeId
        ? await tx.payment.findFirst({ where: { stripeChargeId: chargeId } })
        : null;
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
      const tenantIdForRow = member?.tenantId ?? linkedPayment?.tenantId ?? tenantId;
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
        if (linkedPayment) {
          if (status === "won") {
            await tx.payment.update({
              where: { id: linkedPayment.id },
              data: { status: "succeeded" },
            });
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
              if (fundedPack && fundedPack.status === "active") {
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
      }
    }
    });  // close withRlsBypass wrapper
  } catch {
    // Roll back the idempotency claim so Stripe retries this event later.
    if (claimedEventRowId) {
      await withRlsBypass((tx) =>
        tx.stripeEvent.delete({ where: { id: claimedEventRowId! } }),
      ).catch(() => {});
    }
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
