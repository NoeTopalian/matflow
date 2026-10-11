// Payments lane PD (11 Oct 2026) — reconciliation logic with Stripe and the
// database both replaced (the store writes are proven against a real database
// in tests/integration/pay-pd-reconcile-db.test.ts, under both roles).
//
// Pinned: missing handled events are recorded as reconcile-found and never
// processed; unhandled and other-mode events are ignored; a subscription whose
// status disagrees with the member's payment status is reported; a payment
// whose charge was refunded/partially refunded in Stripe is reported; a
// vanished subscription is reported; a club whose Stripe access was withdrawn
// is reported with its backlog and never called; one club's Stripe error does
// not stop the others; nothing writes member or payment state; one run row,
// finished with the right status.

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  tenants: [] as Array<{ id: string; stripeAccountId: string | null; stripeConnected: boolean }>,
  known: new Set<string>(),
  members: [] as Array<{ id: string; tenantId: string; stripeSubscriptionId: string; paymentStatus: string }>,
  payments: [] as Array<{ id: string; tenantId: string; status: string; stripeChargeId: string | null; stripePaymentIntentId: string | null; refundedAmountPence: number | null }>,
  backlog: 0,
  runs: [] as Array<Record<string, unknown>>,
  writes: [] as string[],
}));
const recordReceived = vi.hoisted(() => vi.fn(async (e: { id: string }) => {
  db.known.add(e.id);
  return { eventId: e.id, status: "received", attempts: 0, tenantId: null, alreadyProcessed: false };
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>) =>
    fn({
      tenant: { findMany: async () => db.tenants.filter((t) => t.stripeAccountId) },
      stripeEvent: {
        findMany: async ({ where }: { where: { eventId: { in: string[] } } }) =>
          where.eventId.in.filter((id) => db.known.has(id)).map((eventId) => ({ eventId })),
        count: async () => db.backlog,
      },
      member: {
        findMany: async ({ where }: { where: { tenantId: string } }) => db.members.filter((m) => m.tenantId === where.tenantId),
        update: async () => { db.writes.push("member.update"); },
        updateMany: async () => { db.writes.push("member.updateMany"); },
      },
      payment: {
        findMany: async ({ where }: { where: { tenantId: string } }) => db.payments.filter((p) => p.tenantId === where.tenantId),
        update: async () => { db.writes.push("payment.update"); },
        updateMany: async () => { db.writes.push("payment.updateMany"); },
      },
      stripeReconcileRun: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          db.runs.push({ id: `run-${db.runs.length + 1}`, ...data });
          return { id: `run-${db.runs.length}` };
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const r = db.runs.find((x) => x.id === where.id)!;
          Object.assign(r, data);
          return r;
        },
      },
    }),
}));
vi.mock("@/lib/stripe/event-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/event-store")>()),
  recordReceived,
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

import { runStripeReconciliation, type ReconcileStripe } from "@/lib/stripe/reconcile";

const NOW = new Date("2026-10-11T03:00:00Z");
const T = Math.floor(NOW.getTime() / 1000) - 3600;
const ev = (id: string, type: string, livemode = false) => ({ id, type, created: T, livemode, data: { object: { id: `obj_${id}` } } });

function fakeStripe(over: Partial<{
  events: Record<string, ReturnType<typeof ev>[]>;
  subs: Record<string, string | Error>;
  charges: Record<string, { status: string; refunded: boolean; amount_refunded: number; disputed: boolean } | Error>;
  intents: Record<string, string>;
}> = {}) {
  const calls: Array<{ kind: string; id?: string; acct: string }> = [];
  const missing = () => Object.assign(new Error("No such object"), { code: "resource_missing", statusCode: 404 });
  const s: ReconcileStripe = {
    events: {
      list: (_p, o) => {
        calls.push({ kind: "events.list", acct: o.stripeAccount });
        const list = over.events?.[o.stripeAccount];
        if (!list) throw new Error(`stripe down for ${o.stripeAccount}`);
        return (async function* () { yield* list; })();
      },
    },
    subscriptions: {
      retrieve: async (id, _p, o) => {
        calls.push({ kind: "subscriptions.retrieve", id, acct: o.stripeAccount });
        const v = over.subs?.[id];
        if (v === undefined) throw missing();
        if (v instanceof Error) throw v;
        return { id, status: v };
      },
    },
    charges: {
      retrieve: async (id, _p, o) => {
        calls.push({ kind: "charges.retrieve", id, acct: o.stripeAccount });
        const v = over.charges?.[id];
        if (v === undefined) throw missing();
        if (v instanceof Error) throw v;
        return { id, ...v };
      },
    },
    paymentIntents: {
      retrieve: async (id, _p, o) => {
        calls.push({ kind: "paymentIntents.retrieve", id, acct: o.stripeAccount });
        const v = over.intents?.[id];
        if (v === undefined) throw missing();
        return { id, status: v };
      },
    },
  };
  return { stripe: s, calls };
}

beforeEach(() => {
  db.tenants = [];
  db.known = new Set();
  db.members = [];
  db.payments = [];
  db.backlog = 0;
  db.runs = [];
  db.writes = [];
  recordReceived.mockClear();
  process.env.STRIPE_SECRET_KEY = "sk_test_paypd_synthetic_never_used";
});

describe("pay-pd: Stripe reconciliation", () => {
  it("records missing handled events as reconcile-found, ignores unhandled and other-mode events, never processes", async () => {
    db.tenants = [{ id: "t1", stripeAccountId: "acct_1", stripeConnected: true }];
    db.known.add("evt_seen");
    const { stripe } = fakeStripe({
      events: {
        acct_1: [
          ev("evt_seen", "invoice.payment_succeeded"),
          ev("evt_lost", "invoice.payment_succeeded"),
          ev("evt_lost_sub", "customer.subscription.updated"),
          ev("evt_unhandled", "customer.created"),
          ev("evt_live", "invoice.payment_failed", true),
        ],
      },
    });
    const r = await runStripeReconciliation({ stripe, now: NOW });
    expect(r.eventsScanned).toBe(5);
    expect(r.missing).toEqual([
      { tenantId: "t1", stripeAccountId: "acct_1", eventId: "evt_lost", type: "invoice.payment_succeeded" },
      { tenantId: "t1", stripeAccountId: "acct_1", eventId: "evt_lost_sub", type: "customer.subscription.updated" },
    ]);
    expect(recordReceived).toHaveBeenCalledTimes(2);
    for (const call of recordReceived.mock.calls as unknown as Array<[{ id: string; account: string }, { reconcileFound: boolean; tenantId: string }]>) {
      expect(call[0].account).toBe("acct_1");
      expect(call[1]).toEqual({ reconcileFound: true, tenantId: "t1" });
    }
    expect(r.missingCount).toBe(2);
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]).toMatchObject({ trigger: "cron", status: "mismatches", eventsMissing: 2, eventsScanned: 5, tenantsChecked: 1 });
    expect(db.writes).toEqual([]);
  });

  it("a second run finds nothing new for events already recorded", async () => {
    db.tenants = [{ id: "t1", stripeAccountId: "acct_1", stripeConnected: true }];
    const { stripe } = fakeStripe({ events: { acct_1: [ev("evt_lost", "charge.refunded")] } });
    expect((await runStripeReconciliation({ stripe, now: NOW })).missingCount).toBe(1);
    const second = await runStripeReconciliation({ stripe, now: NOW });
    expect(second.missingCount).toBe(0);
    expect(db.runs[1]).toMatchObject({ status: "ok" });
  });

  it("reports subscription status that disagrees with the member, and a subscription Stripe no longer has", async () => {
    db.tenants = [{ id: "t1", stripeAccountId: "acct_1", stripeConnected: true }];
    db.members = [
      { id: "m_ok", tenantId: "t1", stripeSubscriptionId: "sub_ok", paymentStatus: "paid" },
      { id: "m_drift", tenantId: "t1", stripeSubscriptionId: "sub_drift", paymentStatus: "paid" },
      { id: "m_gone", tenantId: "t1", stripeSubscriptionId: "sub_gone", paymentStatus: "paid" },
      { id: "m_unmapped", tenantId: "t1", stripeSubscriptionId: "sub_incomplete", paymentStatus: "pending" },
    ];
    const { stripe, calls } = fakeStripe({ events: { acct_1: [] }, subs: { sub_ok: "active", sub_drift: "past_due", sub_incomplete: "incomplete" } });
    const r = await runStripeReconciliation({ stripe, now: NOW });
    expect(r.stateMismatches).toEqual([
      { tenantId: "t1", kind: "subscription", objectId: "sub_drift", recordId: "m_drift", field: "paymentStatus", stored: "paid", stripe: "past_due" },
      { tenantId: "t1", kind: "subscription", objectId: "sub_gone", recordId: "m_gone", field: "exists", stored: "linked", stripe: "missing" },
    ]);
    expect(calls.filter((c) => c.kind === "subscriptions.retrieve").every((c) => c.acct === "acct_1")).toBe(true);
    expect(db.writes).toEqual([]);
    expect(db.runs[0]).toMatchObject({ status: "mismatches" });
  });

  it("reports a payment refunded or failed in Stripe but not here, and a partial refund amount mismatch", async () => {
    db.tenants = [{ id: "t1", stripeAccountId: "acct_1", stripeConnected: true }];
    db.payments = [
      { id: "p_ok", tenantId: "t1", status: "succeeded", stripeChargeId: "ch_ok", stripePaymentIntentId: "pi_ok", refundedAmountPence: null },
      { id: "p_refunded", tenantId: "t1", status: "succeeded", stripeChargeId: "ch_ref", stripePaymentIntentId: null, refundedAmountPence: null },
      { id: "p_partial", tenantId: "t1", status: "succeeded", stripeChargeId: "ch_part", stripePaymentIntentId: null, refundedAmountPence: 500 },
      { id: "p_pi", tenantId: "t1", status: "succeeded", stripeChargeId: null, stripePaymentIntentId: "pi_failed", refundedAmountPence: null },
    ];
    const { stripe } = fakeStripe({
      events: { acct_1: [] },
      charges: {
        ch_ok: { status: "succeeded", refunded: false, amount_refunded: 0, disputed: false },
        ch_ref: { status: "succeeded", refunded: true, amount_refunded: 4500, disputed: false },
        ch_part: { status: "succeeded", refunded: false, amount_refunded: 1000, disputed: false },
      },
      intents: { pi_failed: "requires_payment_method" },
    });
    const r = await runStripeReconciliation({ stripe, now: NOW });
    expect(r.stateMismatches).toEqual([
      { tenantId: "t1", kind: "payment", objectId: "ch_ref", recordId: "p_refunded", field: "status", stored: "succeeded", stripe: "refunded" },
      { tenantId: "t1", kind: "payment", objectId: "ch_ref", recordId: "p_refunded", field: "amountRefundedPence", stored: 0, stripe: 4500 },
      { tenantId: "t1", kind: "payment", objectId: "ch_part", recordId: "p_partial", field: "amountRefundedPence", stored: 500, stripe: 1000 },
      { tenantId: "t1", kind: "payment", objectId: "pi_failed", recordId: "p_pi", field: "status", stored: "succeeded", stripe: "requires_payment_method" },
    ]);
    expect(db.writes).toEqual([]);
  });

  it("a club whose Stripe access was withdrawn is reported with its backlog and never called", async () => {
    db.tenants = [
      { id: "t_gone", stripeAccountId: "acct_gone", stripeConnected: false },
      { id: "t1", stripeAccountId: "acct_1", stripeConnected: true },
      { id: "t_none", stripeAccountId: null, stripeConnected: false },
    ];
    db.backlog = 3;
    const { stripe, calls } = fakeStripe({ events: { acct_1: [] } });
    const r = await runStripeReconciliation({ stripe, now: NOW });
    expect(r.skippedTenants).toEqual([{ tenantId: "t_gone", stripeAccountId: "acct_gone", reason: "stripe_access_withdrawn", unprocessedInStore: 3 }]);
    expect(r.tenantsSkipped).toBe(1);
    expect(r.tenantsChecked).toBe(1);
    expect(calls.some((c) => c.acct === "acct_gone")).toBe(false);
    expect(db.runs[0]).toMatchObject({ tenantsSkipped: 1, skipped: { tenants: r.skippedTenants, truncated: [] } });
  });

  it("one club's Stripe failure is recorded and the others are still checked", async () => {
    db.tenants = [
      { id: "t_down", stripeAccountId: "acct_down", stripeConnected: true },
      { id: "t1", stripeAccountId: "acct_1", stripeConnected: true },
    ];
    const { stripe } = fakeStripe({ events: { acct_1: [ev("evt_x", "invoice.voided")] } });
    const r = await runStripeReconciliation({ stripe, now: NOW });
    expect(r.errors).toEqual([{ tenantId: "t_down", error: "stripe down for acct_down" }]);
    expect(r.missing.map((m) => m.eventId)).toEqual(["evt_x"]);
    expect(db.runs[0]).toMatchObject({ status: "errors" });
  });

  it("without a Stripe key the run is recorded as skipped and nothing is called", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    db.tenants = [{ id: "t1", stripeAccountId: "acct_1", stripeConnected: true }];
    const r = await runStripeReconciliation({ now: NOW });
    expect(r.skipped).toBe("Stripe not configured");
    expect(db.runs[0]).toMatchObject({ status: "skipped" });
  });

  it("the window is clamped to Stripe's 30-day event history", async () => {
    db.tenants = [{ id: "t1", stripeAccountId: "acct_1", stripeConnected: true }];
    let gte = 0;
    const { stripe } = fakeStripe({ events: { acct_1: [] } });
    const list = stripe.events.list;
    stripe.events.list = (p, o) => { gte = p.created.gte; return list(p, o); };
    await runStripeReconciliation({ stripe, now: NOW, lookbackMs: 400 * 24 * 3600 * 1000 });
    expect(Math.floor(NOW.getTime() / 1000) - gte).toBe(30 * 24 * 3600);
  });
});
