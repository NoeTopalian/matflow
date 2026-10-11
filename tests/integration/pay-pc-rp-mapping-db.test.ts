// Review RP (11 Oct 2026), adopted by lane PC (copied from <scratchpad>/pay/RP/tests/rp-mapping-db.test.ts;
// M5 now asserts the RP-7 rule). Reviewer's own mapping / tenant-scoping / livemode probes at the REAL webhook
// route (real constructEvent with a synthetic local secret, real store, real rows). TEST branch only,
// RP guarded runners, both roles. Stubbed: subscription retrieve, invoice payment-id resolver, email, Sentry,
// account-status refresh. Prefix rpmap.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

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
  resolveInvoicePaymentIds: vi.fn(async () => ({ paymentIntentId: null, chargeId: null })),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true, logId: "x" })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/stripe-account-status", () => ({ refreshStripeAccountStatus: vi.fn(async () => {}) }));

import Stripe from "stripe";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST } from "@/app/api/stripe/webhook/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `rpmap${Date.now().toString(36)}`;
const T = { A: `${STAMP}-ta`, B: `${STAMP}-tb` };
const ACCT = { A: `acct_${STAMP}A`, B: `acct_${STAMP}B` };
const CUS = `cus_${STAMP}shared`;
const M = { A1: `${STAMP}-a1`, B1: `${STAMP}-b1` };
const SUBX = `sub_${STAMP}X`;
const SUBTU = `sub_${STAMP}TU`;
const PI_A = `pi_${STAMP}A`;
const CH_A = `ch_${STAMP}A`;
const IN_A = `in_${STAMP}A`;
let seq = 0;
const eid = (l: string) => `evt_${STAMP}_${l}_${++seq}`;
const SECRET = "whsec_rpmap_synthetic_local_only_0123456789";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
process.env.STRIPE_SECRET_KEY = "sk_test_rpmap_synthetic_never_used";
const signer = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" as never });

async function deliver(account: string, ev: Record<string, unknown>, raw?: string) {
  const payload = raw ?? JSON.stringify({ object: "event", account, livemode: false, created: 5000, ...ev });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: SECRET } as never);
  const res = await POST(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: payload }) as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const snapshotA = () => withRlsBypass(async (tx) => ({
  member: await tx.member.findUnique({ where: { id: M.A1 }, select: { status: true, paymentStatus: true, stripeSubscriptionId: true, stripeCustomerId: true, updatedAt: true } }),
  mapping: await tx.memberSubscription.findUnique({ where: { stripeSubscriptionId: SUBX } }),
  payments: await tx.payment.findMany({ where: { tenantId: T.A }, orderBy: { id: "asc" } }),
  tenant: await tx.tenant.findUnique({ where: { id: T.A }, select: { stripeConnected: true, stripeAccountStatus: true } }),
  disputes: await tx.dispute.count({ where: { tenantId: T.A } }),
}));
const subEv = (type: string, sub: string, status: string, created = 5000) => ({ id: eid(type.split(".").pop()!), type, created, data: { object: { id: sub, object: "subscription", customer: CUS, status, items: { data: [] } } } });
const invEv = (type: string, inv: string, sub: string) => ({ id: eid(type.split(".").pop()!), type, data: { object: { id: inv, object: "invoice", customer: CUS, amount_due: 4500, amount_paid: type.endsWith("succeeded") ? 4500 : 0, currency: "gbp", billing_reason: "subscription_cycle", parent: { type: "subscription_details", subscription_details: { subscription: sub, metadata: {} } } } } });

describe.skipIf(!HAS_DB)("RP - mappings, tenant scoping and livemode at the real webhook", () => {
  beforeAll(async () => {
    const who = await withRlsBypass((tx) => tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`);
    process.stderr.write(`[rpmap] role=${who[0]?.current_user} RLS_ENFORCED=${process.env.RLS_ENFORCED ?? "unset"}\n`);
    await withRlsBypass(async (tx) => {
      for (const k of ["A", "B"] as const) {
        await tx.tenant.create({ data: { id: T[k], name: `${STAMP} ${k}`, slug: T[k], stripeAccountId: ACCT[k], stripeConnected: true } });
      }
      await tx.member.create({ data: { id: M.A1, tenantId: T.A, email: `${STAMP}-a1@example.test`, name: "RP A1", stripeCustomerId: CUS, stripeSubscriptionId: SUBX, paymentStatus: "paid" } });
      await tx.member.create({ data: { id: M.B1, tenantId: T.B, email: `${STAMP}-b1@example.test`, name: "RP B1", stripeCustomerId: CUS, paymentStatus: "paid" } });
      await tx.memberSubscription.create({ data: { tenantId: T.A, memberId: M.A1, stripeAccountId: ACCT.A, stripeSubscriptionId: SUBX, source: "app", status: "active", lastEventCreated: 1000 } });
      await tx.payment.create({ data: { tenantId: T.A, memberId: M.A1, stripePaymentIntentId: PI_A, stripeChargeId: CH_A, stripeInvoiceId: IN_A, amountPence: 4500, currency: "GBP", status: "succeeded", paidAt: new Date() } });
    });
  }, 120_000);

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_${STAMP}_` } } });
      for (const t of [T.A, T.B]) {
        await tx.dispute.deleteMany({ where: { tenantId: t } });
        await tx.auditLog.deleteMany({ where: { tenantId: t } });
        await tx.payment.deleteMany({ where: { tenantId: t } });
        await tx.memberSubscription.deleteMany({ where: { tenantId: t } });
        await tx.member.deleteMany({ where: { tenantId: t } });
        await tx.tenant.deleteMany({ where: { id: t } });
      }
    }, { timeout: 60_000 });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: { in: [T.A, T.B] } } }),
      events: await tx.stripeEvent.count({ where: { eventId: { startsWith: `evt_${STAMP}_` } } }),
      payments: await tx.payment.count({ where: { tenantId: { in: [T.A, T.B] } } }),
    }));
    expect(left).toEqual({ tenants: 0, events: 0, payments: 0 });
  }, 120_000);

  it("M1 events from a DIFFERENT connected account naming club A's subscription, invoice, charge, PI and metadata change nothing in club A", async () => {
    const before = await snapshotA();
    const evs: Array<Record<string, unknown>> = [
      subEv("customer.subscription.updated", SUBX, "canceled", 9000),
      subEv("customer.subscription.updated", SUBX, "incomplete_expired", 9001),
      subEv("customer.subscription.deleted", SUBX, "canceled", 9002),
      invEv("invoice.payment_failed", `in_${STAMP}Bx`, SUBX),
      invEv("invoice.payment_succeeded", IN_A, SUBX),
      invEv("invoice.payment_action_required", `in_${STAMP}By`, SUBX),
      { id: eid("voided"), type: "invoice.voided", data: { object: { id: IN_A, object: "invoice", customer: CUS, parent: { type: "subscription_details", subscription_details: { subscription: SUBX } } } } },
      { id: eid("refunded"), type: "charge.refunded", data: { object: { id: CH_A, object: "charge", payment_intent: PI_A, amount_refunded: 4500, amount: 4500 } } },
      { id: eid("dispute"), type: "charge.dispute.created", data: { object: { id: `du_${STAMP}`, object: "dispute", charge: CH_A, payment_intent: PI_A, amount: 4500, currency: "gbp", reason: "fraudulent", status: "needs_response" } } },
      { id: eid("pifail"), type: "payment_intent.payment_failed", data: { object: { id: PI_A, object: "payment_intent" } } },
      { id: eid("pisucc"), type: "payment_intent.succeeded", data: { object: { id: `pi_${STAMP}Bz`, object: "payment_intent", amount_received: 100, currency: "gbp", metadata: { type: "adhoc", tenantId: T.A, memberId: M.A1 } } } },
      { id: eid("checkout"), type: "checkout.session.completed", data: { object: { id: `cs_${STAMP}`, object: "checkout.session", payment_intent: `pi_${STAMP}Bw`, metadata: { matflowKind: "shop_order", tenantId: T.A, orderRef: "ORD-1" } } } },
    ];
    const outs: unknown[] = [];
    for (const e of evs) {
      const r = await deliver(ACCT.B, e);
      outs.push([e.type, r.status, r.body.outcome ?? r.body]);
    }
    process.stderr.write(`[rpmap] M1 outcomes ${JSON.stringify(outs)}\n`);
    const after = await snapshotA();
    expect(after).toEqual(before);
    // nothing was written in club B either
    const b = await withRlsBypass(async (tx) => ({ pays: await tx.payment.count({ where: { tenantId: T.B } }), maps: await tx.memberSubscription.count({ where: { tenantId: T.B } }) }));
    expect(b).toEqual({ pays: 0, maps: 0 });
    for (const o of outs as Array<[string, number]>) expect(o[1]).toBe(200);
  });

  it("M2 customer.deleted for the SAME customer id from account B clears only club B's link", async () => {
    const r = await deliver(ACCT.B, { id: eid("cusdel"), type: "customer.deleted", data: { object: { id: CUS, object: "customer" } } });
    expect(r.status).toBe(200);
    const a = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: M.A1 }, select: { stripeCustomerId: true } }));
    const b = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: M.B1 }, select: { stripeCustomerId: true } }));
    expect(a?.stripeCustomerId).toBe(CUS);
    expect(b?.stripeCustomerId).toBeNull();
  });

  it("M3 TeamUp's subscription on club A's payer is cancelled and deleted while MatFlow's mapped one is active: nothing moves", async () => {
    const before = await snapshotA();
    const outs = [];
    for (const e of [subEv("customer.subscription.updated", SUBTU, "past_due", 9100), subEv("customer.subscription.updated", SUBTU, "canceled", 9101), subEv("customer.subscription.deleted", SUBTU, "canceled", 9102), invEv("invoice.payment_failed", `in_${STAMP}TU`, SUBTU)]) {
      const r = await deliver(ACCT.A, e);
      outs.push(r.body.outcome);
    }
    expect(await snapshotA()).toEqual(before);
    expect(outs).toEqual(["ignored_foreign", "ignored_foreign", "ignored_foreign", "ignored_foreign"]);
  });

  it("M4 livemode: true, missing, and the string 'false' are all recorded ignored_mode and change nothing", async () => {
    const before = await snapshotA();
    const base = subEv("customer.subscription.updated", SUBX, "canceled", 9200);
    const live = await deliver(ACCT.A, { ...base, id: eid("live"), livemode: true });
    const missingId = eid("nolive");
    const missing = await deliver(ACCT.A, {}, JSON.stringify({ object: "event", account: ACCT.A, created: 9201, id: missingId, type: base.type, data: base.data }));
    const str = await deliver(ACCT.A, {}, JSON.stringify({ object: "event", account: ACCT.A, created: 9202, livemode: "false", id: eid("strlive"), type: base.type, data: base.data }));
    expect([live.body.outcome, missing.body.outcome, str.body.outcome]).toEqual(["ignored_mode", "ignored_mode", "ignored_mode"]);
    expect(await snapshotA()).toEqual(before);
    const row = await withRlsBypass((tx) => tx.stripeEvent.findUnique({ where: { eventId: missingId }, select: { status: true, tenantId: true } }));
    expect(row).toEqual({ status: "ignored_mode", tenantId: T.A });
  });

  it("M5 stale and same-second ordering on the mapped subscription (fresh retrieve fails -> observe)", async () => {
    // newer applied
    const r1 = await deliver(ACCT.A, subEv("customer.subscription.updated", SUBX, "past_due", 9300));
    expect(r1.body.outcome).toBe("processed");
    // strictly older -> stale
    const r2 = await deliver(ACCT.A, subEv("customer.subscription.updated", SUBX, "active", 9299));
    expect(r2.body.outcome).toBe("ignored_stale");
    const m = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: M.A1 }, select: { paymentStatus: true } }));
    expect(m?.paymentStatus).toBe("overdue");
    // same second with Stripe unreachable: the processor falls back to the payload
    retrieveSubscription.mockRejectedValueOnce(new Error("stripe down"));
    const r3 = await deliver(ACCT.A, subEv("customer.subscription.updated", SUBX, "active", 9300));
    const m3 = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: M.A1 }, select: { paymentStatus: true } }));
    process.stderr.write(`[rpmap] M5 same-second with retrieve failing: outcome=${String(r3.body.outcome)} paymentStatus=${m3?.paymentStatus}\n`);
    // Lane PC, RP-7: the payload is never applied in place of the fresh state — the delivery is refused
    // (409, Stripe retries) and the member keeps the state of the newest applied event.
    expect(r3.status).toBe(409);
    expect(m3?.paymentStatus).toBe("overdue");
    const row = await withRlsBypass((tx) => tx.memberSubscription.findUnique({ where: { stripeSubscriptionId: SUBX }, select: { status: true, lastEventCreated: true } }));
    expect(row).toEqual({ status: "past_due", lastEventCreated: BigInt(9300) });
  });

  it("M6 global-unique key probe: a PaymentIntent event from account B whose id equals club A's PI, for B's own ad-hoc member", async () => {
    const before = await withRlsBypass((tx) => tx.payment.findUnique({ where: { stripePaymentIntentId: PI_A } }));
    const r = await deliver(ACCT.B, { id: eid("pikey"), type: "payment_intent.succeeded", data: { object: { id: PI_A, object: "payment_intent", amount_received: 1, currency: "gbp", latest_charge: `ch_${STAMP}B`, metadata: { type: "adhoc", tenantId: T.B, memberId: M.B1 } } } });
    const after = await withRlsBypass((tx) => tx.payment.findUnique({ where: { stripePaymentIntentId: PI_A } }));
    process.stderr.write(`[rpmap] M6 status=${r.status} outcome=${String(r.body.outcome ?? JSON.stringify(r.body))} A-row tenant=${after?.tenantId} chargeBefore=${before?.stripeChargeId} chargeAfter=${after?.stripeChargeId}\n`);
    expect(after?.tenantId).toBe(T.A);
  });

  it("M7 backfill vs TEST-branch data: members with a pointer on a club with an account id, against mapping rows", async () => {
    const counts = await withRlsBypass(async (tx) => {
      const rows = await tx.$queryRaw<Array<Record<string, bigint>>>`
        SELECT
          (SELECT count(*) FROM "Member" m JOIN "Tenant" t ON t.id = m."tenantId" WHERE m."stripeSubscriptionId" IS NOT NULL AND t."stripeAccountId" IS NOT NULL AND m."tenantId" NOT LIKE ${STAMP + "%"}) AS eligible,
          (SELECT count(*) FROM "Member" m WHERE m."stripeSubscriptionId" IS NOT NULL AND m."tenantId" NOT LIKE ${STAMP + "%"}) AS pointers,
          (SELECT count(*) FROM "MemberSubscription" s WHERE s."tenantId" NOT LIKE ${STAMP + "%"}) AS mappings,
          (SELECT count(*) FROM "MemberSubscription" s WHERE s.source = 'adopted' AND s.status = 'unknown') AS backfilled,
          (SELECT count(*) FROM "Member" m WHERE m."stripeSubscriptionId" IS NOT NULL AND m."tenantId" NOT LIKE ${STAMP + "%"} AND NOT EXISTS (SELECT 1 FROM "MemberSubscription" s WHERE s."stripeSubscriptionId" = m."stripeSubscriptionId" AND s."memberId" = m.id)) AS pointers_without_mapping,
          (SELECT count(*) FROM "Member" m WHERE m."stripeSubscriptionId" IS NOT NULL AND m."billedBy" = 'teamup') AS teamup_with_pointer`;
      return Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
    });
    process.stderr.write(`[rpmap] M7 TEST-branch counts ${JSON.stringify(counts)}\n`);
    expect(typeof counts.eligible).toBe("number");
  });
});
