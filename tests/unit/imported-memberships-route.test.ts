import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * GET /api/members/[id]/imported-memberships (2 Oct 2026): staff-readable,
 * tenant-scoped; dates come back date-only; the standing names a decision
 * (two current rows) or a scheduled start without choosing either.
 */
const { authMock, memberFindFirst, imFindMany } = vi.hoisted(() => ({
  authMock: vi.fn(),
  memberFindFirst: vi.fn(),
  imFindMany: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({ member: { findFirst: memberFindFirst }, importedMembership: { findMany: imFindMany } })),
}));

import { GET } from "@/app/api/members/[id]/imported-memberships/route";

const req = () => new Request("http://localhost/api/members/m1/imported-memberships");
const params = { params: Promise.resolve({ id: "m1" }) };
const im = (over: Record<string, unknown>) => ({
  id: "r", importJobId: "j", sourceRow: 2, planLabel: "A", type: "recurring", status: "active", processor: "Stripe",
  purchaseDate: null, startDate: new Date("2026-01-05T00:00:00Z"), expiryDate: null, cancelledDate: null, completedAt: null,
  isFirst: true, otherActive: null, entitlement: "history", disposition: "member_history", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ user: { id: "u1", role: "coach", tenantId: "t1" } });
  memberFindFirst.mockResolvedValue({ id: "m1", billedBy: "teamup", billingStatusAsOf: new Date("2026-10-02T11:27:00Z") });
});

describe("imported memberships", () => {
  it("a member session is refused; a coach may read", async () => {
    authMock.mockResolvedValueOnce({ user: { id: "u2", role: "member", tenantId: "t1", memberId: "m1" } });
    expect((await GET(req(), params)).status).toBe(403);
    imFindMany.mockResolvedValueOnce([]);
    expect((await GET(req(), params)).status).toBe(200);
    expect(memberFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "m1", tenantId: "t1" } }));
    expect(imFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", memberId: "m1" } }));
  });

  it("404 for a member outside the tenant", async () => {
    memberFindFirst.mockResolvedValueOnce(null);
    expect((await GET(req(), params)).status).toBe(404);
  });

  it("date-only dates; two current rows = a decision, no winner; a scheduled row is named", async () => {
    imFindMany.mockResolvedValueOnce([
      im({ id: "r1", planLabel: "A", entitlement: "current" }),
      im({ id: "r2", planLabel: "B", entitlement: "current", startDate: new Date("2026-06-01T00:00:00Z") }),
      im({ id: "r3", planLabel: "C", entitlement: "scheduled", startDate: new Date("2026-11-01T00:00:00Z") }),
      im({ id: "r4", planLabel: "Old", status: "cancelled", cancelledDate: new Date("2025-12-31T00:00:00Z") }),
    ]);
    const body = await (await GET(req(), params)).json();
    expect(body.billedBy).toBe("teamup");
    expect(body.standing).toEqual({ decisionRequired: ["A", "B"], scheduled: [{ planLabel: "C", startDate: "2026-11-01" }] });
    expect(body.rows[0].startDate).toBe("2026-01-05");
    expect(body.rows[3].cancelledDate).toBe("2025-12-31");
    expect(body.rows).toHaveLength(4);
  });
});
