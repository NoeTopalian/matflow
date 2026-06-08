import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { memberFindFirstMock, paymentCreateMock, memberUpdateMock, logAuditMock } = vi.hoisted(
  () => ({
    memberFindFirstMock: vi.fn(),
    paymentCreateMock: vi.fn(),
    memberUpdateMock: vi.fn(),
    logAuditMock: vi.fn(),
  }),
);

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findFirst: memberFindFirstMock,
      update: memberUpdateMock,
    },
    payment: {
      create: paymentCreateMock,
    },
  },
}));

vi.mock("@/lib/authz", () => ({
  requireOwnerOrManager: vi.fn(async () => ({
    session: {} as unknown,
    tenantId: "tenant-A",
    userId: "user-owner-A",
    role: "owner",
  })),
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));

vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: msg }),
  }),
}));

import { POST } from "@/app/api/payments/manual/route";

const MEMBER = { id: "member-1", name: "Sean Coates" };
const PAYMENT = { id: "payment-1", amountPence: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  memberFindFirstMock.mockResolvedValue(MEMBER);
  paymentCreateMock.mockResolvedValue(PAYMENT);
  memberUpdateMock.mockResolvedValue(MEMBER);
});

function makeReq(body: unknown) {
  return new Request("http://localhost/api/payments/manual", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("B1 — method-aware payment validation", () => {
  it("accepts comp method with £0 amount", async () => {
    const res = await POST(makeReq({ memberId: "member-1", amountPence: 0, method: "comp" }) as never);
    expect(res.status).toBe(201);
  });

  it("accepts exempt method with £0 amount", async () => {
    const res = await POST(makeReq({ memberId: "member-1", amountPence: 0, method: "exempt" }) as never);
    expect(res.status).toBe(201);
  });

  it("rejects cash method with £0 amount", async () => {
    const res = await POST(makeReq({ memberId: "member-1", amountPence: 0, method: "cash" }) as never);
    expect(res.status).toBe(400);
    expect(paymentCreateMock).not.toHaveBeenCalled();
  });

  it("rejects external method with £0 amount", async () => {
    const res = await POST(makeReq({ memberId: "member-1", amountPence: 0, method: "external" }) as never);
    expect(res.status).toBe(400);
    expect(paymentCreateMock).not.toHaveBeenCalled();
  });

  it("rejects other method with £0 amount", async () => {
    const res = await POST(makeReq({ memberId: "member-1", amountPence: 0, method: "other" }) as never);
    expect(res.status).toBe(400);
    expect(paymentCreateMock).not.toHaveBeenCalled();
  });

  it("rejects other method with valid amount but no notes", async () => {
    const res = await POST(makeReq({ memberId: "member-1", amountPence: 500, method: "other" }) as never);
    expect(res.status).toBe(400);
    expect(paymentCreateMock).not.toHaveBeenCalled();
  });

  it("rejects other method with valid amount but blank notes", async () => {
    const res = await POST(makeReq({ memberId: "member-1", amountPence: 500, method: "other", notes: "   " }) as never);
    expect(res.status).toBe(400);
    expect(paymentCreateMock).not.toHaveBeenCalled();
  });

  it("accepts other method with valid amount and non-empty notes", async () => {
    const res = await POST(makeReq({ memberId: "member-1", amountPence: 500, method: "other", notes: "Direct bank transfer ref #123" }) as never);
    expect(res.status).toBe(201);
  });

  it("accepts cash method with positive amount", async () => {
    const res = await POST(makeReq({ memberId: "member-1", amountPence: 4500, method: "cash" }) as never);
    expect(res.status).toBe(201);
  });
});
