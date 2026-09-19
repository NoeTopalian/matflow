// A roster ticked on the create form must reach the database.
//
// `classCreateSchema` had no `roster` key. Zod strips unknown keys, so the
// array the form sent was gone before the handler saw it: POST /api/classes
// answered 201, the toast said the class was created, and the comp squad the
// owner had just ticked was nowhere. The PATCH route has accepted `roster`
// since Task 5, so the two halves of one feature disagreed — create silently
// dropped what edit stored.
//
// The rule create now shares with edit: roster mode and rank gates are mutually
// exclusive. Naming both is a 400 rather than a silent winner.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";
import { classCreateSchema } from "@/lib/schemas/class";

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
  mockClassCreate,
  mockRosterCreateMany,
  mockMemberFindMany,
  mockTenantFindUnique,
  mockInstanceCreateMany,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockClassCreate: vi.fn(),
  mockRosterCreateMany: vi.fn(),
  mockMemberFindMany: vi.fn(),
  mockTenantFindUnique: vi.fn(),
  mockInstanceCreateMany: vi.fn(),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: mockLogAudit }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      class: { create: mockClassCreate },
      classRoster: { createMany: mockRosterCreateMany },
      member: { findMany: mockMemberFindMany },
      tenant: { findUnique: mockTenantFindUnique },
      classInstance: { createMany: mockInstanceCreateMany },
    }),
}));

let POST: typeof import("@/app/api/classes/route")["POST"];
beforeAll(async () => {
  ({ POST } = await import("@/app/api/classes/route"));
});

const req = (body: unknown) =>
  new Request("https://matflow.studio/api/classes", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "https://matflow.studio" },
    body: JSON.stringify(body),
  });

const base = {
  name: "Comp Squad",
  duration: 60,
  schedules: [{ dayOfWeek: 2, startTime: "18:00", endTime: "19:00" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "usr_1", role: "owner", tenantId: TENANT } });
  // The created class comes back WITH its schedules — that is what the route
  // feeds to buildInstanceRows, so an empty array here would silently skip the
  // minting assertion rather than test it.
  mockClassCreate.mockResolvedValue({
    id: "cls_1",
    name: "Comp Squad",
    schedules: [{ dayOfWeek: 2, startTime: "18:00", endTime: "19:00", startDate: new Date(), endDate: null }],
  });
  mockTenantFindUnique.mockResolvedValue({ timezone: "Europe/London" });
  mockInstanceCreateMany.mockResolvedValue({ count: 8 });
  mockRosterCreateMany.mockResolvedValue({ count: 2 });
  mockMemberFindMany.mockResolvedValue([{ id: "mem_1" }, { id: "mem_2" }]);
});

describe("classCreateSchema", () => {
  it("accepts a roster array rather than stripping it", () => {
    const parsed = classCreateSchema.safeParse({ ...base, roster: [{ memberId: "mem_1" }] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.roster).toEqual([{ memberId: "mem_1" }]);
  });

  it("still parses a class with no roster at all", () => {
    const parsed = classCreateSchema.safeParse(base);
    expect(parsed.success).toBe(true);
  });

  it("refuses a roster entry with no memberId", () => {
    expect(classCreateSchema.safeParse({ ...base, roster: [{}] }).success).toBe(false);
  });
});

describe("POST /api/classes — roster on create", () => {
  it("writes a ClassRoster row per ticked member, inside the create transaction", async () => {
    const res = await POST(req({ ...base, roster: [{ memberId: "mem_1" }, { memberId: "mem_2" }] }));

    expect(res.status).toBe(201);
    expect(mockRosterCreateMany).toHaveBeenCalledTimes(1);
    const rows = mockRosterCreateMany.mock.calls[0][0].data;
    expect(rows).toEqual([
      { tenantId: TENANT, classId: "cls_1", memberId: "mem_1", addedByUserId: "usr_1" },
      { tenantId: TENANT, classId: "cls_1", memberId: "mem_2", addedByUserId: "usr_1" },
    ]);
  });

  it("only rosters members of the caller's own club", async () => {
    // A ticked id from another gym must not become a roster row here. The
    // members are re-read under the tenant context and anything that does not
    // come back is not written.
    mockMemberFindMany.mockResolvedValue([{ id: "mem_1" }]);

    await POST(req({ ...base, roster: [{ memberId: "mem_1" }, { memberId: "mem_foreign" }] }));

    const rows = mockRosterCreateMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0].memberId).toBe("mem_1");
  });

  it("writes nothing and says so when a roster is combined with a rank gate", async () => {
    const res = await POST(req({ ...base, requiredRankId: "rank_1", roster: [{ memberId: "mem_1" }] }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("rank");
    expect(mockClassCreate).not.toHaveBeenCalled();
    expect(mockRosterCreateMany).not.toHaveBeenCalled();
  });

  it("does not touch ClassRoster when no roster is sent", async () => {
    await POST(req(base));
    expect(mockRosterCreateMany).not.toHaveBeenCalled();
  });

  it("an empty roster array creates the class and no roster rows", async () => {
    const res = await POST(req({ ...base, roster: [] }));
    expect(res.status).toBe(201);
    expect(mockRosterCreateMany).not.toHaveBeenCalled();
  });

  it("still mints the rolling window of instances", async () => {
    await POST(req({ ...base, roster: [{ memberId: "mem_1" }] }));
    expect(mockInstanceCreateMany).toHaveBeenCalled();
  });

  it("`roster` never reaches class.create as a column", async () => {
    await POST(req({ ...base, roster: [{ memberId: "mem_1" }] }));
    const createArgs = mockClassCreate.mock.calls[0][0];
    expect(createArgs.data).not.toHaveProperty("roster");
  });
});
