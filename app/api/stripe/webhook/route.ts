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
  //
  // Audit iter-1-member-lifecycle A3H-2: side-effects (emails) and audit-log
  // entries are NOT dispatched inside the withRlsBypass callback. They're
  // collected here and dispatched ONLY after the transaction commits
  // successfully. Without this, a fire-and-forget sendEmail that runs before
  // the transaction commits could fire even if the commit fails → Stripe
  // retries the event → duplicate notifications.
  // Derive the type from sendEmail's signature so it includes the typed
  // TemplateId union without needing to export it.
  const pendingEmails: Array<Parameters<typeof sendEmail>[0]> = [];
  const pendingAuditLogs: Array<{
    tenantId: string;
    userId: string | null;
    action: string;
    entityType: string;
    entityId: string;
    metadata: Record<string, unknown>;
  }> = [];
  try {
    await withRlsBypass(async (tx) => {
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
        select: { id: true, tenantId: true },
      });
    }

    // Fix 3 (T-1): refresh cached Tenant.stripeAccountStatus on every
    // account.updated event so checkout/portal gates see the latest
    // charges_enabled / payouts_enabled / past-due signals in seconds.
    if (event.type === "account.updated") {
      if (tenantId) {
        await refreshStripeAccountStatus(tenantId, stripeAccountId);
        // Audit iter-2 (verifier Gap 3): defer to pendingAuditLogs so a
        // transaction rollback doesn't leave a phantom audit row when the
        // idempotency claim gets deleted on Stripe retry.
        pendingAuditLogs.push({
          tenantId,
          userId: null,
          action: "stripe.webhook.account_updated",
          entityType: "Tenant",
          entityId: tenantId,
          metadata: { stripeAccountId },
        });
      }
    } else if (event.type === "customer.subscription.deleted") {
      const customerId = obj.customer as string;
      if (customerId && tenantId) {
        // Audit iter-1-member-lifecycle A3C-1: also flip Member.status to
        // "cancelled" — previously only paymentStatus moved, leaving every
        // self-cancelled member appearing active in counts, check-in, etc.
        // Contract documented at /api/member/subscriptions/cancel:7-9 and
        // lib/stripe/subscriptions.ts:138; the webhook now honours it.
        // Audit iter-2-database A8I2-V-GAP3 [High]: refuse the no-tenant
        // fallback (was the same cross-tenant vector as findMember which
        // S-4 closed). The tenantId guard at the outer if() now mirrors
        // findMember's behaviour — silent skip + 200 ack so Stripe stops
        // retrying.
        // D2: resolve the member first so the audit entityId is the Member.id,
        // not the Stripe customer id. Member-scoped surfaces — notably the GDPR
        // DSAR export (app/api/admin/dsar/export) which queries AuditLog by
        // {entityType:"Member", entityId: memberId} — never matched a cus_… id,
        // so this Stripe-initiated cancellation was silently dropped from the
        // member's data export. Every sibling branch already keys on member.id.
        const cancelledMember = await findMember(customerId);
        await tx.member.updateMany({
          where: { stripeCustomerId: customerId, tenantId },
          data: { status: "cancelled", paymentStatus: "cancelled", stripeSubscriptionId: null },
        });
        // A3H-9: audit-log the subscription deletion so the gym owner can
        // trace the cancellation back to the Stripe event.
        if (cancelledMember) {
          const subId = (obj.id as string) ?? null;
          pendingAuditLogs.push({
            tenantId,
            userId: null,
            action: "member.subscription.cancelled_by_stripe",
            entityType: "Member",
            entityId: cancelledMember.id,
            metadata: { stripeCustomerId: customerId, stripeSubscriptionId: subId },
          });
        }
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
        // D3: audit the failure for EVERY member, not only those with an email
        // on file. Previously this push sat inside the `if (memberFull?.email)`
        // block, so an email-less member got the overdue flip + failed ledger
        // row but no audit trail of the failure.
        const amountPence = (obj.amount_due as number) ?? 0;
        const currency = ((obj.currency as string) ?? "gbp").toUpperCase();
        const failureReason = (obj.last_finalization_error as { message?: string } | null)?.message ?? null;
        pendingAuditLogs.push({
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
        if (memberFull?.email) {
          const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
          const portalUrl = `${getBaseUrl(req)}/member/profile`;
          const formattedAmount = `${symbol}${(amountPence / 100).toFixed(2)}`;
          // Audit iter-1-member-lifecycle A3H-2: queue instead of dispatch.
          pendingEmails.push({
            tenantId: member.tenantId,
            templateId: "payment_failed",
            to: memberFull.email,
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
          const dashboardUrl = `${getBaseUrl(req)}/dashboard/members/${member.id}`;
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
      const customerId = obj.customer as string;
      const member = customerId ? await findMember(customerId) : null;
      if (member) {
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
        await tx.member.update({
          where: { id: member.id },
          data: { paymentStatus: "paid" },
        });
        // A1: a subscription charge fires BOTH invoice.payment_succeeded and
        // payment_intent.succeeded. The PI leg keys its upsert on
        // stripePaymentIntentId; key THIS leg on the same PI (when present) so
        // the two legs converge on ONE Payment row regardless of delivery order
        // — instead of two 'succeeded' rows (double-counted revenue) or a P2002
        // collision on the @unique stripePaymentIntentId. Fall back to the
        // invoice id only when the payload carries no payment_intent.
        const invoiceId = obj.id as string;
        const invoicePiId = (obj.payment_intent as string) ?? null;
        const invoicePaidAt = new Date(((obj.status_transitions as { paid_at?: number } | undefined)?.paid_at ?? Date.now() / 1000) * 1000);
        await tx.payment.upsert({
          where: invoicePiId ? { stripePaymentIntentId: invoicePiId } : { stripeInvoiceId: invoiceId },
          create: {
            tenantId: member.tenantId,
            memberId: member.id,
            stripeInvoiceId: invoiceId,
            stripePaymentIntentId: invoicePiId,
            stripeChargeId: (obj.charge as string) ?? null,
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
            stripeChargeId: (obj.charge as string) ?? null,
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
        // (we only act on a still-'pending' Order). Cross-check metadata.tenantId
        // vs resolved tenantId matches the class_pack branch above (M8, 2026-05-07).
        const order = await tx.order.findFirst({
          where: { tenantId: metadata.tenantId, orderRef: metadata.orderRef, status: "pending" },
          select: { id: true, memberId: true, totalPence: true },
        });
        if (order) {
          await tx.order.update({
            where: { id: order.id },
            data: { status: "paid", paidAt: new Date() },
          });
          // A2: mirror a Payment row so the Stripe shop sale is visible to the
          // revenue/ledger/CSV surfaces (revenue/summary, /dashboard/payments,
          // export.csv) — all of which read Payment, never Order. Mirrors the
          // class_pack branch above. Idempotent on the @unique stripePaymentIntentId.
          const paymentIntentId = (obj.payment_intent as string) ?? null;
          try {
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
          } catch (e: unknown) {
            // Idempotent on stripePaymentIntentId @unique — duplicate replays are fine.
            if ((e as { code?: string }).code !== "P2002") throw e;
          }
        }
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
      const paymentIntentId = (obj.payment_intent as string | null) ?? null;
      const refundedAmount = (obj.amount_refunded as number) ?? 0;
      // Match by charge id first; fall back to the payment_intent id so
      // paymentIntent-only payments (refunded via the PI, with no stripeChargeId
      // stored) still reconcile — e.g. when the API DB write failed and the
      // webhook is the eventual-consistency backstop.
      let existing = await tx.payment.findFirst({ where: { stripeChargeId: chargeId } });
      if (!existing && paymentIntentId) {
        existing = await tx.payment.findFirst({ where: { stripePaymentIntentId: paymentIntentId } });
      }
      if (existing && existing.status !== "refunded") {
        await tx.payment.update({
          where: { id: existing.id },
          data: {
            status: "refunded",
            refundedAt: new Date(),
            refundedAmountPence: refundedAmount,
          },
        });
        // ULT-022: a refund issued from the Stripe dashboard (not the owner API)
        // only ever fires charge.refunded — the synchronous pack-void in
        // app/api/payments/[id]/refund never runs. So if this payment funded a
        // class-pack purchase, void any unredeemed credits here too, mirroring
        // the dispute-lost branch below (route.ts ~622-636). Otherwise the member
        // keeps spendable credits at check-in (lib/checkin.ts only filters
        // status='active' AND creditsRemaining>0) for a payment they got back.
        if (existing.stripePaymentIntentId) {
          const fundedPack = await tx.memberClassPack.findUnique({
            where: { stripePaymentIntentId: existing.stripePaymentIntentId },
          });
          if (fundedPack && fundedPack.status === "active") {
            await tx.memberClassPack.update({
              where: { id: fundedPack.id },
              data: { status: "refunded", creditsRemaining: 0 },
            });
            console.warn(
              `[stripe-webhook] charge.refunded — voided MemberClassPack ${fundedPack.id} ` +
              `(member=${fundedPack.memberId}, paymentIntentId=${existing.stripePaymentIntentId})`,
            );
          }
        }
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
        // Audit iter-1-member-lifecycle A3C-1: mirror subscription.deleted —
        // when Stripe reports the subscription as canceled / incomplete_expired
        // we also need to flip Member.status, otherwise a member who exits via
        // this branch (vs subscription.deleted) gets the same phantom-active
        // state. Membership status only flips down to cancelled here; reaching
        // "active" requires explicit staff PATCH (intentional).
        const newStatus = paymentStatus === "cancelled" ? "cancelled" : undefined;
        await tx.member.update({
          where: { id: member.id },
          data: {
            stripeSubscriptionId: status === "canceled" ? null : subscriptionId,
            ...(paymentStatus ? { paymentStatus } : {}),
            ...(newStatus ? { status: newStatus } : {}),
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
        // Audit iter-1-member-lifecycle A3H-5: BACS DD and other standalone
        // PaymentIntents (not tied to an invoice) need to flip Member.paymentStatus
        // back to "paid" — otherwise the BACS pending → succeeded flow leaves
        // the member in `paymentStatus: "pending"` forever. Mirrors the
        // invoice.payment_succeeded leg at line 218.
        await tx.member.update({
          where: { id: member.id },
          data: { paymentStatus: "paid" },
        });
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
      const customerId = (obj.customer as string) ?? null;
      const member = customerId ? await findMember(customerId) : null;
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
    } else if (event.type === "charge.dispute.created" || event.type === "charge.dispute.updated") {
      const customerId = (obj.customer as string) ?? null;
      const chargeId = (obj.charge as string) ?? null;
      const disputePaymentIntentId = (obj.payment_intent as string | null) ?? null;
      const member = customerId ? await findMember(customerId) : null;
      // B1: match the Payment by charge id first, then fall back to the
      // payment_intent — mirrors the charge.refunded reconciliation. PI-only /
      // charge-null payments (class packs, some PaymentIntents) otherwise never
      // link, so the contested funds keep counting as succeeded revenue and the
      // dispute is invisible to the ledger.
      let linkedPayment = chargeId
        ? await tx.payment.findFirst({ where: { stripeChargeId: chargeId } })
        : null;
      if (!linkedPayment && disputePaymentIntentId) {
        linkedPayment = await tx.payment.findFirst({ where: { stripePaymentIntentId: disputePaymentIntentId } });
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

        // B2: keep Member.paymentStatus in sync so the dashboard "payments due"
        // tile and reports payment-health reflect an active or lost chargeback.
        // 'won' with no prior refund returns the member to paid; every other
        // dispute state is funds-at-risk/clawed-back → overdue. Mirrors the
        // invoice.payment_failed leg's overdue flip.
        const disputeMemberId = member?.id ?? linkedPayment?.memberId ?? null;
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
            const dashboardUrl = `${getBaseUrl(req)}/dashboard/payments`;
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
    }
    });  // close withRlsBypass wrapper
  } catch (err) {
    // Audit iter-1-member-lifecycle backlog M3A-8: log the error before
    // rolling back so the failure mode is observable in production logs.
    console.error("[stripe-webhook] processing failed", {
      eventId: event.id,
      type: event.type,
      error: (err as Error)?.message,
    });
    // Roll back the idempotency claim so Stripe retries this event later.
    if (claimedEventRowId) {
      await withRlsBypass((tx) =>
        tx.stripeEvent.delete({ where: { id: claimedEventRowId! } }),
      ).catch(() => {});
    }
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  // Audit iter-1-member-lifecycle A3H-2 + A3H-9: dispatch side-effects only
  // AFTER the transaction has committed. Both lists are fire-and-forget so
  // any individual failure does not affect the 200 response to Stripe.
  for (const email of pendingEmails) {
    sendEmail(email).catch(() => {});
  }
  for (const entry of pendingAuditLogs) {
    void logAudit({ ...entry, req }).catch(() => {});
  }

  return NextResponse.json({ received: true });
}
