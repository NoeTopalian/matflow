// POST /api/members/[id]/card/revoke — killing a lost or replaced ID card.
//
// The column existed long before anything could turn it: lib/card-token.ts
// said in terms that "REVOCATION IS NOT YET OPERABLE", so a lost card stayed
// valid for its full five-year expiry. These tests guard the two properties
// that make revocation real rather than decorative:
//
//  * the version is INCREMENTED, not assigned — two staff revoking the same
//    lost card at once must not both land on the same number and leave one of
//    the printed cards alive;
//  * the member is reached only through the caller's own tenant.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

const TENANT = "tenant_a";
const USER = "user_1";
const MEMBER = "mem_1";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { mockRequireApiStaff, mockFindFirst, mockUpdate, mockLogAudit } = vi.hoisted(() => ({
  mockRequireApiStaff: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUpdate: vi.fn(),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/lib/api-authz", () => ({ requireApiStaff: mockRequireApiStaff }));
vi.mock("@/lib/audit-log", () => ({ logAudit: mockLogAudit }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ member: { findFirst: mockFindFirst, update: mockUpdate } }),
}));

type Route = typeof import("@/app/api/members/[id]/card/revoke/route");
let POST: Route["POST"];

beforeAll(async () => {
  ({ POST } = await import("@/app/api/members/[id]/card/revoke/route"));
});

function req(body: unknown) {
  return { json: async () => body, headers: new Headers() } as unknown as Request;
}
const params = Promise.resolve({ id: MEMBER });

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireApiStaff.mockResolvedValue({ ok: true, tenantId: TENANT, userId: USER, role: "coach" });
  mockFindFirst.mockResolvedValue({ id: MEMBER, name: "Sam Green", cardVersion: 1 });
  mockUpdate.mockResolvedValue({ cardVersion: 2 });
  mockLogAudit.mockResolvedValue(undefined);
});

describe("POST /api/members/[id]/card/revoke", () => {
  it("increments the card version rather than assigning a computed one", async () => {
    const res = await POST(req({ reason: "Lost at training" }), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.cardVersion).toBe(2);
    // `{ increment: 1 }` and not `cardVersion: current + 1`: two concurrent
    // revocations of the same lost card must both move the number.
    expect(mockUpdate.mock.calls[0][0].data).toEqual({ cardVersion: { increment: 1 } });
  });

  it("reaches the member only within the caller's tenant", async () => {
    await POST(req({ reason: "Replaced after promotion" }), { params });
    expect(mockFindFirst.mock.calls[0][0].where).toEqual({ id: MEMBER, tenantId: TENANT });
  });

  it("404s for a member outside the tenant, and changes nothing", async () => {
    mockFindFirst.mockResolvedValue(null);
    const res = await POST(req({ reason: "Lost at training" }), { params });

    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("refuses when the staff gate refuses", async () => {
    mockRequireApiStaff.mockResolvedValue({
      ok: false,
      response: { status: 403, json: async () => ({ error: "Forbidden" }) },
    });
    const res = await POST(req({ reason: "Lost at training" }), { params });

    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["too short", { reason: "lost" }],
  ])("refuses a %s reason, so the audit row can never be meaningless", async (_l, body) => {
    const res = await POST(req(body), { params });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("records the reason and both versions in the audit trail", async () => {
    await POST(req({ reason: "Left the club" }), { params });

    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.action).toBe("member.card_revoked");
    expect(entry.entityId).toBe(MEMBER);
    expect(entry.metadata.reason).toBe("Left the club");
    expect(entry.metadata.previousCardVersion).toBe(1);
    expect(entry.metadata.cardVersion).toBe(2);
  });
});
