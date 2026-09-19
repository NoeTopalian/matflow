// POST /api/classes minted no ClassInstance rows — only the PATCH route, the
// Generate buttons and the (never-run) cron did — so a class created for
// 12:30 today had no session to check into until someone found a button.
// Noe, 18 Sep 2026. The create now mints the same rolling window the PATCH
// route and the cron maintain, spelled the same way, in the same transaction.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => ({})) }));
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", role: "owner", tenantId: "t1" } })),
}));

const MON_18 = { dayOfWeek: 1, startTime: "18:00", endTime: "19:00", startDate: null, endDate: null };

const mockPrisma = {
  class: { create: vi.fn() },
  tenant: { findUnique: vi.fn() },
  classInstance: { createMany: vi.fn() },
};
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) => fn(mockPrisma)),
}));

function postReq(body: unknown) {
  return new Request("http://test/api/classes", { method: "POST", body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.class.create.mockResolvedValue({ id: "c1", name: "Beginner BJJ", schedules: [MON_18] });
  mockPrisma.tenant.findUnique.mockResolvedValue({ timezone: "Europe/London" });
  mockPrisma.classInstance.createMany.mockResolvedValue({ count: 8 });
});

describe("POST /api/classes mints the rolling window of instances", () => {
  it("creates eight Mondays (56 days) for a Monday slot, idempotently, and reports the count", async () => {
    const { POST } = await import("@/app/api/classes/route");
    const res = await POST(postReq({ name: "Beginner BJJ", duration: 60, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] }));
    expect(res.status).toBe(201);
    expect((await res.json()).instancesCreated).toBe(8);

    expect(mockPrisma.classInstance.createMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.classInstance.createMany.mock.calls[0][0] as {
      data: Array<{ classId: string; date: Date; startTime: string; endTime: string }>;
      skipDuplicates: boolean;
    };
    expect(call.skipDuplicates).toBe(true);
    expect(call.data).toHaveLength(8);
    for (const row of call.data) {
      expect(row).toMatchObject({ classId: "c1", startTime: "18:00", endTime: "19:00" });
      // Round-3 day-marker migration: a ClassInstance.date is UTC midnight of
      // the club's calendar date, so it is read in UTC. Reading it in the
      // process's zone is the defect, not the notation.
      expect(row.date.getUTCDay()).toBe(1);
      expect(row.date.toISOString()).toMatch(/T00:00:00\.000Z$/);
    }
  });
});
