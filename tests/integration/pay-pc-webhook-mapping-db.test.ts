// Payments lane PC (11 Oct 2026) — the scoping, ordering and separation rules
// at the REAL webhook route against REAL rows (Neon TEST branch, guarded
// runners only; run under BOTH the owner role and the restricted matflow_app
// role with RLS enforced). Skips without a database.
//
// One club, one payer customer in the TeamUp replace window:
//   mem-A  active pointer -> sub_mf (MatFlow's replacement, mapped);
//          the same customer also carries sub_tu (TeamUp's, NOT mapped)
//   mem-B  a second child on the SAME customer, pointer -> sub_kid (mapped)
//   mem-C  pays at the desk (no pointer), abandoned an in-app signup sub_ab
//          (mapped, status incomplete, not active)
//   mem-D  first payment never completed: pointer -> sub_d (mapped, incomplete)
//
// Real: the route, stripe.webhooks.constructEvent with a synthetic local
// secret, lane PD's event store, Prisma rows. Stubbed: the Stripe network
// lookups (invoice payment ids, fresh subscription retrieve), email, Sentry,
// the account-status refresh.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const retrieveSubscription = vi.hoisted(() => vi.fn());
vi.mock("stripe", async (importOriginal) => {
  const mod = await importOriginal<typeof import("stripe")>();
  const Real = mod.default as unknown as new (key: string, opts?: unknown) => { subscriptions: { retrieve: unknown } };
  function FakeStripe(this: unknown, key: string, opts?: unknown) {
    const inst = new Real(key, opts);
    inst.subscriptions.retrieve = retrieveSubscription;
    return inst;
  }
  FakeStripe.prototype = (Real as unknown as { prototype: object }).prototype;
  return { ...mod, default: FakeStripe };
});
vi.mock("@/lib/stripe/invoice-payment", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/invoice-payment")>()),
  resolveInvoicePaymentIds: vi.fn(async (_s: unknown, invoiceId: string) => ({ paymentIntentId: `pi_for_${invoiceId}`, chargeId: null })),
}));
const sendEmailMock = vi.hoisted(() => vi.fn<(m: unknown) => Promise<{ ok: boolean; logId: string }>>(async () => ({ ok: true, logId: "mail-test" })));
vi.mock("@/lib/email", () => ({ sendEmail: sendEmailMock }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/stripe-account-status", () => ({ refreshStripeAccountStatus: vi.fn(async () => {}) }));

import Stripe from "stripe";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST } from "@/app/api/stripe/webhook/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `paypc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TENANT = `${STAMP}-t`;
const ACCT = `acct_${STAMP}`;
const CUS = `cus_${STAMP}`;
const MEM = { A: `${STAMP}-a`, B: `${STAMP}-b`, C: `${STAMP}-c`, D: `${STAMP}-d`, E: `${STAMP}-e`, F: `${STAMP}-f` };
const SUB = { mf: `sub_${STAMP}_mf`, tu: `sub_${STAMP}_tu`, kid: `sub_${STAMP}_kid`, ab: `sub_${STAMP}_ab`, d: `sub_${STAMP}_d`, f: `sub_${STAMP}_f`, unknown: `sub_${STAMP}_unknown` };
let evtSeq = 0;
const evtId = (label: string) => `evt_${STAMP}_${label}_${++evtSeq}`;

const SECRET = "whsec_paypc_synthetic_local_only_0123456789";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
process.env.STRIPE_SECRET_KEY = "sk_test_paypc_synthetic_never_used";
const signer = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" as never });

async function deliver(event: { id: string; type: string; created?: number; livemode?: boolean; data: { object: Record<string, unknown> } }) {
  const payload = JSON.stringify({ object: "event", account: ACCT, livemode: false, created: 2000, ...event });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: SECRET } as Parameters<typeof signer.webhooks.generateTestHeaderString>[0]);
  const headers = new Headers({ "content-type": "application/json", "stripe-signature": sig });
  const res = await POST(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers, body: payload }) as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const subEvent = (type: string, sub: string, status: string, created?: number) => ({
  id: evtId(type.split(".").pop()!), type, ...(created !== undefined ? { created } : {}),
  data: { object: { id: sub, object: "subscription", customer: CUS, status, items: { data: [] } } },
});
const invoiceEvent = (type: string, invoice: string, sub: string, amount = 4500) => ({
  id: evtId(type.split(".").pop()!), type,
  data: { object: {
    id: invoice, object: "invoice", customer: CUS, amount_paid: type.endsWith("succeeded") ? amount : 0, amount_due: amount, currency: "gbp",
    parent: { type: "subscription_details", subscription_details: { subscription: sub, metadata: {} } },
    status_transitions: { paid_at: 1_790_000_000 },
  } },
});

const member = (id: string) => withRlsBypass((tx) => tx.member.findUnique({ where: { id }, select: { status: true, paymentStatus: true, stripeSubscriptionId: true, cancelledAt: true } }));
const mapping = (sub: string) => withRlsBypass((tx) => tx.memberSubscription.findUnique({ where: { stripeSubscriptionId: sub } }));
const eventRow = (id: string) => withRlsBypass((tx) => tx.stripeEvent.findUnique({ where: { eventId: id }, select: { status: true, tenantId: true } }));

describe.skipIf(!HAS_DB)("pay-pc: subscription and invoice events move only the member their MatFlow mapping names", () => {
  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.tenant.create({ data: { id: TENANT, name: `${STAMP} club`, slug: TENANT, stripeAccountId: ACCT, stripeConnected: true } });
      const mk = (id: string, label: string, data: Record<string, unknown>) =>
        tx.member.create({ data: { id, tenantId: TENANT, email: `${STAMP}-${label}@example.test`, name: `PC ${label}`, ...data } });
      await mk(MEM.A, "a", { stripeCustomerId: CUS, stripeSubscriptionId: SUB.mf, paymentStatus: "paid" });
      // Child 2 on the same paying customer (the partial unique index on
      // stripeCustomerId is per tenant, so the second child carries no
      // customer id of its own here — the mapping is what links it).
      await mk(MEM.B, "b", { stripeSubscriptionId: SUB.kid, paymentStatus: "paid" });
      await mk(MEM.C, "c", { paymentStatus: "paid" });
      await mk(MEM.D, "d", { stripeSubscriptionId: SUB.d, paymentStatus: "pending" });
      // Round 3: signing up in the app, first payment not yet taken.
      await mk(MEM.F, "f", { stripeSubscriptionId: SUB.f, paymentStatus: "pending" });
      const map = (memberId: string, sub: string, status: string, source = "app") =>
        tx.memberSubscription.create({ data: { tenantId: TENANT, memberId, stripeAccountId: ACCT, stripeSubscriptionId: sub, source, status, lastEventCreated: 1000 } });
      await map(MEM.A, SUB.mf, "active", "migration");
      await map(MEM.B, SUB.kid, "active");
      await map(MEM.C, SUB.ab, "incomplete");
      await map(MEM.D, SUB.d, "incomplete");
      await map(MEM.F, SUB.f, "incomplete");
    });
  }, 120_000);

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_${STAMP}_` } } });
      await tx.auditLog.deleteMany({ where: { tenantId: TENANT } });
      await tx.payment.deleteMany({ where: { tenantId: TENANT } });
      await tx.memberSubscription.deleteMany({ where: { tenantId: TENANT } });
      await tx.member.deleteMany({ where: { tenantId: TENANT } });
      await tx.tenant.deleteMany({ where: { id: TENANT } });
    });
  }, 120_000);

  // Each test checks the ROWS first and the reported outcomes last, so a run
  // against code without the rules fails on the behaviour, not on a missing
  // response field.

  it("(a) TeamUp's subscription on the payer's customer: updated, canceled, deleted and a failed invoice change nothing", async () => {
    const before = await member(MEM.A);
    const events = [
      subEvent("customer.subscription.updated", SUB.tu, "past_due"),
      subEvent("customer.subscription.updated", SUB.tu, "canceled"),
      subEvent("customer.subscription.deleted", SUB.tu, "canceled"),
      invoiceEvent("invoice.payment_failed", `in_${STAMP}_tu`, SUB.tu),
    ];
    const results = [];
    for (const e of events) results.push(await deliver(e));
    expect(await member(MEM.A)).toEqual(before);
    expect(await mapping(SUB.tu)).toBeNull();
    const payments = await withRlsBypass((tx) => tx.payment.count({ where: { tenantId: TENANT } }));
    expect(payments).toBe(0);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(results.map((r) => r.body.outcome)).toEqual(["ignored_foreign", "ignored_foreign", "ignored_foreign", "ignored_foreign"]);
    for (const e of events) expect(await eventRow(e.id)).toMatchObject({ status: "ignored_foreign", tenantId: TENANT });
  });

  it("(b) a delayed subscription.updated older than the applied one is ignored_stale", async () => {
    const newer = subEvent("customer.subscription.updated", SUB.mf, "past_due", 3000);
    const r1 = await deliver(newer);
    expect(await member(MEM.A)).toMatchObject({ paymentStatus: "overdue", stripeSubscriptionId: SUB.mf });
    const older = subEvent("customer.subscription.updated", SUB.mf, "active", 2500);
    const r2 = await deliver(older);
    expect(await member(MEM.A)).toMatchObject({ paymentStatus: "overdue" });
    expect(await mapping(SUB.mf)).toMatchObject({ status: "past_due", lastEventCreated: 3000 });
    // A newer one restores it, and no fresh retrieve was needed for any of them.
    const r3 = await deliver(subEvent("customer.subscription.updated", SUB.mf, "active", 3100));
    expect(await member(MEM.A)).toMatchObject({ paymentStatus: "paid" });
    expect(retrieveSubscription).not.toHaveBeenCalled();
    expect(r2.status).toBe(200);
    expect([r1.body.outcome, r2.body.outcome, r3.body.outcome]).toEqual(["processed", "ignored_stale", "processed"]);
    expect(await eventRow(older.id)).toMatchObject({ status: "ignored_stale" });
  });

  it("(b) a same-second event is decided by the subscription retrieved fresh on the club's account", async () => {
    retrieveSubscription.mockResolvedValueOnce({ id: SUB.mf, status: "active", pause_collection: null, items: { data: [] } });
    const r = await deliver(subEvent("customer.subscription.updated", SUB.mf, "past_due", 3100));
    expect(retrieveSubscription).toHaveBeenCalledWith(SUB.mf, {}, { stripeAccount: ACCT });
    expect(await member(MEM.A)).toMatchObject({ paymentStatus: "paid" });
    expect(await mapping(SUB.mf)).toMatchObject({ status: "active" });
    expect(r.body.outcome).toBe("processed");
  });

  it("(c) two mapped subscriptions for one payer: each event moves only its own member", async () => {
    const r1 = await deliver(subEvent("customer.subscription.updated", SUB.kid, "past_due", 3200));
    expect(await member(MEM.B)).toMatchObject({ paymentStatus: "overdue", stripeSubscriptionId: SUB.kid });
    expect(await member(MEM.A)).toMatchObject({ paymentStatus: "paid", stripeSubscriptionId: SUB.mf });
    const inv = invoiceEvent("invoice.payment_succeeded", `in_${STAMP}_kid`, SUB.kid, 3000);
    const r2 = await deliver(inv);
    const pay = await withRlsBypass((tx) => tx.payment.findFirst({ where: { tenantId: TENANT, stripeInvoiceId: `in_${STAMP}_kid` } }));
    expect(pay).toMatchObject({ memberId: MEM.B, status: "succeeded", amountPence: 3000 });
    expect(await member(MEM.B)).toMatchObject({ paymentStatus: "paid" });
    expect(await member(MEM.A)).toMatchObject({ paymentStatus: "paid", stripeSubscriptionId: SUB.mf });
    expect([r1.body.outcome, r2.body.outcome]).toEqual(["processed", "processed"]);
  });

  it("(d) a late payment_failed after payment_succeeded for the same invoice changes nothing", async () => {
    const invoice = `in_${STAMP}_d`;
    const r1 = await deliver(invoiceEvent("invoice.payment_succeeded", invoice, SUB.mf));
    const late = invoiceEvent("invoice.payment_failed", invoice, SUB.mf);
    const r2 = await deliver(late);
    const rows = await withRlsBypass((tx) => tx.payment.findMany({ where: { tenantId: TENANT, OR: [{ stripeInvoiceId: invoice }, { stripePaymentIntentId: `pi_for_${invoice}` }] } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "succeeded", memberId: MEM.A });
    expect(await member(MEM.A)).toMatchObject({ paymentStatus: "paid" });
    expect(r2.status).toBe(200);
    expect([r1.body.outcome, r2.body.outcome]).toEqual(["processed", "ignored_stale"]);
  });

  it("(e) incomplete_expired on a NON-active mapping ends it and leaves the desk payer untouched", async () => {
    const before = await member(MEM.C);
    const r = await deliver(subEvent("customer.subscription.updated", SUB.ab, "incomplete_expired", 3300));
    expect(await member(MEM.C)).toEqual(before);
    expect(before).toMatchObject({ status: "active", paymentStatus: "paid", stripeSubscriptionId: null });
    const m = await mapping(SUB.ab);
    expect(m).toMatchObject({ status: "incomplete_expired" });
    expect(m?.endedAt).toBeInstanceOf(Date);
    expect(r.body.outcome).toBe("processed");
  });

  it("(e) incomplete_expired on the ACTIVE mapping clears the pointer only — Member.status and paymentStatus stay", async () => {
    const r1 = await deliver(subEvent("customer.subscription.updated", SUB.d, "incomplete_expired", 3300));
    expect(await member(MEM.D)).toMatchObject({ status: "active", paymentStatus: "pending", stripeSubscriptionId: null, cancelledAt: null });
    // And it cannot be revived afterwards.
    const r2 = await deliver(subEvent("customer.subscription.updated", SUB.d, "active", 9000));
    expect(await member(MEM.D)).toMatchObject({ paymentStatus: "pending", stripeSubscriptionId: null });
    expect(await mapping(SUB.d)).toMatchObject({ status: "incomplete_expired" });
    expect([r1.body.outcome, r2.body.outcome]).toEqual(["processed", "ignored_stale"]);
  });

  it("(e) subscription.deleted on the ACTIVE mapping: pointer cleared, paymentStatus cancelled, Member.status still active", async () => {
    const r = await deliver(subEvent("customer.subscription.deleted", SUB.kid, "canceled", 3400));
    expect(await member(MEM.B)).toMatchObject({ status: "active", paymentStatus: "cancelled", stripeSubscriptionId: null, cancelledAt: null });
    const events = await withRlsBypass((tx) => tx.memberStatusEvent.count({ where: { memberId: MEM.B } }));
    expect(events).toBe(0);
    expect(await mapping(SUB.kid)).toMatchObject({ status: "canceled" });
    expect(r.body.outcome).toBe("processed");
  });

  it("(f) an unknown subscription on the known account: 200 ignored_foreign, no row anywhere changes", async () => {
    const snapshot = await withRlsBypass(async (tx) => ({
      members: await tx.member.findMany({ where: { tenantId: TENANT }, select: { id: true, updatedAt: true }, orderBy: { id: "asc" } }),
      maps: await tx.memberSubscription.findMany({ where: { tenantId: TENANT }, select: { id: true, updatedAt: true }, orderBy: { id: "asc" } }),
      payments: await tx.payment.count({ where: { tenantId: TENANT } }),
    }));
    const e = subEvent("customer.subscription.updated", SUB.unknown, "active", 5000);
    const r = await deliver(e);
    const after = await withRlsBypass(async (tx) => ({
      members: await tx.member.findMany({ where: { tenantId: TENANT }, select: { id: true, updatedAt: true }, orderBy: { id: "asc" } }),
      maps: await tx.memberSubscription.findMany({ where: { tenantId: TENANT }, select: { id: true, updatedAt: true }, orderBy: { id: "asc" } }),
      payments: await tx.payment.count({ where: { tenantId: TENANT } }),
    }));
    expect(after).toEqual(snapshot);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: true, outcome: "ignored_foreign" });
    expect(await eventRow(e.id)).toMatchObject({ status: "ignored_foreign" });
  });

  it("(g) a live-mode event against the test key: 200, recorded ignored_mode, nothing applied", async () => {
    const mapBefore = await mapping(SUB.mf);
    const retrievesBefore = retrieveSubscription.mock.calls.length;
    const e = { ...subEvent("customer.subscription.updated", SUB.mf, "canceled", 6000), livemode: true };
    const r = await deliver(e);
    expect(await member(MEM.A)).toMatchObject({ stripeSubscriptionId: SUB.mf, paymentStatus: "paid" });
    expect(await mapping(SUB.mf)).toEqual(mapBefore);
    expect(retrieveSubscription.mock.calls.length).toBe(retrievesBefore);
    // Acknowledged so Stripe stops retrying; recorded so it is visible.
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: true, outcome: "ignored_mode" });
    expect(await eventRow(e.id)).toMatchObject({ status: "ignored_mode", tenantId: TENANT });
    // A redelivery is recognised and changes nothing.
    const again = await deliver(e);
    expect(again).toMatchObject({ status: 200 });
    expect(await mapping(SUB.mf)).toEqual(mapBefore);
  });

  it("(h) duplicate delivery: processed once, the second is acknowledged as already processed", async () => {
    const inv = invoiceEvent("invoice.payment_succeeded", `in_${STAMP}_dup`, SUB.mf, 1234);
    const first = await deliver(inv);
    const second = await deliver(inv);
    const n = await withRlsBypass((tx) => tx.payment.count({ where: { tenantId: TENANT, stripeInvoiceId: `in_${STAMP}_dup` } }));
    expect(n).toBe(1);
    expect(second).toMatchObject({ status: 200, body: { alreadyProcessed: true } });
    expect(first.body.outcome).toBe("processed");
  });

  it("(r3) a failed FIRST invoice on an incomplete mapping: Payment failed + mapping recorded, member not overdue, no email", async () => {
    sendEmailMock.mockClear();
    const invoice = `in_${STAMP}_first`;
    const r = await deliver(invoiceEvent("invoice.payment_failed", invoice, SUB.f, 3000));
    expect(await member(MEM.F)).toMatchObject({ paymentStatus: "pending", stripeSubscriptionId: SUB.f, status: "active" });
    const pay = await withRlsBypass((tx) => tx.payment.findFirst({ where: { tenantId: TENANT, stripeInvoiceId: invoice } }));
    expect(pay).toMatchObject({ status: "failed", memberId: MEM.F, amountPence: 3000 });
    expect(await mapping(SUB.f)).toMatchObject({ status: "incomplete", lastFailedInvoiceId: invoice });
    expect((await mapping(SUB.f))?.lastPaymentFailedAt).toBeInstanceOf(Date);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(r.body.outcome).toBe("processed");
  });

  it("(r3) a RENEWAL failure on the active mapping still dunns: overdue and the payment-failed emails", async () => {
    sendEmailMock.mockClear();
    const invoice = `in_${STAMP}_renewal`;
    const r = await deliver(invoiceEvent("invoice.payment_failed", invoice, SUB.mf, 4500));
    expect(await member(MEM.A)).toMatchObject({ paymentStatus: "overdue", stripeSubscriptionId: SUB.mf });
    expect(await mapping(SUB.mf)).toMatchObject({ lastFailedInvoiceId: invoice });
    const templates = sendEmailMock.mock.calls.map((c) => (c[0] as { templateId: string }).templateId);
    expect(templates).toContain("payment_failed");
    expect(r.body.outcome).toBe("processed");
  });

  it("(r3) invoice.voided of a mapped subscription with no Payment row: processed, nothing changes; unmapped: ignored_foreign", async () => {
    const before = await member(MEM.F);
    const mapped = await deliver({ id: evtId("voided"), type: "invoice.voided", data: { object: { id: `in_${STAMP}_void_nopay`, object: "invoice", customer: CUS, parent: { type: "subscription_details", subscription_details: { subscription: SUB.f, metadata: {} } } } } });
    const foreign = await deliver({ id: evtId("voided"), type: "invoice.voided", data: { object: { id: `in_${STAMP}_void_tu`, object: "invoice", customer: CUS, parent: { type: "subscription_details", subscription_details: { subscription: SUB.tu, metadata: {} } } } } });
    expect(await member(MEM.F)).toEqual(before);
    expect([mapped.body.outcome, foreign.body.outcome]).toEqual(["processed", "ignored_foreign"]);
    // And the voided invoice with a Payment row (the failed first invoice above) is voided.
    const r = await deliver({ id: evtId("voided"), type: "invoice.voided", data: { object: { id: `in_${STAMP}_first`, object: "invoice", customer: CUS, parent: { type: "subscription_details", subscription_details: { subscription: SUB.f, metadata: {} } } } } });
    const pay = await withRlsBypass((tx) => tx.payment.findFirst({ where: { tenantId: TENANT, stripeInvoiceId: `in_${STAMP}_first` } }));
    expect(pay).toMatchObject({ status: "refunded", refundedAmountPence: 3000 });
    expect(r.body.outcome).toBe("processed");
  });

  it("backfill: the migration's own INSERT maps a member's existing pointer as adopted (rolled back afterwards)", async () => {
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20261011190000_pay_pc_member_subscription_mapping/migration.sql"), "utf8");
    const start = sql.indexOf('INSERT INTO "MemberSubscription"');
    const end = sql.indexOf(";", start);
    expect(start).toBeGreaterThan(0);
    // The statement exactly as the migration runs it (INSERT … SELECT … ON CONFLICT DO NOTHING).
    const insert = sql.slice(start, end);
    expect(insert).toMatch(/ON CONFLICT \("stripeSubscriptionId"\) DO NOTHING$/);
    class Rollback extends Error {}
    let seen: Array<{ memberId: string; source: string; status: string; stripeAccountId: string; lastEventCreated: number | null }> = [];
    await withRlsBypass(async (tx) => {
      await tx.member.create({ data: { id: MEM.E, tenantId: TENANT, email: `${STAMP}-e@example.test`, name: "PC e", stripeSubscriptionId: `sub_${STAMP}_legacy` } });
      await tx.$executeRawUnsafe(insert);
      seen = await tx.memberSubscription.findMany({
        where: { tenantId: TENANT, stripeSubscriptionId: `sub_${STAMP}_legacy` },
        select: { memberId: true, source: true, status: true, stripeAccountId: true, lastEventCreated: true },
      });
      throw new Rollback("undo the backfill probe");
    }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
    expect(seen).toEqual([{ memberId: MEM.E, source: "adopted", status: "unknown", stripeAccountId: ACCT, lastEventCreated: null }]);
    expect(await member(MEM.E)).toBeNull();
  });
});
