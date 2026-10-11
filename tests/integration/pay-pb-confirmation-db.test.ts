// Payments lane PB (11 Oct 2026), audit F1 — the first-payment journey on REAL
// rows (Neon TEST branch, guarded runners only; run under BOTH the owner role
// and the restricted matflow_app role with RLS enforced). Skips without a DB.
//
// Real: the start routes (member + guardian), the new confirmation and status
// routes, lane PA's club-account guard, lane PC's mapping writer and webhook
// handler (signed with a synthetic local secret), lane PD's event store,
// Prisma rows. Stubbed: the Stripe network (customer/subscription create and
// retrieve), invoice payment-id lookups, email, Sentry, CSRF.
//
// Pinned:
//   (a) a member starts a subscription: mapping incomplete, pointer set,
//       paymentStatus pending, Member.status untouched; the member and staff get
//       the secret on the CLUB's account; another member gets 404
//   (b) a guardian gets the secret for a confirmed child only; an unconfirmed
//       guardian and another parent get 404
//   (c) Stripe expires the unpaid subscription: only the mapping ends; the
//       person stays active, no other member changes; confirmation answers
//       409 ended without asking Stripe
//   (d) retry after expiry: a NEW request id passes the duplicate guard and
//       creates a new mapping; the ended one stays ended
//   RP-2: at every point before the payment lands the member carries NO tier
//       (membershipTierId and membershipType null) — a tier with "pending"
//       counts as desk coverage in lib/checkin.ts
//   (e) the payment lands (subscription active + invoice paid): the status
//       route reports mapping active, Payment succeeded, paymentStatus paid —
//       three facts, no secret

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: null as unknown,
  subs: new Map<string, { status: string; invoice: string; secret: string; customer: string }>(),
  seq: 0,
  retrieveCalls: [] as Array<{ id: string; opts: unknown }>,
  createCalls: [] as Array<{ opts: unknown }>,
}));

vi.mock("@/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("stripe", async (importOriginal) => {
  const mod = await importOriginal<typeof import("stripe")>();
  const Real = mod.default as unknown as new (key: string, opts?: unknown) => Record<string, Record<string, unknown>>;
  function FakeStripe(this: unknown, key: string, opts?: unknown) {
    const inst = new Real(key, opts);
    inst.customers.create = async () => ({ id: `cus_${process.env.PAYPB_STAMP}_${++h.seq}` });
    inst.subscriptions.create = async (params: { customer: string }, reqOpts: unknown) => {
      h.createCalls.push({ opts: reqOpts });
      const n = ++h.seq;
      const id = `sub_${process.env.PAYPB_STAMP}_${n}`;
      const rec = { status: "incomplete", invoice: `in_${process.env.PAYPB_STAMP}_${n}`, secret: `pi_${n}_secret_pb`, customer: params.customer };
      h.subs.set(id, rec);
      return {
        id, object: "subscription", status: "incomplete", customer: params.customer, items: { data: [] },
        latest_invoice: { id: rec.invoice, object: "invoice", amount_due: 6500, currency: "gbp", confirmation_secret: { client_secret: rec.secret } },
      };
    };
    inst.subscriptions.retrieve = async (id: string, params?: { expand?: string[] }, reqOpts?: unknown) => {
      h.retrieveCalls.push({ id, opts: reqOpts ?? params });
      const rec = h.subs.get(id);
      if (!rec) throw new Error("No such subscription");
      return {
        id, object: "subscription", status: rec.status, customer: rec.customer, items: { data: [] }, metadata: {},
        latest_invoice: { id: rec.invoice, object: "invoice", amount_due: 6500, currency: "gbp", confirmation_secret: { client_secret: rec.secret } },
      };
    };
    return inst;
  }
  FakeStripe.prototype = (Real as unknown as { prototype: object }).prototype;
  return { ...mod, default: FakeStripe };
});
vi.mock("@/lib/stripe/invoice-payment", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/invoice-payment")>()),
  resolveInvoicePaymentIds: vi.fn(async (_s: unknown, invoiceId: string) => ({ paymentIntentId: `pi_for_${invoiceId}`, chargeId: null })),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true, logId: "mail-test" })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import Stripe from "stripe";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as startPOST } from "@/app/api/member/subscriptions/start/route";
import { POST as startKidPOST } from "@/app/api/member/subscriptions/start-for-kid/route";
import { POST as staffCreatePOST } from "@/app/api/stripe/create-subscription/route";
import { GET as confirmationGET } from "@/app/api/stripe/subscriptions/[id]/confirmation/route";
import { GET as statusGET } from "@/app/api/stripe/subscriptions/[id]/status/route";
import { POST as webhookPOST } from "@/app/api/stripe/webhook/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `paypb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
process.env.PAYPB_STAMP = STAMP;
const TENANT = `${STAMP}-t`;
const ACCT = `acct_${STAMP}`;
const MEM = { A: `${STAMP}-a`, B: `${STAMP}-b`, O: `${STAMP}-o`, P: `${STAMP}-p`, K: `${STAMP}-k`, Q: `${STAMP}-q`, U: `${STAMP}-u` };
const SUB_U = `sub_${STAMP}_u`;
const SUB_B = `sub_${STAMP}_b`;
const PRICE = { adult: `price_${STAMP}_adult`, kids: `price_${STAMP}_kids` };

const SECRET = "whsec_paypb_synthetic_local_only_0123456789";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
process.env.STRIPE_SECRET_KEY = "sk_test_paypb_synthetic_never_used";
const signer = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" as never });
let evtSeq = 0;

const asMember = (memberId: string) => ({ user: { id: `${memberId}-user`, tenantId: TENANT, role: "member", memberId } });
const asOwner = () => ({ user: { id: `${STAMP}-owner`, tenantId: TENANT, role: "owner" } });

const post = (body: unknown) =>
  new Request("http://localhost/api/member/subscriptions/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function confirm(id: string) {
  const res = await confirmationGET(new Request(`http://localhost/api/stripe/subscriptions/${id}/confirmation`), ctx(id));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function status(id: string) {
  const res = await statusGET(new Request(`http://localhost/api/stripe/subscriptions/${id}/status`), ctx(id));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function deliver(type: string, object: Record<string, unknown>, created: number) {
  const payload = JSON.stringify({ id: `evt_${STAMP}_${++evtSeq}`, object: "event", account: ACCT, livemode: false, created, type, data: { object } });
  const sig = signer.webhooks.generateTestHeaderString({ payload, secret: SECRET } as Parameters<typeof signer.webhooks.generateTestHeaderString>[0]);
  const res = await webhookPOST(
    new Request("http://localhost/api/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: payload }) as never,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const member = (id: string) =>
  withRlsBypass((tx) => tx.member.findUnique({ where: { id }, select: { status: true, paymentStatus: true, stripeSubscriptionId: true, cancelledAt: true, membershipTierId: true, membershipType: true } }));
const mapping = (sub: string) => withRlsBypass((tx) => tx.memberSubscription.findUnique({ where: { stripeSubscriptionId: sub } }));

let firstSub = "";
let secondSub = "";

describe.skipIf(!HAS_DB)("pay-pb: first payment — start, confirm, expire, restart, pay on real rows", () => {
  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.tenant.create({
        data: {
          id: TENANT, name: `${STAMP} club`, slug: TENANT, stripeAccountId: ACCT, stripeConnected: true, memberSelfBilling: true,
          stripeAccountStatus: { chargesEnabled: true, payoutsEnabled: true, requirementsPastDue: [], disabledReason: null, refreshedAt: new Date().toISOString() },
        },
      });
      await tx.membershipTier.create({ data: { tenantId: TENANT, name: "PB adult", pricePence: 6500, billingCycle: "monthly", stripePriceId: PRICE.adult, isKids: false, isActive: true } });
      await tx.membershipTier.create({ data: { tenantId: TENANT, name: "PB kids", pricePence: 3000, billingCycle: "monthly", stripePriceId: PRICE.kids, isKids: true, isActive: true } });
      const mk = (id: string, label: string, data: Record<string, unknown> = {}) =>
        tx.member.create({ data: { id, tenantId: TENANT, email: `${STAMP}-${label}@example.test`, name: `PB ${label}`, ...data } });
      // A pays at the desk today (paid, active) and starts an in-app membership.
      await mk(MEM.A, "a", { status: "active", paymentStatus: "paid" });
      // B is an unrelated member with a live subscription: must never move.
      await mk(MEM.B, "b", { status: "active", paymentStatus: "paid", stripeSubscriptionId: SUB_B });
      await mk(MEM.O, "o");
      await mk(MEM.P, "p");
      await mk(MEM.K, "k", { parentMemberId: MEM.P, guardianConfirmedAt: new Date() });
      await mk(MEM.Q, "q");
      // U is linked to Q by a SUGGESTION only (no guardianConfirmedAt).
      await mk(MEM.U, "u", { parentMemberId: MEM.Q, guardianConfirmedAt: null, paymentStatus: "pending", stripeSubscriptionId: SUB_U });
      const map = (memberId: string, sub: string, status: string) =>
        tx.memberSubscription.create({ data: { tenantId: TENANT, memberId, stripeAccountId: ACCT, stripeSubscriptionId: sub, source: "app", status, lastEventCreated: 1000 } });
      await map(MEM.B, SUB_B, "active");
      await map(MEM.U, SUB_U, "incomplete");
    });
    h.subs.set(SUB_U, { status: "incomplete", invoice: `in_${STAMP}_u`, secret: "pi_u_secret_pb", customer: `cus_${STAMP}_u` });
  }, 120_000);

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_${STAMP}_` } } });
      await tx.auditLog.deleteMany({ where: { tenantId: TENANT } });
      await tx.payment.deleteMany({ where: { tenantId: TENANT } });
      await tx.memberSubscription.deleteMany({ where: { tenantId: TENANT } });
      await tx.member.deleteMany({ where: { tenantId: TENANT, parentMemberId: { not: null } } });
      await tx.member.deleteMany({ where: { tenantId: TENANT } });
      await tx.membershipTier.deleteMany({ where: { tenantId: TENANT } });
      await tx.tenant.deleteMany({ where: { id: TENANT } });
    });
    const left = await withRlsBypass(async (tx) => ({
      members: await tx.member.count({ where: { tenantId: TENANT } }),
      maps: await tx.memberSubscription.count({ where: { tenantId: TENANT } }),
      tenants: await tx.tenant.count({ where: { id: TENANT } }),
    }));
    expect(left).toEqual({ members: 0, maps: 0, tenants: 0 });
  }, 120_000);

  it("(a) a member starts: mapping incomplete, pointer set, pending, Member.status untouched; secret only on the club account", async () => {
    h.session = asMember(MEM.A);
    const res = await startPOST(post({ priceId: PRICE.adult, requestId: `${STAMP}-req-1` }));
    expect(res.status).toBe(201);
    const started = (await res.json()) as { subscriptionId: string; clientSecret: string };
    firstSub = started.subscriptionId;
    expect(h.createCalls.at(-1)?.opts).toMatchObject({ stripeAccount: ACCT });

    expect(await member(MEM.A)).toMatchObject({ status: "active", paymentStatus: "pending", stripeSubscriptionId: firstSub });
    // RP-2: no tier before payment (a tier + "pending" is desk coverage in lib/checkin.ts).
    expect(await member(MEM.A)).toMatchObject({ membershipTierId: null, membershipType: null });
    expect(await mapping(firstSub)).toMatchObject({ memberId: MEM.A, status: "incomplete", endedAt: null, stripeAccountId: ACCT });

    const mine = await confirm(firstSub);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ state: "requires_payment", stripeAccount: ACCT, clientSecret: started.clientSecret });
    expect(h.retrieveCalls.at(-1)).toEqual({ id: firstSub, opts: { stripeAccount: ACCT } });

    h.session = asOwner();
    expect((await confirm(firstSub)).status).toBe(200);

    h.session = asMember(MEM.O);
    const calls = h.retrieveCalls.length;
    const other = await confirm(firstSub);
    expect(other.status).toBe(404);
    expect(other.body.clientSecret).toBeUndefined();
    expect((await status(firstSub)).status).toBe(404);
    expect(h.retrieveCalls.length).toBe(calls);
  });

  it("(a2) RP-2: a staff start writes the subscription and NO tier, even when the drawer sends the tier id", async () => {
    h.session = asOwner();
    const tierId = (await withRlsBypass((tx) => tx.membershipTier.findFirst({ where: { tenantId: TENANT, stripePriceId: PRICE.adult }, select: { id: true } })))!.id;
    const res = await staffCreatePOST(
      new Request("http://localhost/api/stripe/create-subscription", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberId: MEM.O, priceId: PRICE.adult, requestId: `${STAMP}-req-staff`, membershipTierId: tierId }),
      }),
    );
    expect(res.status).toBe(200);
    const sub = ((await res.json()) as { subscriptionId: string }).subscriptionId;
    expect(await member(MEM.O)).toMatchObject({ paymentStatus: "pending", stripeSubscriptionId: sub, membershipTierId: null, membershipType: null });
  });

  it("(b) a guardian pays for a CONFIRMED child only", async () => {
    h.session = asMember(MEM.P);
    const res = await startKidPOST(
      new Request("http://localhost/api/member/subscriptions/start-for-kid", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ kidMemberId: MEM.K, priceId: PRICE.kids, requestId: `${STAMP}-req-kid` }),
      }),
    );
    expect(res.status).toBe(201);
    const kidSub = ((await res.json()) as { subscriptionId: string }).subscriptionId;
    expect((await confirm(kidSub)).status).toBe(200);
    expect(await member(MEM.K)).toMatchObject({ paymentStatus: "pending", membershipTierId: null, membershipType: null });

    // Another parent cannot pay it; P cannot pay Q's suggested child; Q (unconfirmed) cannot either.
    h.session = asMember(MEM.Q);
    expect((await confirm(kidSub)).status).toBe(404);
    expect((await confirm(SUB_U)).status).toBe(404);
    h.session = asMember(MEM.P);
    expect((await confirm(SUB_U)).status).toBe(404);
  });

  it("(c) Stripe expires the unpaid subscription: only the mapping ends; the person and other members are untouched; no secret", async () => {
    const bBefore = await member(MEM.B);
    h.subs.get(firstSub)!.status = "incomplete_expired";
    const r = await deliver("customer.subscription.updated", { id: firstSub, object: "subscription", customer: h.subs.get(firstSub)!.customer, status: "incomplete_expired", items: { data: [] } }, 5000);
    expect(r.status).toBe(200);

    const a = await member(MEM.A);
    expect(a).toMatchObject({ status: "active", stripeSubscriptionId: null, cancelledAt: null, membershipTierId: null, membershipType: null });
    expect(a?.paymentStatus).not.toBe("cancelled");
    expect(await mapping(firstSub)).toMatchObject({ status: "incomplete_expired" });
    expect((await mapping(firstSub))?.endedAt).toBeInstanceOf(Date);
    expect(await member(MEM.B)).toEqual(bBefore);
    expect(await mapping(SUB_B)).toMatchObject({ status: "active", endedAt: null });

    h.session = asMember(MEM.A);
    const calls = h.retrieveCalls.length;
    const c = await confirm(firstSub);
    expect(c.status).toBe(409);
    expect(c.body.state).toBe("ended");
    expect(c.body.clientSecret).toBeUndefined();
    expect(h.retrieveCalls.length).toBe(calls);
    const s = await status(firstSub);
    expect(s.body.subscription).toMatchObject({ status: "incomplete_expired", ended: true, current: false });
  });

  it("(d) a restart after expiry with a NEW request id passes the duplicate guard", async () => {
    h.session = asMember(MEM.A);
    const res = await startPOST(post({ priceId: PRICE.adult, requestId: `${STAMP}-req-2` }));
    expect(res.status).toBe(201);
    secondSub = ((await res.json()) as { subscriptionId: string }).subscriptionId;
    expect(secondSub).not.toBe(firstSub);
    expect(await member(MEM.A)).toMatchObject({ status: "active", paymentStatus: "pending", stripeSubscriptionId: secondSub, membershipTierId: null, membershipType: null });
    expect(await mapping(secondSub)).toMatchObject({ status: "incomplete", endedAt: null });
    expect(await mapping(firstSub)).toMatchObject({ status: "incomplete_expired" });
    // And while the new one is unpaid, a third start is refused (resume instead).
    const again = await startPOST(post({ priceId: PRICE.adult, requestId: `${STAMP}-req-3` }));
    expect(again.status).toBe(409);
    expect((await confirm(secondSub)).status).toBe(200);
  });

  it("(e) once Stripe reports the payment, status shows mapping active, Payment succeeded, paymentStatus paid", async () => {
    const rec = h.subs.get(secondSub)!;
    rec.status = "active";
    const before = await status(secondSub);
    expect(await member(MEM.A)).toMatchObject({ membershipTierId: null, membershipType: null });
    expect(before.body).toMatchObject({ subscription: { status: "incomplete" }, payment: null, billing: { paymentStatus: "pending" } });

    await deliver("customer.subscription.updated", { id: secondSub, object: "subscription", customer: rec.customer, status: "active", items: { data: [] } }, 6000);
    await deliver(
      "invoice.payment_succeeded",
      {
        id: rec.invoice, object: "invoice", customer: rec.customer, amount_paid: 6500, amount_due: 6500, currency: "gbp",
        parent: { type: "subscription_details", subscription_details: { subscription: secondSub, metadata: {} } },
        status_transitions: { paid_at: 1_790_000_000 },
      },
      6001,
    );
    const after = await status(secondSub);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({
      subscription: { status: "active", ended: false, current: true },
      payment: { status: "succeeded", amountPence: 6500 },
      billing: { paymentStatus: "paid" },
    });
    expect(JSON.stringify(after.body)).not.toMatch(/secret/);
    expect(await member(MEM.A)).toMatchObject({ status: "active", paymentStatus: "paid" });
    // Nothing left to pay.
    const c = await confirm(secondSub);
    expect(c.status).toBe(409);
    expect(c.body.state).toBe("already_paid");
  });
});
