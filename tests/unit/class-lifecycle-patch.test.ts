// T6b: PATCH /api/classes/[id] carries the Pause / Resume / Restore half of
// the lifecycle (archive is DELETE).
//
//  - `isActive: false` pauses and leaves an archive marker alone.
//  - `isActive: true` resumes or restores: it clears deletedAt too, and mints
//    the sessions no generator made while the class was off the timetable.
//  - An imported history class can never be reactivated: 409 with a sentence,
//    nothing written (acceptance 5).
//  - The audit row carries isActive AND deletedAt before/after, so Undo puts
//    back exactly paused or archived.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => ({})) }));
vi.mock("@/lib/class-lifecycle", () => ({ mintUpcomingSessions: vi.fn(async () => 16) }));
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", role: "owner", tenantId: "t1" } })),
}));

const mockPrisma = {
  class: { findFirst: vi.fn(), updateMany: vi.fn() },
  classRoster: { deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn().mockResolvedValue(0) },
  classSubscription: { findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
  rankSystem: { findFirst: vi.fn() },
  $queryRaw: vi.fn().mockResolvedValue([{ id: "c1" }]),
};

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) => fn(mockPrisma)),
}));

import { logAudit } from "@/lib/audit-log";
import { mintUpcomingSessions } from "@/lib/class-lifecycle";

const ARCHIVED = new Date("2026-10-10T09:00:00.000Z");

function patch(body: unknown) {
  return new Request("http://test/api/classes/c1", { method: "PATCH", body: JSON.stringify(body) });
}

/** findFirst is called: pre-flight ownership, then `before`, then the re-read `found`. */
function classStates(pre: Record<string, unknown>, before: Record<string, unknown>, after: Record<string, unknown>) {
  mockPrisma.class.findFirst
    .mockResolvedValueOnce({ id: "c1", ...pre })
    .mockResolvedValueOnce({ id: "c1", name: "Fundamentals", ...before })
    .mockResolvedValueOnce({ id: "c1", name: "Fundamentals", schedules: [], allowedTiers: [], ...after });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.class.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.$queryRaw.mockResolvedValue([{ id: "c1" }]);
});

describe("PATCH /api/classes/[id] — lifecycle", () => {
  it("acceptance 5: an imported history class cannot be reactivated — 409 with a sentence, nothing changes", async () => {
    mockPrisma.class.findFirst.mockResolvedValueOnce({ id: "c1", sourceImportJobId: "job-1" });
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ isActive: true }), { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("imported_class");
    expect(body.error).toMatch(/imported attendance history/);
    expect(mockPrisma.class.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("Pause writes isActive false and leaves deletedAt alone; no sessions are minted", async () => {
    classStates({ sourceImportJobId: null }, { isActive: true, deletedAt: null }, { isActive: false, deletedAt: null });
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ isActive: false }), { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    const data = mockPrisma.class.updateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.isActive).toBe(false);
    expect(data.deletedAt).toBeUndefined();
    expect(mintUpcomingSessions).not.toHaveBeenCalled();
    expect(vi.mocked(logAudit).mock.calls[0][0].metadata).toMatchObject({
      before: { isActive: true },
      after: { isActive: false },
    });
  });

  it("Resume of a paused class sets isActive true, clears deletedAt, and mints the rolling window", async () => {
    classStates({ sourceImportJobId: null }, { isActive: false, deletedAt: null }, { isActive: true, deletedAt: null });
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ isActive: true }), { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    const data = mockPrisma.class.updateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({ isActive: true, deletedAt: null });
    expect(mintUpcomingSessions).toHaveBeenCalledWith(mockPrisma, "t1", "c1");
    expect((await res.json()).sessionsCreatedOnResume).toBe(16);
  });

  it("Restore of an archived class records deletedAt before/after, so Undo puts the archive back", async () => {
    classStates({ sourceImportJobId: null }, { isActive: false, deletedAt: ARCHIVED }, { isActive: true, deletedAt: null });
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ isActive: true }), { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    expect(vi.mocked(logAudit).mock.calls[0][0].metadata).toMatchObject({
      before: { isActive: false, deletedAt: ARCHIVED.toISOString() },
      after: { isActive: true, deletedAt: null },
      sessionsCreatedOnResume: 16,
    });
  });

  it("an ordinary edit of a live class does not mint and does not touch deletedAt", async () => {
    classStates({ sourceImportJobId: null }, { isActive: true, deletedAt: null }, { isActive: true, deletedAt: null });
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ name: "Fundamentals (Mon)" }), { params: Promise.resolve({ id: "c1" }) });
    expect(res.status).toBe(200);
    expect(mockPrisma.class.updateMany.mock.calls[0][0].data.deletedAt).toBeUndefined();
    expect(mintUpcomingSessions).not.toHaveBeenCalled();
  });
});
