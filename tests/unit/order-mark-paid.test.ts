import { vi, describe, it, expect, beforeEach } from "vitest";

// Lane 1 iter-1 CSRF-sweep follow-up: short-circuit the guard so test
// Requests (which carry no browser-set Origin header) don't 403.
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));


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
const { findFirstMock, findUniqueMock, updateMock, updateManyMock, logAuditMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  findUniqueMock: vi.fn(),
  updateMock: vi.fn(),
  updateManyMock: vi.fn(),
  logAuditMock: vi.fn(),
}));

// The transaction stand-in is a literal, not a dynamic `import("@/lib/prisma")`
// resolved per call. Two concurrent POSTs (the race block below) both hit that
// import at once, and one of them reached the REAL client — "DATABASE_URL is
// required" from a unit test that touches no database. Nothing here needs the
// module; it only needs the four mocks.
vi.mock("@/lib/prisma-tenant", () => {
  const tx = {
    order: {
      findFirst: findFirstMock,
      findUnique: findUniqueMock,
      update: updateMock,
      updateMany: updateManyMock,
    },
  };
  return {
    withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
    withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    order: {
      findFirst: findFirstMock,
      findUnique: findUniqueMock,
      update: updateMock,
      updateMany: updateManyMock,
    },
  },
}));

vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi.fn(async () => ({
    ok: true,
    session: {} as unknown,
    tenantId: "tenant-A",
    userId: "user-owner-A",
    role: "owner",
  })),
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
  // `clearAllMocks` clears recorded CALLS but leaves queued `…Once` values in
  // place, so a test that queues two answers and fails on the first leaks the
  // second into whatever runs next — which showed up as a later test silently
  // taking the "someone else settled it" branch. Reset the queues outright.
  findFirstMock.mockReset();
  findUniqueMock.mockReset();
  updateMock.mockReset();
  updateManyMock.mockReset();
  logAuditMock.mockReset();
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
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "paid", paidAt: new Date(), paidByUserId: "user-owner-A" });

    const res = await POST(makeReq(validBody) as never, { params });
    expect(res.status).toBe(200);
    // The transition is conditional — `status: "pending"` is IN the WHERE
    // clause, which is what makes the write itself the lock (see the race
    // block below). `tenantId` stays in the clause so it cannot widen.
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "test-id", tenantId: "tenant-A", status: "pending" },
      data: expect.objectContaining({
        status: "paid",
        paidByUserId: "user-owner-A",
      }),
    });
  });

  it("is idempotent — second call on already-paid order does NOT write", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "paid", paidAt: new Date() });
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "paid" });

    const res = await POST(makeReq(validBody) as never, { params });
    expect(res.status).toBe(200);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 409 when trying to pay a cancelled order", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "cancelled", paidAt: null });
    const res = await POST(makeReq(validBody) as never, { params });
    expect(res.status).toBe(409);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// Round 3 (lane L-E). The idempotency guard above is a READ, and the write that
// followed it used to be unconditional. Two tills, a double-tap, or the retry of
// a request whose response was lost all produce two requests that both read
// `pending` — and the club's audit trail then says the money was collected
// twice, by whichever staff member wrote last.
//
// The fix puts the status in the WHERE clause, so the database decides the
// winner. The loser matches nothing, returns the settled row, and writes no
// second audit entry.
describe("POST /api/orders/[id]/mark-paid — two tills at once settle it once", () => {
  it("writes one audit row when two identical requests race", async () => {
    // Both requests get past the read guard: this is the interleaving the
    // read-then-write shape cannot survive.
    findFirstMock.mockResolvedValue({ id: "test-id", status: "pending", paidAt: null });
    // Postgres serialises the two conditional updates: one matches, one does not.
    updateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    // The unconditional `update` the reverted code calls always "succeeds" —
    // which is exactly the problem, and why this mock is deliberately generous.
    updateMock.mockResolvedValue({ id: "test-id", status: "paid", paidAt: new Date(), paidByUserId: "user-owner-A" });

    const [a, b] = await Promise.all([
      POST(makeReq(validBody) as never, { params }),
      POST(makeReq(validBody) as never, { params }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    // Nothing reaches the unconditional write any more.
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/orders/[id]/mark-paid — reason field validation (Fix 5)", () => {
  it("returns 400 when body is missing entirely", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "pending", paidAt: null });
    const res = await POST(makeReq() as never, { params });
    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("returns 400 when reason is missing from body", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "pending", paidAt: null });
    const res = await POST(makeReq({}) as never, { params });
    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("returns 400 when reason is too short (< 3 chars after trim)", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "pending", paidAt: null });
    const res = await POST(makeReq({ reason: "ok" }) as never, { params });
    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("returns 400 when reason is too long (> 200 chars)", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "pending", paidAt: null });
    const res = await POST(makeReq({ reason: "x".repeat(201) }) as never, { params });
    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
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
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("succeeds with valid reason and writes reason to audit log metadata", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "pending", paidAt: null });
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    findFirstMock.mockResolvedValueOnce({ id: "test-id", status: "paid", paidAt: new Date(), paidByUserId: "user-owner-A" });

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
