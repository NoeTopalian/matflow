import { vi, describe, it, expect, beforeEach } from "vitest";

// Audit money-path P0-3 — POST /api/members/[id]/charge must not treat a
// transport failure as a decline.
//
// A decline is a verdict: Stripe reached the issuer, no money moved, and the
// client is free to bin its idempotency key and start again. A connection
// reset or timeout is NOT a verdict — the member may already have been
// charged — so the response must be distinguishable (`outcomeUnknown: true`)
// and the client must replay the same key. The old code collapsed both into
// one 402 and the drawer discarded its requestId, which is precisely how a
// staff retry after a network blip charged the member twice.

vi.mock("next/server", () => ({
  NextResponse: {
    // Headers are carried through, not dropped: Retry-After is part of the
    // 429 contract the client backs off on, and a mock that discards it lets
    // a route ship the status without the header and still look tested.
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: new Headers(init?.headers ?? {}),
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

vi.mock("@/lib/api-authz", () => ({
  // The route gates via @/lib/api-authz so an expired session returns JSON 401
  // rather than a 307 to the login page — on a money route a redirect reads to
  // the client as "the charge may have gone through".
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
    member: { findFirst: vi.fn() },
    tenant: { findUnique: vi.fn() },
    payment: { upsert: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/email", () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({
    status,
    json: async () => ({ error: msg }),
  }),
}));

// The ad-hoc charge route is rate-limited to 5 attempts per member per hour.
// Every case below charges the SAME member, and the limiter's bucket outlives
// individual tests, so from the sixth case on the route would answer 429 and
// this file would be asserting the limiter instead of the outcome
// classification it exists to test. Mocked to allow by default; the limiter's
// own behaviour is asserted in the dedicated block at the bottom of this file.
const checkRateLimitMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
);
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: checkRateLimitMock,
  resetRateLimit: vi.fn().mockResolvedValue(undefined),
  getClientIp: () => "127.0.0.1",
}));

const paymentIntentsCreateMock = vi.fn();
vi.mock("stripe", () => ({
  default: class {
    paymentIntents = { create: paymentIntentsCreateMock };
  },
}));

import { prisma } from "@/lib/prisma";

/** Shapes a rejection the way stripe-node does: a real Error carrying `type`. */
function stripeError(type: string, message: string) {
  return Object.assign(new Error(message), { type });
}

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test";
  vi.mocked(prisma.member.findFirst).mockResolvedValue({
    id: "mem-1",
    name: "Aoife Byrne",
    email: null,
    stripeCustomerId: "cus_x",
  } as never);
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
    stripeAccountId: "acct_test",
    currency: "GBP",
    name: "Total BJJ",
  } as never);
  vi.mocked(prisma.payment.upsert).mockResolvedValue({} as never);
  vi.mocked(prisma.payment.create).mockResolvedValue({} as never);
});

function chargeReq(body: object = {}) {
  return new Request("http://localhost/api/members/mem-1/charge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      amountPence: 2500,
      description: "Private lesson",
      requestId: REQUEST_ID,
      ...body,
    }),
  });
}

async function post(body: object = {}) {
  const { POST } = await import("@/app/api/members/[id]/charge/route");
  return POST(chargeReq(body) as never, { params: Promise.resolve({ id: "mem-1" }) });
}

describe("P0-3 — the idempotency key actually reaches Stripe", () => {
  it("passes the client requestId through as Stripe's idempotencyKey in the request options", async () => {
    paymentIntentsCreateMock.mockResolvedValue({ id: "pi_1", status: "succeeded" });
    await post();

    expect(paymentIntentsCreateMock).toHaveBeenCalledTimes(1);
    const [params, options] = paymentIntentsCreateMock.mock.calls[0];
    expect(params.amount).toBe(2500);
    // Request options are the SECOND argument to paymentIntents.create, and
    // must carry both the connected account and the idempotency key. Without
    // the key here the client-side requestId is decorative and a retry
    // double-charges however carefully the client hangs on to it.
    expect(options.idempotencyKey).toBe(`matflow_adhoc_mem-1_${REQUEST_ID}`);
    expect(options.stripeAccount).toBe("acct_test");
  });

  it("a replayed requestId produces the identical idempotency key", async () => {
    paymentIntentsCreateMock.mockResolvedValue({ id: "pi_1", status: "succeeded" });
    await post();
    await post();
    const first = paymentIntentsCreateMock.mock.calls[0][1].idempotencyKey;
    const second = paymentIntentsCreateMock.mock.calls[1][1].idempotencyKey;
    expect(second).toBe(first);
  });
});

describe("P0-3 — decline vs transport failure", () => {
  it("a card decline is terminal: 402 with outcomeUnknown false", async () => {
    paymentIntentsCreateMock.mockRejectedValueOnce(
      stripeError("StripeCardError", "Your card was declined."),
    );
    const res = await post();
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // False, not merely absent — the drawer only discards its idempotency key
    // on an explicit "no money moved".
    expect(body.outcomeUnknown).toBe(false);
    expect(body.error).toMatch(/declined/i);
  });

  it("a decline is recorded in the ledger as failed", async () => {
    paymentIntentsCreateMock.mockRejectedValueOnce(
      stripeError("StripeCardError", "Your card was declined."),
    );
    await post();
    expect(vi.mocked(prisma.payment.create)).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.payment.create).mock.calls[0][0] as { data: { status: string } };
    expect(arg.data.status).toBe("failed");
  });

  it("a connection error is NOT a decline: 502 with outcomeUnknown true", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    paymentIntentsCreateMock.mockRejectedValueOnce(
      stripeError("StripeConnectionError", "An error occurred with our connection to Stripe."),
    );
    const res = await post();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.outcomeUnknown).toBe(true);
    // Copy must not claim the charge failed — it may well have succeeded.
    expect(body.error).toMatch(/may still have gone through/i);
    expect(body.error).not.toMatch(/declined/i);
    errSpy.mockRestore();
  });

  it("a Stripe API outage (5xx) is an unknown outcome, not a decline", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    paymentIntentsCreateMock.mockRejectedValueOnce(
      stripeError("StripeAPIError", "An unknown error occurred"),
    );
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).outcomeUnknown).toBe(true);
    errSpy.mockRestore();
  });

  it("a bare timeout with no Stripe error type falls through to unknown, not failed", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    paymentIntentsCreateMock.mockRejectedValueOnce(new Error("socket hang up"));
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).outcomeUnknown).toBe(true);
    errSpy.mockRestore();
  });

  it("an unknown outcome with no PaymentIntent id writes NO ledger row", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    paymentIntentsCreateMock.mockRejectedValueOnce(stripeError("StripeConnectionError", "timeout"));
    await post();
    // A "failed" row we cannot stand behind, with no PI to key it to, can never
    // be reconciled or deduped. The payment_intent.succeeded webhook upserts
    // the row if the charge did in fact land.
    expect(vi.mocked(prisma.payment.create)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.payment.upsert)).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("a malformed request is terminal (never reached the card): outcomeUnknown false", async () => {
    paymentIntentsCreateMock.mockRejectedValueOnce(
      stripeError("StripeInvalidRequestError", "No such customer: cus_x"),
    );
    const res = await post();
    expect(res.status).toBe(402);
    expect((await res.json()).outcomeUnknown).toBe(false);
  });
});

describe("P0-3 — PaymentIntent statuses that are not a verdict", () => {
  it("status 'processing' is unknown, not failed, and lands in the ledger as pending", async () => {
    paymentIntentsCreateMock.mockResolvedValueOnce({ id: "pi_proc", status: "processing" });
    const res = await post();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.outcomeUnknown).toBe(true);
    expect(body.paymentIntentId).toBe("pi_proc");

    const upsertArg = vi.mocked(prisma.payment.upsert).mock.calls[0][0] as {
      create: { status: string };
    };
    expect(upsertArg.create.status).toBe("pending");
  });

  it("status 'requires_payment_method' is a settled no: 402, ledger failed", async () => {
    paymentIntentsCreateMock.mockResolvedValueOnce({
      id: "pi_dead",
      status: "requires_payment_method",
      last_payment_error: { message: "Your card has insufficient funds." },
    });
    const res = await post();
    expect(res.status).toBe(402);
    expect((await res.json()).outcomeUnknown).toBe(false);

    const upsertArg = vi.mocked(prisma.payment.upsert).mock.calls[0][0] as {
      create: { status: string };
    };
    expect(upsertArg.create.status).toBe("failed");
  });

  it("a successful charge still returns 200 with the PaymentIntent id", async () => {
    paymentIntentsCreateMock.mockResolvedValueOnce({ id: "pi_ok", status: "succeeded" });
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.paymentIntentId).toBe("pi_ok");

    const upsertArg = vi.mocked(prisma.payment.upsert).mock.calls[0][0] as {
      create: { status: string; paidAt?: Date };
    };
    expect(upsertArg.create.status).toBe("succeeded");
    expect(upsertArg.create.paidAt).toBeInstanceOf(Date);
  });
});

// ── Expired session on a money route must be a settled failure, not "unknown" ──

describe("P0-4 — an expired session is JSON 401, never a redirect", () => {
  it("returns the gate's 401 and never reaches Stripe", async () => {
    // Before this was migrated off @/lib/authz, requireOwner() threw
    // NEXT_REDIRECT, Next answered 307 -> /login, fetch followed it, and the
    // drawer got HTML. res.json() threw, so `data.ok === true` was false AND
    // `settledFailure` was false — landing in the outcome-UNKNOWN branch, which
    // tells staff "it may still have gone through — check before charging
    // again". An expired cookie was reported as a possible live charge.
    const { requireApiOwner } = await import("@/lib/api-authz");
    vi.mocked(requireApiOwner).mockResolvedValueOnce({
      ok: false,
      response: { status: 401, json: async () => ({ ok: false, error: "Your session has expired. Please sign in again." }) },
    } as never);

    const res = await post();

    expect(res.status).toBe(401);
    // 4xx is a SETTLED failure in AdhocChargeDrawer, so the drawer says the
    // charge did not happen rather than "it might have".
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(paymentIntentsCreateMock).not.toHaveBeenCalled();
  });
});

describe("Tier 3.7 — the ad-hoc charge rate limit", () => {
  it("refuses over the cap with 429 + Retry-After, and never reaches Stripe", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 3600 });
    paymentIntentsCreateMock.mockClear();

    const res = await post();

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    // The whole point of the cap: a hijacked session must not reach the card.
    expect(paymentIntentsCreateMock).not.toHaveBeenCalled();
  });

  it("a 429 is settled, not outcome-unknown — the drawer must not warn about a charge that never happened", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60 });
    const res = await post();
    const body = await res.json();

    // The drawer reads an UNFLAGGED 4xx as settled, which is correct here.
    // This asserts the pairing rather than the flag: were this ever moved to a
    // 5xx without an explicit outcomeUnknown:false, staff would be told the
    // member might have been charged when nothing left the building.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(body.outcomeUnknown).toBeUndefined();
  });

  it("keys the bucket on the member, so one member's cap cannot lock out another", async () => {
    checkRateLimitMock.mockClear();
    paymentIntentsCreateMock.mockResolvedValue({ id: "pi_1", status: "succeeded" });

    await post();

    expect(checkRateLimitMock).toHaveBeenCalledWith("charge:adhoc:mem-1", 5, 60 * 60 * 1000);
  });
});
