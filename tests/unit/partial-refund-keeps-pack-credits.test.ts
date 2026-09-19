// A partial refund must not destroy a whole class pack.
//
// Every pack-void site in the product did `{ status: "refunded",
// creditsRemaining: 0 }` the moment any refund settled. So a £5 goodwill refund
// on a £100 ten-class pack handed the member back 5% of their money and took
// 100% of what they had bought — and because lib/checkin.ts only redeems packs
// that are active with credits left, the classes were gone with no screen
// anywhere explaining why.
//
// Two sites are apportioned now, through one shared helper so they cannot drift:
// the owner refund route, and the charge.refunded webhook (a refund issued from
// the Stripe dashboard never runs the route at all).
//
// Two sites deliberately stay whole-pack voids: invoice.voided reverses the
// entire invoice, and a lost chargeback is adversarial rather than goodwill.

import { vi, describe, it, expect, beforeEach } from "vitest";
import { packCreditsAfterRefund } from "@/lib/pack-refund";

// ── the arithmetic ───────────────────────────────────────────────────────────

describe("packCreditsAfterRefund — whole classes only", () => {
  // £100 pack, ten classes, nothing used yet.
  const pack = { totalCredits: 10, creditsRemaining: 10, paidPence: 10000, creditsRedeemed: 0 };

  it("a £5 goodwill refund takes NO classes — £5 does not buy one", () => {
    const out = packCreditsAfterRefund({ ...pack, refundedPence: 500 });
    expect(out.creditsRevoked).toBe(0);
    expect(out.creditsRemaining).toBe(10);
    expect(out.status).toBeNull();
  });

  it("a £25 refund takes exactly the two classes it paid for", () => {
    const out = packCreditsAfterRefund({ ...pack, refundedPence: 2500 });
    expect(out.creditsRevoked).toBe(2);
    expect(out.creditsRemaining).toBe(8);
    expect(out.status).toBeNull();
  });

  it("rounds down — £29 buys back two classes, not three", () => {
    const out = packCreditsAfterRefund({ ...pack, refundedPence: 2900 });
    expect(out.creditsRevoked).toBe(2);
    expect(out.creditsRemaining).toBe(8);
  });

  it("a FULL refund still voids the pack outright", () => {
    const out = packCreditsAfterRefund({ ...pack, refundedPence: 10000 });
    expect(out.creditsRemaining).toBe(0);
    expect(out.status).toBe("refunded");
  });

  it("over-refund (Stripe cumulative exceeding our figure) also voids", () => {
    const out = packCreditsAfterRefund({ ...pack, refundedPence: 12000 });
    expect(out.creditsRemaining).toBe(0);
    expect(out.status).toBe("refunded");
  });

  it("never takes more classes than are left — seven already attended", () => {
    // £50 back would buy five classes, but only three remain. You cannot
    // un-attend a class, so three is the most that can be revoked.
    const out = packCreditsAfterRefund({
      ...pack, creditsRemaining: 3, creditsRedeemed: 7, refundedPence: 5000,
    });
    expect(out.creditsRevoked).toBe(3);
    expect(out.creditsRemaining).toBe(0);
    // Still a PARTIAL refund, so the pack is not marked refunded — that status
    // is what blocks a restore, and the member paid for half of it.
    expect(out.status).toBeNull();
  });

  it("a zero refund changes nothing (guards a replayed webhook)", () => {
    const out = packCreditsAfterRefund({ ...pack, refundedPence: 0 });
    expect(out.creditsRevoked).toBe(0);
    expect(out.creditsRemaining).toBe(10);
    expect(out.status).toBeNull();
  });

  it("voids when the refund cannot be apportioned at all", () => {
    // No price to divide by: money came back and we cannot say how much of the
    // pack it covers, so the conservative answer is the whole thing.
    expect(packCreditsAfterRefund({ ...pack, paidPence: 0, refundedPence: 500 }).status)
      .toBe("refunded");
    expect(packCreditsAfterRefund({ ...pack, totalCredits: 0, refundedPence: 500 }).status)
      .toBe("refunded");
  });
});

// ── the same refund, reported more than once ─────────────────────────────────
//
// Stripe reports a refund CUMULATIVELY and reports it more than once: the owner
// refunds at the desk, and then `charge.refunded` echoes the identical total
// back through the webhook. The helper used to subtract the credits it computed
// from the pack's CURRENT `creditsRemaining`, which the first pass had already
// reduced — so a £25 refund on a £100 ten-class pack took two classes at the
// desk and two more when the echo landed. The member got a quarter of their
// money back and lost two fifths of their classes.
//
// The answer is a function of the pack AS SOLD — total, minus what has been
// attended, minus what the cumulative refund has bought back — so it is the
// same answer however many times the same refund is reported.

describe("packCreditsAfterRefund — idempotent under a repeated report", () => {
  const sold = { totalCredits: 10, paidPence: 10000 };

  it("the webhook echo of a partial refund takes nothing further", () => {
    // Desk: nothing attended, nothing refunded yet.
    const desk = packCreditsAfterRefund({ ...sold, creditsRemaining: 10, creditsRedeemed: 0, refundedPence: 2500 });
    expect(desk.creditsRemaining).toBe(8);
    expect(desk.creditsRevoked).toBe(2);

    // Echo: the pack now reads 8, and Stripe reports the SAME cumulative £25.
    const echo = packCreditsAfterRefund({ ...sold, creditsRemaining: 8, creditsRedeemed: 0, refundedPence: 2500 });
    expect(echo.creditsRemaining, "the same £25 must not revoke a second pair").toBe(8);
    expect(echo.creditsRevoked).toBe(0);
    expect(echo.status).toBeNull();
  });

  it("a tenth report of the same refund is still the same answer", () => {
    let creditsRemaining = 10;
    for (let i = 0; i < 10; i += 1) {
      creditsRemaining = packCreditsAfterRefund({
        ...sold, creditsRemaining, creditsRedeemed: 0, refundedPence: 2500,
      }).creditsRemaining;
    }
    expect(creditsRemaining).toBe(8);
  });

  it("successive partials count from the pack, not from each other", () => {
    // £5 then a cumulative £30 on a £50 ten-class pack, two classes attended.
    const fifty = { totalCredits: 10, paidPence: 5000, creditsRedeemed: 2 };
    const first = packCreditsAfterRefund({ ...fifty, creditsRemaining: 8, refundedPence: 500 });
    expect(first.creditsRemaining).toBe(7);

    const second = packCreditsAfterRefund({ ...fifty, creditsRemaining: 7, refundedPence: 3000 });
    // £30 back on a £50 ten-class pack is six classes; ten sold, two attended,
    // six revoked leaves two.
    expect(second.creditsRemaining).toBe(2);
    expect(second.creditsRevoked).toBe(5);
  });

  it("attendance between the refund and its echo is not charged to the refund", () => {
    // Desk revokes two of ten. The member then attends one on the credits they
    // kept, so the pack reads 7. The echo must leave 7, not 5.
    const echo = packCreditsAfterRefund({ ...sold, creditsRemaining: 7, creditsRedeemed: 1, refundedPence: 2500 });
    expect(echo.creditsRemaining).toBe(7);
    expect(echo.creditsRevoked).toBe(0);
  });

  it("a full refund voids the pack, and its echo leaves it voided", () => {
    const full = packCreditsAfterRefund({ ...sold, creditsRemaining: 10, creditsRedeemed: 0, refundedPence: 10000 });
    expect(full.creditsRemaining).toBe(0);
    expect(full.status).toBe("refunded");

    const echo = packCreditsAfterRefund({ ...sold, creditsRemaining: 0, creditsRedeemed: 0, refundedPence: 10000 });
    expect(echo.creditsRemaining).toBe(0);
    expect(echo.creditsRevoked).toBe(0);
    expect(echo.status).toBe("refunded");
  });
});

// ── the route actually uses it ───────────────────────────────────────────────

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
}));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: vi.fn().mockResolvedValue({ ok: true, tenantId: "tenant-A", userId: "user-1" }),
}));
vi.mock("@/lib/authz", () => ({
  requireOwner: vi.fn().mockResolvedValue({ tenantId: "tenant-A", userId: "user-1" }),
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
    payment: { findFirst: vi.fn(), updateMany: vi.fn() },
    tenant: { findUnique: vi.fn() },
    member: { findFirst: vi.fn() },
    memberClassPack: { findUnique: vi.fn(), update: vi.fn() },
    classPackRedemption: { count: vi.fn() },
  },
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({ status, json: async () => ({ error: msg }) }),
}));

const refundsCreateMock = vi.fn();
const chargesRetrieveMock = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    refunds = { create: refundsCreateMock };
    charges = { retrieve: chargesRetrieveMock };
    subscriptions = { cancel: vi.fn(), update: vi.fn() };
  },
}));

import { prisma } from "@/lib/prisma";

const PACK_PRICE = 10000; // £100.00, ten classes

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.STRIPE_SECRET_KEY = "sk_test";
  vi.mocked(prisma.payment.findFirst).mockResolvedValue({
    id: "pay-1", tenantId: "tenant-A", memberId: "mem-1",
    amountPence: PACK_PRICE, currency: "GBP", status: "succeeded",
    stripeChargeId: "ch_x", stripePaymentIntentId: "pi_x",
    stripeInvoiceId: null, refundedAmountPence: null,
  } as never);
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
    stripeAccountId: "acct_test", name: "Total BJJ",
  } as never);
  vi.mocked(prisma.payment.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.member.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.memberClassPack.findUnique).mockResolvedValue({
    id: "mcp-1", memberId: "mem-1", status: "active", creditsRemaining: 10,
    pack: { totalCredits: 10 },
  } as never);
  vi.mocked(prisma.memberClassPack.update).mockResolvedValue({} as never);
  vi.mocked(prisma.classPackRedemption.count).mockResolvedValue(0 as never);
  refundsCreateMock.mockImplementation((params: { amount?: number }) =>
    Promise.resolve({ id: "re_xyz", amount: params.amount, status: "succeeded", charge: "ch_x" }),
  );
});

async function refund(amountPence?: number, cumulative = amountPence ?? PACK_PRICE) {
  // First read = what Stripe already shows refunded; second = the cumulative
  // after this refund settles, which is what the route records.
  chargesRetrieveMock.mockResolvedValueOnce({ amount_refunded: 0 });
  chargesRetrieveMock.mockResolvedValueOnce({ amount_refunded: cumulative });
  const { POST } = await import("@/app/api/payments/[id]/refund/route");
  const req = new Request("http://localhost/api/payments/pay-1/refund", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(amountPence === undefined ? {} : { amountPence }),
  });
  return POST(req as never, { params: Promise.resolve({ id: "pay-1" }) });
}

describe("POST /api/payments/[id]/refund — the pack survives a partial", () => {
  it("a £5 goodwill refund does not touch the pack at all", async () => {
    const res = await refund(500);
    const body = await res.json();

    expect(res.status).toBe(200);
    // The defect this file exists for: this used to be called with
    // { status: "refunded", creditsRemaining: 0 }.
    expect(vi.mocked(prisma.memberClassPack.update)).not.toHaveBeenCalled();
    expect(body.packVoided).toBe(false);
    expect(body.packCreditsRevoked).toBe(0);
  });

  it("a £25 refund takes two classes and leaves the pack active", async () => {
    await refund(2500);

    const arg = vi.mocked(prisma.memberClassPack.update).mock.calls[0][0] as {
      data: { creditsRemaining: number; status?: string };
    };
    expect(arg.data.creditsRemaining).toBe(8);
    // A partial must NOT flip the status — "refunded" is what blocks a restore.
    expect(arg.data.status).toBeUndefined();
  });

  it("a full refund still voids the pack", async () => {
    const res = await refund(undefined, PACK_PRICE);
    const body = await res.json();

    const arg = vi.mocked(prisma.memberClassPack.update).mock.calls[0][0] as {
      data: { creditsRemaining: number; status?: string };
    };
    expect(arg.data.creditsRemaining).toBe(0);
    expect(arg.data.status).toBe("refunded");
    expect(body.packVoided).toBe(true);
    expect(body.packCreditsRevoked).toBe(10);
  });

  it("reads the pack's totalCredits, so the apportionment can be evaluated", async () => {
    await refund(2500);
    // Dropping this include would leave the helper dividing by undefined and
    // silently falling back to voiding everything — a vacuous fix.
    const arg = vi.mocked(prisma.memberClassPack.findUnique).mock.calls[0][0] as {
      include?: { pack?: { select?: { totalCredits?: boolean } } };
    };
    expect(arg.include?.pack?.select?.totalCredits).toBe(true);
  });

  it("counts the pack's redemptions, so the sum is against the pack as sold", async () => {
    await refund(2500);
    // Without the count the route can only subtract from what is left, which is
    // what let the webhook echo take the same two classes a second time.
    expect(vi.mocked(prisma.classPackRedemption.count)).toHaveBeenCalled();
    const arg = vi.mocked(prisma.classPackRedemption.count).mock.calls[0][0] as {
      where?: { memberPackId?: string };
    };
    expect(arg.where?.memberPackId).toBe("mcp-1");
  });

  it("re-applying the same cumulative refund takes no further classes", async () => {
    // The webhook echo, seen from the route's side: the pack has already been
    // reduced to 8 and Stripe reports the same £25.
    vi.mocked(prisma.memberClassPack.findUnique).mockResolvedValue({
      id: "mcp-1", memberId: "mem-1", status: "active", creditsRemaining: 8,
      pack: { totalCredits: 10 },
    } as never);
    vi.mocked(prisma.payment.findFirst).mockResolvedValue({
      id: "pay-1", tenantId: "tenant-A", memberId: "mem-1",
      amountPence: PACK_PRICE, currency: "GBP", status: "succeeded",
      stripeChargeId: "ch_x", stripePaymentIntentId: "pi_x",
      stripeInvoiceId: null, refundedAmountPence: 2500,
    } as never);

    const res = await refund(undefined, 2500);
    const body = await res.json();
    expect(body.packCreditsRevoked).toBe(0);
    const calls = vi.mocked(prisma.memberClassPack.update).mock.calls as Array<
      [{ data: { creditsRemaining: number } }]
    >;
    if (calls.length > 0) {
      expect(calls[0][0].data.creditsRemaining, "the echo must leave the pack at eight").toBe(8);
    }
  });
});
