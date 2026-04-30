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
vi.mock("@/lib/prisma", () => ({
  prisma: {
    class: { findFirst: vi.fn() },
    classSubscription: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const mockAuth = vi.mocked(auth);
const mockClassFindFirst = vi.mocked(prisma.class.findFirst);
const mockSubFindMany = vi.mocked(prisma.classSubscription.findMany);
const mockSubCreate = vi.mocked(prisma.classSubscription.create);
const mockSubDeleteMany = vi.mocked(prisma.classSubscription.deleteMany);

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
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ classIds: ["cls-1", "cls-2"] });
    expect(mockSubFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { memberId: "mem-1", class: { tenantId: "tenant-A" } },
    }));
  });

  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null as never);
    const { GET } = await import("@/app/api/member/me/subscriptions/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

describe("POST /api/member/class-subscriptions/[classId]", () => {
  it("creates a subscription when class belongs to tenant", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockClassFindFirst.mockResolvedValue({ id: "cls-1" } as never);
    mockSubCreate.mockResolvedValue({} as never);

    const { POST } = await import("@/app/api/member/class-subscriptions/[classId]/route");
    const res = await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "cls-1" }) });
    expect(res.status).toBe(201);
    expect(mockSubCreate).toHaveBeenCalledWith({
      data: { memberId: "mem-1", classId: "cls-1" },
    });
  });

  it("returns 404 when class belongs to a different tenant", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockClassFindFirst.mockResolvedValue(null);

    const { POST } = await import("@/app/api/member/class-subscriptions/[classId]/route");
    const res = await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "cls-from-tenant-B" }) });
    expect(res.status).toBe(404);
    expect(mockSubCreate).not.toHaveBeenCalled();
  });

  it("idempotent on duplicate subscribe (P2002)", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "tenant-A", memberId: "mem-1" },
    } as never);
    mockClassFindFirst.mockResolvedValue({ id: "cls-1" } as never);
    mockSubCreate.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));

    const { POST } = await import("@/app/api/member/class-subscriptions/[classId]/route");
    const res = await POST(new Request("http://localhost"), { params: Promise.resolve({ classId: "cls-1" }) });
    expect(res.status).toBe(201);
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
    expect(res.status).toBe(200);
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
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, removed: 0 });
  });
});
