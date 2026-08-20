/**
 * Stripe → MatFlow reconciliation backstop (Tier 1.2).
 *
 * The whole payment pipeline is webhook-driven. Even with atomic idempotency and
 * Stripe's own retries, an event can still go unprocessed (a multi-day outage, a
 * webhook misconfiguration, a destination that was paused). This is the universal
 * safety net: for every connected account it lists the events Stripe actually
 * emitted and flags any HANDLED-type event whose id never made it into our
 * StripeEvent ledger — i.e. a silently-dropped payment/subscription/dispute event
 * — and raises it to Sentry + the logs so an operator can resend it from the
 * Stripe dashboard. (Auto-reprocessing is a deliberate follow-up: it needs the
 * webhook handler extracted into a reusable processor.)
 *
 * Read-only against the DB — it detects drops and reports them; it deletes
 * nothing. StripeEvent lifecycle belongs to app/api/cron/retention.
 *
 * Lives here rather than in the route because two cron entries would exceed the
 * Vercel Hobby limit of 2, so /api/cron/retention calls this as its first step.
 * The standalone /api/cron/stripe-reconcile route is kept for manual runs.
 */
import { withRlsBypass } from "@/lib/prisma-tenant";
import * as Sentry from "@sentry/nextjs";

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
// exhausts Stripe's retries is still caught here. Comfortably longer than the
// daily cadence, so a skipped night still gets covered by the next run.
const LOOKBACK_MS = 72 * 60 * 60 * 1000;

export type ReconcileResult = {
  ok: boolean;
  skipped?: string;
  tenantsChecked: number;
  eventsScanned: number;
  missingCount: number;
  missing: { tenantId: string; stripeAccountId: string; eventId: string; type: string }[];
  errors: { tenantId: string; error: string }[];
};

export async function runStripeReconciliation(): Promise<ReconcileResult> {
  const empty: ReconcileResult = {
    ok: true,
    tenantsChecked: 0,
    eventsScanned: 0,
    missingCount: 0,
    missing: [],
    errors: [],
  };
  if (!process.env.STRIPE_SECRET_KEY) {
    return { ...empty, skipped: "Stripe not configured" };
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
  const missing: ReconcileResult["missing"] = [];
  const errors: ReconcileResult["errors"] = [];

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
    console.error("[stripe-reconcile] unprocessed Stripe events detected", { count: missing.length, missing });
    Sentry.captureMessage(
      `Stripe reconcile: ${missing.length} handled event(s) Stripe emitted were never processed`,
      { level: "error", tags: { area: "stripe-reconcile" }, extra: { missing } },
    );
  }
  if (errors.length > 0) {
    console.warn("[stripe-reconcile] per-tenant errors", { errors });
  }

  // Tier 4.17 originally pruned StripeEvent here at 30 days. That prune is gone:
  // app/api/cron/retention owns StripeEvent's lifecycle on a 90-day window
  // (STRIPE_EVENT_RETENTION_MS, "Stripe's event replay window is ~30 days; 90 is
  // a generous idempotency margin"). Two prunes on one table means the shorter
  // one silently wins and the published retention rule becomes dead code, so
  // this job only DETECTS drops now — retention deletes.
  return {
    ok: true,
    tenantsChecked: tenants.length,
    eventsScanned,
    missingCount: missing.length,
    missing,
    errors,
  };
}
