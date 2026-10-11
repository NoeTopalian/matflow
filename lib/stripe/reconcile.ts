/**
 * Stripe → MatFlow reconciliation (payments lane PD, 11 Oct 2026; was Tier 1.2).
 *
 * The pipeline is webhook-driven and Stripe says so plainly: deliveries are
 * retried for three days, order is not guaranteed, duplicates happen, and the
 * Events API only reaches back 30 days. This job is the backstop. Per club that
 * holds a connected-account id:
 *
 *  (a) EVENTS — lists the account's events for the window (as the connected
 *      account, `Stripe-Account`), and every HANDLED-type event the store has
 *      never seen is written to the store as `received` with attempts 0 and
 *      `reconcileFoundAt` set. It is NOT processed: replay is operator-
 *      controlled (lib/stripe/replay.ts, /admin/stripe). The whole window is
 *      compared rather than `delivery_success=false` alone: an event Stripe
 *      counts as delivered (a 2xx from an older deploy, a P2002 misread as a
 *      duplicate) can still be missing here, and only a full comparison sees it.
 *  (b) STATE — for each live MemberSubscription mapping, the subscription is
 *      retrieved and its status and current_period_end compared with the
 *      mapping, and (for the member's active mapping) the member's payment
 *      status through the map the webhook uses; for each Stripe-backed Payment
 *      in the window, the charge (or PaymentIntent) is retrieved and its status
 *      and amount_refunded compared with the row. Differences are REPORTED
 *      (ids, field names, statuses, pence) — this job never writes member or
 *      payment state.
 *
 * A club whose Stripe access was withdrawn (`stripeConnected: false`) but which
 * still holds an id is REPORTED (with its unprocessed store rows) and not
 * called: the platform can no longer act as that account.
 *
 * Every run writes one `StripeReconcileRun` row (running → final status) that
 * /admin/stripe shows. Callers: /api/cron/stripe-reconcile (its own schedule
 * and gate, STRIPE_RECONCILE_ENABLED) and, unchanged, the retention cron.
 */
import type { Prisma } from "@prisma/client";
import { withRlsBypass } from "@/lib/prisma-tenant";
import * as Sentry from "@sentry/nextjs";
import { HANDLED_STRIPE_EVENT_TYPES } from "@/lib/stripe/handled-events";
import { classifyStripeKey } from "@/lib/stripe/key-mode";
import { subscriptionStatusToPaymentStatus } from "@/lib/stripe/subscription-status";
import { recordReceived, sanitiseEventError } from "@/lib/stripe/event-store";
import { subscriptionCurrentPeriodEnd } from "@/lib/stripe/webhook/mapping";

const HANDLED_EVENT_TYPES = HANDLED_STRIPE_EVENT_TYPES;

/** Default window: a little over two delivery-retry windows, so a skipped night is still covered. */
export const RECONCILE_LOOKBACK_MS = 72 * 60 * 60 * 1000;
/** Stripe's List Events reaches back 30 days; asking for more returns nothing extra. */
export const RECONCILE_MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound on retrieves per club per kind, to stay inside the cron's maxDuration. */
export const RECONCILE_MAX_OBJECTS_PER_TENANT = 200;

type StripeEventLike = {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  account?: string | null;
  data: { object: { id?: unknown } & Record<string, unknown> };
};
type AcctOpt = { stripeAccount: string };

/** The Stripe calls this job makes — all reads, all as the connected account. */
export type ReconcileStripe = {
  events: { list(params: { limit: number; created: { gte: number } }, opts: AcctOpt): AsyncIterable<StripeEventLike> };
  subscriptions: {
    retrieve(id: string, params: Record<string, never>, opts: AcctOpt): Promise<{ id: string; status: string } & Record<string, unknown>>;
  };
  charges: {
    retrieve(
      id: string,
      params: Record<string, never>,
      opts: AcctOpt,
    ): Promise<{ id: string; status: string; refunded: boolean; amount_refunded: number; disputed: boolean }>;
  };
  paymentIntents: { retrieve(id: string, params: Record<string, never>, opts: AcctOpt): Promise<{ id: string; status: string }> };
};

export type StateMismatch = {
  tenantId: string;
  kind: "subscription" | "payment";
  /** The Stripe object compared (sub_…, ch_…, pi_…). */
  objectId: string;
  /** The MatFlow row compared (Member.id or Payment.id). */
  recordId: string;
  field: "paymentStatus" | "status" | "currentPeriodEnd" | "amountRefundedPence" | "exists" | "mapping";
  stored: string | number | null;
  stripe: string | number | null;
};

export type ReconcileResult = {
  ok: boolean;
  skipped?: string;
  runId: string | null;
  tenantsChecked: number;
  tenantsSkipped: number;
  eventsScanned: number;
  missingCount: number;
  missing: { tenantId: string; stripeAccountId: string; eventId: string; type: string }[];
  stateMismatches: StateMismatch[];
  skippedTenants: { tenantId: string; stripeAccountId: string; reason: "stripe_access_withdrawn"; unprocessedInStore: number }[];
  truncated: { tenantId: string; kind: "subscriptions" | "payments"; limit: number }[];
  errors: { tenantId: string; error: string }[];
};

export type ReconcileOptions = {
  trigger?: "cron" | "manual";
  lookbackMs?: number;
  now?: Date;
  /** Injected in tests; otherwise built from STRIPE_SECRET_KEY. */
  stripe?: ReconcileStripe;
  /** Limit the run to these clubs (tests, manual runs). */
  tenantIds?: string[];
};

function isMissingResource(err: unknown): boolean {
  const e = err as { code?: unknown; statusCode?: unknown; raw?: { code?: unknown } } | null;
  return e?.code === "resource_missing" || e?.raw?.code === "resource_missing" || e?.statusCode === 404;
}

/** Local Payment statuses consistent with what Stripe says about the charge. */
function acceptableForCharge(c: { status: string; refunded: boolean; disputed: boolean }): string[] {
  if (c.disputed) return ["disputed", "succeeded", "refunded"];
  if (c.refunded) return ["refunded"];
  if (c.status === "succeeded") return ["succeeded"];
  if (c.status === "pending") return ["pending"];
  return ["failed"];
}

function acceptableForIntent(status: string): string[] {
  switch (status) {
    case "succeeded":
      return ["succeeded", "refunded", "disputed"];
    case "processing":
      return ["pending"];
    case "requires_payment_method":
    case "requires_action":
    case "requires_confirmation":
      return ["pending", "failed"];
    case "canceled":
      return ["failed"];
    default:
      return ["pending", "failed", "succeeded"];
  }
}

async function makeStripe(): Promise<ReconcileStripe> {
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" });
  return stripe as unknown as ReconcileStripe;
}

export async function runStripeReconciliation(opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();
  const lookback = Math.min(Math.max(opts.lookbackMs ?? RECONCILE_LOOKBACK_MS, 60_000), RECONCILE_MAX_LOOKBACK_MS);
  const windowStart = new Date(now.getTime() - lookback);
  const trigger = opts.trigger ?? "cron";
  const result: ReconcileResult = {
    ok: true,
    runId: null,
    tenantsChecked: 0,
    tenantsSkipped: 0,
    eventsScanned: 0,
    missingCount: 0,
    missing: [],
    stateMismatches: [],
    skippedTenants: [],
    truncated: [],
    errors: [],
  };

  if (!opts.stripe && !process.env.STRIPE_SECRET_KEY) {
    const run = await withRlsBypass((tx) =>
      tx.stripeReconcileRun.create({
        data: { trigger, windowStart, status: "skipped", finishedAt: new Date(), errors: [{ tenantId: null, error: "Stripe not configured" }] },
        select: { id: true },
      }),
    );
    return { ...result, runId: run.id, skipped: "Stripe not configured" };
  }
  const stripe = opts.stripe ?? (await makeStripe());
  const keyMode = classifyStripeKey(process.env.STRIPE_SECRET_KEY).mode;
  const expectLive = keyMode === "live" ? true : keyMode === "test" ? false : null;

  const run = await withRlsBypass((tx) =>
    tx.stripeReconcileRun.create({ data: { trigger, windowStart, status: "running" }, select: { id: true } }),
  );
  result.runId = run.id;

  // Cross-tenant enumeration — bypass is intentional (a cron has no session).
  const tenants = await withRlsBypass((tx) =>
    tx.tenant.findMany({
      where: {
        stripeAccountId: { not: null },
        ...(opts.tenantIds ? { id: { in: opts.tenantIds } } : {}),
      },
      select: { id: true, stripeAccountId: true, stripeConnected: true },
      orderBy: { id: "asc" },
    }),
  );
  const createdGte = Math.floor(windowStart.getTime() / 1000);

  for (const tenant of tenants) {
    const acct = tenant.stripeAccountId!;
    if (!tenant.stripeConnected) {
      const unprocessed = await withRlsBypass((tx) =>
        tx.stripeEvent.count({ where: { OR: [{ tenantId: tenant.id }, { stripeAccountId: acct }], status: { in: ["received", "failed"] } } }),
      );
      result.skippedTenants.push({ tenantId: tenant.id, stripeAccountId: acct, reason: "stripe_access_withdrawn", unprocessedInStore: unprocessed });
      continue;
    }
    result.tenantsChecked++;
    try {
      await reconcileEvents(stripe, tenant.id, acct, createdGte, expectLive, result);
      await reconcileSubscriptions(stripe, tenant.id, acct, result);
      await reconcilePayments(stripe, tenant.id, acct, windowStart, result);
    } catch (e) {
      result.errors.push({ tenantId: tenant.id, error: sanitiseEventError(e) });
    }
  }
  result.tenantsSkipped = result.skippedTenants.length;
  result.missingCount = result.missing.length;

  const status = result.errors.length > 0 ? "errors" : result.missingCount > 0 || result.stateMismatches.length > 0 ? "mismatches" : "ok";
  await withRlsBypass((tx) =>
    tx.stripeReconcileRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: new Date(),
        tenantsChecked: result.tenantsChecked,
        tenantsSkipped: result.tenantsSkipped,
        eventsScanned: result.eventsScanned,
        eventsMissing: result.missingCount,
        stateMismatches: result.stateMismatches as unknown as Prisma.InputJsonValue,
        skipped: { tenants: result.skippedTenants, truncated: result.truncated } as unknown as Prisma.InputJsonValue,
        errors: result.errors as unknown as Prisma.InputJsonValue,
      },
    }),
  );

  if (result.missingCount > 0 || result.stateMismatches.length > 0) {
    console.error("[stripe-reconcile] drift detected", {
      runId: run.id,
      missing: result.missingCount,
      mismatches: result.stateMismatches.length,
    });
    Sentry.captureMessage(
      `Stripe reconcile: ${result.missingCount} missing event(s), ${result.stateMismatches.length} state mismatch(es)`,
      { level: "error", tags: { area: "stripe-reconcile" }, extra: { runId: run.id } },
    );
  }
  if (result.errors.length > 0) {
    console.warn("[stripe-reconcile] per-tenant errors", { runId: run.id, errors: result.errors });
  }
  // StripeEvent lifecycle (the 90-day prune) belongs to app/api/cron/retention.
  return result;
}

async function reconcileEvents(
  stripe: ReconcileStripe,
  tenantId: string,
  acct: string,
  createdGte: number,
  expectLive: boolean | null,
  result: ReconcileResult,
): Promise<void> {
  const handled: StripeEventLike[] = [];
  for await (const ev of stripe.events.list({ limit: 100, created: { gte: createdGte } }, { stripeAccount: acct })) {
    result.eventsScanned++;
    if (!HANDLED_EVENT_TYPES.has(ev.type)) continue;
    // An event of the other mode is not ours to process under this key.
    if (expectLive !== null && ev.livemode !== expectLive) continue;
    handled.push(ev);
  }
  if (handled.length === 0) return;
  const known = await withRlsBypass((tx) =>
    tx.stripeEvent.findMany({ where: { eventId: { in: handled.map((e) => e.id) } }, select: { eventId: true } }),
  );
  const knownSet = new Set(known.map((k) => k.eventId));
  for (const ev of handled) {
    if (knownSet.has(ev.id)) continue;
    await recordReceived({ ...ev, account: acct }, { reconcileFound: true, tenantId });
    result.missing.push({ tenantId, stripeAccountId: acct, eventId: ev.id, type: ev.type });
  }
}

/**
 * Subscriptions are compared through lane PC's MemberSubscription mapping —
 * the verified link between one Stripe subscription and one member. For every
 * live mapping (not ended): its status and current_period_end against Stripe's;
 * and, when it is the member's ACTIVE mapping (Member.stripeSubscriptionId
 * points at it), the member's paymentStatus against the status map the webhook
 * uses. A member pointer with no mapping row at all is reported without a
 * Stripe call. Reports only: no mapping, member or payment row is written.
 */
async function reconcileSubscriptions(stripe: ReconcileStripe, tenantId: string, acct: string, result: ReconcileResult): Promise<void> {
  const { mappings, unmapped } = await withRlsBypass(async (tx) => {
    const mappings = await tx.memberSubscription.findMany({
      where: { tenantId, endedAt: null },
      select: {
        id: true,
        memberId: true,
        stripeSubscriptionId: true,
        status: true,
        currentPeriodEnd: true,
        member: { select: { paymentStatus: true, stripeSubscriptionId: true } },
      },
      orderBy: { id: "asc" },
      take: RECONCILE_MAX_OBJECTS_PER_TENANT + 1,
    });
    const pointers = await tx.member.findMany({
      where: { tenantId, stripeSubscriptionId: { not: null } },
      select: { id: true, stripeSubscriptionId: true },
      orderBy: { id: "asc" },
      take: RECONCILE_MAX_OBJECTS_PER_TENANT,
    });
    const known = pointers.length
      ? await tx.memberSubscription.findMany({
          where: { tenantId, stripeSubscriptionId: { in: pointers.map((p) => p.stripeSubscriptionId!) } },
          select: { stripeSubscriptionId: true },
        })
      : [];
    const knownSet = new Set(known.map((k) => k.stripeSubscriptionId));
    return { mappings, unmapped: pointers.filter((p) => !knownSet.has(p.stripeSubscriptionId!)) };
  });
  if (mappings.length > RECONCILE_MAX_OBJECTS_PER_TENANT) {
    result.truncated.push({ tenantId, kind: "subscriptions", limit: RECONCILE_MAX_OBJECTS_PER_TENANT });
    mappings.length = RECONCILE_MAX_OBJECTS_PER_TENANT;
  }
  for (const p of unmapped) {
    result.stateMismatches.push({ tenantId, kind: "subscription", objectId: p.stripeSubscriptionId!, recordId: p.id, field: "mapping", stored: "missing", stripe: null });
  }
  for (const m of mappings) {
    const subId = m.stripeSubscriptionId;
    let sub: { status: string } & Record<string, unknown>;
    try {
      sub = await stripe.subscriptions.retrieve(subId, {}, { stripeAccount: acct });
    } catch (e) {
      if (isMissingResource(e)) {
        result.stateMismatches.push({ tenantId, kind: "subscription", objectId: subId, recordId: m.memberId, field: "exists", stored: m.status, stripe: "missing" });
        continue;
      }
      throw e;
    }
    if (sub.status !== m.status) {
      result.stateMismatches.push({ tenantId, kind: "subscription", objectId: subId, recordId: m.memberId, field: "status", stored: m.status, stripe: sub.status });
    }
    const stripeEnd = subscriptionCurrentPeriodEnd(sub);
    const storedEnd = m.currentPeriodEnd;
    const toSec = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null);
    if (stripeEnd && toSec(storedEnd) !== toSec(stripeEnd)) {
      result.stateMismatches.push({
        tenantId,
        kind: "subscription",
        objectId: subId,
        recordId: m.memberId,
        field: "currentPeriodEnd",
        stored: storedEnd ? storedEnd.toISOString() : null,
        stripe: stripeEnd.toISOString(),
      });
    }
    const active = m.member.stripeSubscriptionId === subId;
    const expected = subscriptionStatusToPaymentStatus(sub.status);
    if (active && expected !== undefined && expected !== m.member.paymentStatus) {
      result.stateMismatches.push({ tenantId, kind: "subscription", objectId: subId, recordId: m.memberId, field: "paymentStatus", stored: m.member.paymentStatus, stripe: sub.status });
    }
  }
}

async function reconcilePayments(
  stripe: ReconcileStripe,
  tenantId: string,
  acct: string,
  windowStart: Date,
  result: ReconcileResult,
): Promise<void> {
  const payments = await withRlsBypass((tx) =>
    tx.payment.findMany({
      where: {
        tenantId,
        createdAt: { gte: windowStart },
        OR: [{ stripeChargeId: { not: null } }, { stripePaymentIntentId: { not: null } }],
      },
      select: { id: true, status: true, stripeChargeId: true, stripePaymentIntentId: true, refundedAmountPence: true },
      orderBy: { createdAt: "asc" },
      take: RECONCILE_MAX_OBJECTS_PER_TENANT + 1,
    }),
  );
  if (payments.length > RECONCILE_MAX_OBJECTS_PER_TENANT) {
    result.truncated.push({ tenantId, kind: "payments", limit: RECONCILE_MAX_OBJECTS_PER_TENANT });
    payments.length = RECONCILE_MAX_OBJECTS_PER_TENANT;
  }
  for (const p of payments) {
    if (p.stripeChargeId) {
      let ch: { status: string; refunded: boolean; amount_refunded: number; disputed: boolean };
      try {
        ch = await stripe.charges.retrieve(p.stripeChargeId, {}, { stripeAccount: acct });
      } catch (e) {
        if (isMissingResource(e)) {
          result.stateMismatches.push({ tenantId, kind: "payment", objectId: p.stripeChargeId, recordId: p.id, field: "exists", stored: p.status, stripe: "missing" });
          continue;
        }
        throw e;
      }
      if (!acceptableForCharge(ch).includes(p.status)) {
        result.stateMismatches.push({ tenantId, kind: "payment", objectId: p.stripeChargeId, recordId: p.id, field: "status", stored: p.status, stripe: ch.refunded ? "refunded" : ch.disputed ? "disputed" : ch.status });
      }
      const localRefunded = p.refundedAmountPence ?? 0;
      if (localRefunded !== ch.amount_refunded) {
        result.stateMismatches.push({ tenantId, kind: "payment", objectId: p.stripeChargeId, recordId: p.id, field: "amountRefundedPence", stored: localRefunded, stripe: ch.amount_refunded });
      }
    } else if (p.stripePaymentIntentId) {
      let pi: { status: string };
      try {
        pi = await stripe.paymentIntents.retrieve(p.stripePaymentIntentId, {}, { stripeAccount: acct });
      } catch (e) {
        if (isMissingResource(e)) {
          result.stateMismatches.push({ tenantId, kind: "payment", objectId: p.stripePaymentIntentId, recordId: p.id, field: "exists", stored: p.status, stripe: "missing" });
          continue;
        }
        throw e;
      }
      if (!acceptableForIntent(pi.status).includes(p.status)) {
        result.stateMismatches.push({ tenantId, kind: "payment", objectId: p.stripePaymentIntentId, recordId: p.id, field: "status", stored: p.status, stripe: pi.status });
      }
    }
  }
}
