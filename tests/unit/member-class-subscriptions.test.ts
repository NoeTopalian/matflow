import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
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
    // The booking path reads the class through a locking `SELECT … FOR UPDATE`
    // rather than `findFirst`, so the place-count and the insert cannot race.
    $queryRaw: vi.fn(),
    class: { findFirst: vi.fn() },
    classSubscription: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const mockAuth = vi.mocked(auth);
const mockQueryRaw = vi.mocked(prisma.$queryRaw);
const mockSubFindMany = vi.mocked(prisma.classSubscription.findMany);
const mockSubCreate = vi.mocked(prisma.classSubscription.create);
const mockSubDeleteMany = vi.mocked(prisma.classSubscription.deleteMany);
const mockSubCount = vi.mocked(prisma.classSubscription.count);

/** The locking read resolves to the class row, or to nothing for a foreign id. */
function classRow(over: Partial<{ id: string; maxCapacity: number | null }> = {}) {
  return [{ id: over.id ?? "cls-1", maxCapacity: over.maxCapacity ?? null }];
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/member/me/subscriptions", () => {
  it("returns subscribed class IDs scoped to the member's tenant", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockSubFindMany.mockResolvedValue([
      { classId: "cls-1" },
      { classId: "cls-2" },
    ] as never);

    const { GET } = await import("@/app/api/member/me/subscriptions/route");
    const res = await GET();
    expect(res!.status).toBe(200);
    expect(await res.json()).toEqual({ classIds: ["cls-1", "cls-2"] });
    // Task 3e TIGHTENED this predicate — it was `class: { tenantId }` alone.
    // Archiving a class leaves its ClassSubscription rows behind (nothing
    // cascades, and deliberately so: isActive:false is "paused", and
    // unsubscribing the whole class on a pause would be data loss), so an
    // unscoped read handed the member dead class ids forever with no UI to
    // clear them. The tenant scope this case was written to defend is intact
    // and now carries the visibility scope too.
    expect(mockSubFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        memberId: "mem-1",
        class: { tenantId: "tenant-A", isActive: true, deletedAt: null },
      },
    }));
  });

  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null as never);
    const { GET } = await import("@/app/api/member/me/subscriptions/route");
    const res = await GET();
    expect(res!.status).toBe(401);
  });
});

describe("POST /api/member/class-subscriptions/[classId]", () => {
  it("creates a subscription when class belongs to tenant", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockQueryRaw.mockResolvedValue(classRow() as never);
    mockSubCreate.mockResolvedValue({} as never);

    const { POST } = await import("@/app/api/member/class-subscriptions/[classId]/route");
    const res = await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "cls-1" }) });
    expect(res!.status).toBe(201);
    expect(mockSubCreate).toHaveBeenCalledWith({
      data: { memberId: "mem-1", classId: "cls-1" },
    });
  });

  it("returns 404 when class belongs to a different tenant", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockQueryRaw.mockResolvedValue([] as never);

    const { POST } = await import("@/app/api/member/class-subscriptions/[classId]/route");
    const res = await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "cls-from-tenant-B" }) });
    expect(res!.status).toBe(404);
    expect(mockSubCreate).not.toHaveBeenCalled();
  });

  it("idempotent on duplicate subscribe (P2002)", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockQueryRaw.mockResolvedValue(classRow() as never);
    mockSubCount.mockResolvedValue(0 as never);
    mockSubCreate.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));

    const { POST } = await import("@/app/api/member/class-subscriptions/[classId]/route");
    const res = await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "cls-1" }) });
    expect(res!.status).toBe(201);
  });

  // ── Capacity (round 1 defect L-F 1) ───────────────────────────────────────
  // The member schedule prints `capacity` for every class, and the booking
  // route used to select `{ id: true }` and insert regardless — so a class
  // that seats one took as many bookings as it was offered. Enforced here.

  it("refuses a booking when the class is already full, and writes nothing", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockQueryRaw.mockResolvedValue(classRow({ maxCapacity: 2 }) as never);
    mockSubCount.mockResolvedValue(2 as never);

    const { POST } = await import("@/app/api/member/class-subscriptions/[classId]/route");
    const res = await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "cls-1" }) });

    expect(res!.status).toBe(409);
    const body = await res!.json() as { error: string };
    expect(body.error).toMatch(/full/i);
    // Honest about the absent waiting list rather than implying one exists.
    expect(body.error).toMatch(/waiting list/i);
    expect(mockSubCreate).not.toHaveBeenCalled();
  });

  it("allows the last place when one remains", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockQueryRaw.mockResolvedValue(classRow({ maxCapacity: 2 }) as never);
    mockSubCount.mockResolvedValue(1 as never);
    mockSubCreate.mockResolvedValue({} as never);

    const { POST } = await import("@/app/api/member/class-subscriptions/[classId]/route");
    const res = await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "cls-1" }) });
    expect(res!.status).toBe(201);
    expect(mockSubCreate).toHaveBeenCalled();
  });

  it("a class with no capacity set is never refused", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockQueryRaw.mockResolvedValue(classRow({ maxCapacity: null }) as never);
    mockSubCreate.mockResolvedValue({} as never);

    const { POST } = await import("@/app/api/member/class-subscriptions/[classId]/route");
    const res = await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "cls-1" }) });
    expect(res!.status).toBe(201);
    // No capacity means no count — the query is not run at all.
    expect(mockSubCount).not.toHaveBeenCalled();
  });

  it("counts the other members' places, so re-booking your own place stays idempotent", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockQueryRaw.mockResolvedValue(classRow({ maxCapacity: 1 }) as never);
    mockSubCount.mockResolvedValue(0 as never);
    mockSubCreate.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));

    const { POST } = await import("@/app/api/member/class-subscriptions/[classId]/route");
    const res = await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "cls-1" }) });

    // A member who already holds the only place must not be told the class is
    // full by their own booking. The count excludes the caller for exactly this.
    expect(res!.status).toBe(201);
    expect(mockSubCount).toHaveBeenCalledWith({
      where: { classId: "cls-1", memberId: { not: "mem-1" } },
    });
  });

  it("takes a row lock on the class before counting, so two bookings cannot share the last place", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockQueryRaw.mockResolvedValue(classRow({ maxCapacity: 5 }) as never);
    mockSubCount.mockResolvedValue(0 as never);
    mockSubCreate.mockResolvedValue({} as never);

    const { POST } = await import("@/app/api/member/class-subscriptions/[classId]/route");
    await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "cls-1" }) });

    // A count followed by an insert is not enough under READ COMMITTED: two
    // members booking the last place both read the same count and both insert.
    // The lock is what makes the second wait, re-count and see the place gone.
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const sqlParts = (mockQueryRaw.mock.calls[0][0] as unknown as { join?: (s: string) => string } | string[]);
    const sqlText = Array.isArray(sqlParts) ? sqlParts.join("?") : String(sqlParts);
    expect(sqlText).toMatch(/FOR UPDATE/i);
  });
});

describe("DELETE /api/member/class-subscriptions/[classId]", () => {
  it("deleteMany scoped via class.tenantId", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockSubDeleteMany.mockResolvedValue({ count: 1 } as never);

    const { DELETE } = await import("@/app/api/member/class-subscriptions/[classId]/route");
    const res = await DELETE(new Request("http://localhost"), { params: Promise.resolve({ classId: "cls-1" }) });
    expect(res!.status).toBe(200);
    expect(mockSubDeleteMany).toHaveBeenCalledWith({
      where: { memberId: "mem-1", classId: "cls-1", class: { tenantId: "tenant-A" } },
    });
  });

  it("cross-tenant delete is silent no-op (count: 0)", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockSubDeleteMany.mockResolvedValue({ count: 0 } as never);

    const { DELETE } = await import("@/app/api/member/class-subscriptions/[classId]/route");
    const res = await DELETE(new Request("http://localhost"), { params: Promise.resolve({ classId: "cls-from-tenant-B" }) });
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ success: true, removed: 0 });
  });
});
