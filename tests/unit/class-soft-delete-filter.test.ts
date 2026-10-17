/**
 * Task 3e — `Class.deletedAt` was never filtered.
 *
 * The column exists with an index (`@@index([tenantId, deletedAt])`) and every
 * reader used `isActive: true` alone. RULES §5: "Soft-delete columns must be
 * filtered by every reader, or they are worse than no soft-delete at all" — a
 * half-filtered soft-delete is the worst of both, because the operator is told
 * the class is gone and the members still see it.
 *
 * These tests pin the predicate each reader sends to Postgres. They are
 * predicate tests on purpose: `deletedAt` has no writer yet, so a fixture-based
 * test would assert on a state the app cannot currently reach, and would go
 * green for the wrong reason. What must never regress is the WHERE clause.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => ({})) }));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "u1", role: "owner", tenantId: "t1", memberId: "m1" },
  })),
}));

const mockPrisma = {
  class: { findMany: vi.fn(), findFirst: vi.fn() },
  // Round-3 day-marker migration: the generate routes read the club zone.
  tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: "Europe/London" }) },
  classInstance: { findMany: vi.fn(), createMany: vi.fn() },
  classSubscription: { findMany: vi.fn() },
  classRoster: { findMany: vi.fn(), groupBy: vi.fn() },
  memberRank: { findMany: vi.fn() },
  rankSystem: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  // T6a: the timetable page reads the club's tiers; the schedule reads the member's plan.
  membershipTier: { findMany: vi.fn().mockResolvedValue([]) },
  member: { findFirst: vi.fn().mockResolvedValue(null) },
  // T6b: a paused-looking class is checked for a pre-T6b archive (class.deleted) row.
  auditLog: { findMany: vi.fn().mockResolvedValue([]) },
};

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) => fn(mockPrisma)),
}));

vi.mock("@/lib/authz", () => ({
  requireStaff: vi.fn(async () => ({
    session: {
      user: { id: "u1", role: "owner", tenantId: "t1", primaryColor: "var(--color-primary)" },
    },
  })),
}));

// The dashboard page renders a client component; the test only cares about the
// query it runs first, so the component is stubbed out of the import graph.
vi.mock("@/components/dashboard/TimetableManager", () => ({ default: () => null }));

/** The `where` of a delegate's Nth findMany call. */
function whereOfCall(fn: ReturnType<typeof vi.fn>, n = 0) {
  return (fn.mock.calls[n]?.[0] as { where?: Record<string, unknown> } | undefined)?.where;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.class.findMany.mockResolvedValue([]);
  mockPrisma.class.findFirst.mockResolvedValue(null);
  mockPrisma.classInstance.findMany.mockResolvedValue([]);
  mockPrisma.classSubscription.findMany.mockResolvedValue([]);
  mockPrisma.classRoster.findMany.mockResolvedValue([]);
  mockPrisma.classRoster.groupBy.mockResolvedValue([]);
  mockPrisma.memberRank.findMany.mockResolvedValue([]);
  mockPrisma.rankSystem.findMany.mockResolvedValue([]);
  mockPrisma.user.findMany.mockResolvedValue([]);
});

describe("Task 3e — every Class reader filters deletedAt", () => {
  it("GET /api/classes excludes soft-deleted classes", async () => {
    const { GET } = await import("@/app/api/classes/route");
    await GET(new Request("http://test/api/classes"));

    expect(whereOfCall(mockPrisma.class.findMany)).toMatchObject({
      tenantId: "t1",
      isActive: true,
      deletedAt: null,
    });
  });

  it("GET /api/member/schedule excludes soft-deleted classes", async () => {
    const { GET } = await import("@/app/api/member/schedule/route");
    await GET(new Request("http://test/api/member/schedule"));

    expect(whereOfCall(mockPrisma.class.findMany)).toMatchObject({
      tenantId: "t1",
      isActive: true,
      deletedAt: null,
    });
  });

  it("buildMemberSchedule (used by /api/member/home) excludes soft-deleted classes", async () => {
    const { buildMemberSchedule } = await import("@/lib/member-home");
    await buildMemberSchedule(mockPrisma as never, {
      tenantId: "t1",
      memberId: "m1",
      dateParam: null,
    });

    expect(whereOfCall(mockPrisma.class.findMany)).toMatchObject({
      tenantId: "t1",
      isActive: true,
      deletedAt: null,
    });
  });

  it("the staff timetable page excludes soft-deleted classes", async () => {
    const TimetablePage = (await import("@/app/dashboard/timetable/page")).default;
    await TimetablePage();

    expect(whereOfCall(mockPrisma.class.findMany)).toMatchObject({
      tenantId: "t1",
      isActive: true,
      deletedAt: null,
    });
  });

  it("POST /api/instances/generate does not mint instances for a removed class", async () => {
    const { POST } = await import("@/app/api/instances/generate/route");
    await POST(
      new Request("http://test/api/instances/generate", {
        method: "POST",
        body: JSON.stringify({ weeks: 4 }),
      }),
    );

    // Generating for a removed class would resurrect it on the check-in screen
    // even though every list filters it out.
    expect(whereOfCall(mockPrisma.class.findMany)).toMatchObject({
      tenantId: "t1",
      isActive: true,
      deletedAt: null,
    });
  });

  it("POST /api/classes/[id]/instances does not mint instances for a removed class", async () => {
    const { POST } = await import("@/app/api/classes/[id]/instances/route");
    await POST(
      new Request("http://test/api/classes/c1/instances", {
        method: "POST",
        body: JSON.stringify({ weeks: 4 }),
      }),
      { params: Promise.resolve({ id: "c1" }) },
    );

    // T6b: the route reads the class by id + tenant, then refuses a paused or
    // archived one with a sentence (a 409, not a silent 404) and mints nothing.
    expect(whereOfCall(mockPrisma.class.findFirst)).toMatchObject({ id: "c1", tenantId: "t1" });
    expect(mockPrisma.classInstance.createMany).not.toHaveBeenCalled();
  });

  it("POST /api/classes/[id]/instances refuses a PAUSED class and says so", async () => {
    mockPrisma.class.findFirst.mockResolvedValue({ id: "c1", isActive: false, deletedAt: null, sourceImportJobId: null, schedules: [] });
    const { POST } = await import("@/app/api/classes/[id]/instances/route");
    const res = await POST(
      new Request("http://test/api/classes/c1/instances", { method: "POST", body: JSON.stringify({ weeks: 4 }) }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/paused/);
    expect(mockPrisma.classInstance.createMany).not.toHaveBeenCalled();
  });

  it("POST /api/classes/[id]/instances refuses an ARCHIVED class and says so", async () => {
    mockPrisma.class.findFirst.mockResolvedValue({ id: "c1", isActive: false, deletedAt: new Date(), sourceImportJobId: null, schedules: [] });
    const { POST } = await import("@/app/api/classes/[id]/instances/route");
    const res = await POST(
      new Request("http://test/api/classes/c1/instances", { method: "POST", body: JSON.stringify({ weeks: 4 }) }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/archived/);
    expect(mockPrisma.classInstance.createMany).not.toHaveBeenCalled();
  });

  it("POST /api/classes/[id]/instances calls a class archived before T6b (no deletedAt) archived, not paused", async () => {
    mockPrisma.class.findFirst.mockResolvedValue({ id: "c1", isActive: false, deletedAt: null, sourceImportJobId: null, schedules: [] });
    mockPrisma.auditLog.findMany.mockResolvedValueOnce([
      { entityId: "c1", action: "class.deleted", createdAt: new Date("2026-09-01T10:00:00Z") },
    ]);
    const { POST } = await import("@/app/api/classes/[id]/instances/route");
    const res = await POST(
      new Request("http://test/api/classes/c1/instances", { method: "POST", body: JSON.stringify({ weeks: 4 }) }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/archived.*Restore it first/);
  });

  it("a successful per-class Generate writes class.instances_generated", async () => {
    mockPrisma.class.findFirst.mockResolvedValue({
      id: "c1", isActive: true, deletedAt: null, sourceImportJobId: null,
      schedules: [{ dayOfWeek: 1, startTime: "10:00", endTime: "11:00" }],
    });
    mockPrisma.classInstance.createMany.mockResolvedValue({ count: 4 });
    const { logAudit } = await import("@/lib/audit-log");
    const { POST } = await import("@/app/api/classes/[id]/instances/route");
    const res = await POST(
      new Request("http://test/api/classes/c1/instances", { method: "POST", body: JSON.stringify({ weeks: 4 }) }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "class.instances_generated", entityType: "Class", entityId: "c1", metadata: expect.objectContaining({ created: 4, weeks: 4 }) }),
    );
  });
});

describe("Task 3e — archived classes stop appearing in a member's subscriptions", () => {
  it("GET /api/member/me/subscriptions drops subscriptions to archived/removed classes", async () => {
    const { GET } = await import("@/app/api/member/me/subscriptions/route");
    await GET();

    // Archiving a class leaves its ClassSubscription rows behind — nothing
    // deletes them and the member has no UI to clear them, so the unfiltered
    // read returned dead class ids forever.
    expect(whereOfCall(mockPrisma.classSubscription.findMany)).toMatchObject({
      memberId: "m1",
      class: { tenantId: "t1", isActive: true, deletedAt: null },
    });
  });
});
