// DELETE /api/classes/[id] must prove it owns the class before it counts
// anything about it.
//
// The route answered a 409 carrying `attendanceCount` and `rosterCount` for a
// class it had not yet established belonged to the caller's club. Those two
// counts each carried their own tenant predicate, so the numbers themselves
// were scoped — but the SHAPE of the handler made the refusal depend on two
// separate `where` clauses staying right for ever, in a body that is returned
// before the ownership gate runs. That is one edit away from being a disclosure
// of how busy another gym's class is and how many members are on its roster.
//
// The rule these tests fix in place: resolve the class by { id, tenantId }
// FIRST; a class that is not ours is 404 and nothing is counted, nothing is
// read and nothing is written.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

const TENANT = "tenant_a";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const {
  mockAuth,
  mockClassFindFirst,
  mockAttendanceCount,
  mockRosterCount,
  mockClassUpdateMany,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockClassFindFirst: vi.fn(),
  mockAttendanceCount: vi.fn(),
  mockRosterCount: vi.fn(),
  mockClassUpdateMany: vi.fn(),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: mockLogAudit }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      class: { findFirst: mockClassFindFirst, updateMany: mockClassUpdateMany },
      attendanceRecord: { count: mockAttendanceCount },
      classRoster: { count: mockRosterCount },
    }),
}));

let DELETE: typeof import("@/app/api/classes/[id]/route")["DELETE"];

beforeAll(async () => {
  ({ DELETE } = await import("@/app/api/classes/[id]/route"));
});

const req = (query = "") =>
  new Request(`https://matflow.studio/api/classes/cls_1${query}`, { method: "DELETE" });
const params = Promise.resolve({ id: "cls_1" });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "usr_1", role: "owner", tenantId: TENANT } });
  mockClassFindFirst.mockResolvedValue({ id: "cls_1" });
  mockAttendanceCount.mockResolvedValue(0);
  mockRosterCount.mockResolvedValue(0);
  mockClassUpdateMany.mockResolvedValue({ count: 1 });
});

describe("DELETE /api/classes/[id] — ownership before disclosure", () => {
  it("404s a class belonging to another club without counting anything", async () => {
    mockClassFindFirst.mockResolvedValue(null); // not ours

    const res = await DELETE(req(), { params });

    expect(res.status).toBe(404);
    expect(mockAttendanceCount).not.toHaveBeenCalled();
    expect(mockRosterCount).not.toHaveBeenCalled();
    expect(mockClassUpdateMany).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("the 404 body carries no counts — a foreign class answers like a missing one", async () => {
    mockClassFindFirst.mockResolvedValue(null);
    mockAttendanceCount.mockResolvedValue(31);
    mockRosterCount.mockResolvedValue(12);

    const body = await (await DELETE(req(), { params })).json();

    expect(body).toEqual({ error: "Not found" });
    expect(JSON.stringify(body)).not.toContain("31");
    expect(JSON.stringify(body)).not.toContain("12");
  });

  it("resolves ownership with both id and tenantId", async () => {
    await DELETE(req(), { params });

    expect(mockClassFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "cls_1", tenantId: TENANT }) }),
    );
  });

  it("still refuses a class of our own that has history, and still says how much", async () => {
    mockAttendanceCount.mockResolvedValue(31);
    mockRosterCount.mockResolvedValue(12);

    const res = await DELETE(req(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.attendanceCount).toBe(31);
    expect(body.rosterCount).toBe(12);
    expect(mockClassUpdateMany).not.toHaveBeenCalled();
  });

  it("?force=true soft-deletes our own class and audits it", async () => {
    mockAttendanceCount.mockResolvedValue(31);
    mockRosterCount.mockResolvedValue(12);

    const res = await DELETE(req("?force=true"), { params });

    expect(res.status).toBe(200);
    expect(mockClassUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "cls_1", tenantId: TENANT }),
        data: { isActive: false },
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "class.deleted", entityId: "cls_1" }),
    );
  });

  it("a clean class of our own soft-deletes without force", async () => {
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(200);
    expect(mockClassUpdateMany).toHaveBeenCalled();
  });
});
