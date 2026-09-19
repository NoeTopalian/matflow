// Campaign lane L-B, J17: `staff/assignable` answered `private, max-age=300`
// on per-tenant staff data, while its own sibling `GET /api/staff` carries the
// note "per-tenant data must not be cached upstream" and uses `no-store`.
//
// `private` keeps it out of shared caches, so this is not a cross-tenant leak —
// but a staff member removed through `DELETE /api/staff/[id]` went on appearing
// in the dashboard's Add-Task assignee list for up to five minutes after their
// account was gone, and a task assigned to them would have pointed at a row
// that no longer exists.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: { user: { findMany } } }));

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "u-1", tenantId: "t-A", role: "coach" } }),
}));

import { GET } from "@/app/api/staff/assignable/route";

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([{ id: "u-1", name: "Ann", role: "coach" }]);
});

describe("GET /api/staff/assignable", () => {
  it("is never cached — a removed staff member must not linger in the picker", async () => {
    const res = await GET();
    // The NextResponse mock above hands back the plain headers object it was
    // given, not a real `Headers`, so read it as one.
    const cacheControl = (res.headers as unknown as Record<string, string>)["Cache-Control"];

    expect(res.status).toBe(200);
    expect(cacheControl).toBe("private, no-store");
    expect(cacheControl).not.toMatch(/max-age=[1-9]/);
  });
});
