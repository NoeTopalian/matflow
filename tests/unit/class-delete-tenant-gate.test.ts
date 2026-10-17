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
//
// T6b (17 Oct 2026): DELETE now ARCHIVES (isActive false + deletedAt now) and
// there is no 409 for history any more — the counts are read by `?dryRun=1`
// for the owner's counted confirmation. The ownership rule is unchanged.

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
  mockBookingCount,
  mockClassUpdateMany,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockClassFindFirst: vi.fn(),
  mockAttendanceCount: vi.fn(),
  mockRosterCount: vi.fn(),
  mockBookingCount: vi.fn(),
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
      classSubscription: { count: mockBookingCount },
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
  mockClassFindFirst.mockResolvedValue({ id: "cls_1", isActive: true, deletedAt: null, sourceImportJobId: null });
  mockAttendanceCount.mockResolvedValue(0);
  mockRosterCount.mockResolvedValue(0);
  mockBookingCount.mockResolvedValue(0);
  mockClassUpdateMany.mockResolvedValue({ count: 1 });
});

describe("DELETE /api/classes/[id] — ownership before disclosure", () => {
  it("404s a class belonging to another club without counting anything", async () => {
    mockClassFindFirst.mockResolvedValue(null); // not ours

    const res = await DELETE(req(), { params });

    expect(res.status).toBe(404);
    expect(mockAttendanceCount).not.toHaveBeenCalled();
    expect(mockRosterCount).not.toHaveBeenCalled();
    expect(mockBookingCount).not.toHaveBeenCalled();
    expect(mockClassUpdateMany).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("the 404 body carries no counts — a foreign class answers like a missing one, dry run included", async () => {
    mockClassFindFirst.mockResolvedValue(null);
    mockAttendanceCount.mockResolvedValue(31);
    mockRosterCount.mockResolvedValue(12);

    const body = await (await DELETE(req("?dryRun=1"), { params })).json();

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

  it("?dryRun=1 says how much history a class of ours has, and changes nothing", async () => {
    mockAttendanceCount.mockResolvedValue(31);
    mockRosterCount.mockResolvedValue(12);
    mockBookingCount.mockResolvedValue(4);

    const res = await DELETE(req("?dryRun=1"), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ dryRun: true, state: "active", attendanceCount: 31, rosterCount: 12, bookingCount: 4 });
    expect(mockClassUpdateMany).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("archives a class WITH history without any force flag (no 409 dance), and audits the prior state", async () => {
    mockAttendanceCount.mockResolvedValue(31);
    mockRosterCount.mockResolvedValue(12);

    const res = await DELETE(req(), { params });

    expect(res.status).toBe(200);
    const update = mockClassUpdateMany.mock.calls[0][0] as { where: Record<string, unknown>; data: { isActive: boolean; deletedAt: Date } };
    expect(update.where).toMatchObject({ id: "cls_1", tenantId: TENANT, deletedAt: null, isActive: true });
    expect(update.data.isActive).toBe(false);
    expect(update.data.deletedAt).toBeInstanceOf(Date);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "class.deleted",
        entityId: "cls_1",
        metadata: expect.objectContaining({
          archived: true,
          attendanceCount: 31,
          rosterCount: 12,
          before: { isActive: true, deletedAt: null },
          after: { isActive: false, deletedAt: update.data.deletedAt.toISOString() },
        }),
      }),
    );
  });

  it("archiving a PAUSED class records that it was paused, so Undo returns it to paused", async () => {
    mockClassFindFirst.mockResolvedValue({ id: "cls_1", isActive: false, deletedAt: null, sourceImportJobId: null });

    const res = await DELETE(req(), { params });

    expect(res.status).toBe(200);
    expect(mockClassUpdateMany.mock.calls[0][0].where).toMatchObject({ isActive: false, deletedAt: null });
    expect(mockLogAudit.mock.calls[0][0].metadata.before).toEqual({ isActive: false, deletedAt: null });
  });

  it("?force=true is still accepted from old clients and archives the same way", async () => {
    const res = await DELETE(req("?force=true"), { params });
    expect(res.status).toBe(200);
    expect(mockClassUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("an already archived class is a no-op: no second write, no second audit row", async () => {
    mockClassFindFirst.mockResolvedValue({ id: "cls_1", isActive: false, deletedAt: new Date("2026-10-01T00:00:00Z"), sourceImportJobId: null });
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).alreadyArchived).toBe(true);
    expect(mockClassUpdateMany).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("an imported history class is refused with a sentence and left alone", async () => {
    mockClassFindFirst.mockResolvedValue({ id: "cls_1", isActive: false, deletedAt: null, sourceImportJobId: "job_1" });
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Rollback/);
    expect(mockClassUpdateMany).not.toHaveBeenCalled();
  });

  it("a state change racing the archive matches nothing and is reported, not audited", async () => {
    mockClassUpdateMany.mockResolvedValue({ count: 0 });
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(409);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
