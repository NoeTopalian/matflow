import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/member/classes ("Your Classes" on the member progress page) lists
 * only live classes. An attendance import creates inactive historical Class
 * rows (sourceImportJobId set, never on the timetable); one of those must
 * never appear as one of "Your Classes".
 */

const { authMock, findManyMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  findManyMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ attendanceRecord: { findMany: findManyMock } }),
}));

import { GET } from "@/app/api/member/classes/route";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { tenantId: "t1", memberId: "m1" } });
});

describe("GET /api/member/classes — live classes only", () => {
  it("filters attendance to classes that are active, not deleted and not import-created", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "a1",
        classInstance: {
          date: new Date("2026-10-05T00:00:00Z"),
          startTime: "18:00",
          class: { id: "c1", name: "No-Gi", coachName: "Coach Mike" },
        },
      },
    ]);

    const res = await GET(new Request("http://localhost/api/member/classes"));
    const body = await res.json();

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberId: "m1",
          classInstance: { class: { isActive: true, deletedAt: null, sourceImportJobId: null } },
        },
      }),
    );
    expect(body).toEqual([{ id: "c1", name: "No-Gi", day: "Monday", time: "18:00", coach: "Coach Mike" }]);
  });
});
