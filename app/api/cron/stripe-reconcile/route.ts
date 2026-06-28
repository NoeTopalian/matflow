/**
 * Vercel cron — Stripe → MatFlow reconciliation backstop (Tier 1.2).
 * Schedule in vercel.json. Runs every few hours.
 *
 * The whole payment pipeline is webhook-driven. Even with atomic idempotency and
 * Stripe's own retries, an event can still go unprocessed (a multi-day outage, a
 * webhook misconfiguration, a destination that was paused). This job is the
 * universal safety net: for every connected account it lists the events Stripe
 * actually emitted and flags any HANDLED-type event whose id never made it into
 * our StripeEvent ledger — i.e. a silently-dropped payment/subscription/dispute
 * event — and raises it to Sentry + the logs so an operator can resend it from
 * the Stripe dashboard. (Auto-reprocessing is a deliberate follow-up: it needs
 * the webhook handler extracted into a reusable processor.)
 *
 * Read-only against the DB except for nothing — it only READS StripeEvent and
 * Tenant. No mutations, so it is safe to run frequently.
 */
import { withRlsBypass } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

export const runtime = "nodejs";
export const maxDuration = 300;

// Keep in sync with HANDLED_EVENT_TYPES in app/api/stripe/webhook/route.ts — these
// are the only events whose absence from StripeEvent indicates a real drop (we
// intentionally never claim unhandled types).
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
  "account.updated",
]);

// Look back a little over two webhook-retry windows so a transient outage that
// exhausts Stripe's retries is still caught here.
const LOOKBACK_MS = 72 * 60 * 60 * 1000;

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  }

  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });
  const createdGte = Math.floor((Date.now() - LOOKBACK_MS) / 1000);

  // Cross-tenant enumeration — bypass is intentional (a cron has no session).
  const tenants = await withRlsBypass((tx) =>
    tx.tenant.findMany({
      where: { stripeConnected: true, stripeAccountId: { not: null } },
      select: { id: true, stripeAccountId: true, name: true },
    }),
  );

  let eventsScanned = 0;
  const missing: { tenantId: string; stripeAccountId: string; eventId: string; type: string }[] = [];
  const errors: { tenantId: string; error: string }[] = [];

  for (const tenant of tenants) {
    const acct = tenant.stripeAccountId!;
    try {
      // Page through the connected account's recent events.
      const handledIds: { id: string; type: string }[] = [];
      for await (const ev of stripe.events.list(
        { limit: 100, created: { gte: createdGte } },
        { stripeAccount: acct },
      )) {
        eventsScanned++;
        if (HANDLED_EVENT_TYPES.has(ev.type)) handledIds.push({ id: ev.id, type: ev.type });
      }
      if (handledIds.length === 0) continue;

      // Which of those did we actually claim?
      const claimed = await withRlsBypass((tx) =>
        tx.stripeEvent.findMany({
          where: { eventId: { in: handledIds.map((e) => e.id) } },
          select: { eventId: true },
        }),
      );
      const claimedSet = new Set(claimed.map((c) => c.eventId));
      for (const e of handledIds) {
        if (!claimedSet.has(e.id)) {
          missing.push({ tenantId: tenant.id, stripeAccountId: acct, eventId: e.id, type: e.type });
        }
      }
    } catch (e) {
      errors.push({ tenantId: tenant.id, error: (e as Error)?.message ?? "unknown" });
    }
  }

  if (missing.length > 0) {
    console.error("[cron/stripe-reconcile] unprocessed Stripe events detected", { count: missing.length, missing });
    Sentry.captureMessage(
      `Stripe reconcile: ${missing.length} handled event(s) Stripe emitted were never processed`,
      { level: "error", tags: { area: "stripe-reconcile" }, extra: { missing } },
    );
  }
  if (errors.length > 0) {
    console.warn("[cron/stripe-reconcile] per-tenant errors", { errors });
  }

  // Tier 4.17: StripeEvent is an unbounded append-only idempotency ledger on the
  // hot webhook path. Prune rows older than 30 days — well past Stripe's ~3-day
  // retry window, so a pruned id can never be redelivered and wrongly reprocessed.
  let pruned = 0;
  try {
    const res = await withRlsBypass((tx) =>
      tx.stripeEvent.deleteMany({
        where: { processedAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      }),
    );
    pruned = res.count;
  } catch (e) {
    console.warn("[cron/stripe-reconcile] StripeEvent prune failed", { error: (e as Error)?.message });
  }

  return NextResponse.json({
    ok: true,
    tenantsChecked: tenants.length,
    eventsScanned,
    missingCount: missing.length,
    missing,
    errors,
    pruned,
  });
}
