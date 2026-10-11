import { vi, describe, it, expect, beforeEach } from "vitest";

// Payments lane PC (11 Oct 2026) — audit §11, §13, §17 (F4, F5, F8).
//
// The webhook used to find "the member" by Stripe customer and then let any
// subscription or invoice on that customer move them. In the TeamUp replace
// window one customer carries two live subscriptions (TeamUp's and MatFlow's
// replacement), so TeamUp's could re-point or cancel the member while MatFlow's
// kept billing. These tests pin the replacement rule: subscription and invoice
// events resolve through the MemberSubscription mapping (immutable, written by
// MatFlow when it creates, migrates or adopts a subscription), are ordered by
// event.created against the mapping, never cancel the member record, and an
// event that maps to nothing MatFlow owns writes nothing at all.

vi.mock("next/server", () => ({
  NextRequest: class extends Request {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const constructEventMock = vi.fn();
const invoicesRetrieveMock = vi.fn();
const paymentIntentsRetrieveMock = vi.fn();
const paymentMethodsRetrieveMock = vi.fn();
const subscriptionsRetrieveMock = vi.fn();
const subscriptionsListMock = vi.fn();
const invoicePaymentsListMock = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    webhooks = { constructEvent: constructEventMock };
    invoices = { retrieve: invoicesRetrieveMock };
    paymentIntents = { retrieve: paymentIntentsRetrieveMock };
    paymentMethods = { retrieve: paymentMethodsRetrieveMock };
    subscriptions = { retrieve: subscriptionsRetrieveMock, list: subscriptionsListMock };
    invoicePayments = { list: invoicePaymentsListMock };
  },
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    stripeEvent: { create: vi.fn() },
    tenant: { findFirst: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    user: { findMany: vi.fn() },
    member: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    memberSubscription: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    memberStatusEvent: { create: vi.fn() },
    payment: { findFirst: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    dispute: { upsert: vi.fn() },
  },
}));

const sendEmailMock = vi.fn().mockResolvedValue({ ok: true });
vi.mock("@/lib/email", () => ({ sendEmail: sendEmailMock }));
const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/stripe-account-status", () => ({ refreshStripeAccountStatus: vi.fn(async () => {}) }));

import { prisma } from "@/lib/prisma";

const db = {
  claim: vi.mocked(prisma.stripeEvent.create),
  tenantFindFirst: vi.mocked(prisma.tenant.findFirst),
  memberFindFirst: vi.mocked(prisma.member.findFirst),
  memberFindUnique: vi.mocked(prisma.member.findUnique),
  memberUpdate: vi.mocked(prisma.member.update),
  memberUpdateMany: vi.mocked(prisma.member.updateMany),
  mapFindFirst: vi.mocked(prisma.memberSubscription.findFirst),
  mapFindMany: vi.mocked(prisma.memberSubscription.findMany),
  mapUpdate: vi.mocked(prisma.memberSubscription.update),
  mapUpdateMany: vi.mocked(prisma.memberSubscription.updateMany),
  statusEvent: vi.mocked(prisma.memberStatusEvent.create),
  payFindFirst: vi.mocked(prisma.payment.findFirst),
  payUpsert: vi.mocked(prisma.payment.upsert),
  payUpdate: vi.mocked(prisma.payment.update),
};

// One payer, the TeamUp replace window: customer cus_payer carries TeamUp's
// subscription (sub_teamup, NOT MatFlow's: no mapping) and MatFlow's
// replacement (sub_matflow, mapped to mem-1, the member's ACTIVE one).
type Mapping = { id: string; tenantId: string; memberId: string; stripeSubscriptionId: string; status: string; lastEventCreated: number | null; endedAt: Date | null };
type MemberRow = { id: string; tenantId: string; status: string; stripeSubscriptionId: string | null; stripeCustomerId: string };
let mappings: Mapping[];
let members: MemberRow[];

function seed() {
  mappings = [
    { id: "ms-1", tenantId: "tenant-A", memberId: "mem-1", stripeSubscriptionId: "sub_matflow", status: "active", lastEventCreated: 1000, endedAt: null },
  ];
  members = [
    { id: "mem-1", tenantId: "tenant-A", status: "active", stripeSubscriptionId: "sub_matflow", stripeCustomerId: "cus_payer" },
  ];
}

function wireDb() {
  db.claim.mockResolvedValue({ id: "row" } as never);
  db.tenantFindFirst.mockResolvedValue({ id: "tenant-A" } as never);
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ name: "Gym" } as never);
  vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);
  db.mapFindFirst.mockImplementation((async (args: { where: { tenantId?: string; stripeSubscriptionId?: string } }) =>
    mappings.find((m) => m.stripeSubscriptionId === args.where.stripeSubscriptionId && (!args.where.tenantId || m.tenantId === args.where.tenantId)) ?? null) as never);
  db.mapFindMany.mockImplementation((async (args: { where: { tenantId?: string; stripeSubscriptionId?: { in: string[] } } }) =>
    mappings.filter((m) => (args.where.stripeSubscriptionId?.in ?? []).includes(m.stripeSubscriptionId))) as never);
  // The conditional ordering write: applies only when the stored
  // lastEventCreated is null or not newer than the event, as Postgres would.
  db.mapUpdateMany.mockImplementation((async (args: { where: { id: string; OR?: Array<{ lastEventCreated: null | { lte: number } }> }; data: Partial<Mapping> }) => {
    const m = mappings.find((x) => x.id === args.where.id);
    if (!m) return { count: 0 };
    if (args.where.OR) {
      const ok = args.where.OR.some((c) => (c.lastEventCreated === null ? m.lastEventCreated === null : m.lastEventCreated !== null && m.lastEventCreated <= c.lastEventCreated.lte));
      if (!ok) return { count: 0 };
    }
    Object.assign(m, args.data);
    return { count: 1 };
  }) as never);
  db.mapUpdate.mockImplementation((async (args: { where: { id: string }; data: Partial<Mapping> }) => {
    const m = mappings.find((x) => x.id === args.where.id)!;
    Object.assign(m, args.data);
    return m;
  }) as never);
  // A member is found by id (through a mapping) or, for the two events that
  // still may, by customer. Returning the payer for a customer lookup is what
  // made the old handler move the member on TeamUp's events.
  db.memberFindFirst.mockImplementation((async (args: { where: { id?: string; stripeCustomerId?: string; tenantId?: string } }) =>
    members.find((m) => (args.where.id ? m.id === args.where.id : m.stripeCustomerId === args.where.stripeCustomerId) && (!args.where.tenantId || m.tenantId === args.where.tenantId)) ?? null) as never);
  db.memberFindUnique.mockImplementation((async (args: { where: { id: string } }) => {
    const m = members.find((x) => x.id === args.where.id);
    return m ? { ...m, name: "Sam", email: "sam@gym.test", tenant: { name: "Gym" }, parent: null } : null;
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  seed();
  wireDb();
});

function req() {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "sig", "content-type": "application/json" },
    body: "{}",
  });
}

async function deliver(event: Record<string, unknown>) {
  constructEventMock.mockReturnValue({ account: "acct_A", livemode: false, created: 2000, ...event });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  const res = (await POST(req() as never)) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json() };
}

function memberWrites() {
  return db.memberUpdate.mock.calls.length + db.memberUpdateMany.mock.calls.length;
}

// ── (a) old (foreign) and replacement (mapped) subscriptions on one customer ──

describe("(a) TeamUp's subscription on the same customer cannot move the member", () => {
  it("subscription.updated for the foreign subscription (past_due) changes nothing and is ignored_foreign", async () => {
    const r = await deliver({ id: "evt_a1", type: "customer.subscription.updated", data: { object: { id: "sub_teamup", customer: "cus_payer", status: "past_due" } } });
    expect(r.status).toBe(200);
    expect(memberWrites()).toBe(0);
    expect(members[0].stripeSubscriptionId).toBe("sub_matflow");
    expect(r.body.outcome).toBe("ignored_foreign");
  });

  it("the foreign subscription being canceled neither cancels the member nor clears the pointer", async () => {
    const r = await deliver({ id: "evt_a2", type: "customer.subscription.updated", data: { object: { id: "sub_teamup", customer: "cus_payer", status: "canceled" } } });
    expect(r.status).toBe(200);
    expect(memberWrites()).toBe(0);
    expect(db.statusEvent).not.toHaveBeenCalled();
    expect(r.body.outcome).toBe("ignored_foreign");
  });

  it("the foreign subscription being deleted writes nothing", async () => {
    const r = await deliver({ id: "evt_a3", type: "customer.subscription.deleted", data: { object: { id: "sub_teamup", customer: "cus_payer", status: "canceled" } } });
    expect(r.status).toBe(200);
    expect(memberWrites()).toBe(0);
    expect(r.body.outcome).toBe("ignored_foreign");
  });

  it("a failed invoice of the foreign subscription does not mark the member overdue or write a Payment", async () => {
    invoicesRetrieveMock.mockResolvedValue({ id: "in_teamup", payments: { data: [] } });
    const r = await deliver({ id: "evt_a4", type: "invoice.payment_failed", data: { object: { id: "in_teamup", customer: "cus_payer", amount_due: 4000, currency: "gbp", parent: { type: "subscription_details", subscription_details: { subscription: "sub_teamup", metadata: {} } } } } });
    expect(r.status).toBe(200);
    expect(memberWrites()).toBe(0);
    expect(db.payUpsert).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(r.body.outcome).toBe("ignored_foreign");
  });

  it("the replacement (mapped) subscription still updates its member", async () => {
    const r = await deliver({ id: "evt_a5", type: "customer.subscription.updated", data: { object: { id: "sub_matflow", customer: "cus_payer", status: "past_due" } } });
    expect(r.status).toBe(200);
    expect(db.memberUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "mem-1" }, data: expect.objectContaining({ paymentStatus: "overdue" }) }));
    expect(mappings[0]).toMatchObject({ status: "past_due", lastEventCreated: 2000 });
    expect(r.body.outcome).toBe("processed");
  });
});

// ── (b) delayed events ────────────────────────────────────────────────────────

describe("(b) a delayed subscription.updated older than the applied state is ignored", () => {
  it("an event created before the mapping's lastEventCreated is ignored_stale and writes nothing", async () => {
    mappings[0].lastEventCreated = 3000;
    mappings[0].status = "active";
    const r = await deliver({ id: "evt_b1", type: "customer.subscription.updated", created: 2500, data: { object: { id: "sub_matflow", customer: "cus_payer", status: "past_due" } } });
    expect(r.status).toBe(200);
    expect(memberWrites()).toBe(0);
    expect(mappings[0]).toMatchObject({ status: "active", lastEventCreated: 3000 });
    // Stale by its own timestamp: no fresh retrieve is needed to decide that.
    expect(subscriptionsRetrieveMock).not.toHaveBeenCalled();
    expect(r.body.outcome).toBe("ignored_stale");
  });

  it("newer then older: the newer applies, the older is ignored", async () => {
    await deliver({ id: "evt_b2", type: "customer.subscription.updated", created: 4000, data: { object: { id: "sub_matflow", customer: "cus_payer", status: "past_due" } } });
    db.memberUpdate.mockClear();
    const r = await deliver({ id: "evt_b3", type: "customer.subscription.updated", created: 3500, data: { object: { id: "sub_matflow", customer: "cus_payer", status: "active" } } });
    expect(db.memberUpdate).not.toHaveBeenCalled();
    expect(mappings[0]).toMatchObject({ status: "past_due", lastEventCreated: 4000 });
    expect(r.body.outcome).toBe("ignored_stale");
  });

  it("a mapping with no lastEventCreated (backfilled) is applied from a FRESH retrieve on the club's account", async () => {
    mappings[0].lastEventCreated = null;
    subscriptionsRetrieveMock.mockResolvedValue({ id: "sub_matflow", status: "active", pause_collection: null, items: { data: [{ current_period_end: 1893456000 }] } });
    const r = await deliver({ id: "evt_b4", type: "customer.subscription.updated", data: { object: { id: "sub_matflow", customer: "cus_payer", status: "past_due" } } });
    expect(subscriptionsRetrieveMock).toHaveBeenCalledWith("sub_matflow", {}, { stripeAccount: "acct_A" });
    // The fresh state (active) wins over the possibly stale payload (past_due).
    expect(db.memberUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ paymentStatus: "paid" }) }));
    expect(mappings[0].status).toBe("active");
    expect(r.body.outcome).toBe("processed");
  });

  it("a same-second event (created equal to lastEventCreated) is also decided by a fresh retrieve", async () => {
    mappings[0].lastEventCreated = 2000;
    subscriptionsRetrieveMock.mockResolvedValue({ id: "sub_matflow", status: "past_due", pause_collection: null, items: { data: [] } });
    const r = await deliver({ id: "evt_b5", type: "customer.subscription.updated", created: 2000, data: { object: { id: "sub_matflow", customer: "cus_payer", status: "active" } } });
    expect(subscriptionsRetrieveMock).toHaveBeenCalled();
    expect(mappings[0].status).toBe("past_due");
    expect(r.body.outcome).toBe("processed");
  });

  it("a canceled mapping is not revived by a later non-terminal update", async () => {
    mappings[0].status = "canceled";
    mappings[0].endedAt = new Date();
    members[0].stripeSubscriptionId = null;
    const r = await deliver({ id: "evt_b6", type: "customer.subscription.updated", created: 9000, data: { object: { id: "sub_matflow", customer: "cus_payer", status: "active" } } });
    expect(memberWrites()).toBe(0);
    expect(mappings[0].status).toBe("canceled");
    expect(r.body.outcome).toBe("ignored_stale");
  });
});

// ── (c) several mapped subscriptions for one payer ───────────────────────────

describe("(c) one payer, two mapped subscriptions: each event touches only its own member", () => {
  beforeEach(() => {
    // A parent paying for two children on ONE customer.
    mappings.push({ id: "ms-2", tenantId: "tenant-A", memberId: "mem-2", stripeSubscriptionId: "sub_kid2", status: "active", lastEventCreated: 1000, endedAt: null });
    members.push({ id: "mem-2", tenantId: "tenant-A", status: "active", stripeSubscriptionId: "sub_kid2", stripeCustomerId: "cus_payer" });
  });

  it("past_due on child 2's subscription moves only child 2", async () => {
    await deliver({ id: "evt_c1", type: "customer.subscription.updated", data: { object: { id: "sub_kid2", customer: "cus_payer", status: "past_due" } } });
    expect(db.memberUpdate).toHaveBeenCalledTimes(1);
    expect(db.memberUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "mem-2" } }));
    expect(mappings[0]).toMatchObject({ status: "active", lastEventCreated: 1000 });
  });

  it("a paid invoice of child 1's subscription records the Payment against child 1 only", async () => {
    invoicesRetrieveMock.mockResolvedValue({ id: "in_k1", payments: { data: [{ status: "paid", payment: { payment_intent: "pi_k1" } }] } });
    paymentIntentsRetrieveMock.mockResolvedValue({ id: "pi_k1", latest_charge: "ch_k1" });
    const r = await deliver({ id: "evt_c2", type: "invoice.payment_succeeded", data: { object: { id: "in_k1", customer: "cus_payer", amount_paid: 3000, amount_due: 3000, currency: "gbp", parent: { type: "subscription_details", subscription_details: { subscription: "sub_matflow", metadata: {} } } } } });
    expect(db.payUpsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ memberId: "mem-1" }) }));
    expect(db.memberUpdate).toHaveBeenCalledTimes(1);
    expect(db.memberUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "mem-1" }, data: { paymentStatus: "paid" } }));
    expect(r.body.outcome).toBe("processed");
  });
});

// ── (d) late invoice.payment_failed after payment_succeeded ──────────────────

describe("(d) a late payment_failed never overwrites a succeeded invoice", () => {
  const failed = (id: string) => ({
    id, type: "invoice.payment_failed",
    data: { object: { id: "in_1", customer: "cus_payer", amount_due: 3000, currency: "gbp", parent: { type: "subscription_details", subscription_details: { subscription: "sub_matflow", metadata: {} } } } },
  });

  it("succeeded on record -> the failure is ignored_stale: no Payment write, no overdue, no emails", async () => {
    invoicesRetrieveMock.mockResolvedValue({ id: "in_1", payments: { data: [{ status: "paid", payment: { payment_intent: "pi_1" } }] } });
    paymentIntentsRetrieveMock.mockResolvedValue({ id: "pi_1", latest_charge: "ch_1" });
    db.payFindFirst.mockResolvedValue({ id: "pay-1", status: "succeeded", stripeInvoiceId: "in_1" } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ email: "owner@gym.test" }] as never);
    const r = await deliver(failed("evt_d1"));
    expect(r.status).toBe(200);
    expect(db.payUpsert).not.toHaveBeenCalled();
    expect(db.memberUpdate).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(r.body.outcome).toBe("ignored_stale");
  });

  it("failed then succeeded for the same invoice: the success applies", async () => {
    invoicesRetrieveMock.mockResolvedValue({ id: "in_1", payments: { data: [{ status: "paid", payment: { payment_intent: "pi_1" } }] } });
    paymentIntentsRetrieveMock.mockResolvedValue({ id: "pi_1", latest_charge: "ch_1" });
    db.payFindFirst.mockResolvedValue({ id: "pay-1", status: "failed", stripeInvoiceId: "in_1" } as never);
    const r = await deliver({ id: "evt_d2", type: "invoice.payment_succeeded", data: { object: { id: "in_1", customer: "cus_payer", amount_paid: 3000, amount_due: 3000, currency: "gbp", parent: { type: "subscription_details", subscription_details: { subscription: "sub_matflow", metadata: {} } } } } });
    expect(db.payUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ status: "succeeded" }) }));
    expect(db.memberUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { paymentStatus: "paid" } }));
    expect(r.body.outcome).toBe("processed");
  });

  it("a first failure (nothing on record) still records the failed Payment and marks the active member overdue", async () => {
    invoicesRetrieveMock.mockResolvedValue({ id: "in_1", payments: { data: [] } });
    db.payFindFirst.mockResolvedValue(null as never);
    const r = await deliver(failed("evt_d3"));
    expect(db.payUpsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ status: "failed", memberId: "mem-1" }) }));
    expect(db.memberUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "mem-1" }, data: { paymentStatus: "overdue" } }));
    expect(r.body.outcome).toBe("processed");
  });
});

// ── (e) payment state, membership and the person are separate ────────────────

describe("(e) an expired or cancelled subscription never cancels the member record", () => {
  it("incomplete_expired on a NON-active mapping (abandoned signup) ends that mapping and leaves the member untouched", async () => {
    // The member pays at the desk (no active pointer) and abandoned an
    // in-app signup whose subscription Stripe has now expired.
    mappings.push({ id: "ms-abandon", tenantId: "tenant-A", memberId: "mem-1", stripeSubscriptionId: "sub_abandoned", status: "incomplete", lastEventCreated: 1000, endedAt: null });
    const r = await deliver({ id: "evt_e1", type: "customer.subscription.updated", data: { object: { id: "sub_abandoned", customer: "cus_payer", status: "incomplete_expired" } } });
    expect(memberWrites()).toBe(0);
    expect(db.statusEvent).not.toHaveBeenCalled();
    const m = mappings.find((x) => x.id === "ms-abandon")!;
    expect(m.status).toBe("incomplete_expired");
    expect(m.endedAt).toBeInstanceOf(Date);
    expect(r.body.outcome).toBe("processed");
  });

  it("incomplete_expired on the ACTIVE mapping clears the pointer only (no paymentStatus, never Member.status)", async () => {
    mappings[0].status = "incomplete";
    const r = await deliver({ id: "evt_e2", type: "customer.subscription.updated", data: { object: { id: "sub_matflow", customer: "cus_payer", status: "incomplete_expired" } } });
    expect(db.memberUpdate).toHaveBeenCalledTimes(1);
    const data = (db.memberUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toEqual({ stripeSubscriptionId: null });
    expect(db.statusEvent).not.toHaveBeenCalled();
    expect(mappings[0].status).toBe("incomplete_expired");
    expect(r.body.outcome).toBe("processed");
  });

  it("subscription.deleted on the ACTIVE mapping ends it and clears the pointer without cancelling the member", async () => {
    const r = await deliver({ id: "evt_e3", type: "customer.subscription.deleted", data: { object: { id: "sub_matflow", customer: "cus_payer", status: "canceled" } } });
    const writes = [...db.memberUpdate.mock.calls, ...db.memberUpdateMany.mock.calls].map((c) => (c[0] as { data: Record<string, unknown> }).data);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ stripeSubscriptionId: null, paymentStatus: "cancelled" });
    expect(writes[0]).not.toHaveProperty("status");
    expect(db.statusEvent).not.toHaveBeenCalled();
    expect(mappings[0]).toMatchObject({ status: "canceled" });
    expect(mappings[0].endedAt).toBeInstanceOf(Date);
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "member.subscription.cancelled_by_stripe", entityId: "mem-1" }));
    expect(r.body.outcome).toBe("processed");
  });

  it("subscription.deleted on a NON-active mapping ends the mapping only", async () => {
    members[0].stripeSubscriptionId = "sub_other";
    const r = await deliver({ id: "evt_e4", type: "customer.subscription.deleted", data: { object: { id: "sub_matflow", customer: "cus_payer", status: "canceled" } } });
    expect(memberWrites()).toBe(0);
    expect(mappings[0].status).toBe("canceled");
    expect(r.body.outcome).toBe("processed");
  });

  it("invoice.payment_action_required is recorded on the mapping and changes no entitlement", async () => {
    const r = await deliver({ id: "evt_e5", type: "invoice.payment_action_required", data: { object: { id: "in_3ds", customer: "cus_payer", amount_due: 3000, currency: "gbp", parent: { type: "subscription_details", subscription_details: { subscription: "sub_matflow", metadata: {} } } } } });
    expect(r.status).toBe(200);
    expect(memberWrites()).toBe(0);
    expect(db.mapUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "ms-1" }, data: expect.objectContaining({ requiresActionInvoiceId: "in_3ds" }) }));
    expect(db.payUpsert).not.toHaveBeenCalled();
    // A later payment of that invoice clears the marker.
    invoicesRetrieveMock.mockResolvedValue({ id: "in_3ds", payments: { data: [{ status: "paid", payment: { payment_intent: "pi_3ds" } }] } });
    paymentIntentsRetrieveMock.mockResolvedValue({ id: "pi_3ds", latest_charge: "ch_3ds" });
    await deliver({ id: "evt_e5b", type: "invoice.payment_succeeded", data: { object: { id: "in_3ds", customer: "cus_payer", amount_paid: 3000, amount_due: 3000, currency: "gbp", parent: { type: "subscription_details", subscription_details: { subscription: "sub_matflow", metadata: {} } } } } });
    expect(db.mapUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "ms-1" }, data: { requiresActionInvoiceId: null, requiresActionAt: null } }));
    expect(r.body.outcome).toBe("processed");
  });
});

// ── (f) unknown subscription on a known account ──────────────────────────────

describe("(f) an object MatFlow does not own is acknowledged and nothing is written", () => {
  it("unknown subscription id -> 200 ignored_foreign, no member, mapping or payment write", async () => {
    const r = await deliver({ id: "evt_f1", type: "customer.subscription.updated", data: { object: { id: "sub_unknown", customer: "cus_stranger", status: "active" } } });
    expect(r.status).toBe(200);
    expect(memberWrites()).toBe(0);
    expect(db.mapUpdate).not.toHaveBeenCalled();
    expect(db.mapUpdateMany).not.toHaveBeenCalled();
    expect(db.payUpsert).not.toHaveBeenCalled();
    expect(r.body).toMatchObject({ received: true, outcome: "ignored_foreign" });
  });

  it("a standalone PaymentIntent that is not MatFlow's (no Payment row, no MatFlow metadata) writes nothing", async () => {
    db.payFindFirst.mockResolvedValue(null as never);
    const r = await deliver({ id: "evt_f2", type: "payment_intent.succeeded", data: { object: { id: "pi_foreign", customer: "cus_payer", amount_received: 4000, currency: "gbp", metadata: {} } } });
    expect(db.payUpsert).not.toHaveBeenCalled();
    expect(memberWrites()).toBe(0);
    expect(r.body.outcome).toBe("ignored_foreign");
  });
});

// ── (g) livemode must match the key's mode ───────────────────────────────────

describe("(g) livemode mismatch is refused before anything is claimed", () => {
  it("a LIVE event against a TEST key -> 400, not claimed", async () => {
    const r = await deliver({ id: "evt_g1", type: "customer.subscription.updated", livemode: true, data: { object: { id: "sub_matflow", customer: "cus_payer", status: "past_due" } } });
    expect(r.status).toBe(400);
    expect(db.claim).not.toHaveBeenCalled();
    expect(memberWrites()).toBe(0);
  });

  it("a TEST event against a LIVE key -> 400, not claimed", async () => {
    process.env.STRIPE_SECRET_KEY = "rk_live_x";
    const r = await deliver({ id: "evt_g2", type: "invoice.payment_failed", livemode: false, data: { object: { id: "in_x", customer: "cus_payer" } } });
    expect(r.status).toBe(400);
    expect(db.claim).not.toHaveBeenCalled();
  });

  it("an event with no livemode at all -> 400", async () => {
    constructEventMock.mockReturnValue({ id: "evt_g3", type: "account.updated", account: "acct_A", created: 1, data: { object: { id: "acct_A" } } });
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = (await POST(req() as never)) as unknown as { status: number };
    expect(res.status).toBe(400);
    expect(db.claim).not.toHaveBeenCalled();
  });

  it("matching modes are processed (live/live and test/test)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_x";
    const live = await deliver({ id: "evt_g4", type: "account.updated", livemode: true, data: { object: { id: "acct_A" } } });
    expect(live.status).toBe(200);
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    const test = await deliver({ id: "evt_g5", type: "account.updated", livemode: false, data: { object: { id: "acct_A" } } });
    expect(test.status).toBe(200);
    expect(db.claim).toHaveBeenCalledTimes(2);
  });
});
