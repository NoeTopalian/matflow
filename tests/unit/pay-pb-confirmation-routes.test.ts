// Payments lane PB (11 Oct 2026), audit F1 — the two read routes behind the
// in-app first-payment step.
//
//   GET /api/stripe/subscriptions/[id]/confirmation — the client secret and
//       the club's connected account id, for a MatFlow-mapped subscription
//       Stripe still reports `incomplete`, to someone allowed to pay it
//   GET /api/stripe/subscriptions/[id]/status — MatFlow's own record (mapping,
//       Payment row, paymentStatus), polled after confirmation; no secrets
//
// Pinned here (Stripe and Prisma mocked; the DB version of the access rules
// runs in tests/integration/pay-pb-confirmation-db.test.ts):
//   - who may pay: staff (owner/manager), the member, the CONFIRMED guardian;
//     a coach, another member, an unconfirmed guardian and an unknown or
//     unmapped id all get the same 404, and Stripe is never called
//   - the secret is read from Stripe on the club's account (stripeAccount
//     header = the account lane PA's guard returned) and only while Stripe
//     says `incomplete`; ended / paid / other states answer 409 with no secret
//   - lane PA's refusal is passed through untouched
//   - neither route writes anything (payment state moves only via webhooks)

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  mappingFind: vi.fn(),
  memberFind: vi.fn(),
  paymentFind: vi.fn(),
  writes: vi.fn(),
  club: vi.fn(),
  retrieve: vi.fn(),
  stripeCtor: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      memberSubscription: { findFirst: h.mappingFind, update: h.writes, updateMany: h.writes, upsert: h.writes },
      member: { findFirst: h.memberFind, update: h.writes, updateMany: h.writes },
      payment: { findFirst: h.paymentFind, update: h.writes, upsert: h.writes, create: h.writes },
    }),
}));
vi.mock("@/lib/stripe/club-account", () => ({ clubAccountOrRefusal: h.club }));
vi.mock("stripe", () => ({
  default: function FakeStripe(this: unknown, key: string, opts: unknown) {
    h.stripeCtor(key, opts);
    return { subscriptions: { retrieve: h.retrieve } };
  },
}));

import { GET as confirmationGET } from "@/app/api/stripe/subscriptions/[id]/confirmation/route";
import { GET as statusGET } from "@/app/api/stripe/subscriptions/[id]/status/route";

const TENANT = "tenant_pb";
const ACCT = "acct_club_pb";
const SUB = "sub_pb_1";
const MEMBER = "mem_payer";
const CHILD = "mem_child";

function mapping(over: Record<string, unknown> = {}) {
  return {
    id: "map_1",
    tenantId: TENANT,
    memberId: MEMBER,
    stripeAccountId: ACCT,
    stripeSubscriptionId: SUB,
    status: "incomplete",
    endedAt: null,
    requiresActionInvoiceId: null,
    createdAt: new Date("2026-10-11T10:00:00Z"),
    ...over,
  };
}

function incompleteSub() {
  return {
    status: "incomplete",
    latest_invoice: { id: "in_pb_1", amount_due: 6500, currency: "gbp", confirmation_secret: { client_secret: "pi_pb_secret_abc" } },
  };
}

const ctx = (id = SUB) => ({ params: Promise.resolve({ id }) });
const req = (url = `http://localhost/api/stripe/subscriptions/${SUB}/x`) => new Request(url);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_pb_fixture";
  h.mappingFind.mockResolvedValue(mapping());
  h.memberFind.mockResolvedValue(null);
  h.paymentFind.mockResolvedValue(null);
  h.club.mockResolvedValue({ ok: true, account: { stripeAccountId: ACCT, status: {} } });
  h.retrieve.mockResolvedValue(incompleteSub());
});

describe("pay-pb: GET /api/stripe/subscriptions/[id]/confirmation — who may pay", () => {
  it("401 without a session, before any lookup", async () => {
    h.auth.mockResolvedValue(null);
    const res = await confirmationGET(req(), ctx());
    expect(res.status).toBe(401);
    expect(h.mappingFind).not.toHaveBeenCalled();
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it.each([
    ["owner", { role: "owner" }],
    ["manager", { role: "manager" }],
    ["the member", { role: "member", memberId: MEMBER }],
  ])("%s gets the secret and the club account id, read from Stripe on the club's account", async (_l, user) => {
    h.auth.mockResolvedValue({ user: { tenantId: TENANT, ...user } });
    const res = await confirmationGET(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      state: "requires_payment",
      clientSecret: "pi_pb_secret_abc",
      stripeAccount: ACCT,
      invoiceId: "in_pb_1",
      amountDue: 6500,
      currency: "GBP",
    });
    expect(h.retrieve).toHaveBeenCalledTimes(1);
    const [subId, params, opts] = h.retrieve.mock.calls[0];
    expect(subId).toBe(SUB);
    expect(params).toEqual({ expand: ["latest_invoice.confirmation_secret"] });
    // Direct charge on the connected account — never the platform.
    expect(opts).toEqual({ stripeAccount: ACCT });
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Scoped to the caller's club.
    expect(h.mappingFind.mock.calls[0][0].where).toEqual({ tenantId: TENANT, stripeSubscriptionId: SUB });
  });

  it("the CONFIRMED guardian of the child gets the secret", async () => {
    h.mappingFind.mockResolvedValue(mapping({ memberId: CHILD }));
    h.memberFind.mockResolvedValue({ id: CHILD });
    h.auth.mockResolvedValue({ user: { tenantId: TENANT, role: "member", memberId: MEMBER } });
    const res = await confirmationGET(req(), ctx());
    expect(res.status).toBe(200);
    const where = h.memberFind.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: CHILD, tenantId: TENANT, parentMemberId: MEMBER, guardianConfirmedAt: { not: null } });
  });

  it.each([
    ["a coach", { role: "coach" }, null],
    ["another member", { role: "member", memberId: "mem_other" }, null],
    ["an unconfirmed guardian (no confirmed child row)", { role: "member", memberId: MEMBER }, CHILD],
  ])("%s gets 404 and Stripe is never called", async (_l, user, mappedTo) => {
    if (mappedTo) h.mappingFind.mockResolvedValue(mapping({ memberId: mappedTo }));
    h.memberFind.mockResolvedValue(null);
    h.auth.mockResolvedValue({ user: { tenantId: TENANT, ...user } });
    const res = await confirmationGET(req(), ctx());
    expect(res.status).toBe(404);
    expect(h.club).not.toHaveBeenCalled();
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it("a subscription MatFlow did not map (or another club's) is a 404, indistinguishable from none", async () => {
    h.mappingFind.mockResolvedValue(null);
    h.auth.mockResolvedValue({ user: { tenantId: TENANT, role: "owner" } });
    const res = await confirmationGET(req(), ctx());
    expect(res.status).toBe(404);
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it("a malformed id never reaches the database", async () => {
    h.auth.mockResolvedValue({ user: { tenantId: TENANT, role: "owner" } });
    const res = await confirmationGET(req(), ctx("../../members"));
    expect(res.status).toBe(404);
    expect(h.mappingFind).not.toHaveBeenCalled();
  });
});

describe("pay-pb: confirmation — only an unpaid, current subscription yields a secret", () => {
  beforeEach(() => h.auth.mockResolvedValue({ user: { tenantId: TENANT, role: "member", memberId: MEMBER } }));

  it("an ended mapping (incomplete_expired handled by the webhook) answers 409 ended without calling Stripe", async () => {
    h.mappingFind.mockResolvedValue(mapping({ status: "incomplete_expired", endedAt: new Date() }));
    const res = await confirmationGET(req(), ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.state).toBe("ended");
    expect(body.clientSecret).toBeUndefined();
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it("Stripe already reports it active: 409 already_paid, no secret", async () => {
    h.retrieve.mockResolvedValue({ status: "active", latest_invoice: { confirmation_secret: { client_secret: "pi_x_secret_y" } } });
    const res = await confirmationGET(req(), ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ state: "already_paid" });
    expect(body.clientSecret).toBeUndefined();
  });

  it.each(["incomplete_expired", "canceled"])("Stripe reports %s before MatFlow heard: 409 ended, no secret", async (status) => {
    h.retrieve.mockResolvedValue({ status, latest_invoice: { confirmation_secret: { client_secret: "pi_x_secret_y" } } });
    const res = await confirmationGET(req(), ctx());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.state).toBe("ended");
    expect(body.clientSecret).toBeUndefined();
  });

  it("past_due (a renewal, not a first payment): 409 not_payable, no secret", async () => {
    h.retrieve.mockResolvedValue({ status: "past_due", latest_invoice: { confirmation_secret: { client_secret: "pi_x_secret_y" } } });
    const res = await confirmationGET(req(), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).clientSecret).toBeUndefined();
  });

  it("lane PA's refusal is returned as is and Stripe is not called", async () => {
    const refusal = new Response(JSON.stringify({ ok: false, error: "x", reason: "deauthorized" }), { status: 409 });
    h.club.mockResolvedValue({ ok: false, response: refusal });
    const res = await confirmationGET(req(), ctx());
    expect(res).toBe(refusal);
    expect(h.club).toHaveBeenCalledWith(TENANT, "subscription_start", { audience: "member" });
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it("a subscription made on a different account than the one now connected is not payable here", async () => {
    h.club.mockResolvedValue({ ok: true, account: { stripeAccountId: "acct_new_club_account", status: {} } });
    const res = await confirmationGET(req(), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).clientSecret).toBeUndefined();
    expect(h.retrieve).not.toHaveBeenCalled();
  });

  it("no confirmation secret on the invoice is a 502, not an empty success", async () => {
    h.retrieve.mockResolvedValue({ status: "incomplete", latest_invoice: { id: "in_1", confirmation_secret: null } });
    const res = await confirmationGET(req(), ctx());
    expect(res.status).toBe(502);
  });

  it("a Stripe error is a 502 with no internals", async () => {
    h.retrieve.mockRejectedValue(new Error("No such subscription: sub_pb_1; request-id req_123"));
    const res = await confirmationGET(req(), ctx());
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toMatch(/req_123|No such/);
  });

  it("never writes a member, a mapping or a payment", async () => {
    await confirmationGET(req(), ctx());
    expect(h.writes).not.toHaveBeenCalled();
  });
});

describe("pay-pb: GET /api/stripe/subscriptions/[id]/status — three separate facts, no secrets", () => {
  beforeEach(() => h.auth.mockResolvedValue({ user: { tenantId: TENANT, role: "member", memberId: MEMBER } }));

  it("reports the mapping, the Payment row and paymentStatus separately and never Member.status", async () => {
    h.mappingFind.mockResolvedValue(mapping({ status: "active" }));
    h.paymentFind.mockResolvedValue({ status: "succeeded", amountPence: 6500, currency: "GBP", paidAt: new Date("2026-10-11T10:01:00Z"), failureReason: null });
    h.memberFind.mockResolvedValue({ paymentStatus: "paid", stripeSubscriptionId: SUB });
    const res = await statusGET(req(`http://localhost/api/stripe/subscriptions/${SUB}/status?invoice=in_pb_1`), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      subscription: { status: "active", ended: false, current: true, requiresAction: false },
      payment: { status: "succeeded", amountPence: 6500, currency: "GBP", paidAt: "2026-10-11T10:01:00.000Z", failureReason: null },
      billing: { paymentStatus: "paid" },
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|acct_/);
    // Payment looked up for THIS member and invoice in THIS club.
    expect(h.paymentFind.mock.calls[0][0].where).toEqual({ tenantId: TENANT, memberId: MEMBER, stripeInvoiceId: "in_pb_1" });
    // Member.status is not even read.
    expect(h.memberFind.mock.calls[0][0].select).toEqual({ paymentStatus: true, stripeSubscriptionId: true });
    expect(h.retrieve).not.toHaveBeenCalled();
    expect(h.writes).not.toHaveBeenCalled();
  });

  it("before the webhook lands: still incomplete, no payment row", async () => {
    h.memberFind.mockResolvedValue({ paymentStatus: "pending", stripeSubscriptionId: SUB });
    const res = await statusGET(req(`http://localhost/api/stripe/subscriptions/${SUB}/status`), ctx());
    const body = await res.json();
    expect(body.subscription.status).toBe("incomplete");
    expect(body.payment).toBeNull();
    expect(body.billing.paymentStatus).toBe("pending");
    // Without an invoice id, only payments since this subscription was created count.
    expect(h.paymentFind.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT, memberId: MEMBER, createdAt: { gte: mapping().createdAt } });
  });

  it("an ended mapping reads ended and no longer current", async () => {
    h.mappingFind.mockResolvedValue(mapping({ status: "incomplete_expired", endedAt: new Date() }));
    h.memberFind.mockResolvedValue({ paymentStatus: "pending", stripeSubscriptionId: null });
    const body = await (await statusGET(req(), ctx())).json();
    expect(body.subscription).toMatchObject({ status: "incomplete_expired", ended: true, current: false });
  });

  it("the same access rule: another member gets 404 and nothing is read", async () => {
    h.auth.mockResolvedValue({ user: { tenantId: TENANT, role: "member", memberId: "mem_other" } });
    const res = await statusGET(req(), ctx());
    expect(res.status).toBe(404);
    expect(h.paymentFind).not.toHaveBeenCalled();
  });
});
