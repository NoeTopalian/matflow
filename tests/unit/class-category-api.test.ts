// T6c (Sean note 7): the class category through the API.
//
//  - PATCH writes a valid key through the tenant-scoped updateMany, and the
//    class.updated audit row carries category before/after so Undo can put
//    the previous value back (acceptance 2).
//  - An edit that does not mention category leaves it alone.
//  - A key outside the list is a 400 on PATCH and POST, and nothing is
//    written (acceptance 3).
//  - The kiosk class list carries the key, so the tablet can label it.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => ({})) }));
vi.mock("@/lib/class-lifecycle", () => ({ mintUpcomingSessions: vi.fn(async () => 0) }));
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", role: "owner", tenantId: "t1" } })),
}));

const { mockPrisma, mockTenantFindFirst, mockInstanceFindMany } = vi.hoisted(() => ({
  mockPrisma: {
    class: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    classRoster: { deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn() },
    classSubscription: { findMany: vi.fn(), deleteMany: vi.fn() },
    rankSystem: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  },
  mockTenantFindFirst: vi.fn(),
  mockInstanceFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) =>
    fn({ ...mockPrisma, classInstance: { findMany: mockInstanceFindMany } })),
  withRlsBypass: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ tenant: { findFirst: mockTenantFindFirst } })),
}));
vi.mock("@/lib/token-hash", () => ({ hashToken: (t: string) => `hash_${t}` }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: () => "203.0.113.7",
}));

import { logAudit } from "@/lib/audit-log";

const params = { params: Promise.resolve({ id: "c1" }) };

function patch(body: unknown) {
  return new Request("http://test/api/classes/c1", { method: "PATCH", body: JSON.stringify(body) });
}

/** findFirst is called: pre-flight ownership, then `before`, then the re-read `found`. */
function classStates(before: Record<string, unknown>, after: Record<string, unknown>) {
  mockPrisma.class.findFirst
    .mockResolvedValueOnce({ id: "c1", sourceImportJobId: null })
    .mockResolvedValueOnce({ id: "c1", name: "Advanced", isActive: true, deletedAt: null, ...before })
    .mockResolvedValueOnce({ id: "c1", name: "Advanced", isActive: true, deletedAt: null, schedules: [], allowedTiers: [], ...after });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.class.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.classRoster.count.mockResolvedValue(0);
  mockPrisma.classSubscription.findMany.mockResolvedValue([]);
  mockPrisma.$queryRaw.mockResolvedValue([{ id: "c1" }]);
});

describe("PATCH /api/classes/[id] — category", () => {
  it("acceptance 2: setting No-Gi writes the key, scoped to the club, and records before/after for Undo", async () => {
    classStates({ category: null }, { category: "nogi" });
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ category: "nogi" }), params);
    expect(res.status).toBe(200);
    const call = mockPrisma.class.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "c1", tenantId: "t1" });
    expect(call.data.category).toBe("nogi");
    expect((await res.json()).category).toBe("nogi");
    const audit = vi.mocked(logAudit).mock.calls[0][0];
    expect(audit.action).toBe("class.updated");
    expect(audit.metadata).toMatchObject({ before: { category: null }, after: { category: "nogi" } });
  });

  it("null clears it back to uncategorised", async () => {
    classStates({ category: "gi" }, { category: null });
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ category: null }), params);
    expect(res.status).toBe(200);
    expect(mockPrisma.class.updateMany.mock.calls[0][0].data.category).toBeNull();
  });

  it("an edit that does not mention category leaves it alone", async () => {
    classStates({ category: "gi" }, { category: "gi" });
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ name: "Advanced (Tue)" }), params);
    expect(res.status).toBe(200);
    expect(mockPrisma.class.updateMany.mock.calls[0][0].data.category).toBeUndefined();
  });

  it.each(["No-Gi", "judo", "", 7])("acceptance 3: %j is a 400 and nothing is written", async (value) => {
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ category: value }), params);
    expect(res.status).toBe(400);
    expect(mockPrisma.class.updateMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe("POST /api/classes — category", () => {
  it("acceptance 3: a key outside the list is a 400 and no class is created", async () => {
    const { POST } = await import("@/app/api/classes/route");
    const res = await POST(new Request("http://test/api/classes", {
      method: "POST",
      body: JSON.stringify({
        name: "Wrestling", duration: 60, category: "wrestling",
        schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
      }),
    }));
    expect(res.status).toBe(400);
    expect(mockPrisma.class.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/kiosk/[token]/classes — category", () => {
  it("selects the key and returns it per class (null when uncategorised)", async () => {
    mockTenantFindFirst.mockResolvedValue({
      id: "t1", name: "Total BJJ", primaryColor: "#000", secondaryColor: "#111", textColor: "#fff", bgColor: "#000",
      logoUrl: null, fontFamily: null, subscriptionStatus: "active", deletedAt: null, timezone: "Europe/London",
    });
    const cls = (id: string, category: string | null) => ({
      id, startTime: "18:00", endTime: "19:00", date: new Date("2026-10-17T00:00:00.000Z"),
      class: { id: `c-${id}`, name: id, category, requiredRank: null, maxRank: null, _count: { rosterMembers: 0 } },
    });
    mockInstanceFindMany.mockResolvedValue([cls("i1", "nogi"), cls("i2", null)]);
    const { GET } = await import("@/app/api/kiosk/[token]/classes/route");
    const res = await GET(new Request("https://matflow.studio/api/kiosk/kiosk_token_abcdefghijklmnop/classes"), {
      params: Promise.resolve({ token: "kiosk_token_abcdefghijklmnop" }),
    });
    expect(res.status).toBe(200);
    expect(mockInstanceFindMany.mock.calls[0][0].include.class.select.category).toBe(true);
    const body = (await res.json()) as { classes: { id: string; category: string | null }[] };
    expect(body.classes.map((c) => [c.id, c.category])).toEqual([["i1", "nogi"], ["i2", null]]);
  });
});
