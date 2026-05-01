import { vi, describe, it, expect, beforeEach } from "vitest";

// LB-001 (audit C9): pay-at-desk orders persist + mark-paid endpoint is
// tenant-scoped and idempotent.
// Post-launch hardening (Fix 5): mark-paid requires a `reason` body field
// (3..200 chars) so audit forensics records WHY each manual payment was
// recorded. Stops cash-skimming + reconciles to physical receipts later.

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

// vi.mock is hoisted to the top of the file, so any captured variables must
// be wrapped in vi.hoisted() to be accessible from the mock factory.
const { findFirstMock, findUniqueMock, updateMock, logAuditMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
  logAuditMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    order: {
      findFirst: findFirstMock,
      findUnique: findUniqueMock,
      update: updateMock,
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

vi.mock("@/lib/audit-log", () => ({
  logAudit: logAuditMock,
}));

vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: msg }),
  }),
}));

import { POST } from "@/app/api/orders/[id]/mark-paid/route";

beforeEach(() => {
  vi.clearAllMocks();
});

function makeReq(body?: unknown) {
  return new Request("http://localhost/api/orders/test-id/mark-paid", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = Promise.resolve({ id: "test-id" });
const validBody = { reason: "Cash collected at front desk" };

describe("POST /api/orders/[id]/mark-paid — tenant + idempotency", () => {
  it("returns 404 when the order is in another tenant", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq(validBody) as never, { params });
    expect(res.status).toBe(404);
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { id: "test-id", tenantId: "tenant-A" },
      select: { id: true, status: true, paidAt: true },
    });
  });

  it("flips status pending → paid and stamps paidAt + paidByUserId", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "pending", paidAt: null });
    updateMock.mockResolvedValueOnce({ id: "test-id", status: "paid", paidAt: new Date(), paidByUserId: "user-owner-A" });

    const res = await POST(makeReq(validBody) as never, { params });
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "test-id" },
      data: expect.objectContaining({
        status: "paid",
        paidByUserId: "user-owner-A",
      }),
    });
  });

  it("is idempotent — second call on already-paid order does NOT write", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "paid", paidAt: new Date() });
    findUniqueMock.mockResolvedValueOnce({ id: "test-id", status: "paid" });

    const res = await POST(makeReq(validBody) as never, { params });
    expect(res.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 409 when trying to pay a cancelled order", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "cancelled", paidAt: null });
    const res = await POST(makeReq(validBody) as never, { params });
    expect(res.status).toBe(409);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/orders/[id]/mark-paid — reason field validation (Fix 5)", () => {
  it("returns 400 when body is missing entirely", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "pending", paidAt: null });
    const res = await POST(makeReq() as never, { params });
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when reason is missing from body", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "pending", paidAt: null });
    const res = await POST(makeReq({}) as never, { params });
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when reason is too short (< 3 chars after trim)", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "pending", paidAt: null });
    const res = await POST(makeReq({ reason: "ok" }) as never, { params });
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when reason is too long (> 200 chars)", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "pending", paidAt: null });
    const res = await POST(makeReq({ reason: "x".repeat(201) }) as never, { params });
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 when body is not JSON", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "pending", paidAt: null });
    const req = new Request("http://localhost/api/orders/test-id/mark-paid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await POST(req as never, { params });
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("succeeds with valid reason and writes reason to audit log metadata", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "pending", paidAt: null });
    updateMock.mockResolvedValueOnce({ id: "test-id", status: "paid", paidAt: new Date(), paidByUserId: "user-owner-A" });

    const res = await POST(makeReq({ reason: "Customer paid £20 cash, receipt #4123" }) as never, { params });
    expect(res.status).toBe(200);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "order.mark_paid",
        entityType: "Order",
        entityId: "test-id",
        metadata: expect.objectContaining({
          reason: "Customer paid £20 cash, receipt #4123",
          previousStatus: "pending",
        }),
      }),
    );
  });
});
