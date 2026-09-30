// `Payment.amountPence` is a Postgres `integer`. A fat finger at the desk —
// 2147483648 pence, one past the column's ceiling — reached Prisma, threw, and
// came back as a 500 "Payment processing failed" with a reference to chase.
// A number the column cannot hold is bad data, not a broken product: it belongs
// in the schema, as a 400 that says so, before anything is written.

import { vi, describe, it, expect, beforeEach } from "vitest";

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
vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({ status, json: async () => ({ error: msg }) }),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi
    .fn()
    .mockResolvedValue({ ok: true, tenantId: "tenant-A", userId: "user-1", role: "owner" }),
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    member: { findFirst: vi.fn(), update: vi.fn() },
    payment: { create: vi.fn(), findFirst: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/payments/manual/route";

/** The route reads only `json()` and the headers `logAudit` is handed. */
function req(body: unknown) {
  return {
    headers: new Headers({ origin: "http://localhost:3847", host: "localhost:3847" }),
    json: async () => body,
  } as unknown as Request;
}

const base = {
  memberId: "mem-1",
  method: "cash" as const,
  requestId: "req-abcdefgh",
};

describe("POST /api/payments/manual — an amount the ledger cannot hold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.tenant.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ currency: "GBP" });
    (prisma.member.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "mem-1",
      name: "Sam",
      nextDueAt: null,
      membershipTier: null,
    });
    (prisma.payment.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "pay-1" });
    (prisma.member.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("one penny past a signed 32-bit integer is a 400, never a 500", async () => {
    const res = await POST(req({ ...base, amountPence: 2_147_483_648 }));
    expect(res.status, "the desk must be told what is wrong, not handed a reference").toBe(400);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("a wildly larger number is refused the same way", async () => {
    const res = await POST(req({ ...base, amountPence: 9_999_999_999_999 }));
    expect(res.status).toBe(400);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  // Verifier lane 7 (30 Sep 2026): one click recorded £10,000,000 in cash.
  // A single desk payment caps at £10,000, said in words, nothing written.
  it("£10,000 is accepted; a penny more is refused in words", async () => {
    const ok = await POST(req({ ...base, amountPence: 1_000_000 }));
    expect(ok.status).toBe(201);
    const over = await POST(req({ ...base, amountPence: 1_000_001 }));
    expect(over.status).toBe(400);
    expect(JSON.stringify(await over.json())).toContain("A single payment must be £10,000 or less");
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
  });

  it("an ordinary £40 at the desk is untouched", async () => {
    const res = await POST(req({ ...base, amountPence: 4000 }));
    expect(res.status).toBe(201);
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
  });
});
