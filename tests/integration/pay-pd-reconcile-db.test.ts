// Payments lane PD (11 Oct 2026) — reconciliation store writes against a REAL
// database (Neon TEST branch, both guarded runners). Stripe is replaced by a
// fake that serves the club's events, subscriptions and charges; everything
// MatFlow-side is real: StripeEvent rows, Member and Payment rows, the
// StripeReconcileRun row.
//
// Proof (f): an event the store had processed is deliberately deleted from the
// store; the reconcile run finds it in Stripe's list, records it as `received`
// with attempts 0 and reconcileFoundAt set, and does NOT process it (no
// Payment row appears, no member changes). Also pinned: state drift is
// reported without any member or payment write; a deauthorised club is
// reported, never called; the run row carries the summary.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { runStripeEvent, type StripeEventProcessor } from "@/lib/stripe/event-store";
import { runStripeReconciliation, type ReconcileStripe } from "@/lib/stripe/reconcile";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `paypdrc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const S = STAMP.replace(/-/g, "");
const TENANT = `${STAMP}-t`;
const GONE = `${STAMP}-g`;
const FAKE = `${STAMP}-f`;
const ACCT_FAKE = `acct_${S}_fake`;
const ACCT = `acct_${S}`;
const ACCT_GONE = `acct_${S}gone`;
const MEMBER = `${STAMP}-m`;
const SUB = `sub_${S}`;
const CHARGE = `ch_${S}`;
const NOW = Math.floor(Date.now() / 1000);
const STORED_END = new Date("2026-11-01T00:00:00.000Z");
const STRIPE_END = Math.floor(new Date("2026-11-08T00:00:00.000Z").getTime() / 1000);
const E_KEPT = `evt_${S}_kept`;
const E_DELETED = `evt_${S}_deleted`;

const stripeEvent = (id: string, type: string) => ({ id, type, created: NOW - 600, livemode: false, data: { object: { id: `in_${id}` } } });

describe.skipIf(!HAS_DB)("pay-pd: reconciliation against the real store", () => {
  let paymentId = "";

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_paypd_synthetic_never_used";
    await withRlsBypass(async (tx) => {
      await tx.tenant.create({ data: { id: TENANT, name: `${STAMP} club`, slug: TENANT, stripeAccountId: ACCT, stripeConnected: true } });
      await tx.tenant.create({ data: { id: GONE, name: `${STAMP} gone`, slug: GONE, stripeAccountId: ACCT_GONE, stripeConnected: false } });
      await tx.member.create({ data: { id: MEMBER, tenantId: TENANT, email: `${STAMP}@example.test`, name: "PD reconcile", stripeSubscriptionId: SUB, paymentStatus: "paid" } });
      await tx.memberSubscription.create({
        data: { tenantId: TENANT, memberId: MEMBER, stripeAccountId: ACCT, stripeSubscriptionId: SUB, source: "app", status: "active", currentPeriodEnd: STORED_END },
      });
      const p = await tx.payment.create({ data: { tenantId: TENANT, memberId: MEMBER, stripeChargeId: CHARGE, amountPence: 4500, currency: "GBP", status: "succeeded", paidAt: new Date() } });
      paymentId = p.id;
    });
    // Two events processed normally; then one is deleted from the store (the "dropped" event).
    const proc: StripeEventProcessor = async () => ({ outcome: "processed", tenantId: TENANT });
    for (const id of [E_KEPT, E_DELETED]) {
      expect((await runStripeEvent({ ...stripeEvent(id, "invoice.payment_succeeded"), account: ACCT }, proc)).kind).toBe("processed");
    }
    await withRlsBypass((tx) => tx.stripeEvent.delete({ where: { eventId: E_DELETED } }));
    // A failed event on the withdrawn club's account: the backlog the report must show.
    await runStripeEvent({ ...stripeEvent(`evt_${S}_gonefail`, "invoice.payment_failed"), account: ACCT_GONE }, async () => { throw new Error("club unreachable"); });
  }, 120_000);

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_${S}` } } });
      await tx.stripeReconcileRun.deleteMany({ where: { id: { in: runIds } } });
      await tx.payment.deleteMany({ where: { tenantId: TENANT } });
      await tx.memberSubscription.deleteMany({ where: { tenantId: TENANT } });
      await tx.member.deleteMany({ where: { tenantId: TENANT } });
      await tx.tenant.deleteMany({ where: { id: { in: [TENANT, GONE, FAKE] } } });
    });
  }, 120_000);

  const runIds: string[] = [];
  const calls: string[] = [];
  const fake: ReconcileStripe = {
    events: {
      list: (_p, o) => {
        calls.push(`events:${o.stripeAccount}`);
        const list = o.stripeAccount === ACCT
          ? [stripeEvent(E_KEPT, "invoice.payment_succeeded"), stripeEvent(E_DELETED, "invoice.payment_succeeded"), stripeEvent(`evt_${S}_cust`, "customer.created")]
          : [];
        return (async function* () { yield* list; })();
      },
    },
    subscriptions: { retrieve: async (id, _p, o) => { calls.push(`sub:${o.stripeAccount}`); return { id, status: "past_due", items: { data: [{ current_period_end: STRIPE_END }] } }; } },
    charges: { retrieve: async (id, _p, o) => { calls.push(`ch:${o.stripeAccount}`); return { id, status: "succeeded", refunded: true, amount_refunded: 4500, disputed: false }; } },
    paymentIntents: { retrieve: async (id) => ({ id, status: "succeeded" }) },
  };

  it("(f) a deleted store row is found, recorded received/attempts 0/reconcileFoundAt, and NOT processed", async () => {
    const before = await withRlsBypass((tx) => tx.payment.count({ where: { tenantId: TENANT } }));
    const r = await runStripeReconciliation({ stripe: fake, trigger: "manual", tenantIds: [TENANT, GONE] });
    if (r.runId) runIds.push(r.runId);
    expect(r.missing).toEqual([{ tenantId: TENANT, stripeAccountId: ACCT, eventId: E_DELETED, type: "invoice.payment_succeeded" }]);
    const found = await withRlsBypass((tx) => tx.stripeEvent.findUnique({ where: { eventId: E_DELETED } }));
    expect(found).toMatchObject({ status: "received", attempts: 0, tenantId: TENANT, stripeAccountId: ACCT, objectId: `in_${E_DELETED}`, lastAttemptAt: null });
    expect(found?.reconcileFoundAt).toBeInstanceOf(Date);
    expect(await withRlsBypass((tx) => tx.stripeEvent.findUnique({ where: { eventId: E_KEPT } }))).toMatchObject({ status: "processed" });
    expect(await withRlsBypass((tx) => tx.stripeEvent.count({ where: { eventId: `evt_${S}_cust` } }))).toBe(0);
    // Not processed: no new Payment, member untouched.
    expect(await withRlsBypass((tx) => tx.payment.count({ where: { tenantId: TENANT } }))).toBe(before);

    // (b) state drift reported, never written.
    expect(r.stateMismatches).toEqual([
      { tenantId: TENANT, kind: "subscription", objectId: SUB, recordId: MEMBER, field: "status", stored: "active", stripe: "past_due" },
      { tenantId: TENANT, kind: "subscription", objectId: SUB, recordId: MEMBER, field: "currentPeriodEnd", stored: STORED_END.toISOString(), stripe: new Date(STRIPE_END * 1000).toISOString() },
      { tenantId: TENANT, kind: "subscription", objectId: SUB, recordId: MEMBER, field: "paymentStatus", stored: "paid", stripe: "past_due" },
      { tenantId: TENANT, kind: "payment", objectId: CHARGE, recordId: paymentId, field: "status", stored: "succeeded", stripe: "refunded" },
      { tenantId: TENANT, kind: "payment", objectId: CHARGE, recordId: paymentId, field: "amountRefundedPence", stored: 0, stripe: 4500 },
    ]);
    const m = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: MEMBER }, select: { paymentStatus: true, stripeSubscriptionId: true } }));
    expect(m).toEqual({ paymentStatus: "paid", stripeSubscriptionId: SUB });
    const mapping = await withRlsBypass((tx) => tx.memberSubscription.findUnique({ where: { stripeSubscriptionId: SUB }, select: { status: true, currentPeriodEnd: true, endedAt: true } }));
    expect(mapping).toEqual({ status: "active", currentPeriodEnd: STORED_END, endedAt: null });
    const p = await withRlsBypass((tx) => tx.payment.findUnique({ where: { id: paymentId }, select: { status: true, refundedAmountPence: true } }));
    expect(p).toEqual({ status: "succeeded", refundedAmountPence: null });

    // The withdrawn club: reported with its backlog, never called.
    expect(r.skippedTenants).toEqual([{ tenantId: GONE, stripeAccountId: ACCT_GONE, reason: "stripe_access_withdrawn", unprocessedInStore: 1 }]);
    expect(calls.some((c) => c.endsWith(ACCT_GONE))).toBe(false);

    const run = await withRlsBypass((tx) => tx.stripeReconcileRun.findUnique({ where: { id: r.runId! } }));
    expect(run).toMatchObject({ status: "mismatches", trigger: "manual", tenantsChecked: 1, tenantsSkipped: 1, eventsScanned: 3, eventsMissing: 1 });
    expect(run?.finishedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(run?.stateMismatches)).not.toMatch(/@|PD reconcile/);
  });

  it("a second run records nothing new; the found event stays unprocessed until an operator replays it", async () => {
    const r = await runStripeReconciliation({ stripe: fake, trigger: "manual", tenantIds: [TENANT] });
    if (r.runId) runIds.push(r.runId);
    expect(r.missingCount).toBe(0);
    expect(await withRlsBypass((tx) => tx.stripeEvent.findUnique({ where: { eventId: E_DELETED }, select: { status: true, attempts: true } }))).toEqual({ status: "received", attempts: 0 });
  });

  it("a connected club holding an account id Stripe rejects is recorded with a CODE on the run row and the others are still reconciled", async () => {
    await withRlsBypass((tx) => tx.tenant.create({ data: { id: FAKE, name: `${STAMP} fake`, slug: FAKE, stripeAccountId: ACCT_FAKE, stripeConnected: true } }));
    const KEY_TEXT = "sk_test_51Abc****************************wxyz";
    const rejecting: ReconcileStripe = {
      ...fake,
      events: {
        list: (p, o) => {
          if (o.stripeAccount === ACCT_FAKE) {
            throw Object.assign(new Error(`The provided key '${KEY_TEXT}' does not have access to account '${ACCT_FAKE}' (or that account does not exist).`), {
              type: "StripeInvalidRequestError", code: "account_invalid", statusCode: 403,
            });
          }
          return fake.events.list(p, o);
        },
      },
    };
    const r = await runStripeReconciliation({ stripe: rejecting, trigger: "manual", tenantIds: [TENANT, FAKE] });
    if (r.runId) runIds.push(r.runId);
    expect(r.errors).toEqual([{ tenantId: FAKE, code: "account_invalid" }]);
    expect(r.tenantsChecked).toBe(2);
    const row = await withRlsBypass((tx) => tx.stripeReconcileRun.findUnique({ where: { id: r.runId! } }));
    expect(row?.status).toBe("errors");
    expect(row?.errors).toEqual([{ tenantId: FAKE, code: "account_invalid" }]);
    expect(JSON.stringify(row) + JSON.stringify(r)).not.toMatch(/sk_test|does not have access|\*\*\*\*/);
    // The good club was still reconciled in the same run (its drift is reported).
    expect(r.stateMismatches.some((m) => m.tenantId === TENANT)).toBe(true);
  });
});
