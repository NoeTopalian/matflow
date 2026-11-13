// The class category through the API (club-managed categories, Release A).
//
//  - PATCH writes the club's category by id (`categoryId`) through the
//    tenant-scoped updateMany, never the old key, and the class.updated audit
//    row carries categoryId before/after so Undo can put the previous one back.
//  - An old key (`category`, from a browser holding an older page) is turned
//    into the club's category with that key; a club with no rows yet is seeded
//    first. Both together is a 400.
//  - Another club's id, an unknown id or an old key outside the list is a 400,
//    choosing an archived category a 409, and nothing is written. A class may
//    keep the archived category it has.
//  - The trigger's refusal (a category archived between the check and the
//    write) is a 409 with the same sentence.
//  - The kiosk class list carries the category's name (and the old key for a
//    kiosk holding an older page).

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
    classCategory: { findFirst: vi.fn() },
    classRoster: { deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn() },
    classSubscription: { findMany: vi.fn(), deleteMany: vi.fn() },
    rankSystem: { findFirst: vi.fn() },
    tenant: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
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
import { CATEGORY_ERRORS } from "@/lib/class-category-store";

const params = { params: Promise.resolve({ id: "c1" }) };

function patch(body: unknown) {
  return new Request("http://test/api/classes/c1", { method: "PATCH", body: JSON.stringify(body) });
}

const BEGINNERS = { id: "cat-beg", name: "Beginners", legacyKey: "fundamentals", archivedAt: null };
const NOGI = { id: "cat-nogi", name: "No-Gi", legacyKey: "nogi", archivedAt: null };

/** findFirst is called: pre-flight ownership, then `before`, then the re-read `found`. */
function classStates(before: Record<string, unknown>, after: Record<string, unknown>) {
  mockPrisma.class.findFirst
    .mockResolvedValueOnce({ id: "c1", sourceImportJobId: null })
    .mockResolvedValueOnce({ id: "c1", name: "Advanced", isActive: true, deletedAt: null, ...before })
    .mockResolvedValueOnce({ id: "c1", name: "Advanced", isActive: true, deletedAt: null, schedules: [], allowedTiers: [], ...after });
}

/** The Class row lock read, with the class's category now. */
function lockedWith(categoryId: string | null) {
  mockPrisma.$queryRaw.mockResolvedValue([{ id: "c1", categoryId }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.class.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.classRoster.count.mockResolvedValue(0);
  mockPrisma.classSubscription.findMany.mockResolvedValue([]);
  mockPrisma.classCategory.findFirst.mockReset();
  lockedWith(null);
});

describe("PATCH /api/classes/[id] — category", () => {
  it("choosing the club's Beginners writes its id, scoped to the club, and records before/after for Undo", async () => {
    mockPrisma.classCategory.findFirst.mockResolvedValueOnce({ id: BEGINNERS.id, archivedAt: null });
    classStates({ categoryId: null }, { categoryId: BEGINNERS.id, categoryRef: BEGINNERS });
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ categoryId: BEGINNERS.id }), params);
    expect(res.status).toBe(200);
    // Looked up in this club only.
    expect(mockPrisma.classCategory.findFirst.mock.calls[0][0].where).toEqual({ id: BEGINNERS.id, tenantId: "t1" });
    const call = mockPrisma.class.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "c1", tenantId: "t1" });
    expect(call.data.categoryId).toBe(BEGINNERS.id);
    // The old key is never written by this build: the trigger keeps it in step.
    expect(call.data).not.toHaveProperty("category");
    const body = await res.json();
    expect([body.categoryId, body.categoryName]).toEqual([BEGINNERS.id, "Beginners"]);
    expect(body).not.toHaveProperty("categoryRef");
    const audit = vi.mocked(logAudit).mock.calls[0][0];
    expect(audit.action).toBe("class.updated");
    expect(audit.metadata).toMatchObject({ fields: ["categoryId"], before: { categoryId: null }, after: { categoryId: BEGINNERS.id } });
  });

  it("null clears it back to uncategorised without a lookup (the form sends the category it saw, Release B)", async () => {
    lockedWith(BEGINNERS.id);
    classStates({ categoryId: BEGINNERS.id }, { categoryId: null, categoryRef: null });
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ categoryId: null, categoryBaseId: BEGINNERS.id }), params);
    expect(res.status).toBe(200);
    expect(mockPrisma.classCategory.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.class.updateMany.mock.calls[0][0].data.categoryId).toBeNull();
    expect((await res.json()).categoryName).toBeNull();
  });

  it("an edit that does not mention a category leaves it alone", async () => {
    lockedWith(BEGINNERS.id);
    classStates({ categoryId: BEGINNERS.id }, { categoryId: BEGINNERS.id, categoryRef: BEGINNERS });
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ name: "Advanced (Tue)" }), params);
    expect(res.status).toBe(200);
    expect(mockPrisma.classCategory.findFirst).not.toHaveBeenCalled();
    const data = mockPrisma.class.updateMany.mock.calls[0][0].data;
    expect(data.categoryId).toBeUndefined();
    expect(data.category).toBeUndefined();
  });

  it("an old key from an older page is turned into the club's category with that key", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    mockPrisma.classCategory.findFirst.mockResolvedValueOnce({ id: NOGI.id, archivedAt: null });
    classStates({ categoryId: null }, { categoryId: NOGI.id, categoryRef: NOGI });
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ category: "nogi" }), params);
    expect(res.status).toBe(200);
    expect(mockPrisma.classCategory.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1", legacyKey: "nogi" });
    expect(mockPrisma.class.updateMany.mock.calls[0][0].data.categoryId).toBe(NOGI.id);
    expect(mockPrisma.class.updateMany.mock.calls[0][0].data).not.toHaveProperty("category");
    // Counted for the Release B activation gate, with nothing identifying.
    expect(info).toHaveBeenCalledWith("[class-category] legacy key write");
    expect(vi.mocked(logAudit).mock.calls[0][0].metadata).toMatchObject({ fields: ["categoryId"] });
    info.mockRestore();
  });

  it("an old key at a club with no category rows yet seeds the eight first", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    mockPrisma.classCategory.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: NOGI.id, archivedAt: null });
    classStates({ categoryId: null }, { categoryId: NOGI.id, categoryRef: NOGI });
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ category: "nogi" }), params);
    expect(res.status).toBe(200);
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.class.updateMany.mock.calls[0][0].data.categoryId).toBe(NOGI.id);
  });

  it("a category and an old key together is a 400 and nothing is written", async () => {
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ categoryId: NOGI.id, category: "gi" }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(CATEGORY_ERRORS.both);
    expect(mockPrisma.class.updateMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("another club's category (or an unknown id) is a 400 and nothing is written", async () => {
    mockPrisma.classCategory.findFirst.mockResolvedValueOnce(null);
    classStates({}, {});
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ categoryId: "cat-of-another-club" }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(CATEGORY_ERRORS.notFound);
    expect(mockPrisma.class.updateMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("choosing an archived category is a 409; keeping the archived one the class has is allowed", async () => {
    mockPrisma.classCategory.findFirst.mockResolvedValueOnce({ id: "cat-old", archivedAt: new Date() });
    classStates({}, {});
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const refused = await PATCH(patch({ categoryId: "cat-old" }), params);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe(CATEGORY_ERRORS.archived);
    expect(mockPrisma.class.updateMany).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockPrisma.class.updateMany.mockResolvedValue({ count: 1 });
    lockedWith("cat-old");
    mockPrisma.classCategory.findFirst.mockResolvedValueOnce({ id: "cat-old", archivedAt: new Date() });
    classStates({ categoryId: "cat-old" }, { categoryId: "cat-old", categoryRef: { id: "cat-old", name: "Gi" } });
    const kept = await PATCH(patch({ categoryId: "cat-old", name: "Gi (Thu)" }), params);
    expect(kept.status).toBe(200);
  });

  it("a category archived between the check and the write: the trigger's refusal is a 409", async () => {
    mockPrisma.classCategory.findFirst.mockResolvedValueOnce({ id: NOGI.id, archivedAt: null });
    classStates({}, {});
    mockPrisma.class.updateMany.mockRejectedValueOnce(new Error("MF_CLASS_CATEGORY_ARCHIVED: that category is archived"));
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ categoryId: NOGI.id }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(CATEGORY_ERRORS.archived);
    expect(logAudit).not.toHaveBeenCalled();
  });

  it.each(["No-Gi", "judo", "", 7])("an old key %j outside the list is a 400 and nothing is written", async (value) => {
    const { PATCH } = await import("@/app/api/classes/[id]/route");
    const res = await PATCH(patch({ category: value }), params);
    expect(res.status).toBe(400);
    expect(mockPrisma.class.updateMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe("POST /api/classes — category", () => {
  const body = (extra: Record<string, unknown>) => new Request("http://test/api/classes", {
    method: "POST",
    body: JSON.stringify({ name: "Wrestling", duration: 60, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }], ...extra }),
  });

  it("an old key outside the list is a 400 and no class is created", async () => {
    const { POST } = await import("@/app/api/classes/route");
    const res = await POST(body({ category: "wrestling" }));
    expect(res.status).toBe(400);
    expect(mockPrisma.class.create).not.toHaveBeenCalled();
  });

  it("another club's category is a 400 and no class is created", async () => {
    mockPrisma.tenant.findUnique.mockResolvedValue({ timezone: "Europe/London" });
    mockPrisma.classCategory.findFirst.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/classes/route");
    const res = await POST(body({ categoryId: "cat-of-another-club" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(CATEGORY_ERRORS.notFound);
    expect(mockPrisma.class.create).not.toHaveBeenCalled();
  });

  it("a category and an old key together is a 400 before any write", async () => {
    const { POST } = await import("@/app/api/classes/route");
    const res = await POST(body({ categoryId: NOGI.id, category: "nogi" }));
    expect(res.status).toBe(400);
    expect(mockPrisma.class.create).not.toHaveBeenCalled();
  });
});

describe("GET /api/kiosk/[token]/classes — category", () => {
  it("returns each class's category name, and the old key for a kiosk holding an older page", async () => {
    mockTenantFindFirst.mockResolvedValue({
      id: "t1", name: "Total BJJ", primaryColor: "#000", secondaryColor: "#111", textColor: "#fff", bgColor: "#000",
      logoUrl: null, fontFamily: null, subscriptionStatus: "active", deletedAt: null, timezone: "Europe/London",
    });
    const cls = (id: string, category: string | null, name: string | null) => ({
      id, startTime: "18:00", endTime: "19:00", date: new Date("2026-10-17T00:00:00.000Z"),
      class: { id: `c-${id}`, name: id, category, categoryRef: name ? { name } : null, requiredRank: null, maxRank: null, _count: { rosterMembers: 0 } },
    });
    // A renamed starting category, one the club made (no old key), and none.
    mockInstanceFindMany.mockResolvedValue([cls("i1", "fundamentals", "Beginners"), cls("i2", null, "Intermediate"), cls("i3", null, null)]);
    const { GET } = await import("@/app/api/kiosk/[token]/classes/route");
    const res = await GET(new Request("https://matflow.studio/api/kiosk/kiosk_token_abcdefghijklmnop/classes"), {
      params: Promise.resolve({ token: "kiosk_token_abcdefghijklmnop" }),
    });
    expect(res.status).toBe(200);
    const select = mockInstanceFindMany.mock.calls[0][0].include.class.select;
    expect(select.category).toBe(true);
    expect(select.categoryRef).toEqual({ select: { name: true } });
    const out = (await res.json()) as { classes: { id: string; category: string | null; categoryName: string | null }[] };
    expect(out.classes.map((c) => [c.id, c.category, c.categoryName])).toEqual([
      ["i1", "fundamentals", "Beginners"],
      ["i2", null, "Intermediate"],
      ["i3", null, null],
    ]);
  });
});
