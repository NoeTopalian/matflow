import { vi, describe, it, expect, beforeEach } from "vitest";

// M3: Settings Store products are backed by /api/products (GET list, POST create,
// owner/manager-gated) and /api/products/[id] (PATCH, DELETE soft-delete). These
// unit tests confirm the CRUD contract: validation, tenant scoping, soft-delete.

vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { productFindMany, productCreate, productFindFirst, productUpdate } = vi.hoisted(() => ({
  productFindMany: vi.fn(),
  productCreate: vi.fn(),
  productFindFirst: vi.fn(),
  productUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: { findMany: productFindMany, create: productCreate, findFirst: productFindFirst, update: productUpdate },
  },
}));
vi.mock("@/lib/api-authz", () => ({
  requireApiStaff: vi.fn(async () => ({ ok: true, tenantId: "t-A", userId: "u-1", role: "owner" })),
  requireApiOwnerOrManager: vi.fn(async () => ({ ok: true, tenantId: "t-A", userId: "u-1", role: "owner" })),
}));

vi.mock("@/lib/authz", () => ({
  requireStaff: vi.fn(async () => ({ tenantId: "t-A", userId: "u-1", role: "owner" })),
  requireOwnerOrManager: vi.fn(async () => ({ tenantId: "t-A", userId: "u-1", role: "owner" })),
}));
vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({ status, json: async () => ({ error: msg }) }),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

import { GET, POST } from "@/app/api/products/route";
import { PATCH, DELETE } from "@/app/api/products/[id]/route";

function jsonReq(body: unknown) {
  return { json: async () => body } as unknown as Request;
}

beforeEach(() => vi.clearAllMocks());

describe("/api/products", () => {
  it("GET lists only non-deleted products for the tenant", async () => {
    productFindMany.mockResolvedValue([{ id: "p1", name: "Tee" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "p1", name: "Tee" }]);
    expect(productFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t-A", deletedAt: null } }),
    );
  });

  it("POST creates a product with valid data (201, tenant-scoped)", async () => {
    productCreate.mockResolvedValue({ id: "p2", name: "Gi", pricePence: 8999 });
    const res = await POST(jsonReq({ name: "Gi", pricePence: 8999, category: "clothing" }) as never);
    expect(res.status).toBe(201);
    expect(productCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tenantId: "t-A", name: "Gi", category: "clothing" }) }),
    );
  });

  it("POST rejects an invalid category (400)", async () => {
    const res = await POST(jsonReq({ name: "X", pricePence: 100, category: "weapons" }) as never);
    expect(res.status).toBe(400);
    expect(productCreate).not.toHaveBeenCalled();
  });

  it("POST rejects a negative price (400)", async () => {
    const res = await POST(jsonReq({ name: "X", pricePence: -5, category: "food" }) as never);
    expect(res.status).toBe(400);
  });
});

describe("/api/products/[id]", () => {
  const params = { params: Promise.resolve({ id: "p1" }) };

  it("DELETE soft-deletes (sets deletedAt), does not hard-delete", async () => {
    productFindFirst.mockResolvedValue({ id: "p1" });
    productUpdate.mockResolvedValue({ id: "p1" });
    const res = await DELETE({} as never, params as never);
    expect(res.status).toBe(200);
    expect(productUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p1" }, data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
  });

  it("PATCH updates an existing product", async () => {
    productFindFirst.mockResolvedValue({ id: "p1" });
    productUpdate.mockResolvedValue({ id: "p1", name: "Renamed" });
    const res = await PATCH(jsonReq({ name: "Renamed" }) as never, params as never);
    expect(res.status).toBe(200);
    expect(productUpdate).toHaveBeenCalled();
  });
});
