// Decision 1 (30 Sep 2026): "No payment yet" instead of "Paid".
//
// Every member used to be "Paid" the moment the desk added them — the column's
// default — so nobody could ever owe money and Payments → Outstanding always
// said "Nobody owes you right now" (end-user round 3, journeys 2 and 5). A
// member added at the desk now starts "pending", shown as "No payment yet";
// recording a payment makes them "paid"; Outstanding lists them at their
// plan's price; and the Payments page says what was collected today and this
// month, in the club's own zone.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  gate: vi.fn(),
  memberCreate: vi.fn(),
  memberFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  memberCount: vi.fn(),
  memberUpdate: vi.fn(),
  tierFindFirst: vi.fn(),
  paymentCreate: vi.fn(),
  paymentFindMany: vi.fn(),
  tenantFindUnique: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwnerOrManager: h.gate }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      create: h.memberCreate,
      findFirst: h.memberFindFirst,
      findMany: h.memberFindMany,
      count: h.memberCount,
      update: h.memberUpdate,
    },
    membershipTier: { findFirst: h.tierFindFirst },
    magicLinkToken: { create: vi.fn().mockResolvedValue({}) },
    memberStatusEvent: { create: vi.fn().mockResolvedValue({ id: "evt" }) },
    payment: { create: h.paymentCreate, findMany: h.paymentFindMany, findFirst: vi.fn() },
    tenant: { findUnique: h.tenantFindUnique },
  },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/api-error", () => ({
  apiError: vi.fn((message: string, status: number) => ({ status, json: async () => ({ error: message }) })),
}));

import { paymentStatusLabel, initialDeskPaymentStatus } from "@/lib/payment-status";
import { buildOutstandingRows, NO_PAYMENT_YET_REASON } from "@/lib/billing";
import { collectionWindows, sumCollected, collectedLine } from "@/lib/payment-totals";
import { parseTeamUp } from "@/lib/importers/teamup";

const TENANT = "tenant_a";
let createMember: typeof import("@/app/api/members/route")["POST"];
let recordPayment: typeof import("@/app/api/payments/manual/route")["POST"];
let outstanding: typeof import("@/app/api/payments/outstanding/route")["GET"];

beforeAll(async () => {
  ({ POST: createMember } = await import("@/app/api/members/route"));
  ({ POST: recordPayment } = await import("@/app/api/payments/manual/route"));
  ({ GET: outstanding } = await import("@/app/api/payments/outstanding/route"));
});

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "user_1", tenantId: TENANT, role: "owner", tenantSlug: "a" } });
  h.gate.mockResolvedValue({ ok: true, tenantId: TENANT, userId: "user_1", role: "owner" });
  h.memberCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "mem_new", status: "active", ...data }));
  h.memberFindFirst.mockResolvedValue(null);
  h.memberFindMany.mockResolvedValue([]);
  h.memberCount.mockResolvedValue(0);
  h.paymentFindMany.mockResolvedValue([]);
  h.tenantFindUnique.mockResolvedValue({ currency: "GBP", name: "Club" });
});

const membersReq = (body: unknown) =>
  new Request("https://matflow.studio/api/members", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "https://matflow.studio" },
    body: JSON.stringify(body),
  });

describe("a member added at the desk starts with No payment yet", () => {
  it("an adult on a priced plan is created pending, with no due date seeded", async () => {
    h.tierFindFirst.mockResolvedValue({ id: "tier_1", name: "Adult Monthly", billingCycle: "monthly", pricePence: 8000 });
    const res = await createMember(membersReq({ name: "Otto Overdue", email: "otto@example.test", membershipTierId: "tier_1" }));
    expect(res.status).toBe(201);
    const data = h.memberCreate.mock.calls[0][0].data;
    // The old code wrote nothing, so the column default "paid" won.
    expect(data.paymentStatus).toBe("pending");
    expect(data.nextDueAt).toBeUndefined();
    expect(data.membershipTierId).toBe("tier_1");
  });

  it("an adult with no plan is pending too", async () => {
    await createMember(membersReq({ name: "Wynn Nowaiver", email: "wynn@example.test" }));
    expect(h.memberCreate.mock.calls[0][0].data.paymentStatus).toBe("pending");
  });

  it("a child added from the Family card (parent set) is pending", async () => {
    h.memberFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.id === "parent_1" ? { id: "parent_1", parentMemberId: null } : null,
    );
    await createMember(membersReq({ name: "Kai Parent", parentMemberId: "parent_1", accountType: "kids", dateOfBirth: "2016-04-10" }));
    expect(h.memberCreate.mock.calls[0][0].data.paymentStatus).toBe("pending");
  });

  it("a free plan (priced at nothing) is free, and keeps its first due date", async () => {
    h.tierFindFirst.mockResolvedValue({ id: "tier_free", name: "Staff", billingCycle: "monthly", pricePence: 0 });
    await createMember(membersReq({ name: "Sam Staff", email: "sam@example.test", membershipTierId: "tier_free" }));
    const data = h.memberCreate.mock.calls[0][0].data;
    expect(data.paymentStatus).toBe("free");
    expect(data.nextDueAt).toBeInstanceOf(Date);
  });

  it("the rule, on its own", () => {
    expect(initialDeskPaymentStatus(null)).toBe("pending");
    expect(initialDeskPaymentStatus({ pricePence: 8000 })).toBe("pending");
    expect(initialDeskPaymentStatus({ pricePence: 0 })).toBe("free");
  });
});

describe("TeamUp-billed members keep the standing the import gives them", () => {
  it("a current TeamUp membership still imports as paid", () => {
    const header =
      "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
    const row = "Ada Lovelace,ada@example.test,,Adults Advanced 2026,recurring,active,Stripe,2026-01-14,2026-01-14,,,Yes,,,,,,,GB,,07000000001,,1990-04-15,,,";
    const { drafts } = parseTeamUp(`${header}\n${row}`, { today: "2026-09-24" });
    expect(drafts.find((d) => d.name === "Ada Lovelace")?.paymentStatus).toBe("paid");
  });
});

describe("the label", () => {
  it('reads "No payment yet" for pending, and the others as before', () => {
    expect(paymentStatusLabel("pending")).toBe("No payment yet");
    expect(paymentStatusLabel("paid")).toBe("Paid");
    expect(paymentStatusLabel("overdue")).toBe("Overdue");
    expect(paymentStatusLabel("free")).toBe("Free");
  });
});

describe("recording a first payment", () => {
  const payReq = (body: unknown) =>
    new Request("http://localhost/api/payments/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("moves No payment yet to paid and starts the schedule from the day paid", async () => {
    // Even if a tier edit had seeded a date a cycle ahead, the first payment
    // covers the first period from the day it was paid.
    h.memberFindFirst.mockResolvedValue({
      id: "mem_1", name: "Ava", paymentStatus: "pending",
      nextDueAt: new Date("2026-10-15T00:00:00.000Z"),
      membershipTier: { billingCycle: "monthly" },
    });
    h.paymentCreate.mockResolvedValue({ id: "pay_1" });
    const res = await recordPayment(payReq({
      memberId: "mem_1", amountPence: 8000, method: "cash", paidAt: "2026-09-15T12:00:00.000Z", requestId: "req_first_payment_1",
    }));
    expect(res.status).toBe(201);
    const update = h.memberUpdate.mock.calls[0][0].data;
    expect(update.paymentStatus).toBe("paid");
    expect((update.nextDueAt as Date).toISOString()).toBe("2026-10-15T12:00:00.000Z");
  });

  it("a paid member's next payment still advances from their due date", async () => {
    h.memberFindFirst.mockResolvedValue({
      id: "mem_2", name: "Pia", paymentStatus: "paid",
      nextDueAt: new Date("2026-10-08T00:00:00.000Z"),
      membershipTier: { billingCycle: "monthly" },
    });
    h.paymentCreate.mockResolvedValue({ id: "pay_2" });
    await recordPayment(payReq({
      memberId: "mem_2", amountPence: 8000, method: "cash", paidAt: "2026-09-30T12:00:00.000Z", requestId: "req_next_payment_2",
    }));
    expect((h.memberUpdate.mock.calls[0][0].data.nextDueAt as Date).toISOString()).toBe("2026-11-08T00:00:00.000Z");
  });
});

describe("Outstanding lists No payment yet", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");

  it("with the plan price and the reason", () => {
    const rows = buildOutstandingRows({
      now,
      overdueMembers: [],
      latestFailed: new Map(),
      noPaymentYetMembers: [{ id: "m1", name: "Otto", membershipType: "Adult Monthly", planPricePence: 8000, billedBy: "matflow" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      memberId: "m1", amountPence: 8000, amountSource: "plan_price", reason: NO_PAYMENT_YET_REASON, kind: "no_payment_yet", daysOverdue: null,
    });
  });

  it("never a TeamUp-billed member, and one row per member", () => {
    const rows = buildOutstandingRows({
      now,
      overdueMembers: [{ id: "m1", name: "Otto", membershipType: "Adult Monthly", nextDueAt: new Date("2026-09-01T00:00:00Z"), planPricePence: 8000 }],
      latestFailed: new Map(),
      noPaymentYetMembers: [
        { id: "m1", name: "Otto", membershipType: "Adult Monthly", planPricePence: 8000, billedBy: "matflow" },
        { id: "m2", name: "Tia TeamUp", membershipType: "Adult Monthly", planPricePence: 8000, billedBy: "teamup" },
      ],
    });
    expect(rows.map((r) => [r.memberId, r.kind])).toEqual([["m1", "no_payment_yet"]]);
  });

  it("the route asks for MatFlow-billed members on a plan with No payment yet", async () => {
    h.memberFindMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.paymentStatus === "pending"
        ? [{ id: "m1", name: "Otto", membershipType: "Adult Monthly", billedBy: "matflow", membershipTier: { pricePence: 8000 } }]
        : [],
    );
    const res = await outstanding();
    const body = await res.json();
    const pendingWhere = h.memberFindMany.mock.calls.map((c) => c[0].where).find((w) => w.paymentStatus === "pending");
    expect(pendingWhere).toMatchObject({
      tenantId: TENANT,
      paymentStatus: "pending",
      membershipTierId: { not: null },
      billedBy: { not: "teamup" },
    });
    expect(body.total).toBe(1);
    expect(body.totalPence).toBe(8000);
    expect(body.rows[0].reason).toBe("No payment yet");
  });
});

describe("collected today and this month, in the club's zone", () => {
  // Wed 30 Sep 2026 10:00 London (BST, UTC+1) = 09:00Z. London midnight today
  // is 29 Sep 23:00Z; the month began 31 Aug 23:00Z.
  const now = new Date("2026-09-30T09:00:00.000Z");
  const london = collectionWindows(now, "Europe/London");

  it("starts today and this month at the club's midnight, not the server's", () => {
    expect(london.dayStart.toISOString()).toBe("2026-09-29T23:00:00.000Z");
    expect(london.monthStart.toISOString()).toBe("2026-08-31T23:00:00.000Z");
  });

  it("a payment at 00:30 London belongs to today; one at 23:30 the night before does not", () => {
    const pay = (iso: string, amountPence: number, status = "succeeded", refundedAmountPence: number | null = null) => ({
      amountPence, status, paidAt: new Date(iso), createdAt: new Date(iso), refundedAmountPence,
    });
    const totals = sumCollected(
      [
        pay("2026-09-29T23:30:00.000Z", 8000), // 00:30 BST on the 30th — today
        pay("2026-09-29T22:30:00.000Z", 7400), // 23:30 BST on the 29th — this month, not today
        pay("2026-08-31T22:30:00.000Z", 5000), // 23:30 BST on 31 Aug — last month
        pay("2026-09-30T08:00:00.000Z", 4000, "refunded"), // refunded: nothing kept
        pay("2026-09-30T08:10:00.000Z", 3000, "failed"), // never collected
        pay("2026-09-30T08:20:00.000Z", 6000, "succeeded", 1000), // partly refunded
      ],
      london,
    );
    expect(totals).toEqual({ todayPence: 8000 + 5000, monthPence: 8000 + 7400 + 5000 });
  });

  it("a club east of UTC starts its day earlier in UTC terms", () => {
    const bali = collectionWindows(now, "Asia/Makassar");
    expect(bali.dayStart.toISOString()).toBe("2026-09-29T16:00:00.000Z");
  });

  it("says it as one line", () => {
    expect(collectedLine({ todayPence: 23400, monthPence: 123456, currency: "GBP" })).toBe(
      "Collected today £234.00 · this month £1,234.56",
    );
  });
});
