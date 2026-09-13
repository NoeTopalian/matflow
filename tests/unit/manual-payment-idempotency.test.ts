// Two staff on two tills must not be able to record the same £40 twice.
//
// Stripe-backed payments dedupe at Stripe via an idempotency key. A manual
// payment — cash at the desk, a bank transfer, a comp — never touches Stripe,
// so there was nothing to dedupe against. `RecordPaymentModal` does have an
// in-flight guard (its `submitting` state), and that is the half that does not
// matter: it cannot see the other till, and it cannot see the member profile's
// drawer recording the same payment at the same moment.
//
// The key is caller-minted and REQUIRED. Minting one server-side would produce
// a fresh value per request — no protection at all, while looking like some.
// The client holds it across exactly the retries that must dedupe and mints a
// new one for a genuinely different payment, which is why a club can still take
// two identical £40s from the same member in one day.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const {
  memberFindFirstMock,
  paymentCreateMock,
  paymentFindFirstMock,
  memberUpdateMock,
  tenantFindUniqueMock,
} = vi.hoisted(() => ({
  memberFindFirstMock: vi.fn(),
  paymentCreateMock: vi.fn(),
  paymentFindFirstMock: vi.fn(),
  memberUpdateMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: tenantFindUniqueMock },
    member: { findFirst: memberFindFirstMock, update: memberUpdateMock },
    payment: { create: paymentCreateMock, findFirst: paymentFindFirstMock },
  },
}));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi.fn(async () => ({
    ok: true, session: {} as unknown, tenantId: "tenant-A", userId: "user-1", role: "owner",
  })),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({ status, json: async () => ({ error: msg }) }),
}));

type Route = typeof import("@/app/api/payments/manual/route");
let POST: Route["POST"];
beforeAll(async () => { ({ POST } = await import("@/app/api/payments/manual/route")); });

const REQ_ID = "req_till_one_abc123";

function req(body: unknown) {
  return new Request("http://localhost/api/payments/manual", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tenantFindUniqueMock.mockResolvedValue({ currency: "GBP" });
  memberFindFirstMock.mockResolvedValue({ id: "member-1", name: "Sean" });
  paymentCreateMock.mockResolvedValue({ id: "payment-1" });
  memberUpdateMock.mockResolvedValue({});
});

describe("manual payment — the server-side dedupe key", () => {
  it("writes the caller's requestId onto the Payment row", async () => {
    await POST(req({ memberId: "member-1", amountPence: 4000, method: "cash", requestId: REQ_ID }) as never);
    // Without this the unique index has nothing to bite on and the whole
    // mechanism is decorative.
    expect(paymentCreateMock.mock.calls[0][0].data.requestId).toBe(REQ_ID);
  });

  it("refuses a request with no requestId rather than proceeding unprotected", async () => {
    const res = await POST(req({ memberId: "member-1", amountPence: 4000, method: "cash" }) as never);
    expect(res.status).toBe(400);
    expect(paymentCreateMock).not.toHaveBeenCalled();
  });

  it("refuses a too-short requestId instead of keying on it", async () => {
    const res = await POST(
      req({ memberId: "member-1", amountPence: 4000, method: "cash", requestId: "short" }) as never,
    );
    expect(res.status).toBe(400);
    expect(paymentCreateMock).not.toHaveBeenCalled();
  });

  it("returns the payment that already exists instead of writing a second", async () => {
    // The second till. Postgres rejects the insert on (tenantId, requestId).
    paymentCreateMock.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    paymentFindFirstMock.mockResolvedValue({ id: "payment-1", amountPence: 4000 });

    const res = await POST(
      req({ memberId: "member-1", amountPence: 4000, method: "cash", requestId: REQ_ID }) as never,
    );
    const body = await res.json();

    // 200, not 409: their intent was ONE payment and the ledger holds exactly
    // one. A 409 here reads as "it did not save" and invites a third attempt.
    expect(res.status).toBe(200);
    expect(body.id).toBe("payment-1");
    expect(paymentFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-A", requestId: REQ_ID } }),
    );
  });

  it("still fails loudly when the write fails for any other reason", async () => {
    // A genuine database failure must not be dressed up as a successful
    // duplicate — that would be report-success-on-failure.
    paymentCreateMock.mockRejectedValue(Object.assign(new Error("db down"), { code: "P1001" }));

    const res = await POST(
      req({ memberId: "member-1", amountPence: 4000, method: "cash", requestId: REQ_ID }) as never,
    );
    expect(res.status).toBe(500);
    expect(paymentFindFirstMock).not.toHaveBeenCalled();
  });

  it("a different payment carries a different key, so a club can take two identical £40s", async () => {
    await POST(req({ memberId: "member-1", amountPence: 4000, method: "cash", requestId: "req_morning_aaa1" }) as never);
    await POST(req({ memberId: "member-1", amountPence: 4000, method: "cash", requestId: "req_evening_bbb2" }) as never);

    // Same member, same amount, same day, two rows — which is why the key is
    // the caller's and not a composite of amount+date.
    expect(paymentCreateMock).toHaveBeenCalledTimes(2);
    expect(paymentCreateMock.mock.calls[0][0].data.requestId)
      .not.toBe(paymentCreateMock.mock.calls[1][0].data.requestId);
  });
});
